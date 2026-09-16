# RIGFLOW PB API Collector v4

v4 posts directly to the public OutSystems `ScreenDataSetGetVoosAeroportoCache` screen-service endpoint using the request payload captured from the PB flight panel. Playwright remains only as a fallback.

Expected successful log:

`[PB API] OK: <count> voos; mode=direct`

Endpoints:
- `/health`
- `/debug/pb`
- `POST /refresh`

Keep the existing Render environment variables:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- optional `POLL_MS=30000`

If PB changes the OutSystems module/API version, `/health` and logs will say that the payload needs refresh.
