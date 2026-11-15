# E4-b — Repositórios e serviços de posts

Data: 2026-11-14 · Segue o E4-a. Continua a **não haver merge** da branch do E4: os serviços e
repositórios do E4 foram reescritos sobre o `dev` (F1–F8 + E4-a), corrigindo os achados da revisão.

Este bloco é só a camada de dados e de regras. **Rotas, cache do feed e `/sync` ficam para o E4-c.**

## 1. Check — o que a revisão encontrou e este bloco resolve

| #   | Problema no E4                                                                                       | Gravidade |
| --- | ---------------------------------------------------------------------------------------------------- | --------- |
| 1   | Idempotência `get` → criar → `set`: dois pedidos concorrentes com a mesma chave criavam 2 posts      | Crítica   |
| 2   | Mesma chave com outro corpo repetia a resposta antiga em silêncio (sem comparar o pedido)            | Alta      |
| 3   | Caminho REST sem transacção: post + chave + outbox, e like + contador, não eram atómicos             | Crítica   |
| 4   | `presentOne(post, db)` usava o pool com uma transacção aberta: 2 ligações por pedido (esgota o pool) | Alta      |
| 5   | Apagar post era hard delete: o autor destruía a evidência de um post denunciado                      | Alta      |
| 6   | Cursor por `createdAt` em ms: saltava linhas; cursor inválido → `Invalid Date` → 500                 | Média     |
| 7   | `top` e `liked` sem paginação; `liked` truncado em silêncio nos 500                                  | Média     |
| 8   | Apresentação devolvia `authorId` mesmo com autor apagado, em apagamento ou post anónimo (anulava F5) | Alta      |
| 9   | Presenter carregava a tabela de cards inteira por chamada                                            | Média     |
| 10  | Segundo apagar/retirar denúncia dava 404 (no `/sync`, «rejected» para algo já aplicado)              | Média     |
| 11  | `setStatus` não preenchia `publishedAt` ao aprovar um post em revisão                                | Média     |
| 12  | Contas em apagamento mantinham acesso de escrita até o token expirar (15 min)                        | Alta      |
| 13  | O motivo de um post estar em revisão não ficava registado                                            | Média     |

## 2. Decisões

| Tema                       | Escolha                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Retenção de posts apagados | 30 dias, configurável (`POSTS_DELETED_RETENTION_DAYS`); depois eliminação de vez (job)         |
| Contas em apagamento (D6)  | Consulta à BD a cada escrita (por chave primária); bloqueio imediato; leituras não pagam custo |
| Idempotência               | Reserva da chave antes do trabalho, na mesma transacção; hash do pedido; conflito → 409        |
| Atomicidade                | Cada serviço corre numa transacção (savepoint se já houver uma): tudo ou nada                  |
| Apagar de outro utilizador | `not_found` (não se confirma a existência de posts alheios)                                    |

## 3. Alterações

- `repositories/posts.ts` (reescrito sobre o do `dev`): `softDelete`, `purgeDeleted` (em lotes),
  `findById` sem apagados por defeito (`includeDeleted`), `list` com cursor composto opaco para
  `recent`/`top`/`liked` (timestamp exacto em microssegundos), `InvalidCursorError`,
  `setStatus` com `publishedAt`, `listLikedPostIds` com `truncated`. Todas as leituras excluem apagados.
- `repositories/outbox.ts`: `idempotencyKeysRepo.reserve` (reaproveita chaves expiradas) e `complete`;
  `Executor` em vez de `Database`.
- `repositories/{users,cards,reports}.ts`: `Executor`; `usersRepo.findManyByIds`, `cardsRepo.findByIds`,
  `reportsRepo.findByPostAndReporter`.
- `services/posts.ts` (novo): criar, apagar, curtir/descurtir, denunciar, retirar denúncia. Devolvem
  `changed` (ou `replayed`) para o `/sync` distinguir `applied` de `duplicate`. Eventos no outbox:
  `post.created/deleted/liked/unliked/reported/escalated`.
- `services/post-presenter.ts` (novo): 3 consultas por página; `author: null` para conta apagada, em
  apagamento ou post anónimo; nunca devolve `authorId`; `isMine`/`isLiked` por espectador.
- `maintenance.ts` + `env.ts` + `.env.example`: purga dos posts apagados há mais de
  `POSTS_DELETED_RETENTION_DAYS` (até 20 lotes de 500 por execução).

## 4. Segurança e privacidade

- Evidência preservada: apagar não destrói denúncias nem likes durante a retenção; depois, tudo
  desaparece por cascata (direito a apagar respeitado, com prazo definido).
- O texto de um post apagado fica guardado até 30 dias. Quem não precisar de evidência pode baixar o prazo.
- Nenhuma resposta contém o identificador interno do autor.
- Chaves de idempotência são por utilizador: ninguém repete (nem adivinha) a de outro.
- Escritas bloqueadas imediatamente a contas em apagamento.

## 5. Testes

- Novos: `test/services/posts.test.ts` (idempotência, concorrência, atomicidade, conflito, filtro,
  conta em apagamento, soft delete, likes, denúncias e escalada, retirada), `test/services/post-presenter.test.ts`
  (anonimização, `isMine`/`isLiked`, cards), `test/repositories/idempotency.test.ts` (reserva, concorrência,
  expiração, rollback).
- Alargados: `test/repositories/posts.test.ts` (soft delete, purga, cursor a microssegundos e com empates,
  `top`/`liked`, `publishedAt`), `test/maintenance.test.ts` (purga e prazo configurável).

## 6. Operação

- Variável nova (com default): `POSTS_DELETED_RETENTION_DAYS=30`.
- Sem migrações novas (o schema veio no E4-a).

## 7. Pendente

- E4-c: rotas (`/posts`, likes, denúncias com erros no formato único, `GET /posts/:id` só com
  visibilidade), cache do feed versionada, `/sync` com limites por operação e registo no `server.ts`.
- E4-d: ADR-012/006, `api.md`, `arquitectura.md`, spec do filtro.
