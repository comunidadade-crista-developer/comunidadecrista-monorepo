# API — Comunidade Cristã

Base: raiz do host da API (por exemplo `https://api.<dominio>/gospel-cards`). Ainda não há prefixo
`/api/v1`; se vier a existir, será um registo próprio.
Formato: JSON
Autenticação: `Authorization: Bearer <accessToken>` (JWT EdDSA, 15 min). Os tokens de renovação são opacos.

Os schemas de pedido e resposta vivem em `packages/shared` (`auth.ts`, `cards.ts`, `posts.ts`,
`sync.ts`, `admin.ts`) e são a fonte de verdade; este documento descreve o comportamento.

## Convenções

**Erros — formato único**: `{ "error": "<código estável>", "message"?: "…", "fields"?: { "<campo>": "<mensagem>" } }`.

| Estado | Quando                                                                                    |
| ------ | ----------------------------------------------------------------------------------------- |
| 400    | `validation_error` (com `fields`) ou erro de regra de negócio (ex.: `contains_link`)      |
| 401    | Sem sessão válida: `missing_token`, `invalid_token`                                       |
| 403    | `account_inactive` (conta com apagamento pendente) ou `forbidden`                         |
| 404    | `not_found`. Para recursos de outros utilizadores ou não públicos é sempre 404, nunca 403 |
| 409    | Conflito (`username_taken`, `idempotency_key_conflict`, `last_admin`)                     |
| 429    | `rate_limited`, com cabeçalho `Retry-After` (segundos)                                    |
| 5xx    | Mensagem genérica, sem detalhes internos                                                  |

Sem sessão válida, os pedidos autenticados são recusados (401) **antes** de o corpo ser validado.

**Cache HTTP**: todas as respostas levam `Cache-Control: no-store`, excepto as respostas públicas 200/304
dos gospel cards.

**Autor das partilhas**: nenhuma resposta traz o identificador interno do autor. O campo `author` é
`{ "username": "…" }` ou `null` («[removido]»: conta apagada, em apagamento ou partilha anonimizada); o
campo `isMine` diz se a partilha é do utilizador que pede.

**Limites por utilizador** (omissão; configuráveis por `RATE_LIMIT_*`, ver `.env.example`):

| Operação                     | Limite                                                  |
| ---------------------------- | ------------------------------------------------------- |
| Leitura do feed / de um post | 120 por 60 s (por IP e, com sessão, por utilizador)     |
| Criar partilha               | 10 por hora                                             |
| Apagar partilha              | 30 por hora                                             |
| Likes (curtir e descurtir)   | 120 por hora                                            |
| Denúncias (criar e retirar)  | 10 por hora                                             |
| Pedidos `/sync`              | 60 por hora (e cada operação paga o limite do seu tipo) |
| Painel admin: leituras       | 120 por 60 s, por administrador                         |
| Painel admin: decisões       | 30 por 60 s, por administrador                          |
| Global (todas as rotas)      | 300 por 60 s, por IP (`RATE_LIMIT_GLOBAL_*`)            |

**Pedidos**: corpo máximo 512 KiB (`BODY_LIMIT_BYTES`; acima → `413 payload_too_large`) e 30 s para
receber o pedido completo (`REQUEST_TIMEOUT_MS`). O CORS não usa credenciais: a autenticação é por
`Authorization: Bearer`, nunca por cookies.

### Refresh: tolerância e contrato para o cliente

O refresh token é de uso único: cada `/auth/refresh` devolve um par novo e o token enviado fica
substituído. Reenviar um token **já substituído** é tratado como roubo (`401 token_reuse` e a
família inteira é revogada), **excepto** durante `REFRESH_REUSE_GRACE_S` segundos (10 por omissão,
0 desliga): nesse prazo o servidor aceita o reenvio e emite um token novo na mesma família, sem
revogar nada. Cobre vários separadores a renovar ao mesmo tempo e o _retry_ depois de uma resposta
perdida. A tolerância só vale para tokens substituídos por rotação: um token revogado por logout,
ou cuja sessão já terminou, é sempre `token_reuse`.

O cliente (`apps/web`) tem de **renovar numa só chamada de cada vez** (_single-flight_):

1. Dentro do separador, uma só renovação em curso; os pedidos que falham com `401` esperam por ela.
2. Entre separadores, serializar com `navigator.locks.request("cc-refresh", …)`. Dentro do bloqueio,
   **reler** o token guardado: se outro separador já o renovou, usar esse e não chamar a API.
3. Guardar o par novo **antes** de largar o bloqueio.
4. Em `401 token_reuse` ou `invalid_refresh`, terminar a sessão local e pedir novo login. Nunca
   repetir o refresh em ciclo.

