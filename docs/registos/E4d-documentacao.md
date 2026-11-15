# E4-d — Documentação (ADRs, arquitectura, API, especificação)

Data: 2026-11-15 · Fecha o E4 (E4-a base, E4-b serviços, E4-c rotas/cache/sync, E4-d documentação).
Só documentação: não há alterações de código nem de testes.

## 1. Check — o que a comparação com o `dev` mostrou

| #   | Situação                                                                                                                                                                                  | Resolução                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | O `dev` tem os ADR-001 a 012 dentro do `arquitectura.md` (já actualizados: `kid` no ADR-006, apagamento no ADR-012); o E4 tinha-os em ficheiros, mas com textos antigos e **sem** ADR-012 | Um ficheiro por ADR em `docs/Arquitectura/adr/`, a partir do texto do `dev` |
| 2   | ADR-013 e ADR-014 do E4 descreviam regras já ultrapassadas (limiar `doctrine` 2, categorias, «cancelar» a apagar, esquema da migração)                                                    | Reescritos conforme a implementação, com nota de revisão                    |
| 3   | A especificação `filtro anti-spam.md` mantinha o «pendente por conta nova» rejeitado no ADR-013 e variáveis de ambiente que não existem                                                   | Reescrita (v2); o ADR prevalece; testes 24, 25 e 29 retirados               |
| 4   | O modelo de dados do `arquitectura.md` estava desactualizado (E4-a/b) e dava `users.deleted_at` como «pedido de apagamento»                                                               | Diagrama e notas corrigidos                                                 |
| 5   | O `arquitectura.md` dizia `Base: /api/v1`; o `api.md` diz que não há prefixo                                                                                                              | Alinhado (sem prefixo)                                                      |
| 6   | O `api.md` só documentava health e gospel cards                                                                                                                                           | Passa a cobrir convenções, auth/conta, partilhas, likes, denúncias, `/sync` |
| 7   | Estratégia de cache sem o feed; secção de sync sem os estados de resultado                                                                                                                | §8 e §9 actualizadas                                                        |
| 8   | Runbook sem as novas variáveis nem sintomas do feed/outbox/sync                                                                                                                           | Acrescentados                                                               |

## 2. Alterações

- `docs/Arquitectura/adr/` (novo): `README.md` (índice) e `ADR-001` … `ADR-014`, um por ficheiro.
  - ADR-004, 005, 007 e 012 ganham uma nota de estado do E4-b/E4-c (cache do feed, worker do outbox, contrato do `/sync`, conta pendente sem escrita).
  - ADR-013 e ADR-014 reescritos; o ADR-014 regista a revisão do limiar de `doctrine` (2 → 3).
- `docs/Arquitectura/arquitectura.md`: §4 passa a índice dos ADRs; §5 modelo de dados; §6 rotas (partilhas, conta, `/sync`, `/sync/bootstrap`, estado «planeado» de `/users/me/*` e `/admin/*`); §8 resultados do `/sync`; §9 cache do feed; §11 limites e privacidade.
- `docs/api/api.md`: reescrito (convenções de erro e cache, limites, partilhas, denúncias, sync).
- `docs/Arquitectura/spec/filtro anti-spam.md`: v2, alinhada com os ADRs.
- `docs/runbooks/runbook.md`: variáveis opcionais do E4; incidentes (feed desactualizado, outbox, `deferred` no `/sync`).

## 3. Decisões

| Tema                    | Escolha                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| Fonte de verdade        | Código e ADRs; a especificação passa a documento histórico de referência |
| Texto dos ADR-001 a 012 | O do `dev` (mais recente), sem mudanças de decisão; só notas de estado   |
| Rotas ainda não feitas  | Listadas como «Planeado» (`/users/me/*`, `/admin/*`), não escondidas     |

## 4. Fica para depois

- `resumo-seguranca.md` (revisão geral) e `plano-de-construcao.md` (estado das tarefas do E4).
- Documentar as rotas de recuperação e de conta com exemplos completos (hoje só o resumo e os schemas de `packages/shared`).
- Fase própria (D12): `/users/me/posts`, `/users/me/reports`, `PATCH /users/me`, `POST /users/me/password`.

## 5. Como verificar

Sem código a testar. Conferir que as ligações relativas dos ADRs funcionam (`adr/ADR-0NN.md` a partir de `arquitectura.md`, `../adr/…` a partir da especificação) e que `pnpm typecheck` / `pnpm test` continuam verdes (não são afectados).
