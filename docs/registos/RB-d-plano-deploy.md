# RB-d — Plano de deploy do backend

Plano completo em etapas, runbooks por serviço e plano de gestão e controlo, antes de interligar os serviços.

## Decisões (2026-11-20)

Sem domínio no arranque (`EDGE_MODE=none` com proxy de confiança), Node 24.22.3, Postgres 17, uma só região
(Frankfurt), um operador. Multi-região rejeitada para o MVP: há um único Postgres de escrita e o plano gratuito do
Render só tem uma instância.

## Documentos

- [deploy-backend](../runbooks/deploy-backend.md): decisões, riscos R1 a R7 e as Etapas 0 a 9 com critérios de saída.
- [servico-github](../runbooks/servico-github.md), [servico-neon](../runbooks/servico-neon.md),
  [servico-upstash](../runbooks/servico-upstash.md), [servico-render](../runbooks/servico-render.md),
  [servico-monitorizacao](../runbooks/servico-monitorizacao.md).
- [gestao-e-controlo](../runbooks/gestao-e-controlo.md): papéis, acessos, segredos, mudanças, quotas, incidentes, backups e revisões.

## Riscos encontrados na pesquisa

O Render desaconselha o plano gratuito em produção; o worker do outbox pode esgotar as 100 CU-horas da Neon (estimativa:
~127 com a API acordada 17 h/dia); a Upstash gratuita tem 500 mil comandos/mês; a Neon gratuita só guarda 6 h de histórico.
Cada um tem mitigação e gatilho de subida definidos.

## Validado

O role `comunidade_app` (só DML) foi testado num Postgres 16 local: lê, escreve, usa `FOR UPDATE` e advisory locks, e não
consegue criar nem apagar tabelas.

## Por confirmar na consola (não verificado)

Frankfurt no plano gratuito da Upstash e do Render; comportamento da Upstash ao esgotar a quota; nomes exactos das opções
de Auto-Deploy e Rollback no Render; termos do UptimeRobot; limite de ligações do _pooler_ da Neon.

## Fora deste bloco (precisa de autorização)

Alinhar `docker-compose.yml` e CI a Postgres 17; _script_ de smoke; _script_ de benchmark do argon2; _workflow_ de backup;
worker do outbox com recuo quando não há eventos (se o risco R2 se confirmar).
