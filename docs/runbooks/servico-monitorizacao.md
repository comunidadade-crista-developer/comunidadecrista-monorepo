# Serviço: monitorização, cron e backups

**Função**: manter a API acordada na janela activa, avisar quando falha e guardar cópias da base de dados.
Cobre cron-job.org, o monitor de disponibilidade, os logs do Render e os backups externos.

## 1. cron-job.org (manter acordada)

| Campo     | Valor                                                                                        |
| --------- | -------------------------------------------------------------------------------------------- |
| URL       | `https://<servico>.onrender.com/health` (nunca `/health/deep`: acordaria a Neon e a Upstash) |
| Intervalo | 14 minutos (< 15 min de adormecer)                                                           |
| Janela    | A decidir (ver §2)                                                                           |
| Alertas   | Notificação por falha: confirmar a opção na consola e activar por email                      |

## 2. Janela activa — decisão pendente

O runbook original fixou **06:00–23:00 Europe/Lisbon**. Há público em vários fusos (Moçambique UTC+2, Portugal,
Brasil UTC−3): essa janela deixa o Brasil sem API acordada de madrugada, mas **cada hora acordada custa CU-horas na
Neon (risco R2)**. Escolher com dados: ver as horas de pico reais na primeira semana (Etapa 9) e ajustar. Até lá,
manter a janela do runbook.

## 3. Monitor de disponibilidade

- **UptimeRobot (gratuito)**: intervalo fixo de 5 min; alertas por email. A pesquisa encontrou indicações
  contraditórias sobre o uso comercial do plano gratuito: **confirmar os termos actuais** antes de o usar.
- **Conflito (R6)**: um monitor 24/7 em `/health` mantém a API acordada 24/7 (e a Neon, por causa do worker).
  Configurar o monitor **só na janela activa** (se o serviço o permitir) ou usar apenas os alertas do cron-job.org.
- Monitor a `/health`; um segundo, de baixa frequência, a `/health/deep` (limite de 30 pedidos/min por IP).

## 4. Backups externos (Etapa 8)

A Neon gratuita só dá 6 horas de histórico e 1 _snapshot_ manual: **não chega**.

1. **Diário**: `pg_dump` em formato personalizado, com a ligação directa e um role só de leitura, para um destino
   fora da Neon (um _workflow_ agendado do GitHub com o artefacto cifrado, ou um bucket). O _workflow_ precisa de
   autorização e de um segredo no GitHub com o `DATABASE_URL` de leitura.
2. **Cifrar** os dumps antes de os guardar (contêm hashes e dados de utilizadores).
3. **Retenção**: 7 diários e 4 semanais; apagar o resto.
4. **Restauro testado** (obrigatório antes de dar o backup por válido): restaurar num _branch_ novo da Neon e correr
   `SELECT count(*)` por tabela mais um `/health/deep` apontado a esse _branch_.
5. Documentar o resultado e a data do último restauro testado em [gestao-e-controlo](gestao-e-controlo.md) §7.

## 5. Logs

- Render → Logs: o Render guarda pouco histórico no plano gratuito; para investigar um incidente, exportar logo.
- Eventos a pesquisar: `token_reuse`, `rate_limited`, `5xx`, `Redis indisponível`, `refresh token reenviado`, falhas do outbox.
- Os logs **não contêm IPs, tokens, parâmetros SQL nem mensagens do driver** (só nomes de erro e códigos).

## 6. Verificação

- [ ] O cron mantém a API acordada na janela (primeiro pedido da manhã < 1 s).
- [ ] Um falhanço simulado (pausar o serviço) gera um alerta por email.
- [ ] Um backup diário foi gerado e um restauro foi testado e registado.
