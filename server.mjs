import express from 'express';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const PORT=Number(process.env.PORT||8787);
const POLL_MS=Number(process.env.POLL_MS||30000);
const PB_URL=process.env.PB_URL||'https://transporteaereo.petrobras.com.br/A18040_App/Generic?PageUrl=paineldevoos&MenuName=Painel%20de%20voos';
if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const app=express();
let browser, page;
let memory={status:'starting',lastAttempt:null,lastSuccess:null,count:0,error:null};
const clean=(v='')=>String(v).replace(/\s+/g,' ').trim();
const norm=(v='')=>clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const canonicalHeader=(h)=>{const n=norm(h);if(n.includes('horario')||n.includes('data/hora')||n==='data hora')return'dateTime';if(n.includes('aeroporto'))return'airport';if(n.includes('destino'))return'destination';if(n==='voo'||n.includes('numero do voo')||n.includes('nº voo'))return'flight';if(n.includes('cia aerea')||n.includes('empresa')||n.includes('companhia'))return'company';if(n.includes('mod. aeronave')||n.includes('modelo')||n.includes('aeronave'))return'aircraftModel';if(n.includes('status'))return'status';if(n.includes('observ'))return'remarks';if(n.includes('matricula'))return'registration';if(n.includes('previsto'))return'scheduled';if(n.includes('real'))return'actual';if(n.includes('retorno'))return'returnForecast';return null;};
const keyFor=(f)=>crypto.createHash('sha256').update([f.dateTime,f.airport,f.destination,f.flight,f.company,f.aircraftModel].map(norm).join('|')).digest('hex');

