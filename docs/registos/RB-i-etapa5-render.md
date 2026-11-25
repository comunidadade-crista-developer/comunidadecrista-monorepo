# RB-i — Etapa 5 fechada: Render, benchmark e branch da Neon

- **Benchmark do argon2 no Render** (1 CPU visível): hash mediana 203 ms, verify 204 ms, 4 em simultâneo
  mediana 1490 ms (máx 1798 ms), RSS 89 MiB. Dentro do alvo de 500 ms; parâmetros inalterados.
- **`42P01` em todos os arranques.** O logging novo (RB-h) mostrou `errorCode: "42P01"` no worker e na
  manutenção. As migrações, as permissões e o seed tinham sido executados num _branch_ de teste da Neon;
  o Render liga ao principal, que estava vazio. O `/health/deep` deu `ok` porque faz só `SELECT 1`.
  Resolvido ao migrar o principal; logs limpos e seed confirmado (1 card).
- **Lição.** Verificar migrações, privilégios e seed **no branch da `DATABASE_URL` do Render**, não só
  numa ligação qualquer. O passo 0 do runbook (RB-g) cobre isto.
- **Adiado**: `/health/deep` com verificação de esquema (decisão do operador, 2026-11-25).
- **CodeQL (PR do benchmark)**: alerta de «clear-text logging» dispensado como falso positivo (só regista
  os três parâmetros públicos do argon2).

**Pendente**: conteúdo final dos gospel cards (só existe o exemplo).
