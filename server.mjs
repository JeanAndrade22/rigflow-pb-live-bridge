import express from 'express';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { XMLParser } from 'fast-xml-parser';

const PORT = Number(process.env.PORT || 8787);
const POLL_MS = Number(process.env.POLL_MS || 30000);
const PB_URL = process.env.PB_URL || 'https://transporteaereo.petrobras.com.br/A18040_App/Generic?PageUrl=paineldevoos&MenuName=Painel%20de%20voos';
const PB_API_URL = process.env.PB_API_URL || 'https://transporteaereo.petrobras.com.br/A18040_App/screenservices/A18040_App_Backoffice_CW/PainelDeVoos/PainelDeVoos/ScreenDataSetGetVoosAeroportoCache';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

const app = express();
let browser;
let context;
let page;
let running = false;
let memory = {
  status: 'starting',
  source: 'PB OutSystems direct API',
  lastAttempt: null,
  lastSuccess: null,
  count: 0,
  error: null,
  apiResponseSeenAt: null,
  mode: null,
};

const clean = (v = '') => String(v ?? '').replace(/\s+/g, ' ').trim();
const asArray = (v) => v == null ? [] : Array.isArray(v) ? v : [v];
const stableKey = (flight) => crypto.createHash('sha256').update(`PB|${clean(flight)}`).digest('hex');

const PB_REQUEST_BODY = {
  versionInfo: {
    moduleVersion: '7R+xzrKM_eeJewXnr4WYCQ',
    apiVersion: 'ixZokngowh2BmEzh0JPecg',
  },
  viewName: 'PageGeneric.Generic',
  screenData: {
    variables: {
      IsPartida: true,
      StartIndex: 0,
      TableSort: '',
      VoosAeroportoDTO_New: {
        List: [],
        EmptyListItem: {
          Codigo: '0', CodigoEmpresa: '', NomeEmpresa: '', NumeroVoo: '0',
          PrefixoAeronave: '', ModeloAeronave: '', Rota: '', Observacao: '',
          StatusVoo: '', HorarioOriginal: '1900-01-01T00:00:00',
          PrevisaoDecolagem: '1900-01-01T00:00:00', PrevisaoRetorno: '1900-01-01T00:00:00',
          SiglaAeroporto: '', NomeAeroporto: '', CompanyImg: null, NomeAeroportoAmigavel: '',
        },
      },
      DropdownItems: {
        VooList: { List: [], EmptyListItem: { NumeroVoo: '' } },
        AeroportoList: { List: [], EmptyListItem: { SiglaAeroporto: '', NomeAeroporto: '' } },
        CiaList: { List: [], EmptyListItem: { NomeEmpresa: '' } },
        DestinoList: { List: [], EmptyListItem: { Rota: '' } },
      },
      VoosAeroportoDTO_New_Copy: {
        List: [],
        EmptyListItem: {
          Codigo: '0', CodigoEmpresa: '', NomeEmpresa: '', NumeroVoo: '0',
          PrefixoAeronave: '', ModeloAeronave: '', Rota: '', Observacao: '',
          StatusVoo: '', HorarioOriginal: '1900-01-01T00:00:00',
          PrevisaoDecolagem: '1900-01-01T00:00:00', PrevisaoRetorno: '1900-01-01T00:00:00',
          SiglaAeroporto: '', NomeAeroporto: '', CompanyImg: null, NomeAeroportoAmigavel: '',
        },
      },
      DropdownFilters: {
        AeroportoList: { List: [], EmptyListItem: { SiglaAeroporto: '', NomeAeroporto: '' } },
        Destino: { Rota: '' },
        Voo: { NumeroVoo: '' },
        Cia: { NomeEmpresa: '' },
      },
      TimerId: 0,
      Progress: 0,
    },
  },
  inputParameters: {},
  clientVariables: {
    user_token: '', user_tokenexpires: '', user_cpf: '', user_email: '', user_chave: '',
  },
};

function normalizeDate(value) {
  const s = clean(value);
  return s || '';
}

function getCacheXmls(payload) {
  const list = payload?.data?.List?.List;
  return asArray(list)
    .map((item) => item?.VoosAeroporto_Cache?.XML)
    .filter(Boolean);
}

function extractDtos(parsed) {
  const env = parsed?.Envelope ?? parsed?.['soap:Envelope'];
  const body = env?.Body ?? env?.['soap:Body'];
  const response = body?.GetPainelAeroportoListResponse;
  const result = response?.GetPainelAeroportoListResult;
  const collection = result?.VoosAeroportoCollection;
  return asArray(collection?.VoosAeroportoDTO);
}

function mapDto(dto) {
  const flight = clean(dto.NumeroVoo);
  if (!flight) return null;
  const prefix = clean(dto.PrefixoAeronave);
  const remarks = clean(dto.Observacao);
  return {
    source_key: stableKey(flight),
    date_time: normalizeDate(dto.PrevisaoDecolagem || dto.HorarioOriginal),
    airport: clean(dto.NomeAeroporto || dto.SiglaAeroporto),
    destination: clean(dto.Rota),
    flight,
    company: clean(dto.NomeEmpresa),
    aircraft_model: clean(dto.ModeloAeronave),
    status: clean(dto.StatusVoo),
    remarks: [prefix ? `PREFIXO ${prefix}` : '', remarks].filter(Boolean).join(' · '),
  };
}

