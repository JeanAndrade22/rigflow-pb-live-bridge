# RIGFLOW PB Visual Collector v11

V11 keeps the visual-only PB collection approach and fixes operator/registration recovery from virtualized DOM layouts.

## Changes
- Adds flight-centric DOM context capture around each visible flight number.
- Recovers company/operator, aircraft model and registration from compact ancestors and neighboring DOM nodes when the table splits those fields.
- Never fabricates a company from an aircraft model. If no operator is actually present in the visible DOM context, company stays blank so a richer stored value can survive.
- Keeps V9/V10 logical-flight consolidation, reprogramming history and canonical source keys.
- Adds `/debug/dom/:flight` to show exactly what the browser can see around one flight, making the parser verifiable instead of guess-based.
- `/debug/flight/:flight` continues to expose logical row, timeline and schedules.

## Safety scope
Reads only data rendered by the normal PB flight panel. No internal API, copied session, cookie, token, or authentication bypass.
