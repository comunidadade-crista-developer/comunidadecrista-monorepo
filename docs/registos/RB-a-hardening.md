# RB-a — Endurecimento do backend

Primeiro bloco da revisão do backend (achados 1, 2, 3, 4, 7, 8 e 9).

| Achado | Alteração                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | `pgErrorCode` percorre a cadeia `cause` (o drizzle embrulha o erro do Postgres): o registo concorrente dá `409`, não `500`. Os logs deixam de levar `err` (query e parâmetros). |
| 2      | Em produção `DATABASE_URL`, `REDIS_URL`, `JWT_*` e `IP_HASH_SECRET` são obrigatórios; aviso no arranque com `EDGE_MODE=none` e `TRUST_PROXY=false`.                             |
| 3      | Limite global por IP passa de 100 para 300 por minuto (`RATE_LIMIT_GLOBAL_*`).                                                                                                  |
| 4      | `/health/deep` usa o pool existente, com timeout de 2 s e limite de 30/min.                                                                                                     |
| 7      | `BODY_LIMIT_BYTES` (512 KiB) e `REQUEST_TIMEOUT_MS` (30 s).                                                                                                                     |
| 8      | CORS sem `credentials`.                                                                                                                                                         |
| 9      | Mínimos de argon2 em produção; `index.ts` regista só `errorName`/`errorCode`.                                                                                                   |

Testes novos: `errors`, `http-errors`, `env`, registo concorrente, `server.limits`. | Feito |