## Health

### GET /health

Leve. Não toca em base de dados nem Redis. Usado por cron-job.org.

**200**

```json
{ "status": "ok", "version": "0.1.0", "timestamp": "2025-01-01T00:00:00.000Z" }
```

### GET /health/deep

Toca em Postgres (pelo pool da aplicação, `SELECT 1`) e Redis, cada um com limite de 2 s. Uso em CI e monitorização manual. Limite próprio: 30 pedidos por minuto por IP (`429` acima).

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

## Autenticação e conta

Contrato completo em `packages/shared/src/auth.ts`; fluxos em `docs/Arquitectura/arquitectura.md` §7 e
ADR-006/011/012.

| Método | Rota                   | Sucesso | Notas                                                                                                             |
| ------ | ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/register`       | 201     | Devolve tokens e o `recoveryCode` (mostrado uma só vez). `409 username_taken`.                                    |
| POST   | `/auth/login`          | 200     | `401 invalid_credentials`, `401 recovery_pending`. Reactiva uma conta em apagamento.                              |
| POST   | `/auth/refresh`        | 200     | Rotativo. `401 invalid_refresh` / `refresh_expired` / `token_reuse` (revoga a família). Ver «Refresh».            |
| POST   | `/auth/logout`         | 200     | Termina a sessão: revoga a família do refresh token.                                                              |
| GET    | `/auth/me`             | 200     | Dados do utilizador autenticado.                                                                                  |
| POST   | `/auth/recover/verify` | 200     | Código **ou** 3 perguntas → `recoverySession` (5 min).                                                            |
| POST   | `/auth/recover/reset`  | 200     | Nova palavra-passe; `completed` (código) ou `pending` (perguntas, com atraso).                                    |
| POST   | `/users/me/deletion`   | 200     | `{ password, postsMode: "anonymize" \| "delete" }` → `{ status: "pending_deletion", purgeAt }`. `409 last_admin`. |

## Partilhas

Modelo (`PostPublic`):

```json
{
  "id": "uuid",
  "category": "entendimento | ensinamento | letra_cancao",
  "title": "…",
  "content": "…",
  "status": "published | pending_review | hidden | rejected",
  "likesCount": 3,
  "isLiked": false,
  "isMine": false,
  "author": { "username": "maria" },
  "gospelCardSlug": "o-nascimento-de-jesus",
  "createdAt": "2026-11-14T10:00:00.000Z",
  "publishedAt": "2026-11-14T10:00:00.000Z"
}
```

### GET /posts

Sessão **opcional**: sem `Authorization` o pedido é anónimo; com `Authorization` o token tem de ser válido
(senão `401 invalid_token`, para o cliente renovar a sessão em vez de ficar sem os seus likes).

Query: `category`, `gospelCardId` (uuid), `filter` (`recent` por omissão, `top`, `liked`), `cursor`, `limit`
(1–50, 20 por omissão).

- Só devolve partilhas `published` e não apagadas.
- `filter=liked` exige sessão (`401 missing_token`) e devolve as que o utilizador curtiu, do like mais recente para o mais antigo.
- **Paginação por cursor opaco** (`nextCursor`, `null` na última página). O cursor é de um filtro: usar um cursor de `recent` em `top` dá `400 validation_error` (`fields.cursor`). Em `top` o resultado é aproximado se os likes mudarem a meio.
- Com sessão, `recent` na 1.ª página mostra no topo a partilha do próprio autor que está em revisão (ainda não é pública); essa página pode por isso ter `limit + 1` itens.
- A 1.ª página de `recent`/`top` vem de uma cache de 30 s: os likes do feed público podem atrasar-se esse tempo. Publicar, apagar e escalar invalidam logo.

**200** `{ "posts": [PostPublic], "nextCursor": "…" | null }` · **400** · **401** · **429**

### GET /posts/:id

Sessão opcional (como acima). Uma partilha `published` é pública. `pending_review`, `hidden` e `rejected` só
são visíveis ao **autor** e a **administradores** (papel revalidado na base de dados); para todos os outros,
e para partilhas apagadas, a resposta é `404 not_found`.

**200** `{ "post": PostPublic }` · **400** (id inválido) · **401** · **404** · **429**

### POST /posts

Requer sessão e o cabeçalho `Idempotency-Key` (16–128 caracteres: letras, números, `-` e `_`).

Corpo: `{ "category", "title", "content", "gospelCardSlug"? }`. Título 1–120 e conteúdo 1–5000 caracteres (sem espaços nas pontas).

O conteúdo passa pelo filtro anti-spam (ADR-013):

- **400 `contains_link`** — contém ligação externa.
- **400 `contains_contact`** — contém email, telefone ou IP.
- **201** com `status: "pending_review"` — sinais de spam: a partilha é criada mas não aparece no feed público até ser revista.
- **400 `validation_error`** — corpo inválido, `Idempotency-Key` em falta, `gospelCardSlug` inexistente (`gospel_card_not_found`).

Idempotência: repetir o pedido com a **mesma chave e o mesmo corpo** devolve **200** com a resposta original (não cria outra
partilha). A mesma chave com outro corpo → **409 `idempotency_key_conflict`**. Contas com apagamento pendente → **403 `account_inactive`**.

**201** `{ "post": PostPublic, "status": "published" | "pending_review" }` · **200** (repetição) · **400** · **401** · **403** · **409** · **429**

### DELETE /posts/:id

Só o autor. Apaga (soft delete); repetir é idempotente. Para quem não é o autor, ou se não existe: `404`.

**200** `{ "deleted": true }` · **401** · **403** (`account_inactive`) · **404** · **429**

### POST /posts/:id/like · DELETE /posts/:id/like

Curtir e descurtir são idempotentes. Só se curtem partilhas publicadas e não apagadas (`404` caso contrário).

**200** `{ "likesCount": 3, "isLiked": true }` · **401** · **403** · **404** · **429**

### POST /posts/:id/report

Corpo: `{ "category": "spam" | "off_topic" | "offensive" | "doctrine" | "other", "reason"?: "3–500 caracteres" }`.
`reason` é obrigatório (e só então) quando `category = "other"`. Limiares e regras em ADR-014.

- **200** `{ "outcome": "created" }` — denúncia registada (pode escalar a partilha para revisão).
- **200** `{ "outcome": "duplicate" }` — já existia uma denúncia deste utilizador (em qualquer estado, incluindo retirada).
- **400 `own_post`** — não se denuncia a própria partilha. **404 `not_found`** — não existe, foi apagada ou não está publicada.
- **400 `validation_error`** — categoria em falta ou `other` sem motivo.

### DELETE /posts/:id/report

Retira a denúncia do próprio utilizador (fica `withdrawn`; deixa de contar; **não** reverte uma revisão já iniciada).
Idempotente. **404** se nunca denunciou esta partilha.

**200** `{ "withdrawn": true }` · **401** · **403** · **404** · **429**

## Sync (offline-first)

Contrato em `packages/shared/src/sync.ts`. Ver ADR-007.

### POST /sync

Requer sessão. Corpo: `{ "operations": [ … ] }` (1 a 20 operações; `op_id` único no lote). Cada operação:
`{ "op_id": uuid, "idempotency_key": "…", "type": "…", "payload": { … } }` (payloads estritos: campos a mais → `400`).

| `type`          | `payload`                                       | `result` quando aplicada  |
| --------------- | ----------------------------------------------- | ------------------------- |
| `post.create`   | `{ category, title, content, gospelCardSlug? }` | `{ post, status }`        |
| `post.delete`   | `{ postId }`                                    | `{ deleted: true }`       |
| `post.like`     | `{ postId }`                                    | `{ likesCount, isLiked }` |
| `post.unlike`   | `{ postId }`                                    | `{ likesCount, isLiked }` |
| `post.report`   | `{ postId, category, reason? }`                 | `{ outcome }`             |
| `post.unreport` | `{ postId }`                                    | `{ withdrawn: true }`     |

As operações correm **em série, pela ordem do cliente**, cada uma pelo mesmo serviço do REST (mesmas regras, mesmo
filtro anti-spam) e pagando o **mesmo limite por operação** que o REST.

**200** `{ "results": [ { "op_id", "status", "result"?, "error"? } ], "serverTime": "…" }` — um resultado por operação, pela mesma ordem:

| `status`    | Significado                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applied`   | Aplicada agora.                                                                                                                                                                                                                                                                                                                                                      |
| `duplicate` | Já estava aplicada (chave repetida, like já dado, partilha já apagada…). O `result` é o estado actual. O cliente dá por concluída.                                                                                                                                                                                                                                   |
| `rejected`  | Recusa definitiva: `error.code` ∈ `not_found`, `forbidden` (inclui conta em apagamento), `own_post`, `idempotency_key_conflict` (chave reutilizada com outro corpo **ou por outro tipo de operação**, no mesmo lote ou em lotes anteriores), `gospel_card_not_found`, `contains_link`, `contains_contact`, `internal`. O cliente remove-a da fila e mostra o motivo. |
| `deferred`  | **Não** foi tentada ou falhou por razões transitórias: limite (`error.code = "rate_limited"`, `error.retryAfter` em segundos), prazo do lote esgotado (`SYNC_BATCH_TIMEOUT_MS`, 8 s) ou falha inesperada (`error.code = "internal"`). O cliente repete mais tarde; é seguro (idempotente).                                                                           |

