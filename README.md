# RIGFLOW PB API Collector v3

This version no longer scrapes the rendered flight table. It opens the official PB flight panel with Playwright, captures the OutSystems `ScreenDataSetGetVoosAeroporto` XHR response, parses `VoosAeroporto_Cache.XML`, and writes the current snapshot to Supabase.

## Why this fixes the stale-status problem

The PB response itself contains `NumeroVoo`, `PrefixoAeronave`, `ModeloAeronave`, `Rota`, `StatusVoo`, `HorarioOriginal`, `PrevisaoDecolagem`, `PrevisaoRetorno`, `NomeAeroporto`, `NomeEmpresa`, and `Observacao`.

The key is now stable by PB flight number, so if the same flight is moved to tomorrow or changes from `Previsto` to `CheckIn Aberto`, the existing row is updated instead of creating a second stale copy.

## Render environment variables

Keep the same values already configured:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- optional `POLL_MS=30000`

## Deploy

Replace these files in the existing `rigflow-pb-live-bridge` GitHub repository and commit to `main`:
- `server.mjs`
- `package.json`
- `Dockerfile`
- `render.yaml`

Render Auto-Deploy should rebuild automatically.

## Test

After deploy, open:
- `/health`
- `/debug/pb`

`/debug/pb` should return a fresh count and a sample with live PB statuses.

## Important

The code expects the existing `pb_flights` columns used by the previous collector, including `active`, `last_seen_at`, and `updated_at`.
