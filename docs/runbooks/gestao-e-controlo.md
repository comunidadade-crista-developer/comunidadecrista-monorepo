# Plano de gestão e controlo (produção)

Define quem faz o quê, como se controlam os acessos, os segredos, as mudanças, os custos e os incidentes, e
quando se revê tudo. Escrito para **um operador** (MVP) e pronto para crescer (§9).
Complementa [deploy-backend](deploy-backend.md) e os runbooks por serviço.

## 1. Papéis

| Papel                 | Quem (MVP)                                          | Responsabilidades                                                                |
| --------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Operador              | o próprio                                           | Deploys, migrações, segredos, alertas, backups, incidentes, revisões periódicas. |
| Revisor de código     | o próprio, com os checks da CI como segunda opinião | PR com CI verde e revisão do diff antes de fundir.                               |
| Moderador (admin app) | o próprio                                           | Fila de revisão no painel admin (ADR-015).                                       |

**Risco do operador único**: se perder o acesso às contas ou ao cofre, tudo pára (R7). Mitigação em §2.

## 2. Controlo de acessos

| Conta / sistema          | Dono     | 2FA                                              | Notas                                                     |
| ------------------------ | -------- | ------------------------------------------------ | --------------------------------------------------------- |
| GitHub                   | operador | chave de segurança ou _app_ + códigos de recurso | Ver [servico-github](servico-github.md).                  |
| Render                   | operador | idem                                             | Quem altera variáveis lê todos os segredos da API.        |
| Neon                     | operador | idem                                             | Dono do projecto = dono da base de dados.                 |
| Upstash                  | operador | idem                                             |                                                           |
| Cloudflare               | operador | idem                                             | Só o Pages (frontend); a API fica fora até haver domínio. |
| Gestor de palavras-passe | operador | chave de segurança                               | Cofre de todos os segredos e códigos de recurso.          |

Regras:

1. **2FA em todas as contas**, com códigos de recurso guardados **fora** do cofre principal (papel em local seguro) —
   é o plano de recuperação do operador único.
2. Palavras-passe únicas e longas, só no cofre; nunca em chat, email, tickets ou no repositório.
3. Um **contacto de emergência** (pessoa de confiança) com instruções seladas para recuperar o cofre, a definir antes
   de haver utilizadores reais (decisão do operador).
4. Ligar a base de dados de produção só a partir da máquina do operador, por ligação directa, com o role mínimo (§3).
5. Revisão de acessos trimestral (§8): quem tem acesso a quê; _tokens_ de API e chaves de implementação não usados são removidos.

## 3. Segredos: inventário e rotação

| Segredo                                 | Onde vive                   | Quem o usa           | Rotação proposta                                   | Procedimento                                      |
| --------------------------------------- | --------------------------- | -------------------- | -------------------------------------------------- | ------------------------------------------------- |
| `JWT_PRIVATE_JWK` / `JWT_PUBLIC_JWK`    | Render + cofre              | API                  | Anual, ou de imediato se houver suspeita           | Runbook «Rotação de chaves JWT» (sem _downtime_)  |
| `IP_HASH_SECRET`                        | Render + cofre              | API                  | Só em incidente (reinicia os contadores de limite) | Trocar e redeploy; os baldes zeram                |
| Palavra-passe `comunidade_app` (Neon)   | Render + cofre              | API, CLI do operador | Semestral, ou em incidente                         | `ALTER ROLE`, actualizar `DATABASE_URL`, redeploy |
| Palavra-passe do dono (Neon)            | cofre                       | operador (migrações) | Semestral, ou em incidente                         | Console da Neon                                   |
| `REDIS_URL` (Upstash)                   | Render + cofre              | API                  | Semestral, ou em incidente                         | Regenerar na consola, actualizar, redeploy        |
| Token/segredo de backup (leitura da BD) | GitHub Secrets + cofre      | _workflow_ de backup | Semestral                                          | Novo role de leitura, actualizar o segredo        |
| `CF_ORIGIN_SECRET` (futuro)             | Render + Cloudflare + cofre | API, Cloudflare      | Semestral                                          | Runbook «Rotação do segredo de origem»            |

Regras: um segredo só existe nos locais da tabela; ao rodar, **apagar o antigo** de todos; registar a data da
última rotação no cofre (campo de nota). Qualquer segredo visto num log, PR, chat ou _screenshot_ é tratado como
comprometido (§6).

## 4. Controlo de mudanças

1. Toda a mudança entra por PR com a CI verde (lint, tipos, testes, build, drift de migrações, auditoria, CodeQL).
2. **Mudanças de esquema**: migração compatível com a versão anterior (_expand/contract_), ponto de retorno antes de
   aplicar, `db:migrate` **antes** do deploy, e os `GRANT` do `comunidade_app` verificados depois.
3. **Mudanças de variáveis no Render**: registadas na tabela do [servico-render](servico-render.md) §3 e no cofre; alteram o
   comportamento e reiniciam o serviço — fazer fora da janela de pico.
