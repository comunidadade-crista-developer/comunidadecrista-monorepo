# E4-c — Rotas de posts, cache do feed e `/sync`

Data: 2026-11-14 · Segue o E4-b. Continua a **não haver merge** da branch do E4: rotas, cache e
`/sync` foram reescritos sobre o `dev` (F1–F8 + E4-a + E4-b), corrigindo os achados da revisão.

## 1. Check — o que a revisão encontrou e este bloco resolve

| #   | Problema no E4                                                                                                 | Gravidade |
| --- | -------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | Invalidação da cache do feed com `SCAN` + `DEL` em massa (O(N) por escrita, bloqueia o Redis)                  | Alta      |
| 2   | Todo like/denúncia invalidava a cache: a cache deixava de servir sob carga                                     | Alta      |
| 3   | Valor lido do Redis aceite sem validação (`JSON.parse as ...`)                                                 | Média     |
| 4   | Erros do Redis registados com o objecto `err` (host/porta) e a chave                                           | Média     |
| 5   | Cache de qualquer página (incluindo cursores): chaves a crescer e dados antigos                                | Média     |
| 6   | `/sync` sem os limites por operação: contornava os limites do REST                                             | Crítica   |
| 7   | `/sync` dava `applied` a operações repetidas e `rejected` ao apagar/retirar pela 2.ª vez                       | Média     |
| 8   | `/sync` com uma transacção por operação aberta e o serviço a usar o pool: 2 ligações por operação              | Alta      |
| 9   | Lote sem prazo: um lote lento segurava o pedido até o proxy cortar                                             | Média     |
| 10  | Denúncia devolvia 200/400/404 com corpo `{ outcome }` para erros (formato de erro diferente do resto da API)   | Média     |
| 11  | `GET /posts/:id` mostrava `pending_review` a qualquer pessoa e não deixava o autor ver os seus estados         | Alta      |
| 12  | Token inválido em leitura pública ignorado em silêncio (cliente ficava sem os seus likes, sem renovar o token) | Média     |
| 13  | Post do próprio autor injectado em qualquer filtro/página: duplicados ao paginar                               | Média     |
| 14  | Corpo validado antes da sessão: pedidos sem token recebiam erros de validação                                  | Baixa     |
| 15  | Bootstrap com `myReports` sem o estado `withdrawn` (quebrava a resposta) e listas cortadas sem aviso           | Alta      |
| 16  | Eventos do outbox sem consumidor: ficavam `pending` para sempre (um por like)                                  | Alta      |
| 17  | Bootstrap devolvia o `id` interno de outros utilizadores via `authorId` nos posts                              | Alta      |

## 2. Decisões

| Tema                          | Escolha                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Cache do feed (D7)            | Só 1.ª página de `recent`/`top`; chaves versionadas, `INCR`; TTL 30 s (`FEED_CACHE_TTL_S`); likes não invalidam   |
| Quando invalida               | Criar post publicado, apagar (se mudou), denúncia que escala o post, `/sync` com qualquer destes (1 vez por lote) |
| Cursor (D8)                   | Páginas com cursor nunca passam pela cache; cursor adulterado → 400 `validation_error`                            |
| Leitura com sessão opcional   | Sem `Authorization` = anónimo; com `Authorization` o token tem de ser válido (senão 401)                          |
| `GET /posts/:id` (D4)         | `published` para todos; outros estados só autor e admin (admin revalidado na BD); caso contrário 404              |
| Post em revisão do autor      | Injectado só no topo da 1.ª página de `recent` (nunca está nas páginas públicas: sem duplicados)                  |
| `/sync` (D5)                  | Cada operação paga o balde do REST do seu tipo + o balde do lote; acima do limite → `deferred` + `retryAfter`     |
| `/sync` e erros inesperados   | `deferred` + `internal` (repetir é seguro: serviços transaccionais e idempotentes), não `rejected`                |
| Prazo do lote                 | `SYNC_BATCH_TIMEOUT_MS` (8 s); operações não tentadas → `deferred`                                                |
| `account_inactive` no `/sync` | `forbidden`                                                                                                       |
| Worker do outbox              | Evento sem handler = concluído (nenhum consumidor existe ainda); handler que lança → backoff, `failed` após 6     |
| Erros das rotas               | Sempre `{ error }` no formato único; denúncia: 400 `own_post`, 404 `not_found`; sucesso 200 `{ outcome }`         |

## 3. Alterações

- `cache/feed-cache.ts` (reescrito): versão em Redis, single-flight, valor validado com zod, falhas
  do Redis só registam nome/código, `invalidate()` nunca lança. A página em cache leva `authorIds`
  interno (não sai da API) para calcular `isMine` por espectador.
- `services/feed-view.ts` (novo): `decorateForViewer` (`isLiked` numa consulta por página; `isMine`
  sem consulta); devolve cópias.
- `routes/posts.ts` (reescrito): `GET /posts`, `GET /posts/:id`, `POST /posts` (201; repetição com a
  mesma chave → 200), `DELETE /posts/:id`, `POST|DELETE /posts/:id/like`, `POST|DELETE /posts/:id/report`.
  Autenticação em `preValidation`.
- `routes/sync.ts` (reescrito): `POST /sync`, `GET /sync/bootstrap` (limites e flags `...Truncated`).
- `auth/middleware.ts`: `optionalAuth`.
- `services/posts.ts`: `reportPostService` devolve também `escalated`.
- `workers/outbox-worker.ts` (novo) + registo no `server.ts` (fora dos testes).
- `server.ts`: uma instância de `cardsCache` e de `feedCache` por processo; regista posts e sync.
- `packages/shared/src/sync.ts`: `op_id` único por lote; `withdrawn` em `myReports`;
  `myPostsTruncated`, `myLikedPostIdsTruncated`, `myReportsTruncated`.
- `env.ts` + `.env.example`: `SYNC_BATCH_TIMEOUT_MS`, `FEED_CACHE_TTL_S`, `OUTBOX_WORKER_INTERVAL_MS`,
  `OUTBOX_WORKER_BATCH_SIZE`.
- Testes: `cache/feed-cache`, `routes/posts`, `routes/sync`, `workers/outbox-worker`; `services/posts`
  ajustado (`escalated`).

## 4. Segurança e privacidade

- Nenhuma resposta (feed, post, bootstrap, `/sync`) contém `authorId`; a cache guarda-o só em Redis
  (dado interno), nunca serializado para o cliente.
- Estados não públicos dão 404, nunca 403: não se confirma a existência de posts alheios.
- Sem sessão válida, o pedido é recusado antes de o corpo ser validado.
- Logs sem IP, sem mensagens de erro, sem conteúdo: só `errorName`/`errorCode`/tipo de operação.
- `/sync` não é porta lateral: mesmos limites por operação que o REST (baldes partilhados).
- Atraso conhecido: o contador de likes do feed público e o nome do autor (conta que pediu
  apagamento) podem demorar até `FEED_CACHE_TTL_S` (30 s) a reflectir-se na 1.ª página em cache.

## 5. Como verificar

```
pnpm typecheck
pnpm test
```

Os testes de rotas usam Postgres e Redis reais (como `cards.test.ts`); `feed-cache.test.ts` usa
Redis simulado.
