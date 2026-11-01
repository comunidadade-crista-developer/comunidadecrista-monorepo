# E3 — Gospel cards e cache

Data: 2026-11-01 · Branch de origem: `feat` do E3 (criada sobre a versão antiga do E2), rebaseada
sobre `dev` (F1–F7 aplicados).

## 1. Contexto

Leitura pública dos gospel cards (`GET /gospel-cards`, `GET /gospel-cards/:slug`) com cache. A
branch do E3 foi criada antes da refactorização do E2, por isso o `server.ts`, o formato de erros e
as opções do pool estavam desactualizados. Só se aproveitou o que era do E3.

## 2. Check — o que se encontrou

| #   | Problema                                                                                                           | Gravidade |
| --- | ------------------------------------------------------------------------------------------------------------------ | --------- |
| 1   | O hook global do `dev` força `Cache-Control: no-store` por cima da rota: o `public` do E3 nunca chegava ao cliente | Alta      |
| 2   | `server.ts` do E3 estava na versão antiga: copiá-lo desfazia o formato de erro único, o pool e a manutenção        | Alta      |
| 3   | A cache registava `{ err }`: os erros do ioredis trazem host e porta                                               | Média     |
| 4   | Valores lidos do Redis usados sem validação (`JSON.parse(...) as ...`)                                             | Média     |
| 5   | Ramo `__null__` morto: slugs inexistentes iam sempre à BD (enumeração)                                             | Média     |
| 6   | Corte silencioso a 200 cards na leitura                                                                            | Média     |
| 7   | Seed: `process.exit(1)` ao 1.º erro, escritas parciais e cache não invalidada                                      | Média     |
| 8   | Rate limit fixo em 30/min por IP: bloqueia utilizadores legítimos atrás de CGNAT                                   | Média     |
| 9   | Lista vazia (seed por correr) podia ficar fixada no browser                                                        | Média     |
| 10  | `api.md` dizia `/api/v1` mas as rotas não têm prefixo                                                              | Baixa     |

## 3. Decisões

| Tema                   | Escolha                                                                                               | Alternativas                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------- |
| Cache fora do servidor | **A** — só browser e service worker (`public, max-age=300, stale-while-revalidate=86400`, `ETag`/304) | B: também Cloudflare; C: nenhuma |
| Camadas de cache       | **L1 (memória) + L2 (Redis versionado)**: um hit não toca em Redis nem BD                             | Só Redis (plano original)        |
| Paginação / limite     | Sem paginação; máximo 200 validado **no seed** (erro visível), sem cortar na leitura                  | Paginar; manter o `slice`        |
| Rate limit dos cards   | 120/min por IP, configurável (`RATE_LIMIT_CARDS_MAX`, `RATE_LIMIT_CARDS_WINDOW_S`)                    | 30/min fixo                      |

Decisões tomadas pelo responsável do projecto em 2026-11-01.

## 4. Alterações

- `packages/shared/src/cards.ts` (novo): schemas dos cards com limites, `CardSlug`, `GospelCardsSeedFile` (slugs e `orderIndex` únicos, 1–200 cards).
- `apps/api/src/cache/cards-cache.ts` (novo):
  - L1 em memória (5 min; 60 s sem Redis) e L2 Redis (1 h) com chaves `cc:v1:cards:v<N>:list|item:<slug>`.
  - A versão lê-se do Redis no máximo 1×/min por instância; `invalidate()` faz `INCR`, limpa a L1 e **lança** se o Redis falhar.
  - _stale-if-error_: com o Redis em baixo mantém a última versão conhecida (nova tentativa a cada 10 s) e depois vai à BD.
  - _single-flight_ por chave (anti-stampede); cache negativa de 60 s (máx. 1000 entradas); lista em L1 é autoritativa para `bySlug`.
  - Dados do Redis validados com zod; logs só com `errorName`/`errorCode`.
- `apps/api/src/routes/cards.ts` (novo): rotas, `ETag` fraco (calculado uma vez por objecto), `If-None-Match` → 304, 429 com `Retry-After`. Lista vazia não leva cabeçalhos de cache.
- `apps/api/src/server.ts`: o hook de `Cache-Control` só respeita `public...` em respostas 200/304; regista `cardsRoutes` com a cache.
- `apps/api/src/auth/rate-limit.ts`, `env.ts`, `.env.example`, `test/setup.ts`: balde `rl:cards` configurável.
- `apps/api/src/repositories/cards.ts`: `upsertMany` transaccional (tudo ou nada) com contagens.
- `apps/api/src/db/seed.ts`: valida o JSON com zod antes de escrever, grava numa transacção e invalida a cache; se a invalidação falhar sai com erro para repetir (é idempotente).
- Documentação: `docs/api/api.md`, `docs/Arquitectura/arquitectura.md` (§9), `docs/plano-de-construcao.md` (E3), este registo.

## 5. Segurança e privacidade

- Os cards são públicos: sem dados de utilizador na cache, nem nas chaves, nem nos logs.
- O slug é validado (schema da rota e, de novo, dentro da cache) antes de entrar numa chave do Redis: não há injecção de chaves.
- Erros 4xx/5xx nunca são cacheáveis pelo cliente (`no-store`), incluindo 429.
- Rate limit com chave HMAC do IP (como os restantes baldes); falha do limitador fecha.
- Os logs da cache não levam host, porta nem mensagens de erro do Redis.

## 6. Testes

- `test/cache/cards-cache.test.ts` (sem infra): L1/L2, versão, invalidação entre instâncias, Redis em baixo, L2 corrompida, _stale-if-error_, sem Redis, cache negativa e o seu limite, anti-stampede, slugs inválidos, logs sem host.
- `test/routes/cards.test.ts` (Postgres + Redis): contrato, ordem, campos públicos, chaves no Redis, ETag/304, `no-store` nos erros, rate limit.
- `test/shared/cards-schema.test.ts`: schema do seed e o `cards.json` real do repositório.
- `test/repositories/cards.test.ts` (`upsertMany`), `test/auth/rate-limit.test.ts` (balde dos cards).
- **Por cobrir:** o `seed.ts` como processo (exige Postgres + Redis reais); verificação manual no runbook abaixo.

## 7. Operação

- Variáveis: `RATE_LIMIT_CARDS_MAX` (120) e `RATE_LIMIT_CARDS_WINDOW_S` (60).
- Publicar conteúdo: editar `apps/api/src/db/seed-data/cards.json` e correr `pnpm --filter @comunidade/api db:seed` com `DATABASE_URL` e `REDIS_URL` de produção. Se terminar com "cache não foi invalidada", repetir.
- Depois do seed: instâncias da API até 1 min; browsers até 5 min (mais SWR).
- Cloudflare: manter "Bypass cache" para a API (decisão A). Se um dia se quiser cache na borda, abrir excepção para `/gospel-cards*`.
- O seed não apaga cards removidos do JSON (podem estar ligados a posts).

## 8. Pendente

- Conteúdo: o `cards.json` tem 1 card; os restantes serão fornecidos.
- Registar retroactivamente F1–F7 neste formato (a pedido).
- `/health/deep`: ainda abre uma ligação nova ao Postgres por pedido (backlog).
