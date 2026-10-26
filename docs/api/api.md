# API — Comunidade Cristã

Base: `/api/v1`
Formato: JSON
Autenticação: Bearer JWT (a partir de E2)

## Health

### GET /health

Leve. Não toca em base de dados nem Redis. Usado por cron-job.org.

**200**

```json
{ "status": "ok", "version": "0.1.0", "timestamp": "2025-01-01T00:00:00.000Z" }
```

### GET /health/deep

Toca em Postgres e Redis. Uso em CI e monitorização manual.

_**200**_

```json
{
  "status": "ok",
  "version": "0.1.0",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "checks": { "db": "ok", "redis": "ok" }
}
```
