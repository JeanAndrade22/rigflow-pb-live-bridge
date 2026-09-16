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
  version: '10.0.0',
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


function looksLikeAircraftModel(value) {
  const s = clean(value).toUpperCase();
  return /^(?:AW[- ]?\d{3}|H\d{3}|S[- ]?92A?|ATR[- ]?\d{2,3}(?:[- ]?\d{3})?|EC\d{3}|AS\d{3}|B\d{3}|BELL[- ]?\d{3}|SK\d{2,3})$/.test(s);
}

function looksLikeRegistration(value) {
  const s = clean(value).toUpperCase();
  return /^(?:P[PRSTU]|PT|PS|PP|PR|PU)-?[A-Z0-9]{3,5}$/.test(s);
}

function looksLikeStatus(value) {
  const s = norm(value);
  return [
    'previsto','transferido','atrasado','cancelado','cancelada','decolagem','decolado','pousado',
    'check-in aberto','check in aberto','check-in concluido','check in concluido','embarque','acionamento',
    'em voo','concluido','fechado'
  ].some((x) => s.includes(x));
}

function inferCompany(cells, model, registration, status) {
  const known = [
    'omni','chc','lider','lider aviacao','bristow','aeroleo','aeróleo','azul linhas aereas','azul linhas aéreas',
    'saint','aerorio','helicidade','embraer'
  ];
  const excluded = new Set([clean(model), clean(registration), clean(status)]);
  for (const c of cells.map(clean)) {
    if (!c || excluded.has(c)) continue;
    const n = norm(c);
    if (known.some((k) => n === norm(k) || n.includes(norm(k)))) return c;
  }
  return '';
}

