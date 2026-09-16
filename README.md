# RIGFLOW PB Visual Collector v5

This version intentionally reads only the flights visibly rendered in the Petrobras flight panel.

It does **not** call internal OutSystems screen-service endpoints directly, copy cookies, reuse browser tokens, or reproduce protected sessions.

## What it does
- Opens the normal PB flight panel in Playwright.
- Waits for the visible table/list to render.
- Reads visible rows (including lazy/virtualized rows reached by normal scrolling).
- Extracts time, airport, destination/route, flight number, company, aircraft model, status and observation when present.
- Upserts the current visible snapshot into Supabase every 30 seconds while the Render service is awake.
- Keeps `source_key` stable by flight number so status/time changes update the same flight row.

## Endpoints
- `GET /health` collector status
- `POST /refresh` force one visual refresh
- `GET /debug/visible` inspect a sample of currently visible rows

## Important note about Render Free
Render Free web services can sleep when idle. The 30-second poll only runs while the service is awake. For truly continuous updates, keep the service awake through an approved always-on plan or an approved periodic wake mechanism.