function parsePbPayload(payload) {
  const xmls = getCacheXmls(payload);
  if (!xmls.length) throw new Error('PB API response did not contain VoosAeroporto_Cache.XML');

  const rows = [];
  for (const xml of xmls) {
    const parsed = xmlParser.parse(xml);
    for (const dto of extractDtos(parsed)) {
      const row = mapDto(dto);
      if (row) rows.push(row);
    }
  }

  const byFlight = new Map();
  for (const row of rows) byFlight.set(row.flight, row);
  return [...byFlight.values()].sort((a, b) => String(a.date_time).localeCompare(String(b.date_time)));
}

async function directPbRequest() {
  const response = await fetch(PB_API_URL, {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json; charset=UTF-8',
      'referer': PB_URL,
      'origin': 'https://transporteaereo.petrobras.com.br',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
    },
    body: JSON.stringify(PB_REQUEST_BODY),
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`PB direct API HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error(`PB direct API returned non-JSON: ${text.slice(0, 300)}`); }

  if (payload?.versionInfo?.hasModuleVersionChanged || payload?.versionInfo?.hasApiVersionChanged) {
    throw new Error('PB OutSystems module/API version changed; collector payload needs refresh');
  }

  if (!getCacheXmls(payload).length) {
    throw new Error('PB direct API returned JSON but no VoosAeroporto_Cache.XML');
  }

  memory.mode = 'direct';
  return payload;
}

async function ensureBrowser() {
  if (browser?.isConnected() && page && !page.isClosed()) return;
  try { await browser?.close(); } catch {}
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  context = await browser.newContext({ serviceWorkers: 'block', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  page = await context.newPage();
}

async function browserFallback() {
  await ensureBrowser();
  let found;
  const responsePromise = new Promise((resolve) => {
    const handler = async (response) => {
      if (!/ScreenDataSetGetVoosAeroporto/i.test(response.url())) return;
      try {
        const payload = await response.json();
        if (!getCacheXmls(payload).length) return;
        found = payload;
        page.off('response', handler);
        resolve(payload);
      } catch {}
    };
    page.on('response', handler);
  });
  await page.goto(PB_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const payload = await Promise.race([responsePromise, page.waitForTimeout(15000).then(() => null)]);
  if (!payload && !found) throw new Error('Browser fallback did not capture PB XHR within 15s');
  memory.mode = 'browser-fallback';
  return payload || found;
}

async function getPbApiSnapshot() {
  try {
    return await directPbRequest();
  } catch (directError) {
    console.warn('[PB API] Direct request failed:', directError?.message || directError);
    try {
      return await browserFallback();
    } catch (browserError) {
      throw new Error(`Direct: ${directError?.message || directError} | Fallback: ${browserError?.message || browserError}`);
    }
  }
}

async function persist(flights) {
  if (!flights.length) throw new Error('PB API returned zero flights; previous snapshot preserved');
  const now = new Date().toISOString();
  const rows = flights.map((f) => ({ ...f, active: true, last_seen_at: now, updated_at: now }));

  const { error: upsertError } = await supabase.from('pb_flights').upsert(rows, { onConflict: 'source_key' });
  if (upsertError) throw upsertError;

  const currentKeys = rows.map((r) => r.source_key);
  const { error: deactivateError } = await supabase
    .from('pb_flights')
    .update({ active: false, updated_at: now })
    .eq('active', true)
    .not('source_key', 'in', `(${currentKeys.join(',')})`);
  if (deactivateError) throw deactivateError;

  const { error: syncError } = await supabase.from('pb_sync_status').upsert({
    id: 1,
    status: 'live',
    last_attempt: now,
    last_success: now,
    row_count: rows.length,
    error: null,
    updated_at: now,
  });
  if (syncError) throw syncError;
}

async function setError(err) {
  const now = new Date().toISOString();
  let previousSuccess = memory.lastSuccess;
  try {
    const { data } = await supabase.from('pb_sync_status').select('last_success').eq('id', 1).maybeSingle();
    previousSuccess = data?.last_success || previousSuccess;
  } catch {}
  try {
    await supabase.from('pb_sync_status').upsert({
      id: 1,
      status: previousSuccess ? 'stale' : 'error',
      last_attempt: now,
      last_success: previousSuccess,
      error: err?.message || String(err),
      updated_at: now,
    });
  } catch {}
}

async function capture() {
  if (running) return memory;
  running = true;
  memory.lastAttempt = new Date().toISOString();
  try {
    const payload = await getPbApiSnapshot();
    memory.apiResponseSeenAt = new Date().toISOString();
    const flights = parsePbPayload(payload);
    await persist(flights);
    memory = {
      ...memory,
      status: 'live',
      lastSuccess: new Date().toISOString(),
      count: flights.length,
      error: null,
    };
    console.log(`[PB API] OK: ${flights.length} voos; mode=${memory.mode}`);
  } catch (err) {
    console.error('[PB API] Error:', err?.message || err);
    memory = { ...memory, status: memory.lastSuccess ? 'stale' : 'error', error: err?.message || String(err) };
    await setError(err);
  } finally {
    running = false;
  }
  return memory;
}

app.get('/health', (_req, res) => res.json(memory));
app.post('/refresh', async (_req, res) => res.json(await capture()));
app.get('/debug/pb', async (_req, res) => {
  try {
    const payload = await getPbApiSnapshot();
    const flights = parsePbPayload(payload);
    res.json({ count: flights.length, mode: memory.mode, sample: flights.slice(0, 12) });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`RIGFLOW PB API Collector v4 :${PORT} polling ${POLL_MS}ms`);
  console.log('Primary source: direct OutSystems ScreenDataSetGetVoosAeroportoCache POST');
});

await capture();
setInterval(capture, POLL_MS);

process.on('SIGTERM', async () => {
  try { await browser?.close(); } catch {}
  process.exit(0);
});
