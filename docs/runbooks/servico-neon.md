# Serviço: Neon (PostgreSQL 17)

**Função**: base de dados de produção. **Região**: Frankfurt. **Plano**: gratuito (MVP).
**Responsável**: operador. Variáveis relacionadas: `DATABASE_URL`, `DB_POOL_MAX`, `DB_QUERY_TIMEOUT_MS`.

## 1. Limites do plano gratuito (pesquisa de 2026-11-20; confirmar na consola)

| Limite               | Valor                                                   | Efeito para nós                                                                                           |
| -------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Armazenamento        | 1 GB por projecto                                       | Vigiar o crescimento (`posts`, `moderation_log`, `outbox`).                                               |
| Compute              | 100 CU-horas por projecto por mês; auto-escala até 2 CU | **Risco R2**: o worker do outbox mantém o compute ligado enquanto a API está acordada.                    |
| Suspensão automática | 5 min sem actividade; não se desliga no plano gratuito  | Primeira ligação depois de suspensa tem uma pequena demora.                                               |
| Histórico/restauro   | 6 horas, até 1 GB de alterações; 1 _snapshot_ manual    | **Risco R5**: não substitui um backup externo (ver [servico-monitorizacao](servico-monitorizacao.md) §4). |
| _Branches_           | 10 por projecto                                         | Úteis para testar migrações e restauros.                                                                  |

## 2. Criação (Etapa 2)

1. Neon → **New project**: região **AWS Europe (Frankfurt)**, **Postgres 17**, nome `comunidade-crista`.
2. Anotar as duas _strings_ de ligação: **directa** (para migrações e CLI) e **com _pooler_** (host com
   `-pooler`, para a API). Ambas com `sslmode=require`.
3. Guardar as _strings_ no cofre; nunca no repositório.

## 3. Roles e privilégios (mínimo necessário)

A API não precisa de criar nem alterar tabelas: usa um role só de leitura e escrita de dados. O dono do
projecto serve apenas as migrações e a administração.

Num _branch_ de teste da Neon (ou localmente), validar primeiro; depois em produção, como dono:

```sql
CREATE ROLE comunidade_app LOGIN PASSWORD '<palavra-passe forte, só no cofre>';
REVOKE ALL ON SCHEMA public FROM comunidade_app;
GRANT USAGE ON SCHEMA public TO comunidade_app;
```

**Depois das migrações** (e depois de cada migração que acrescente tabelas):

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO comunidade_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO comunidade_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO comunidade_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO comunidade_app;
```

Limites no role (o _pooler_ recusa-os como parâmetros de ligação; ver runbook principal):

```sql
ALTER ROLE comunidade_app SET statement_timeout = '10s';
ALTER ROLE comunidade_app SET idle_in_transaction_session_timeout = '15s';
```

Validado em Postgres 16 local: com este role, `INSERT`, `UPDATE`, `DELETE`, `SELECT … FOR UPDATE` e
`pg_advisory_xact_lock` funcionam; `CREATE TABLE` e `DROP TABLE` são recusados.

| Uso                              | Role e ligação                         |
| -------------------------------- | -------------------------------------- |
| API no Render                    | `comunidade_app`, ligação com _pooler_ |
| `db:migrate`                     | dono, ligação **directa**              |
| `admin:promote` / `admin:demote` | `comunidade_app` (só faz DML), directa |

## 4. Migrações e atribuição de privilégios

Seguir «Migrações da base de dados» no [runbook principal](runbook.md) e, **logo a seguir a cada
migração**, voltar a correr os `GRANT … ON ALL TABLES` acima (as _default privileges_ cobrem as tabelas novas
criadas pelo mesmo dono, mas confirmar).

## 5. Operação

- **Consumo**: Neon → Monitoring: CU-horas e armazenamento. Alerta interno a 70 % (ver [gestao-e-controlo](gestao-e-controlo.md) §5).
- **Ligações**: `DB_POOL_MAX` (por omissão 10) × instâncias da API ≤ limite de ligações do _pooler_ (confirmar na consola).
- **Ponto de retorno antes de migrar**: criar um _branch_ da Neon a partir do ramo principal.
- **Restauro**: ver [servico-monitorizacao](servico-monitorizacao.md) §4.
- **Rodar a palavra-passe do `comunidade_app`**: `ALTER ROLE … PASSWORD …`, actualizar `DATABASE_URL` no Render e redeploy.

## 6. Verificação

- [ ] `psql` com o role da aplicação lê e escreve; `CREATE TABLE` é recusado.
- [ ] `SHOW statement_timeout;` devolve `10s` com o role da aplicação.
- [ ] `SELECT version();` mostra 17.x.
- [ ] `/health/deep` devolve `db: ok` a partir da API.
