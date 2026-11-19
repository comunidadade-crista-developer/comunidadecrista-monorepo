# E5 + E6 — Ajustes do `/sync` e do worker; administração (ADR-015)

Data: 2026-11-18 · Resultado da comparação dos ramos `featE5` e `featE6-admins` com o `dev` (mais os blocos E4 já aplicados).
Os ramos **não** foram fundidos: o que prestava foi reescrito por cima do estado actual.

## 1. Check — o que a comparação mostrou

### E5 (worker do outbox e `/sync`)

| #   | Situação                                                                                                                | Resolução                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | O worker do E5 duplicava o nosso (`processOutboxBatch` / `startOutboxWorker` já existem, com `backoff` e paragem limpa) | Mantido o nosso; adoptadas só as ideias em falta                                                   |
| 2   | `buildServer` sem opção para desligar o worker; arranque no próprio `buildServer`                                       | `disableWorker` (omissão: desligado em `NODE_ENV=test`); worker e manutenção arrancam em `onReady` |
| 3   | A mesma `idempotency_key` podia servir operações de tipos diferentes no `/sync` sem ser detectada                       | Verificação extra: `rejected` com `idempotency_key_conflict` (no lote e entre lotes)               |
| 4   | Apagar partilha de outro autor                                                                                          | Decisão: mantém-se `not_found`                                                                     |
| 5   | Faltavam testes de concorrência e de `stop()` do worker                                                                 | Acrescentados                                                                                      |

### E6 (admin)

| #   | Situação no `featE6-admins`                                                                                         | Resolução                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Aprovar/rejeitar lia o post fora da transacção: dois admins em simultâneo passavam ambos a verificação de estado    | Transacção com `FOR UPDATE`; o segundo recebe `409`                                       |
| 2   | Aprovava qualquer estado diferente do pedido: um post `hidden` (suspenso por apagamento de conta) podia ressuscitar | Só se decide sobre `pending_review`                                                       |
| 3   | Cursores `z.string()` sem validação                                                                                 | Cursores compostos opacos, um tipo por lista; inválido ou de outra lista → `400`          |
| 4   | N+1 (`findById` por post, em `/admin/reports` e `/admin/moderation-log`)                                            | Uma query de títulos por página                                                           |
| 5   | Sem filtro `deleted_at`                                                                                             | Posts apagados fora das listas e do detalhe                                               |
| 6   | Sem limites no painel; auth em `preHandler`                                                                         | `RATE_LIMIT_ADMIN_READ_*` / `_WRITE_*`; `preValidation` (401/403 antes de validar)        |
| 7   | Contagem por severidade (`basic/medium/high`)                                                                       | Por **categoria** (ADR-014), só denúncias abertas                                         |
| 8   | CLI com SQL cru; `demote` contava admins sem bloqueio (dois `demote` em simultâneo deixavam zero admins)            | Serviço `admin-roles.ts` transaccional, com bloqueio partilhado com o apagamento de conta |
| 9   | Respostas com `reporterId`/`moderatorId`                                                                            | Só `username` (`null` = removido ou sistema)                                              |
| 10  | `server.ts` do ramo com registos duplicados de cards, posts e sync                                                  | Mantido o nosso `server.ts`; só se acrescenta o registo do `adminRoutes`                  |

## 2. Alterações

**E5-follow-up** (`bloco-E5-followup-sync-worker.patch`)

- `routes/sync.ts`: `hasKeyConflict` (mapa por lote + consulta à chave gravada).
- `server.ts`: `disableWorker`; worker do outbox e manutenção em `onReady`, paragem em `onClose`.
- Testes: 3 em `sync.test.ts`; 3 em `outbox-worker.test.ts` (concorrência, `stop()` espera a ronda, sem consumo depois de parar); `server-worker.test.ts` (2).

**E6-a** (`bloco-E6a-schema-migracoes-shared-adr.patch`)

- Migração `0005` (`ADD VALUE` `admin.promoted` / `admin.demoted`, sozinha) e `0006` (`moderation_log.target_user_id`, índices `moderation_log_created_idx` e `reports_status_created_idx`), com snapshots e journal. Validadas num Postgres limpo.
- `packages/shared/src/admin.ts` (contratos) e novos tipos de cursor `admin_posts` / `admin_reports` / `admin_log` em `posts.ts`.
- ADR-015 e índices.

**E6-b/c** (`bloco-E6b-admin-servicos-rotas-cli.patch`)

- `repositories/admin.ts`, `repositories/admin-roster.ts` (`lockAdminRoster`, usado também pelo apagamento de conta; ordem de bloqueios: linha do utilizador → bloqueio do conjunto).
- `services/admin.ts`, `services/admin-roles.ts`; `routes/admin.ts`; limites e env; scripts `admin-promote`, `admin-demote` (+ `admin-role-cli.ts`) e `package.json`; `tsconfig` passa a incluir `scripts/`.
- Testes: serviços (`admin.test.ts`), papéis com concorrência (`admin-roles.test.ts`), rotas (`admin.test.ts`), schemas partilhados, limites.

## 3. Decisões

| Tema                           | Escolha                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| Ordem da fila `pending_review` | Do mais antigo para o mais recente (outros estados: mais recente primeiro)         |
| Estados decidíveis             | Só `pending_review` (aprovar e rejeitar)                                           |
| Migrações                      | Escritas à mão (enum à parte); `pnpm db:generate` deve dizer que não há alterações |
| Frontend                       | Fora deste bloco (o ramo não traz `apps/web`)                                      |
| Invalidação do feed            | Só ao aprovar (um post em revisão nunca esteve no feed público)                    |
| Motivo da rejeição             | Não é mostrado ao autor nesta fase (virá nas rotas `/users/me/posts`)              |
| Limites do painel              | Leituras 120/60 s, decisões 30/60 s, por administrador                             |
| Excerto nas listas             | 200 caracteres; o texto completo só no detalhe                                     |

## 4. Verificação

- Feito aqui: migrações num Postgres 16 limpo (0000 → 0006), `tsc` do pacote `shared`, comportamento dos schemas partilhados, `prettier`, `git apply --check` de cada patch sobre o estado anterior.
- Por fazer do lado do projecto (a sandbox não tem as dependências da API): `pnpm db:generate` (sem alterações), `pnpm typecheck`, `pnpm test`.

## 5. Fica para depois

- Painel `/admin` em `apps/web` (E11) e rotas `/users/me/posts|reports`.
- Segundo factor (TOTP) para admins (pós-MVP, ADR-015).
- Retenção do registo de auditoria (hoje sem prazo; não tem dados pessoais além de nomes de utilizador).
