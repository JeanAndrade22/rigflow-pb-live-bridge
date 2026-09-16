# RIGFLOW PB Visual Collector v9

This version keeps the visual-only collection approach and fixes logical-flight consolidation.

## What V9 changes
- One canonical `pb_flights` row per flight number (`source_key = SHA256("PB|<flight>")`).
- Existing duplicate rows for a visible flight are merged only after the canonical row is successfully written.
- Historical schedule/status snapshots are preserved in `raw.history` before duplicates are deleted.
- `raw.original_schedule`, `raw.current_schedule`, `raw.reprogrammed`, and `raw.previous_schedules` support transferred/reprogrammed flights.
- Sparse DOM captures never erase richer stored values.
- Missing rows in a visual scan are not automatically deactivated.
- `/debug/flight/:flight` returns the logical row plus timeline and schedule history.
- `/` now returns service status instead of `Cannot GET /`.

## Safety scope
Reads only flight data rendered in the normal PB panel. No internal API, copied session, cookie, token, or authentication bypass.

## Verification performed before packaging
- `node --check server.mjs` passed.
- A regression fixture for flight `509571378` verified consolidation of `16/09 10:33`, `16/09 13:33`, and reprogrammed `17/09 06:48`, preserving `10:33` as the original schedule.
- Package contents and ZIP integrity were checked.

## After deploy
Open:
`https://<render-host>/debug/flight/509571378`

Expected after the first successful sync:
- one canonical logical row for the flight,
- `original_schedule: 16/09/2026 10:33:00`,
- `current_schedule: 17/09/2026 06:48:00` (if still shown by PB),
- `reprogrammed: true`,
- timeline/history containing the preserved schedule snapshots.
