# API — Comunidade Cristã

Base: raiz do host da API (por exemplo `https://api.<dominio>/gospel-cards`). Ainda não há prefixo
`/api/v1`; se vier a existir, será um registo próprio.
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

## Gospel cards (conteúdo público)

Sem autenticação. Limite por IP: `RATE_LIMIT_CARDS_MAX` pedidos por `RATE_LIMIT_CARDS_WINDOW_S`
(por omissão 120 por 60 s), partilhado entre a lista e o detalhe. Acima disso: `429`.

**Cache HTTP.** As respostas `200` levam
`Cache-Control: public, max-age=300, stale-while-revalidate=86400` e `ETag` (fraco). Com
`If-None-Match` igual a API responde `304` sem corpo. Lista vazia (seed por correr) e **todos** os
erros levam `Cache-Control: no-store`. Depois de um seed, os clientes podem ver o conteúdo antigo
até 5 minutos (browser) e as instâncias da API até 1 minuto (versão da cache).

### GET /gospel-cards

Lista completa, ordenada por `orderIndex` (no máximo 200 cards; sem paginação).

**200**

```json
{
  "cards": [
    {
      "slug": "o-nascimento-de-jesus",
      "title": "O Nascimento de Jesus",
      "gospelReference": "Mateus 2",
      "summary": "…",
      "otReferences": ["Isaías 7:14"],
      "ntReferences": ["Mateus 2:1-12"],
      "orderIndex": 1
    }
  ]
}
```

**304** (`If-None-Match` igual ao `ETag`), **429** `{ "error": "rate_limited" }` com `Retry-After`.

### GET /gospel-cards/:slug

`slug`: `[a-z0-9-]`, 1–100 caracteres.

**200** `{ "card": { …campos acima } }` · **304** · **400** `{ "error": "validation_error", "fields": { "slug": "slug inválido" } }`
· **404** `{ "error": "not_found" }` · **429** `{ "error": "rate_limited" }`.