Erros do pedido: **400** · **401** · **429** (`Retry-After`, limite de pedidos `/sync`).

### GET /sync/bootstrap

Requer sessão. Devolve o estado inicial do cliente: `serverTime`, `user`, `cards`, `recentPosts` (1.ª página do feed, com `isLiked`/`isMine`),
`myPosts` (até 50, qualquer estado menos apagadas) com `myPostsTruncated`, `myLikedPostIds` (até 500) com `myLikedPostIdsTruncated`, e
`myReports` (até 100; `status` ∈ `open`, `resolved_kept`, `resolved_removed`, `withdrawn`) com `myReportsTruncated`.
Quando uma flag `…Truncated` é `true`, havia mais itens do que os devolvidos.

**200** · **401** · **403** (`account_inactive`) · **429**

## Admin

Contratos em `packages/shared/src/admin.ts`. Ver ADR-015. Todas as rotas exigem sessão **e** papel `admin`
(revalidado na base de dados em cada pedido; contas com apagamento pendente → `403`). Sem sessão: `401`; sem ser
admin: `403`, ambos **antes** de validar a query ou o corpo. Limites por administrador: ver «Convenções».

Nenhuma resposta traz identificadores de utilizadores: autores, denunciantes e moderadores aparecem por
`{ "username": "…" }` (`null` = removido ou, no registo, acção do sistema).

