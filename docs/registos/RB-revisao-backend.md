# RB — Revisão do backend (2026-11-20)

Revisão completa do backend depois de fechar o painel de administração (E6), enquanto o frontend
aguarda. Dividida em três blocos: [RB-a](RB-a-hardening.md) (endurecimento),
[RB-b](RB-b-migracoes-refresh.md) (migrações e refresh) e RB-c (este registo, a actualização dos
documentos e a pesquisa de versões para o deploy, em [versoes-e-seguranca](../runbooks/versoes-e-seguranca.md)).

## 1. Contexto

Backend Fastify 5 + drizzle + Postgres + Redis com E0 a E6 concluídos e testes verdes. A revisão
procurou riscos de produção com vários clientes em simultâneo, fugas de dados nos logs e desvios
entre a documentação e o código.

## 2. Check — achados

| #   | Gravidade | Achado                                                                                                                                                        | Estado                                                                   |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Alta      | `isUniqueViolation` não via o código dentro de `DrizzleQueryError.cause`: registo concorrente dava `500` e o log com `{ err }` expunha a query e os hashes    | Corrigido (RB-a)                                                         |
| 2   | Alta      | Produção arrancava sem `DATABASE_URL`/`REDIS_URL`; com `EDGE_MODE=none` e `TRUST_PROXY=false` atrás do Render todos os utilizadores partilhavam o IP do proxy | Corrigido (RB-a)                                                         |
| 3   | Média     | Limite global de 100/min (memória) abaixo dos baldes de 120/min: utilizadores atrás do mesmo IP (CGNAT) bloqueados                                            | Corrigido (RB-a): 300/min configurável                                   |
| 4   | Média     | `/health/deep` público abria uma ligação nova ao Postgres por pedido                                                                                          | Corrigido (RB-a): pool, timeout, limite 30/min                           |
| 5   | Média     | Reutilização de refresh token (vários separadores, retry) revogava a família                                                                                  | Corrigido (RB-b): tolerância de 10 s                                     |
| 6   | Média     | Migrações em produção sem procedimento; CI sem verificação de desvio                                                                                          | Corrigido (RB-b): runbook e passo de CI                                  |
| 7   | Média     | Sem limite de corpo nem de tempo de pedido                                                                                                                    | Corrigido (RB-a)                                                         |
| 8   | Baixa     | CORS com `credentials: true` sem haver cookies                                                                                                                | Corrigido (RB-a)                                                         |
| 9   | Baixa     | Sem mínimos de argon2 em produção; `index.ts` registava `err`                                                                                                 | Corrigido (RB-a)                                                         |
| 10  | Info      | Access token de 15 min continua válido depois do logout                                                                                                       | Aceite (ADR-006); `requireAdmin` revalida na BD                          |
| 11  | Info      | Bloqueio por conta no login permite negar o acesso a uma conta alvo (compromisso conhecido do rate limit por conta)                                           | Aceite; mitigado pelos baldes por IP e pelo balde por conta mais folgado |
| 12  | Info      | `SECURITY.md` com contacto «a configurar»; sem _secret scanning_ activo                                                                                       | Pendente (antes do deploy)                                               |
| 13  | Info      | Faltavam testes: registo e refresh concorrentes, `/health/deep`, limites                                                                                      | Cobertos em RB-a/RB-b; limitador com Redis em baixo continua por cobrir  |

## 3. Decisões

- **Tolerância do refresh** (decisão do utilizador, desenho nosso): coluna `rotated_at` para só tolerar
  tokens substituídos por rotação; novo token na mesma família; logout revoga a família. Custo
  aceite e registado no [ADR-006](../Arquitectura/adr/ADR-006.md).
- **Migrações manuais antes do deploy** em vez de no arranque da API: evita corridas entre
  instâncias e um arranque lento no plano gratuito do Render.
- **Nomenclatura**: blocos `RB-*` (não `E7`, que é o scaffold do frontend no plano).

## 4. Segurança e privacidade

Nenhum log novo contém IP, parâmetros SQL, tokens ou mensagens de erro do driver
(`safeErrorFields`). O novo log de reenvio dentro da tolerância regista só o `familyId`.

## 5. Testes

Suite completa verde depois de cada bloco (711 testes no fim do RB-b). Novos: `errors`,
`http-errors`, `env`, `server.limits`, registo concorrente, tolerância do refresh.

## 6. Pendente

- Antes do deploy: ver [versoes-e-seguranca](../runbooks/versoes-e-seguranca.md) (Node, Postgres, lista de
  verificação) e preencher o contacto em `SECURITY.md`.
- Activar _secret scanning_ e _push protection_ no GitHub; avaliar `gitleaks` na CI.
- Teste do limitador com o Redis em baixo.
- Retenção do registo de auditoria (`moderation_log`).
- `/users/me/*` (alterar palavra-passe e username, listas de posts e denúncias) e painel admin no
  `apps/web`; TOTP para administradores (depois do MVP).
