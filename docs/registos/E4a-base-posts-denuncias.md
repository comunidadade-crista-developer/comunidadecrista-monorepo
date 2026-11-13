# E4-a — Base de posts, denúncias e filtro (schema, shared, denúncias)

Data: 2026-11-12 · Branch de origem: `feat` do E4/E4.5/E4.6/E4.7 (criada sobre a versão antiga do
E2). **Não foi feito merge**: a branch foi comparada ficheiro a ficheiro com o `dev` (F1–F8) e só
se aproveitaram os deltas do E4, reescritos sobre o `dev`.

Este bloco é só a **base**: schema, contratos partilhados, filtro de conteúdo, limites e o
repositório de denúncias. Serviços de posts, rotas, cache do feed e `/sync` ficam para E4-b e E4-c;
documentação (ADR-012/006, `api.md`, spec) para E4-d.

## 1. Contexto

O E4 acrescenta partilhas (posts), likes, denúncias e sincronização offline. A branch trazia 3
fases de trabalho (E4, E4.5+E5, E4.6+E4.7) e uma base antiga: faltavam F2–F8 e as duas branches
tinham criado uma migração `0003` diferente.

## 2. Check — o que se encontrou (resumo; revisão completa feita em conversa)

| #   | Problema                                                                                              | Gravidade |
| --- | ----------------------------------------------------------------------------------------------------- | --------- |
| 1   | `reports.ts` do E4 regredia o F1: `FOR UPDATE` (deadlock com likes), ordem de locks, sem `minAgeDays` | Crítica   |
| 2   | Retirar uma denúncia apagava-a: destruía evidência e deixava repor o contador em ciclos               | Crítica   |
| 3   | Conflito de migração (`0003` nos dois lados)                                                          | Alta      |
| 4   | `severity` guardada ao lado de `category`: podia ficar incoerente                                     | Alta      |
| 5   | Reportador «válido» contava qualquer partilha (pendente, oculta, rejeitada)                           | Alta      |
| 6   | Filtro: contornos (`.org/.net/.pt`, `wa.me`, `t.me`, `youtu.be`, `dot com`, homóglifos cirílicos)     | Alta      |
| 7   | Filtro: telefones só de Portugal; falsos positivos («às 10:30:15», «versão 1.2.3.4», «AMÉM ALELUIA»)  | Média     |
| 8   | Filtro: regex quadrática (35–50 ms em 5000 caracteres)                                                | Média     |
| 9   | Posts sem trim, sem guarda de NUL (erro 22021 → 500), cursor sem validação                            | Média     |
| 10  | Cursor por `createdAt` em milissegundos: saltava linhas (o Postgres guarda microssegundos)            | Média     |
| 11  | `PostPublic` devolvia `authorId` mesmo com autor apagado/anónimo (anulava o F5)                       | Alta      |
| 12  | Corpo `{outcome}` em respostas 400/404 de denúncias (viola o formato de erro único do F2)             | Média     |
| 13  | CI do `dev`: serviço Postgres publicado em 5430 mas `DATABASE_URL` aponta para 5432                   | Média     |

Os pontos 11 e 12 são resolvidos aqui nos contratos (`shared`); a sua aplicação nas rotas é E4-c.
Os restantes achados da revisão (idempotência com corrida, transacções, `feed-cache` com `SCAN`,
`GET /posts/:id` sem visibilidade, `/sync` sem limites por operação, etc.) ficam para E4-b/E4-c.

## 3. Decisões

Tomadas pelo responsável do projecto em 2026-11-12.

| Tema                    | Escolha                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| Estratégia              | Comparar e aproveitar; **sem merge** da branch                                                             |
| Filtro de conteúdo      | Mais TLDs, telefones PT/MZ/AO/BR, normalização de ofuscação, homóglifos; ADR-013 prevalece sobre a spec    |
| Retirar denúncia        | Estado `withdrawn` (a linha fica); **uma denúncia por utilizador e post, em qualquer estado**              |
| Apagar post             | Soft delete (`posts.deleted_at`)                                                                           |
| `severity`              | **Coluna gerada** pelo Postgres a partir de `category`                                                     |
| Limiares                | basic 10, medium 5, high **3** (era 2); só contam reportadores com conta ≥ 7 dias e partilha **publicada** |
| Denúncias antigas       | Migram como `other`, com o `reason` já preenchido                                                          |
| `authorId` nos posts    | Não sai da API: `author: { username } \| null` + `isMine`                                                  |
| Cursor                  | Composto `(timestamp exacto, id)`, opaco e validado; `top` e `liked` também paginam                        |
| Limites de escrita      | Por utilizador e por operação, configuráveis; o `/sync` aplica os mesmos (E4-c)                            |
| Spec vs ADR             | Prevalece o ADR-013: sem «pendente por conta nova», limiares e palavras-chave no código                    |
| `/users/me/*`, password | Fase própria                                                                                               |

