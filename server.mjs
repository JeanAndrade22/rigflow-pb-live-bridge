import express from 'express';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const PORT = Number(process.env.PORT || 8787);
const POLL_MS = Math.max(30000, Number(process.env.POLL_MS || 30000));
const PB_URL = process.env.PB_URL || 'https://transporteaereo.petrobras.com.br/A18040_App/Generic?PageUrl=paineldevoos&MenuName=Painel%20de%20voos';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const app = express();
let browser;
let running = false;
let memory = {
  version: '8.0.0',
  status: 'starting',
  source: 'PB visible panel only',
  lastAttempt: null,
  lastSuccess: null,
  count: 0,
  error: null,
};

const clean = (v = '') => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = (v = '') => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const stableKey = (flight) => crypto.createHash('sha256').update(`PB|${clean(flight)}`).digest('hex');

function brazilDateParts() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { day: get('day'), month: get('month'), year: get('year') };
}

function normalizeDateTime(value) {
  const s = clean(value);
  if (!s) return '';

  // Keep the same text format already used by pb_flights: DD/MM/YYYY HH:mm:ss
  let m = s.match(/(\d{2})\/(\d{2})\/(\d{4}).*?(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${m[1]}/${m[2]}/${m[3]} ${String(m[4]).padStart(2, '0')}:${m[5]}:${m[6] || '00'}`;

  // Convert ISO-looking values to the existing table format without changing timezone semantics.
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}:${m[6] || '00'}`;

  // If the panel shows only a time, use today's date in Brazil.
  m = s.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
  if (m) {
    const { day, month, year } = brazilDateParts();
    return `${day}/${month}/${year} ${String(m[1]).padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
  }

  return s;
}

function findHeaderIndex(headers, patterns) {
  return headers.findIndex((h) => patterns.some((p) => h.includes(p)));
}

function mapRow(cells, headers) {
  if (!Array.isArray(cells) || cells.length < 4) return null;
  const hs = headers.map(norm);

  const idx = {
    time: findHeaderIndex(hs, ['horario', 'previsao', 'decolagem']),
    airport: findHeaderIndex(hs, ['aeroporto', 'origem']),
    destination: findHeaderIndex(hs, ['destino', 'rota']),
    flight: findHeaderIndex(hs, ['voo']),
    company: findHeaderIndex(hs, ['cia', 'empresa', 'operador']),
    model: findHeaderIndex(hs, ['mod. aeronave', 'modelo', 'aeronave']),
    status: findHeaderIndex(hs, ['status']),
    remarks: findHeaderIndex(hs, ['observacao', 'obs']),
    prefix: findHeaderIndex(hs, ['prefixo', 'matricula']),
    actual: findHeaderIndex(hs, ['real', 'hora real', 'decolagem real']),
    returnForecast: findHeaderIndex(hs, ['retorno', 'previsao retorno']),
  };

  const flightGuess = cells.findIndex((c) => /^\d{7,12}$/.test(clean(c)));
  const flightIdx = idx.flight >= 0 ? idx.flight : flightGuess;
  if (flightIdx < 0) return null;

  const flight = clean(cells[flightIdx]);
  if (!/^\d{7,12}$/.test(flight)) return null;

  const fallback = {
    time: 0,
    airport: 1,
    destination: 2,
    flight: flightIdx,
    company: flightIdx + 1,
    model: flightIdx + 2,
    status: flightIdx + 3,
    remarks: flightIdx + 4,
    prefix: -1,
    actual: -1,
    returnForecast: -1,
  };

  const at = (name) => {
    const i = idx[name] >= 0 ? idx[name] : fallback[name];
    return i >= 0 && i < cells.length ? clean(cells[i]) : '';
  };

  const row = {
    source_key: stableKey(flight),
    date_time: normalizeDateTime(at('time')),
    airport: at('airport'),
    destination: at('destination'),
    flight,
    company: at('company'),
    aircraft_model: at('model'),
    status: at('status'),
    remarks: at('remarks'),
    registration: at('prefix'),
    actual: at('actual'),
    return_forecast: at('returnForecast'),
  };

  row.raw = {
    flight: row.flight,
    company: row.company,
    aircraft_model: row.aircraft_model,
    status: row.status,
    remarks: row.remarks,
    registration: row.registration,
    airport: row.airport,
    destination: row.destination,
    date_time: row.date_time,
    actual: row.actual,
    return_forecast: row.return_forecast,
    source: 'PB visible panel',
  };

  return row;
}

async function ensureBrowser() {
  if (browser?.isConnected()) return;
  try { await browser?.close(); } catch {}
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

function rowQuality(row) {
  if (!row) return -1;
  let score = 0;
  const weighted = [
    ['date_time', 4], ['airport', 3], ['destination', 4], ['company', 2],
    ['aircraft_model', 2], ['status', 5], ['remarks', 2], ['registration', 3],
    ['actual', 1], ['return_forecast', 1],
  ];
  for (const [k, w] of weighted) if (clean(row[k])) score += w;
  // Real operational states are especially valuable and should beat sparse duplicates.
  if (/transfer|atras|check|acion|decol|pous|cancel|corte|embar/i.test(norm(row.status))) score += 3;
  return score;
}

function mergeRow(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const best = rowQuality(incoming) >= rowQuality(existing) ? { ...existing, ...incoming } : { ...incoming, ...existing };
  // Never replace a useful value with blank text from a poorer duplicate DOM representation.
  for (const k of ['date_time','airport','destination','company','aircraft_model','status','remarks','registration','actual','return_forecast']) {
    if (!clean(best[k])) best[k] = clean(incoming[k]) || clean(existing[k]) || '';
  }
  best.source_key = existing.source_key || incoming.source_key;
  best.flight = existing.flight || incoming.flight;
  best.raw = {
    ...(existing.raw || {}), ...(incoming.raw || {}),
    flight: best.flight,
    company: best.company,
    aircraft_model: best.aircraft_model,
    status: best.status,
    remarks: best.remarks,
    registration: best.registration,
    airport: best.airport,
    destination: best.destination,
    date_time: best.date_time,
    actual: best.actual,
    return_forecast: best.return_forecast,
    source: 'PB visible panel',
  };
  return best;
}

async function collectRenderedRows(page) {
  await page.waitForFunction(() => {
    const text = document.body?.innerText || '';
    return /painel de voos/i.test(text) || /cia a[eé]rea/i.test(text) || /mod\. aeronave/i.test(text) || /hor[aá]rio/i.test(text);
  }, { timeout: 45000 }).catch(() => {});

  const collected = new Map();
  let blockNo = 0;
  let noGrowthRounds = 0;

  async function snapshot(label = '') {
    const blocks = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const pushRow = (headers, cells) => {
        const cleaned = cells.map((v) => (v || '').trim());
        if (!cleaned.length) return;
        const sig = cleaned.join(' | ');
        if (seen.has(sig)) return;
        seen.add(sig);
        out.push({ headers, cells: cleaned });
      };

      for (const table of [...document.querySelectorAll('table')]) {
        const headers = [...table.querySelectorAll('thead th, tr:first-child th')]
          .map((e) => (e.innerText || '').trim());
        for (const tr of [...table.querySelectorAll('tbody tr')]) {
          pushRow(headers, [...tr.querySelectorAll('td')].map((e) => e.innerText || ''));
        }
      }

      // OutSystems / virtualized grid fallback.
      for (const grid of [...document.querySelectorAll('[role="grid"], [role="table"], .table, .osui-table')]) {
        let headers = [...grid.querySelectorAll('[role="columnheader"], thead th')]
          .map((e) => (e.innerText || '').trim()).filter(Boolean);
        for (const row of [...grid.querySelectorAll('[role="row"], tbody tr')]) {
          const cells = [...row.querySelectorAll('[role="cell"], td, .table-cell, .td')]
            .map((e) => (e.innerText || '').trim()).filter(Boolean);
          if (cells.length) pushRow(headers, cells);
        }
      }

      // Generic OutSystems fallback: always inspect compact containers containing a flight number.
      // This catches exceptional rows (Transferred/Cancelled/Delayed) that may be rendered outside the main table body.
      const nodes = [...document.querySelectorAll('div, li, section, article')];
      for (const el of nodes) {
        const txt = (el.innerText || '').trim();
        if (!/\b\d{7,12}\b/.test(txt)) continue;
        if (txt.length > 1800) continue;
        const children = [...el.children].map((c) => (c.innerText || '').trim()).filter(Boolean);
        if (children.length >= 4 && children.length <= 20) pushRow([], children);
      }
      return out;
    });

    const before = collected.size;
    for (const block of blocks) {
      const row = mapRow(block.cells, block.headers || []);
      if (row) collected.set(row.flight, mergeRow(collected.get(row.flight), row));
    }
    const added = collected.size - before;
    blockNo += 1;
    console.log(`[PB VISIBLE] scan ${blockNo}${label ? ` ${label}` : ''}: ${blocks.length} linhas, +${added} novos, total ${collected.size}`);
    return added;
  }

  async function findBestScroller() {
    return await page.evaluate(() => {
      const all = [...document.querySelectorAll('*')];
      const candidates = all.map((el, idx) => {
        const s = getComputedStyle(el);
        const scrollable = /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 80;
        if (!scrollable) return null;
        const text = (el.innerText || '').slice(0, 20000);
        const flightHits = (text.match(/\b\d{7,12}\b/g) || []).length;
        const tableish = el.querySelectorAll('table, [role="row"], tbody tr, .table-row').length;
        const score = flightHits * 5 + tableish * 2 + Math.min(20, Math.round(el.scrollHeight / Math.max(1, el.clientHeight)));
        return { idx, score, flightHits, tableish, h: el.scrollHeight, ch: el.clientHeight };
      }).filter(Boolean).sort((a,b) => b.score - a.score);
      if (!candidates.length) return null;
      const best = candidates[0];
      const el = all[best.idx];
      el.setAttribute('data-rigflow-scroller', '1');
      return best;
    });
  }

  await snapshot('initial');
  const scroller = await findBestScroller();
  if (scroller) console.log(`[PB VISIBLE] scroller detected: flights=${scroller.flightHits}, rows=${scroller.tableish}, height=${scroller.h}`);
  else console.log('[PB VISIBLE] no dedicated scroll container detected; using page scroll');

  // Reset to top before a complete pass.
  await page.evaluate(() => {
    const el = document.querySelector('[data-rigflow-scroller="1"]');
    if (el) el.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);
  await snapshot('top');

  // Walk the virtualized list until repeated scans stop discovering new flights.
  for (let i = 0; i < 80; i++) {
    const state = await page.evaluate(() => {
      const el = document.querySelector('[data-rigflow-scroller="1"]');
      if (el) {
        const before = el.scrollTop;
        const step = Math.max(220, Math.floor(el.clientHeight * 0.72));
        el.scrollTop = Math.min(el.scrollTop + step, el.scrollHeight - el.clientHeight);
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
        return { moved: el.scrollTop !== before, atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 4, top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
      }
      const before = window.scrollY;
      window.scrollBy(0, Math.max(350, Math.floor(window.innerHeight * 0.72)));
      return { moved: window.scrollY !== before, atEnd: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4, top: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight };
    });

    // Give OutSystems/virtual list time to recycle/render rows.
    await page.waitForTimeout(650);
    const added = await snapshot(`step=${i + 1}`);
    noGrowthRounds = added === 0 ? noGrowthRounds + 1 : 0;

    if (state.atEnd && noGrowthRounds >= 2) break;
    if (!state.moved && noGrowthRounds >= 2) break;
    if (noGrowthRounds >= 8) {
      // Some virtual lists report a huge/elastic scroll range; stop after repeated no-growth.
      console.log('[PB VISIBLE] stopping after repeated scans with no new flights');
      break;
    }
  }

  // Final bottom snapshot after a slightly longer wait for lazy rendering.
  await page.waitForTimeout(1200);
  await snapshot('final');
  console.log(`[PB VISIBLE] TOTAL: ${collected.size} voos únicos renderizados`);

  return [...collected.values()].sort((a, b) => String(a.date_time).localeCompare(String(b.date_time)));
}

async function readVisiblePanel() {
  await ensureBrowser();
  const context = await browser.newContext({
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  try {
    await page.goto(PB_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);

    let flights = await collectRenderedRows(page);
    if (!flights.length) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3500);
      flights = await collectRenderedRows(page);
    }
    if (!flights.length) throw new Error('Nenhum voo visível foi encontrado no painel PB renderizado');
    return flights;
  } finally {
    await context.close();
  }
}

function unknownColumnName(error) {
  const msg = error?.message || String(error || '');
  const m = msg.match(/Could not find the '([^']+)' column/i);
  return m?.[1] || null;
}

async function adaptiveUpsert(table, rows, options = {}) {
  let payload = Array.isArray(rows) ? rows.map((r) => ({ ...r })) : { ...rows };
  const removed = [];

  for (let attempt = 0; attempt < 12; attempt++) {
    const { error } = await supabase.from(table).upsert(payload, options);
    if (!error) return { removed };
    const col = unknownColumnName(error);
    if (!col) throw error;
    removed.push(col);
    if (Array.isArray(payload)) payload = payload.map((r) => { const x = { ...r }; delete x[col]; return x; });
    else { payload = { ...payload }; delete payload[col]; }
  }
  throw new Error(`Could not adapt ${table} payload to schema`);
}

async function persist(flights) {
  if (!flights.length) throw new Error('Zero visible flights; previous snapshot preserved');
  const now = new Date().toISOString();

  // Fetch current versions so blank/sparse visual rows never erase richer data captured earlier.
  const keys = flights.map((f) => f.source_key);
  const existingByKey = new Map();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const { data, error } = await supabase.from('pb_flights').select('*').in('source_key', chunk);
    if (error) throw error;
    for (const row of data || []) existingByKey.set(row.source_key, row);
  }

  const rows = flights.map((f) => {
    const old = existingByKey.get(f.source_key) || {};
    const merged = { ...old, ...f };
    for (const k of ['date_time','airport','destination','company','aircraft_model','status','remarks','registration','actual','return_forecast']) {
      if (!clean(f[k]) && clean(old[k])) merged[k] = old[k];
    }
    merged.active = true;
    merged.last_seen_at = now;
    merged.source_key = f.source_key;
    merged.flight = f.flight;
    merged.raw = { ...(old.raw || {}), ...(f.raw || {}), captured_at: now };
    // Do not send DB-generated/id fields back unless required.
    delete merged.id;
    return merged;
  });

  const result = await adaptiveUpsert('pb_flights', rows, { onConflict: 'source_key' });
  if (result.removed.length) console.warn('[PB VISIBLE] Ignored unavailable pb_flights columns:', result.removed.join(', '));

  // IMPORTANT: visual/virtualized lists can temporarily omit rows. V8 never deactivates a flight
  // simply because it was absent from one visual scan. This prevents transferred/delayed/cancelled
  // flights from disappearing from RIGFLOW. Frontend date/status filters decide what is shown.

  const syncPayload = {
    id: 1,
    status: 'live',
    last_attempt: now,
    last_success: now,
    row_count: rows.length,
    error: null,
    updated_at: now,
  };
  try {
    const syncResult = await adaptiveUpsert('pb_sync_status', syncPayload);
    if (syncResult.removed.length) console.warn('[PB VISIBLE] Ignored unavailable pb_sync_status columns:', syncResult.removed.join(', '));
  } catch (e) {
    console.warn('[PB VISIBLE] Sync status warning:', e?.message || e);
  }
}

async function setError(err) {
  const now = new Date().toISOString();
  let previousSuccess = memory.lastSuccess;
  try {
    const { data } = await supabase.from('pb_sync_status').select('last_success').eq('id', 1).maybeSingle();
    previousSuccess = data?.last_success || previousSuccess;
  } catch {}

  try {
    await adaptiveUpsert('pb_sync_status', {
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
    const flights = await readVisiblePanel();
    await persist(flights);
    memory = {
      ...memory,
      status: 'live',
      source: 'PB visible panel only',
      lastSuccess: new Date().toISOString(),
      count: flights.length,
      error: null,
    };
    console.log(`[PB VISIBLE] OK: ${flights.length} voos renderizados e sincronizados`);
  } catch (err) {
    console.error('[PB VISIBLE] Error:', err?.message || err);
    memory = { ...memory, status: memory.lastSuccess ? 'stale' : 'error', error: err?.message || String(err) };
    await setError(err);
  } finally {
    running = false;
  }
  return memory;
}

app.get('/health', (_req, res) => res.json(memory));
app.post('/refresh', async (_req, res) => res.json(await capture()));
app.get('/debug/visible', async (_req, res) => {
  try {
    const flights = await readVisiblePanel();
    res.json({ source: 'PB visible panel only', count: flights.length, sample: flights.slice(0, 20) });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get('/debug/flight/:flight', async (req, res) => {
  try {
    const wanted = clean(req.params.flight);
    const flights = await readVisiblePanel();
    const visible = flights.find((f) => f.flight === wanted) || null;
    const { data: stored, error } = await supabase.from('pb_flights').select('*').eq('flight', wanted).order('last_seen_at', { ascending: false }).limit(5);
    if (error) throw error;
    res.json({ flight: wanted, visible, stored: stored || [] });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`RIGFLOW PB Visual Collector v8 :${PORT} polling ${POLL_MS}ms`);
  console.log('Scope: reads only flights rendered in the PB panel. No internal API/session/token reproduction.');
});

await capture();
setInterval(capture, POLL_MS);

process.on('SIGTERM', async () => {
  try { await browser?.close(); } catch {}
  process.exit(0);
});
