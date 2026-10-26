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
5. Env vars obrigatórias: `NODE_ENV=production`, `APP_VERSION`, `LOG_LEVEL=info`, `CORS_ORIGIN`, `DATABASE_URL`, `REDIS_URL`.
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

## Rotação de chaves JWT (E2)

Documentar aqui quando implementado.

## Incidentes

- **API fora**: verificar dashboard Render; ver logs; confirmar Neon e Upstash operacionais.
- **Cold start prolongado**: verificar cron-job.org; confirmar que `/health` responde em < 1s quando acordado.
- **Rate limit a disparar em produção**: confirmar Upstash `@upstash/ratelimit` (E2).

## Trust proxy

Em produção no Render, `TRUST_PROXY=true` **é obrigatório** — sem isto, `request.ip`
é sempre `127.0.0.1` e o rate limit por IP torna-se num rate limit global,
bloqueando todos os utilizadores após 5 logins falhados.

O servidor detecta automaticamente `RENDER=true` e liga trust proxy = 1 hop.
Fora do Render (Fly, VPS, etc.), definir `TRUST_PROXY=true` explicitamente.