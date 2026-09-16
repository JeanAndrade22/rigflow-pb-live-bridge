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
  version: '6.0.0',
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

async function collectRenderedRows(page) {
  await page.waitForFunction(() => {
    const text = document.body?.innerText || '';
    return /painel de voos/i.test(text) || /cia a[eé]rea/i.test(text) || /mod\. aeronave/i.test(text) || /hor[aá]rio/i.test(text);
  }, { timeout: 45000 }).catch(() => {});

  const collected = new Map();

  async function snapshot() {
    const blocks = await page.evaluate(() => {
      const out = [];
      const tables = [...document.querySelectorAll('table')];
      for (const table of tables) {
        const headers = [...table.querySelectorAll('thead th, tr:first-child th')].map((e) => (e.innerText || '').trim());
        const trs = [...table.querySelectorAll('tbody tr')];
        for (const tr of trs) {
          const cells = [...tr.querySelectorAll('td')].map((e) => (e.innerText || '').trim());
          if (cells.length) out.push({ headers, cells });
        }
      }

      if (!out.length) {
        const roleRows = [...document.querySelectorAll('[role="row"]')];
        let headers = [];
        for (const row of roleRows) {
          const headerCells = [...row.querySelectorAll('[role="columnheader"]')]
            .map((e) => (e.innerText || '').trim()).filter(Boolean);
          if (headerCells.length) {
            headers = headerCells;
            continue;
          }
          const cells = [...row.querySelectorAll('[role="cell"], .table-cell, .td')]
            .map((e) => (e.innerText || '').trim()).filter(Boolean);
          if (cells.length) out.push({ headers, cells });
        }
      }
      return out;
    });

    for (const block of blocks) {
      const row = mapRow(block.cells, block.headers || []);
      if (row) collected.set(row.flight, row);
    }
  }

  await snapshot();
  for (let i = 0; i < 24; i++) {
    const moved = await page.evaluate(() => {
      let changed = false;
      const candidates = [...document.querySelectorAll('*')].filter((el) => {
        const s = getComputedStyle(el);
        return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 40;
      });
      for (const el of candidates) {
        const before = el.scrollTop;
        el.scrollTop = Math.min(el.scrollTop + Math.max(450, el.clientHeight * 0.9), el.scrollHeight);
        if (el.scrollTop !== before) changed = true;
      }
      const beforeY = window.scrollY;
      window.scrollBy(0, Math.max(600, window.innerHeight * 0.9));
      if (window.scrollY !== beforeY) changed = true;
      return changed;
    });
    await page.waitForTimeout(300);
    await snapshot();
    if (!moved) break;
  }

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

  // Match the existing pb_flights schema. No updated_at column is used.
  const rows = flights.map((f) => ({
    ...f,
    active: true,
    last_seen_at: now,
  }));

  const result = await adaptiveUpsert('pb_flights', rows, { onConflict: 'source_key' });
  if (result.removed.length) console.warn('[PB VISIBLE] Ignored unavailable pb_flights columns:', result.removed.join(', '));

  // Deactivate only flights from today's visible schedule that were not seen in a healthy capture.
  // Older/future transferred flights are preserved and can be updated when they reappear.
  if (rows.length >= 10) {
    const { day, month, year } = brazilDateParts();
    const todayPrefix = `${day}/${month}/${year}`;
    const visibleKeys = new Set(rows.map((r) => r.source_key));

    const { data: activeToday, error: selectError } = await supabase
      .from('pb_flights')
      .select('source_key,date_time')
      .eq('active', true)
      .like('date_time', `${todayPrefix}%`);

    if (!selectError && Array.isArray(activeToday)) {
      const missing = activeToday.filter((r) => !visibleKeys.has(r.source_key)).map((r) => r.source_key);
      if (missing.length) {
        const { error: deactivateError } = await supabase
          .from('pb_flights')
          .update({ active: false, last_seen_at: now })
          .in('source_key', missing);
        if (deactivateError) console.warn('[PB VISIBLE] Could not deactivate missing rows:', deactivateError.message);
      }
    }
  }

  // Keep sync status updated, but adapt automatically if its schema differs.
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

app.listen(PORT, () => {
  console.log(`RIGFLOW PB Visual Collector v6 :${PORT} polling ${POLL_MS}ms`);
  console.log('Scope: reads only flights rendered in the PB panel. No internal API/session/token reproduction.');
});

await capture();
setInterval(capture, POLL_MS);

process.on('SIGTERM', async () => {
  try { await browser?.close(); } catch {}
  process.exit(0);
});