## 4. Alterações

- `apps/api/drizzle/0004_report_categories_soft_delete.sql` (+ snapshot e journal). A `0003` do E4
  foi descartada. **Escrita à mão** (o `drizzle-kit` não correu no ambiente de revisão): validada
  contra um Postgres 16 real com dados antigos, mas convém correr `pnpm db:generate` e confirmar
  que **não** gera diferenças.
  - `report_status` + `withdrawn`; enums `report_category` e `report_severity`.
  - `reports`: `reason` passa a opcional; `category` obrigatória (sem default); `severity` gerada;
    `withdrawn_at`; `CHECK` «other» exige motivo não vazio; índice `(post_id, category, status)`.
  - `posts`: `deleted_at` (soft delete) e `review_flags text[]` (porquê foi para `pending_review`).
  - `idempotency_keys`: `request_hash` (nulo por agora; passa a ser escrito e comparado no E4-b).
- `apps/api/src/db/schema.ts`: o que acima, com comentários.
- `apps/api/src/db/client.ts`: tipos `DbTransaction` e `Executor`.
- `apps/api/src/repositories/reports.ts`: parte do `reports.ts` do `dev` (F1) e acrescenta só o que
  o E4.7 trazia, corrigido: `file({ category, reason? })`, limiares por gravidade sem somar entre
  si, `withdrawn`, reportador válido com partilha publicada e não apagada, `review_flags`
  (`reports_<gravidade>`) na escalada, `listByReporter` limitado e mais recentes primeiro.
- `packages/shared/src/content-filter.ts` (novo), `posts.ts` (novo), `sync.ts` (novo), `index.ts`.
- `apps/api/src/auth/rate-limit.ts`, `env.ts`, `.env.example`, `test/setup.ts`: limites de feed,
  escritas e sync (todos configuráveis).
- `.github/workflows/ci.yml`: o serviço Postgres publica em `5432:5432` (coerente com `DATABASE_URL`;
  o `docker-compose.yml` local mantém `5430`).

## 5. Segurança e privacidade

- O filtro de conteúdo é uma defesa de produto, não um controlo de segurança: continua a ser
  contornável por quem se esforce. A defesa em profundidade é a moderação, as denúncias e os limites.
- Todas as expressões do filtro são lineares; há teste de carga com entradas adversariais.
- `authorId` deixa de fazer parte do contrato público: não se pode usar para ligar partilhas
  anónimas a uma conta apagada.
- Cursor opaco, com tamanho e alfabeto validados: não permite injecção nem chaves arbitrárias.
- Denúncias nunca são apagadas pelo utilizador: ficam como evidência de campanhas combinadas.
- Falso positivo conhecido e aceite no filtro: «Jesus.Com» (falta o espaço depois do ponto) é
  rejeitado como ligação; a mensagem de erro explica como corrigir.

## 6. Testes

- Novos: `test/repositories/reports.severity.test.ts` (gravidade gerada = `CATEGORY_TO_SEVERITY`,
  CHECK de «other», limiares por gravidade sem soma, reportador válido, `withdrawn`),
  `test/shared/content-filter.test.ts`, limites novos em `test/auth/rate-limit.test.ts`.
- Actualizados: `reports.rules.test.ts`, `reports.test.ts`, `account-deletion.test.ts` (categoria
  obrigatória; denunciar depois de retirar passa a ser `duplicate`).
- Por cobrir (E4-b/E4-c): concorrência na idempotência, visibilidade de `GET /posts/:id`,
  anonimização do autor, paginação por cursor, `/sync` com limites por operação.

## 7. Operação

- Aplicar a migração `0004` (`pnpm db:migrate`). É aditiva; as denúncias existentes ficam como
  `other` com o motivo que tinham.
- Variáveis novas (todas com default): `RATE_LIMIT_FEED_*`, `RATE_LIMIT_POSTS_CREATE_*`,
  `RATE_LIMIT_POSTS_DELETE_*`, `RATE_LIMIT_LIKES_*`, `RATE_LIMIT_REPORTS_*`, `RATE_LIMIT_SYNC_*`.

## 8. Pendente

- E4-b: repositórios e serviços de posts (idempotência com reserva e hash do pedido, transacções,
  soft delete, anonimização, cursor), `reports` dentro de transacção (`Executor`).
- E4-c: rotas, cache do feed versionada, `/sync` com limites por operação e registo no `server.ts`.
- E4-d: ADR-012 (eliminação de conta) e actualização do ADR-006 na pasta `adr/`, `api.md`,
  `arquitectura.md`, correcção da spec do filtro e dos testes 24, 25 e 29.
- Primeiro admin: confirmar como é criado. Nomes reservados adicionais: a confirmar.