**Listas e cursores**: `limit` 1–50 (omissão 20) e `cursor` opaco (o `nextCursor` da resposta anterior; `null` na última
página). Um cursor adulterado ou de outra lista → `400 validation_error`.

### GET /admin/posts

`?status=` (`pending_review` por omissão · `published` · `hidden` · `rejected`). `pending_review` é a fila de trabalho,
do **mais antigo** para o mais recente; os outros estados, do mais recente. Posts apagados não aparecem.

**200** `{ "posts": [ { id, category, title, excerpt (200 car.), status, author, reviewFlags, reportsCount, reportsByCategory { spam, off_topic, offensive, doctrine, other }, createdAt } ], "nextCursor" }`
(contagens de denúncias **abertas**).

### GET /admin/posts/:id

**200** `{ "post": { …, content, gospelCardSlug, likesCount, publishedAt }, "reports": [ { id, postId, postTitle, reporter, category, severity, reason, status, createdAt, resolvedAt } ], "moderation": [ { id, action, moderator, target, reason, createdAt, … } ] }`
· **400** (id inválido) · **404** (inexistente ou apagado).

### POST /admin/posts/:id/approve

Corpo `{ "note"?: "…" }` (1–500 caracteres; campos a mais → `400`). Publica o post, fecha as denúncias abertas como
`resolved_kept`, regista `approved` na auditoria e invalida a cache do feed.

**200** `{ "post": { id, status: "published", publishedAt } }` · **404** · **409 `invalid_state`** (só se decide sobre
`pending_review`; um post `hidden`, por exemplo suspenso por apagamento de conta, não se aprova).

### POST /admin/posts/:id/reject

Corpo `{ "reason": "…" }` (**obrigatório**, 10–500 caracteres). Passa o post a `rejected`, fecha as denúncias como
`resolved_removed` e regista `rejected` com o motivo. O motivo não é mostrado ao autor nesta fase.

**200** `{ "post": { id, status: "rejected", publishedAt } }` · **400** · **404** · **409 `invalid_state`**

Duas decisões em simultâneo sobre o mesmo post: a segunda recebe `409`.

### GET /admin/reports

`?status=` (`open` por omissão · `resolved_kept` · `resolved_removed` · `withdrawn`), das mais recentes.
**200** `{ "reports": [ { id, postId, postTitle | null, reporter, category, severity, reason, status, createdAt, resolvedAt } ], "nextCursor" }`

### GET /admin/moderation-log

`?action=` (`approved` · `rejected` · `admin.promoted` · `admin.demoted`) e `?postId=`, do mais recente.
**200** `{ "entries": [ { id, action, postId | null, postTitle | null, moderator | null, target | null, reason | null, createdAt } ], "nextCursor" }`

### Promover e despromover admins

Não há rotas. Só por CLI, no servidor (ADR-015):

```
pnpm --filter @comunidade/api admin:promote <username>
pnpm --filter @comunidade/api admin:demote  <username>
```

Saída: `0` sucesso (incluindo «nada a fazer»), `1` erro de uso ou de ambiente, `2` utilizador inexistente ou em apagamento, `3` recusado (último admin).
