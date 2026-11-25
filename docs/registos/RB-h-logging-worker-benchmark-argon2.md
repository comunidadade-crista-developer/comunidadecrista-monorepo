# RB-h — Logging do worker e benchmark do argon2

- `outbox-worker.ts` (ronda falhada e handler falhado) e `maintenance.ts` passam a registar
  `safeErrorFields(err)`: nome, código (SQLSTATE, `ETIMEDOUT`...) e causa; nunca a mensagem. Antes só
  saía `errorName: "Error"`, o que escondia a causa dos `worker round failed` e `maintenance failed`
  vistos no primeiro arranque no Render. Testes novos garantem que o código aparece e que um texto
  sensível na mensagem não chega ao log.
- Novo script `apps/api/scripts/benchmark-argon2.ts` (`pnpm --filter @comunidade/api benchmark:argon2`):
  mede hash e verify sequenciais, 4 hashes em simultâneo e a memória, contra o alvo de 500 ms. Procedimento
  no Render sem shell em [servico-render](../runbooks/servico-render.md) §2.1.

**Não validado aqui**: o sandbox não instala `@node-rs/argon2`, `vitest` nem corre o `tsc` da API. A lógica do
benchmark foi exercitada com um _stub_ do argon2 (medições não representativas) e os ficheiros foram
formatados com `prettier`. O `pnpm typecheck` e o `pnpm test` do utilizador são a confirmação.
**Por confirmar**: qual dos dois comandos de início temporário funciona no Render.