function normalizeIdentityFields(row, cells = []) {
  let company = clean(row.company);
  let model = clean(row.aircraft_model);
  let registration = clean(row.registration);
  let status = clean(row.status);

  // Recover fields from generic/virtualized DOM blocks when the positional fallback is shifted.
  if (!model || !looksLikeAircraftModel(model)) {
    const hit = cells.map(clean).find(looksLikeAircraftModel);
    if (hit) model = hit;
  }
  if (!registration || !looksLikeRegistration(registration)) {
    const hit = cells.map(clean).find(looksLikeRegistration);
    if (hit) registration = hit;
  }
  if (!status || !looksLikeStatus(status)) {
    const hit = cells.map(clean).find(looksLikeStatus);
    if (hit) status = hit;
  }

  // A common virtual-grid failure was company=H175 while aircraft_model=H175.
  // Never allow an aircraft model or registration to overwrite the operator/company.
  if (looksLikeAircraftModel(company) || looksLikeRegistration(company) || looksLikeStatus(company)) company = '';
  if (!company) company = inferCompany(cells, model, registration, status);

  // If the model column accidentally captured an operator and company captured a model, swap safely.
  if (looksLikeAircraftModel(company) && !looksLikeAircraftModel(model)) {
    const tmp = model; model = company; company = tmp;
  }

  return { ...row, company, aircraft_model: model, registration, status };
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

  let row = {
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

  row = normalizeIdentityFields(row, cells);

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

function eventFromRow(row, seenAt = null) {
  if (!row) return null;
  const event = {
    date_time: clean(row.date_time),
    status: clean(row.status),
    airport: clean(row.airport),
    destination: clean(row.destination),
    company: clean(row.company),
    aircraft_model: clean(row.aircraft_model),
    registration: clean(row.registration),
    remarks: clean(row.remarks),
    actual: clean(row.actual),
    return_forecast: clean(row.return_forecast),
    seen_at: seenAt || row.last_seen_at || row.first_seen_at || null,
  };
  if (!event.date_time && !event.status && !event.actual && !event.remarks) return null;
  return event;
}

function eventSignature(e) {
  return [e.date_time, norm(e.status), e.actual, e.return_forecast, norm(e.remarks), e.registration].join('|');
}

function parseBrazilSchedule(value) {
  const m = clean(value).match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return Number.POSITIVE_INFINITY;
  return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function buildHistory(existingRows, incoming) {
  const candidates = [];
  for (const row of existingRows || []) {
    const oldHistory = Array.isArray(row?.raw?.history) ? row.raw.history : [];
    for (const e of oldHistory) if (e && typeof e === 'object') candidates.push({ ...e });
    const ev = eventFromRow(row);
    if (ev) candidates.push(ev);
  }
  const incomingEvent = eventFromRow(incoming, new Date().toISOString());
  if (incomingEvent) candidates.push(incomingEvent);

  const dedup = new Map();
  for (const e of candidates) {
    const sig = eventSignature(e);
    const prev = dedup.get(sig);
    if (!prev || String(e.seen_at || '') > String(prev.seen_at || '')) dedup.set(sig, e);
  }
  return [...dedup.values()].sort((a, b) => {
    const da = parseBrazilSchedule(a.date_time);
    const db = parseBrazilSchedule(b.date_time);
    if (da !== db) return da - db;
    return String(a.seen_at || '').localeCompare(String(b.seen_at || ''));
  });
}

function chooseRichest(rows) {
  return [...(rows || [])].sort((a, b) => rowQuality(b) - rowQuality(a))[0] || {};
}

async function persist(flights) {
  if (!flights.length) throw new Error('Zero visible flights; previous snapshot preserved');
  const now = new Date().toISOString();

  // Fetch every stored occurrence for each visible flight number. Historical versions used
  // schedule-dependent source keys, which created duplicate rows after transfers/reprogramming.
  const flightNumbers = [...new Set(flights.map((f) => clean(f.flight)).filter(Boolean))];
  const existingByFlight = new Map();
  for (let i = 0; i < flightNumbers.length; i += 100) {
    const chunk = flightNumbers.slice(i, i + 100);
    const { data, error } = await supabase.from('pb_flights').select('*').in('flight', chunk);
    if (error) throw error;
    for (const row of data || []) {
      const key = clean(row.flight);
      if (!existingByFlight.has(key)) existingByFlight.set(key, []);
      existingByFlight.get(key).push(row);
    }
  }

  const rows = [];
  const duplicateIdsByFlight = new Map();

  for (const f of flights) {
    const previous = existingByFlight.get(f.flight) || [];
    const canonicalKey = stableKey(f.flight);
    const canonicalOld = previous.find((r) => r.source_key === canonicalKey) || null;
    const richestOld = chooseRichest(previous);
    const base = { ...richestOld, ...(canonicalOld || {}) };

    // Prefer the current visible state, but do not let a sparse DOM row erase richer metadata.
    const incoming = normalizeIdentityFields({ ...f }, []);
    const merged = { ...base, ...incoming };
    for (const k of ['date_time','airport','destination','company','aircraft_model','status','remarks','registration','actual','return_forecast']) {
      if (!clean(incoming[k]) && clean(base[k])) merged[k] = base[k];
    }
    // Last guardrail: a model-shaped value can never replace a known operator/company.
    if (looksLikeAircraftModel(merged.company) && clean(base.company) && !looksLikeAircraftModel(base.company)) {
      merged.company = base.company;
    }

    const history = buildHistory(previous, merged);
    const schedules = history.filter((e) => clean(e.date_time));
    const original = schedules[0] || null;
    const currentSchedule = clean(merged.date_time) || (schedules.at(-1)?.date_time || '');
    const reprogrammed = Boolean(original?.date_time && currentSchedule && original.date_time !== currentSchedule);

    const firstSeenCandidates = previous.map((r) => r.first_seen_at).filter(Boolean).sort();
    merged.source_key = canonicalKey;
    merged.flight = f.flight;
    merged.active = true;
    merged.first_seen_at = firstSeenCandidates[0] || now;
    merged.last_seen_at = now;
    merged.raw = {
      ...(richestOld.raw || {}),
      ...(canonicalOld?.raw || {}),
      ...(f.raw || {}),
      flight: f.flight,
      captured_at: now,
      history,
      original_schedule: original?.date_time || currentSchedule || '',
      current_schedule: currentSchedule,
      reprogrammed,
      previous_schedules: [...new Set(schedules.map((e) => e.date_time).filter((d) => d && d !== currentSchedule))],
      logical_flight_key: canonicalKey,
      source: 'PB visible panel',
    };
    delete merged.id;
    rows.push(merged);

    const dupIds = previous.filter((r) => r.source_key !== canonicalKey && r.id).map((r) => r.id);
    if (dupIds.length) duplicateIdsByFlight.set(f.flight, dupIds);
  }

  const result = await adaptiveUpsert('pb_flights', rows, { onConflict: 'source_key' });
  if (result.removed.length) console.warn('[PB VISIBLE] Ignored unavailable pb_flights columns:', result.removed.join(', '));

  // Consolidate only after the canonical logical-flight row has been written successfully.
  // History from the old duplicates is already embedded in raw.history before deletion.
  let removedDuplicates = 0;
  for (const [flight, ids] of duplicateIdsByFlight) {
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const { error } = await supabase.from('pb_flights').delete().in('id', chunk);
      if (error) throw new Error(`Duplicate cleanup failed for flight ${flight}: ${error.message}`);
      removedDuplicates += chunk.length;
    }
  }
  if (removedDuplicates) console.log(`[PB VISIBLE] Consolidated ${removedDuplicates} duplicate rows into logical flights; history preserved in raw.history`);

  // IMPORTANT: visual/virtualized lists can temporarily omit rows. Never deactivate a flight
  // simply because it was absent from one visual scan. Date/status filters decide visibility.

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

app.get('/', (_req, res) => res.json({ service: 'RIGFLOW PB Visual Collector', ...memory, endpoints: ['/health','/debug/visible','/debug/flight/:flight'] }));
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
    const { data: stored, error } = await supabase.from('pb_flights').select('*').eq('flight', wanted).order('last_seen_at', { ascending: false }).limit(20);
    if (error) throw error;
    const logical = (stored || []).find((r) => r.source_key === stableKey(wanted)) || (stored || [])[0] || null;
    res.json({
      flight: wanted,
      visible,
      logical,
      timeline: logical?.raw?.history || [],
      original_schedule: logical?.raw?.original_schedule || null,
      current_schedule: logical?.raw?.current_schedule || null,
      reprogrammed: Boolean(logical?.raw?.reprogrammed),
      stored_rows: stored || [],
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`RIGFLOW PB Visual Collector v10 :${PORT} polling ${POLL_MS}ms`);
  console.log('Scope: reads only flights rendered in the PB panel. No internal API/session/token reproduction.');
});

await capture();
setInterval(capture, POLL_MS);

process.on('SIGTERM', async () => {
  try { await browser?.close(); } catch {}
  process.exit(0);
});
