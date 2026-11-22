# RB-e — Alinhamento a Postgres 17 e contacto de segurança

Primeira etapa do [plano de deploy](../runbooks/deploy-backend.md) (Etapa 1).

- `docker-compose.yml` e o serviço de Postgres da CI passam de `postgres:16-alpine` para `postgres:17-alpine`, igual à versão
  escolhida na Neon.
- O volume local de Postgres 16 não abre em 17: procedimento em «Actualizar o Postgres local» no
  [runbook](../runbooks/runbook.md) (`docker compose down -v`; apaga os dados de desenvolvimento).
- `SECURITY.md` com `seguranca.comunidadecrista@protonmail.com` e ligação ao reporte privado do GitHub.
- Cofre de segredos: Proton Pass (registado no plano de gestão).

**Não validado aqui**: o ambiente de desenvolvimento só tem Postgres 16. As migrações usam SQL standard e `citext`; a
primeira CI em 17 é a confirmação.

**Pendente**: contacto do `CODE_OF_CONDUCT.md` («conduct@<domínio>», ainda por decidir).
