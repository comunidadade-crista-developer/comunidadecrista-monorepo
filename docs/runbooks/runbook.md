# Runbook — Comunidade Cristã

## Ambientes

- **Local**: docker-compose (Postgres 16 + Redis 7) + `pnpm dev`
- **Produção**: Cloudflare Pages (web) + Render free (API) + Neon (Postgres) + Upstash (Redis)

## Deploy

### Backend (Render)

1. Render → **New → Web Service** → conectar repositório GitHub.
2. Runtime: Node 24.
3. Build command: `pnpm install --frozen-lockfile && pnpm --filter @comunidade/api build`
4. Start command: `node apps/api/dist/index.js`
5. Env vars obrigatórias: `NODE_ENV=production`, `APP_VERSION`, `LOG_LEVEL=info`, `CORS_ORIGIN`, `DATABASE_URL`, `REDIS_URL`, `JWT_PRIVATE_JWK`, `JWT_PUBLIC_JWK`, `IP_HASH_SECRET`; com Cloudflare, também `EDGE_MODE=cloudflare` e `CF_ORIGIN_SECRET` (ver "IP do cliente, proxy e Cloudflare").
   Opcionais: `JWT_PUBLIC_JWK_PREVIOUS` (só durante uma rotação), `ACCOUNT_DELETION_GRACE_DAYS` (30), `MAINTENANCE_INTERVAL_MINUTES` (60), `DB_POOL_MAX` e `DB_QUERY_TIMEOUT_MS`.
   Neon: definir os timeouts ao nível do role (`ALTER ROLE <role> SET statement_timeout='10s'; ALTER ROLE <role> SET idle_in_transaction_session_timeout='15s';`), não por parâmetros de ligação (o pooler não os aceita).
6. Plano: Free.

### Frontend (Cloudflare Pages)

1. Pages → **Create project** → conectar repositório.
2. Build command: `pnpm install --frozen-lockfile && pnpm --filter @comunidade/web build`
3. Build output directory: `apps/web/dist`
4. Env vars: `NODE_VERSION=24`.

### Cron de cold start

1. cron-job.org → novo job HTTP GET em `https://<api>.onrender.com/health`.
2. Intervalo: **14 minutos**.
3. Janela activa: **06:00–23:00** (timezone Europe/Lisbon).
4. Não usar `/health/deep` (acordaria Neon e Upstash desnecessariamente).

## Rotação de chaves JWT

Os tokens levam `kid` (thumbprint da chave pública). A API assina com a chave actual e verifica com a
actual e, durante a rotação, também com `JWT_PUBLIC_JWK_PREVIOUS` (só a parte **pública** da chave antiga).
Tempo de vida máximo dos tokens: access 15 min, sessão de recuperação 5 min. Os refresh tokens são opacos
(não dependem da chave).

### Rotação normal (planeada, sem downtime)

1. Gerar um par novo: `pnpm --filter @comunidade/api generate-jwt-keys`.
2. Guardar a pública da chave **actual** (`JWT_PUBLIC_JWK` de hoje) para a usar como anterior.
3. Render → Environment:
   - `JWT_PUBLIC_JWK_PREVIOUS=<pública antiga>`
   - `JWT_PRIVATE_JWK` e `JWT_PUBLIC_JWK` = par novo
     e fazer redeploy. No arranque a API recusa chaves incoerentes (par que não corresponde, pública com
     parte privada, anterior igual à actual): ver os logs de arranque se o deploy falhar.
4. Verificar: login funciona e uma sessão aberta antes do deploy continua válida.
5. Passados **mais de 15 minutos**, remover `JWT_PUBLIC_JWK_PREVIOUS` e fazer redeploy.
6. Apagar a chave privada antiga de onde estiver guardada.

### Compromisso da chave privada (emergência)

Igual, mas **sem** `JWT_PUBLIC_JWK_PREVIOUS`: todos os access tokens e sessões de recuperação antigos
ficam inválidos de imediato. Os clientes renovam a sessão pelo refresh token; se também houver suspeita
de roubo de refresh tokens, revogar todas as sessões na base de dados (`refresh_tokens.revoked_at`).
Rodar também `IP_HASH_SECRET`/`CF_ORIGIN_SECRET` se a plataforma esteve comprometida.

### Boas práticas

- Rodar as chaves de forma planeada (por exemplo, uma vez por ano) para manter o procedimento ensaiado.
- Nunca colocar a chave privada no repositório, em logs, tickets ou chats.

## Incidentes

- **API fora**: verificar dashboard Render; ver logs; confirmar Neon e Upstash operacionais.
- **Cold start prolongado**: verificar cron-job.org; confirmar que `/health` responde em < 1s quando acordado.
- **Rate limit a disparar em produção**: confirmar o Redis (Upstash) acessível; sem Redis o limite aplica-se em memória, por instância.

