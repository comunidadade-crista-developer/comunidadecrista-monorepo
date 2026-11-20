# RB-b — Migrações em produção e tolerância no refresh

Segundo bloco da revisão do backend (achados 5 e 6).

| Achado | Alteração                                                                                                                                                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5      | Migração `0007_refresh_rotated_at` (`refresh_tokens.rotated_at`). `rotate` tolera o reenvio de um token rotacionado há menos de `REFRESH_REUSE_GRACE_S` (10 s) emitindo um token novo na mesma família. O logout revoga a família. |
| 5      | Contrato do cliente (_single-flight_ com Web Locks) em `api.md`, «Refresh». A implementação fica para o `apps/web`.                                                                                                                |
| 6      | Runbook: secção «Migrações da base de dados» (ordem, _expand/contract_, ponto de retorno, regras). CI: `drizzle-kit check` e `generate` sem alterações.                                                                            |

Testes novos em `test/routes/auth.refresh.test.ts`: reenvio dentro da janela, pedidos simultâneos,
fora da janela, após logout do token filho, token revogado por logout, coluna `rotated_at`.

Limitação: o passo novo da CI e o snapshot `0007` (escrito à mão) não puderam ser executados com o
`drizzle-kit` no ambiente de desenvolvimento; a primeira execução da CI confirma-os.