4. **Deploys manuais** de um _commit_ de `master` com a CI verde (nunca de `dev`).
5. **Janela de mudança**: preferir a hora de menor tráfego observada; não fazer deploy à sexta ao fim do dia.
6. Cada deploy fica anotado com `APP_VERSION` (o _commit_), data e resultado do _smoke_.

## 5. Quotas, custos e gatilhos de subida

Vigiar **semanalmente** (e ao fim de 48 h do deploy):

| Recurso                          | Limite gratuito             | Alerta (70 %) | Gatilho de subida (90 % ou sintoma)    | Opções                                                                     |
| -------------------------------- | --------------------------- | ------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| Render: horas de instância       | 750 h/mês                   | 525 h         | Horas > 675 ou queixas de _cold start_ | Encurtar a janela do cron; plano pago sem adormecer                        |
| Neon: CU-horas                   | 100 CU-h/mês                | 70 CU-h       | > 90 CU-h antes do dia 25 do mês       | Alargar `OUTBOX_WORKER_INTERVAL_MS`; worker com recuo (código); plano pago |
| Neon: armazenamento              | 1 GB                        | 700 MB        | > 900 MB                               | Purgas e retenção (`moderation_log`, `outbox`); plano pago                 |
| Upstash: comandos                | 500 mil/mês                 | 350 mil       | > 450 mil ou limite esgotado           | Plano por consumo; reduzir o consumo por pedido                            |
| Upstash: dados                   | 250 MB                      | 175 MB        | > 225 MB                               | Rever TTL das chaves                                                       |
| Render: largura de banda/_build_ | quota do espaço de trabalho | consola       | Aviso de suspensão                     | Ligar um método de pagamento com limite de gasto                           |

**Gatilhos de negócio para o plano pago do Render**: utilizadores activos regulares, queixas de lentidão da primeira
abertura, ou necessidade de a API estar acordada 24/7. Decidir com os números da §5 e registar em `docs/registos/`.

## 6. Incidentes

| Gravidade | Exemplos                                                                                       | Resposta           |
| --------- | ---------------------------------------------------------------------------------------------- | ------------------ |
| SEV1      | API fora > 15 min na janela activa; suspeita de fuga de dados ou de segredo; dados corrompidos | Agir de imediato   |
| SEV2      | Degradação (latência, 5xx pontuais, quota esgotada com fallback); falha do backup              | No próprio dia     |
| SEV3      | Aviso do Dependabot, comportamento menor, pedido de utilizador                                 | Na revisão semanal |

Passos: **1.** Conter (suspender o serviço, revogar o segredo, `INCR cc:v1:feed:version`, _rollback_). **2.** Diagnosticar
nos logs (sem IPs nem dados pessoais). **3.** Corrigir à frente ou restaurar. **4.** Rodar os segredos envolvidos.
**5.** Registar em `docs/registos/` (o quê, quando, causa, correcção, o que muda). Em suspeita de fuga de dados pessoais,
avaliar as obrigações legais de notificação (por exemplo o RGPD, 72 horas à autoridade quando aplicável; não é parecer jurídico).

Segredo comprometido: revogar na origem → rodar → redeploy → procurar uso indevido → registar.

## 7. Backups e continuidade

| Objectivo                        | Valor proposto                                                             |
| -------------------------------- | -------------------------------------------------------------------------- |
| RPO (perda máxima de dados)      | 24 h (um `pg_dump` diário); 6 h para erros recentes pelo histórico da Neon |
| RTO (tempo para repor o serviço) | 4 h, com o restauro ensaiado                                               |
| Retenção                         | 7 diários e 4 semanais, cifrados, fora da Neon                             |

**Registo de restauros testados** (preencher):

| Data | Origem do backup | Destino | Resultado | Duração |
| ---- | ---------------- | ------- | --------- | ------- |
|      |                  |         |           |         |

Um backup sem restauro testado não conta como backup.

## 8. Calendário de revisões

| Frequência | O quê                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semanal    | Quotas (§5); PR do Dependabot; alertas; 5xx, `token_reuse` e `rate_limited` nos logs; fila de moderação.                                                  |
| Mensal     | `pnpm audit` e pesquisa de versões ([versoes-e-seguranca](versoes-e-seguranca.md)); Node/Postgres _patch_; teste do _rollback_ se houve mudanças grandes. |
| Trimestral | Revisão de acessos (§2); restauro de backup testado (§7); revisão deste plano; revisão de `SECURITY.md`.                                                  |
| Semestral  | Rotação de palavras-passe e segredos (§3).                                                                                                                |
| Anual      | Rotação das chaves JWT; revisão do modelo de ameaças ([resumo-seguranca](../resumo-seguranca.md)).                                                        |

## 9. Crescer: de um operador para uma equipa

Quando houver uma segunda pessoa: contas nominais (nunca partilhar logins), papéis separados (quem faz deploy ≠ quem
guarda os segredos de rotação), revisão de PR por outra pessoa (activar a revisão obrigatória), cofre partilhado com
permissões, registo de quem acedeu à base de dados, _on-call_ simples e este plano revisto. O TOTP para
administradores da aplicação (ADR-015) e o plano pago do Render e da Neon entram aqui.