## IP do cliente, proxy e Cloudflare

A API **nunca** guarda nem regista IPs. O IP só existe em memória, durante o pedido, para o
rate limit; nas chaves do Redis entra apenas um HMAC truncado (`IP_HASH_SECRET`).

O IP do cliente é resolvido em `request.clientIp` (`src/net/edge.ts`). Usar sempre este campo,
nunca `request.ip` nem `X-Forwarded-For`.

### Modos

| Cenário                                        | Configuração                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Dev local                                      | `EDGE_MODE=none`, `TRUST_PROXY=false` → `clientIp` = IP da ligação                    |
| Produção com Cloudflare à frente (recomendado) | `EDGE_MODE=cloudflare`, `CF_ORIGIN_SECRET`, `IP_HASH_SECRET`; `TRUST_PROXY` desligado |
| Outro proxy (VPS, Fly) sem Cloudflare          | `EDGE_MODE=none`, `TRUST_PROXY=true`, `TRUST_PROXY_HOPS=<n>`                          |

A cadeia de proxies do Render não está documentada (o número de saltos pode mudar), por isso a
detecção automática de `RENDER=true` foi removida. Com Cloudflare, o IP vem de
`CF-Connecting-IP`, aceite **só** se o pedido trouxer o segredo `X-Origin-Auth`.

### Preparar a Cloudflare (por ordem)

1. **DNS**: adicionar o domínio à Cloudflare (nameservers). Remover registos `AAAA` do host da API
   (o Render não suporta IPv6).
2. **Render → Custom Domains**: adicionar `api.<dominio>`. Na Cloudflare, criar `CNAME api →
<servico>.onrender.com` com **DNS only** (nuvem cinzenta) e esperar o certificado ficar
   _Verified/Issued_ no Render.
3. **SSL/TLS → Overview**: modo **Full (strict)**. O guia do Render indica _Full_; (strict)
   deve funcionar porque o certificado do Render é público — se falhar, voltar a _Full_.
4. Passar o CNAME a **Proxied** (nuvem laranja).
5. **Segredo de origem**: gerar com `openssl rand -base64 48`. Cloudflare → _Rules → Transform
   Rules → Modify Request Header_ → regra para `hostname equals api.<dominio>`:
   _Set static_ `X-Origin-Auth` = o segredo.
6. **Render → Environment**: `EDGE_MODE=cloudflare`, `CF_ORIGIN_SECRET=<segredo>`,
   `IP_HASH_SECRET=<outro segredo, openssl rand -base64 48>`, `CORS_ORIGIN=<dominio do frontend>`.
7. **Verificar** (ver abaixo) antes de apontar o frontend para a API.
8. **cron-job.org**: passar a chamar `https://api.<dominio>/health` (via Cloudflare).
   `/health` responde também sem segredo, para o health check do Render.
9. **Definições recomendadas na Cloudflare**:
   - SSL/TLS → Edge Certificates: _Always Use HTTPS_, TLS mínimo 1.2.
   - Rules → Cache Rules: _Bypass cache_ para `api.<dominio>` (a API também envia `no-store`).
   - Security → WAF → Rate limiting: 1 regra (plano gratuito) para `/auth/*`, como camada
     extra antes de chegar ao Render.
   - Security → Bots → _Bot Fight Mode_ ligado.
   - Desligar _Web Analytics_ / _Browser Insights_ (privacidade).

### Verificação

```bash
# 1) Directo ao Render (sem passar pela Cloudflare): tudo 403 excepto /health
curl -i https://<servico>.onrender.com/auth/me      # esperado: 403 {"error":"forbidden"}
curl -i https://<servico>.onrender.com/health       # esperado: 200

# 2) Via Cloudflare: passa
curl -i https://api.<dominio>/health                # esperado: 200
curl -i https://api.<dominio>/auth/me               # esperado: 401 (sem token), não 403
```

Se o passo 2 der 403, a Transform Rule não está a injectar `X-Origin-Auth`.

### Rotação do segredo de origem (sem downtime)

1. Render: `CF_ORIGIN_SECRET_PREVIOUS=<segredo actual>` e `CF_ORIGIN_SECRET=<novo>`; redeploy.
2. Cloudflare: actualizar o valor da Transform Rule para o novo segredo.
3. Confirmar que o tráfego normal funciona; depois remover `CF_ORIGIN_SECRET_PREVIOUS`.

### Privacidade — o que a Cloudflare e o Render vêem

Cloudflare e Render processam IPs nos seus próprios sistemas, fora do nosso controlo. A
política de privacidade deve dizê-lo; "não guardamos IP" refere-se à nossa base de dados,
aos nossos logs e ao nosso Redis.
