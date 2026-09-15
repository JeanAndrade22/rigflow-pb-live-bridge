RIGFLOW - PB LIVE COLLECTOR

Este pacote NAO vai para Netlify nem para Supabase Edge Functions.
Ele precisa rodar em um servico com Chromium/Playwright, como Render.

Contem:
- Dockerfile
- package.json
- render.yaml
- server.mjs

Variaveis necessarias no servidor:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY

Funcao:
Painel PB -> navegador automatizado -> dados da tabela -> Supabase
Atualizacao prevista: 30 segundos.
