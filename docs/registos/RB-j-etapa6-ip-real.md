# RB-j — Etapa 6: IP real atrás do Render

- **Problema.** Com `TRUST_PROXY_HOPS=1` o limite por IP não era por cliente: a API via o IP da borda do
  Cloudflare do Render. As tentativas de um cliente repartiam-se por várias bordas (o 6.º login não dava `429`)
  e um cliente de outra rede levava `429` por tentativas alheias.
- **Teste** (2026-11-25, `onrender.com`): com `2` a rede A continuou sem `429`; com **`3`** a rede A deu `401` ×5
  e `429` à sexta, a rede B (dados móveis) deu `401` e um `X-Forwarded-For: 1.2.3.4` forjado manteve o `429`.
  Um primeiro teste usou Wi-Fi e cabo do mesmo router, que partilham o IP público: não valia como duas redes.
- **Decisão.** `TRUST_PROXY=true`, `EDGE_MODE=none`, **`TRUST_PROXY_HOPS=3`**, `CORS_ORIGIN=http://localhost:5173`
  (sem frontend). Logs de arranque sem aviso de proxy nem erros.
- **Risco.** O número de saltos depende da infra-estrutura do Render. Repetir o teste se a plataforma mudar, ao
  acrescentar domínio ou Cloudflare (`EDGE_MODE=cloudflare`) e se o limite parecer global.

**Pendente**: o aviso do `pg` sobre `sslmode` (tratado como `verify-full`, o comportamento mais estrito) aparece
em cada arranque. Tornar explícito `sslmode=verify-full` na `DATABASE_URL` silencia-o sem mudar o
comportamento; por validar na Neon antes de alterar o segredo.