async function ensureBrowser(){if(browser?.isConnected()&&page&&!page.isClosed())return;try{await browser?.close()}catch{}browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const context=await browser.newContext({locale:'pt-BR',timezoneId:'America/Sao_Paulo',viewport:{width:1600,height:1100},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36'});page=await context.newPage();page.setDefaultTimeout(25000);}

async function extract(){return page.evaluate(()=>{
 const clean=(v='')=>String(v).replace(/\s+/g,' ').trim(); const norm=(v='')=>clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 const canon=(h)=>{const n=norm(h);if(n.includes('horario')||n.includes('data/hora'))return'dateTime';if(n.includes('aeroporto'))return'airport';if(n.includes('destino'))return'destination';if(n==='voo'||n.includes('numero do voo'))return'flight';if(n.includes('cia aerea')||n.includes('empresa')||n.includes('companhia'))return'company';if(n.includes('mod. aeronave')||n.includes('modelo'))return'aircraftModel';if(n.includes('status'))return'status';if(n.includes('observ'))return'remarks';if(n.includes('matricula'))return'registration';if(n.includes('previsto'))return'scheduled';if(n.includes('real'))return'actual';if(n.includes('retorno'))return'returnForecast';return null;};
 // HTML table path
 for(const table of document.querySelectorAll('table')){const rows=[...table.querySelectorAll('tr')];for(let hi=0;hi<Math.min(rows.length,5);hi++){const cells=[...rows[hi].querySelectorAll('th,td')].map(x=>clean(x.innerText));const headers=cells.map(canon);if(headers.filter(Boolean).length<4)continue;const out=[];for(const row of rows.slice(hi+1)){const vals=[...row.querySelectorAll('td')].map(x=>clean(x.innerText));if(!vals.length)continue;const item={};vals.forEach((v,i)=>{if(headers[i])item[headers[i]]=v});if(Object.values(item).some(Boolean))out.push(item)}if(out.length)return out}}
 // React/div-grid path: find rows with time/date + status and 5-10 direct cells.
 const statusWords=/previsto|decolagem|atrasado|cancelado|check-in|embarque|pous|realizado|transferido/i;
 const dateWords=/\b\d{2}\/\d{2}\/\d{4}\b|\b\d{2}:\d{2}(?::\d{2})?\b/;
 const candidates=[];
 for(const el of document.querySelectorAll('div')){const txt=clean(el.innerText);if(!txt||txt.length>450||!statusWords.test(txt)||!dateWords.test(txt))continue;const kids=[...el.children].filter(k=>{const t=clean(k.innerText);return t&&t.length<160});if(kids.length<6||kids.length>10)continue;const vals=kids.map(k=>clean(k.innerText));if(vals.some(v=>/Horário|Aeroporto|Destino|Cia Aérea|Mod\. Aeronave/i.test(v)))continue;candidates.push(vals)}
 // Deduplicate nested rows and map visual PB order: Horario, Aeroporto, Destino, Voo, Cia, Modelo, Status, Obs.
 const uniq=[]; const seen=new Set(); for(const vals of candidates){const k=vals.join('|');if(seen.has(k))continue;seen.add(k);uniq.push(vals)}
 return uniq.map(v=>({dateTime:v[0]||'',airport:v[1]||'',destination:v[2]||'',flight:v[3]||'',company:v[4]||'',aircraftModel:v[5]||'',status:v[6]||'',remarks:v[7]||''})).filter(x=>x.flight||x.destination);
});}

async function persist(flights){const now=new Date().toISOString();const rows=flights.map(f=>({source_key:keyFor(f),date_time:clean(f.dateTime),airport:clean(f.airport),destination:clean(f.destination),flight:clean(f.flight),company:clean(f.company),aircraft_model:clean(f.aircraftModel),status:clean(f.status),remarks:clean(f.remarks),registration:clean(f.registration),scheduled:clean(f.scheduled),actual:clean(f.actual),return_forecast:clean(f.returnForecast),active:true,last_seen_at:now,raw:f}));
 const keys=rows.map(r=>r.source_key); if(rows.length){const {error}=await supabase.from('pb_flights').upsert(rows,{onConflict:'source_key'});if(error)throw error; const {error:deactivate}=await supabase.from('pb_flights').update({active:false}).eq('active',true).lt('last_seen_at',now);if(deactivate)throw deactivate;}
 await supabase.from('pb_sync_status').upsert({id:1,status:'live',last_attempt:now,last_success:now,row_count:rows.length,error:null,updated_at:now});
}
async function setError(err){const now=new Date().toISOString();const {data}=await supabase.from('pb_sync_status').select('last_success').eq('id',1).maybeSingle();const status=data?.last_success?'stale':'error';await supabase.from('pb_sync_status').upsert({id:1,status,last_attempt:now,error:String(err?.message||err),updated_at:now});memory.status=status;memory.error=String(err?.message||err);}
async function capture() {
  memory.lastAttempt = new Date().toISOString();

  try {
    await ensureBrowser();

    await page.goto(PB_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForLoadState("networkidle", {
      timeout: 60000
    }).catch(() => {});

    await page.waitForTimeout(5000);

    await page.waitForFunction(() => {
      const body = document.body?.innerText || "";

      return (
        body.includes("Painel de voos") ||
        body.includes("Horário") ||
        body.includes("Destino") ||
        body.includes("Cia Aérea")
      );
    }, {
      timeout: 30000
    }).catch(() => {});

    const flights = await extract();

    if (!flights.length) {
      throw new Error(
        "Nenhuma linha de voo encontrada no painel PB renderizado."
      );
    }

    await persist(flights);

    memory = {
      status: "live",
      lastAttempt: new Date().toISOString(),
      lastSuccess: new Date().toISOString(),
      count: flights.length,
      error: null
    };

    console.log(`[PB] OK: ${flights.length} voos capturados`);

  } catch (err) {

    console.error("[PB] Error:", err?.message || err);

    memory = {
      ...memory,
      status: memory.lastSuccess ? "stale" : "error",
      lastAttempt: new Date().toISOString(),
      error: err?.message || String(err)
    };

    await setError(err);
  }
}app.get('/health',(_,res)=>res.json(memory));app.post('/refresh',async(_,res)=>{await capture();res.json(memory)});app.listen(PORT,()=>console.log(`RIGFLOW PB Collector :${PORT} polling ${POLL_MS}ms`));
await capture();setInterval(capture,POLL_MS);
