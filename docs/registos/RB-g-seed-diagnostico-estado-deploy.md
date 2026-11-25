# RB-g — Diagnóstico do seed e estado do deploy

- `db:seed` passa a registar `safeErrorFields(err)` (tipo, código SQLSTATE ou de rede, causa) em vez de só
  o nome do erro. Nunca a mensagem. Motivo: o primeiro falhanço mostrava só «Error»; era `42P01`
  (`relation "gospel_cards" does not exist`) por a `DATABASE_URL` apontar para um _branch_ vazio da Neon.
- Runbook «Migrações da base de dados»: passo 0, confirmar o destino (`ep-…`, branch, `\conninfo`,
  `\dt`) antes de migrar, semear ou promover.
- `deploy-backend.md`: Etapas 0 a 4 fechadas; Etapa 5 em curso (ver o ficheiro).
- `admin:promote` exige o utilizador já registado; passa a constar assim na Etapa 7.

**Não validado aqui**: o `seed.ts` não tem teste automático (script de arranque); verificado só com
`prettier`. O `pnpm typecheck` da CI é a confirmação.
