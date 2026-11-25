# Plano de deploy do backend

**Estado** (2026-11-24): decisões aprovadas em 2026-11-20; **Etapas 0 a 4 fechadas, Etapa 5 em curso** (API no Render com `/health` e `/health/deep` a 200); execução por etapas. Cada etapa tem critério de
saída: só se avança com ele cumprido. Os runbooks por serviço estão ligados em cada etapa; o controlo
contínuo depois do deploy está em [gestao-e-controlo](gestao-e-controlo.md).

## 1. Decisões tomadas

| Tema     | Decisão                                                                                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domínio  | **Sem domínio** no arranque. API em `*.onrender.com`; `EDGE_MODE=none`, `TRUST_PROXY=true`, `TRUST_PROXY_HOPS` a validar (Etapa 6). Cloudflare à frente só quando houver domínio. |
| Node     | **24.22.3** fixado com `NODE_VERSION` no Render (o Render usa 24.22.1 por omissão em serviços novos, anterior ao aviso de 11-11-2026).                                            |
| Postgres | **17** na Neon; `docker-compose.yml` e CI alinhados (bloco próprio, Etapa 1).                                                                                                     |
| Região   | **Frankfurt** para Render, Neon e Upstash (uma só região; multi-região fica para quando houver adesão).                                                                           |
| Operação | **Um operador** no MVP; o plano de gestão prevê o risco e o crescimento.                                                                                                          |
| Branches | `master` = produção; `dev` = integração.                                                                                                                                          |
| Frontend | Fora deste plano (Cloudflare Pages, depois).                                                                                                                                      |

## 2. Riscos identificados na pesquisa (2026-11-20)

| #   | Risco                                                                                                                                                                                                                                                                                                            | Mitigação / decisão                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | A documentação do Render diz para **não usar o plano gratuito em produção**: a API adormece após 15 min sem tráfego (~1 min a acordar), pode reiniciar a qualquer momento, não há shell nem _jobs_ pontuais e há 750 horas de instância por mês. O worker do outbox e a manutenção só correm com a API acordada. | Arrancar no gratuito (decisão do MVP) com **gatilhos de subida** definidos em [gestao-e-controlo](gestao-e-controlo.md) §5. A ausência de shell é contornada com os comandos a partir da máquina do operador.                                            |
| R2  | **Neon gratuita: 100 CU-horas/mês**. O worker do outbox consulta a base de dados de 5 em 5 s enquanto a API está acordada, e a Neon só suspende após 5 min sem actividade: com a API acordada 17 h/dia, o compute fica ligado ~510 h/mês, o que a 0,25 CU dá ~127 CU-h (**estimativa**, acima das 100).          | Medir o consumo real na primeira semana (Etapa 9). Opções por ordem: encurtar a janela do cron; alargar `OUTBOX_WORKER_INTERVAL_MS`; **mudar o worker para recuar quando não há eventos** (alteração de código, precisa de autorização); subir de plano. |
| R3  | **Upstash gratuita: 500 mil comandos/mês e 250 MB**. O rate limit e a cache gastam comandos em quase todos os pedidos; poucos milhares de pedidos por dia podem esgotá-los. Se o Redis falhar, o limitador cai para memória (por instância) e a cache do feed fica só em L1.                                     | Medir comandos por fluxo (Etapa 7), alertar a 70 % (Etapa 8) e subir para o plano por consumo antes de esgotar.                                                                                                                                          |
| R4  | **Sem Cloudflare à frente**: sem WAF nem protecção de DDoS na borda; o IP vem de `X-Forwarded-For` do proxy do Render.                                                                                                                                                                                           | Limites da API (global, por rota, por conta), corpo e tempo máximos; validar o IP real (Etapa 6); Cloudflare quando houver domínio (runbook «IP do cliente, proxy e Cloudflare»).                                                                        |
| R5  | **Backups da Neon gratuita: 6 h de histórico e 1 _snapshot_ manual.** Um erro descoberto no dia seguinte não se recupera pela Neon.                                                                                                                                                                              | `pg_dump` diário para fora da Neon (Etapa 8), com restauro testado.                                                                                                                                                                                      |
| R6  | **Monitorização 24/7 contra a janela de adormecer**: um monitor que bata em `/health` a toda a hora mantém a API acordada 24/7 e, por R2, a base de dados também.                                                                                                                                                | Monitores só na janela activa, ou aceitar o custo (ver [servico-monitorizacao](servico-monitorizacao.md)).                                                                                                                                               |
| R7  | **Operador único**: perda de acesso às contas ou aos segredos pára tudo.                                                                                                                                                                                                                                         | Cofre de recuperação e 2FA com códigos de recurso ([gestao-e-controlo](gestao-e-controlo.md) §2).                                                                                                                                                        |

## 3. Etapas

### Etapa 0 — Decisões e pré-requisitos ✅ (decisões tomadas)

- [x] Domínio, Node, Postgres, região, operação (secção 1).
- [x] Contas criadas (Neon, Upstash, Render, Cloudflare), ainda **não interligadas**.
- [x] Email de segurança: `seguranca.comunidadecrista@protonmail.com` (no `SECURITY.md`).
- [x] Gestor de palavras-passe: **Proton Pass** (cofre dos segredos).
- [x] Contacto do `CODE_OF_CONDUCT.md`: o mesmo email de segurança (RB-f).

**Saída**: tudo marcado.

### Etapa 1 — Repositório pronto ([servico-github](servico-github.md)) ✅

- [x] Branch `master` protegida; checks obrigatórios: _Lint, Typecheck, Test, Build_, _Dependency audit_ e _CodeQL_.
- [x] _Secret scanning_, _push protection_, _Dependabot alerts_ e _private vulnerability reporting_ activos.
- [x] **Alinhamento a Postgres 17** (`docker-compose.yml` e CI): obriga a recriar o volume local (runbook «Actualizar o Postgres local»); a CI confirma as migrações em 17.
- [x] `SECURITY.md` com o contacto real.
- [x] CI verde em `dev` e `master`; `pnpm audit` sem resultados.
- [x] Teste local do build de produção: `pnpm build` e `node apps/api/dist/index.js` com `NODE_ENV=production` e variáveis de teste.

**Saída**: o build de produção arranca localmente e a CI está verde.

### Etapa 2 — Dados ([servico-neon](servico-neon.md), [servico-upstash](servico-upstash.md)) ✅

- [x] Neon: projecto em Frankfurt, Postgres 17, _autosuspend_ de 5 min (não se desliga no plano gratuito).
- [x] Neon: roles separados — dono (migrações) e `comunidade_app` (só DML), com os _timeouts_ no role da aplicação.
- [x] Upstash: base de dados em Frankfurt (confirmar disponibilidade na consola), TLS, `rediss://`.
- [x] Guardar as duas _strings_ de ligação da Neon (directa e _pooler_) e a do Redis no cofre.

**Saída**: `psql` e `redis-cli` ligam com as credenciais finais; o role da aplicação não consegue criar tabelas.

### Etapa 3 — Segredos ([gestao-e-controlo](gestao-e-controlo.md) §2) ✅

- [x] Par de chaves JWT: `pnpm --filter @comunidade/api generate-jwt-keys`.
- [x] `IP_HASH_SECRET`: `openssl rand -base64 48`.
- [x] Tabela de variáveis de produção preenchida ([servico-render](servico-render.md) §3), com cópia no cofre.

**Saída**: nenhuma variável obrigatória em falta (a API recusa arrancar sem elas).

### Etapa 4 — Migrar e semear ✅

- [x] `db:migrate` contra a Neon pela ligação **directa**, como dono (runbook «Migrações da base de dados»).
- [x] Verificar as 8 migrações em `drizzle.__drizzle_migrations` e as tabelas.
- [x] Atribuir os privilégios ao `comunidade_app` ([servico-neon](servico-neon.md) §4).
- [x] `db:seed` executado (só o card de exemplo; o seed é idempotente).
- [ ] Conteúdo final dos _gospel cards_ (a fornecer): substituir `seed-data/cards.json` e repetir o seed. **Não bloqueia o deploy.**

**Saída**: esquema e _seed_ verificados por queries; o role da aplicação lê e escreve.

**Nota (2026-11-24)**: o primeiro seed falhou por a `DATABASE_URL` apontar para outro _branch_ da Neon (vazio). Passo de confirmação do destino no runbook, «Migrações da base de dados», passo 0.

### Etapa 5 — API no Render ([servico-render](servico-render.md))

- [ ] Serviço criado em Frankfurt, com `NODE_VERSION=24.22.3` (**confirmado no log de build**), _health check_ em `/health` e **Auto-Deploy desligado** (falta confirmar estes dois na consola).
- [x] Variáveis de produção introduzidas (secção 3 do runbook do Render).
- [ ] **Benchmark do argon2** no CPU do Render: alvo < 500 ms por hash; ajustar `ARGON2_*` sem ir abaixo dos mínimos de produção (um _script_ de medição é opcional, _precisa de autorização_).
- [x] Primeiro deploy manual: `/health` e `/health/deep` respondem `200` (`db: ok`, `redis: ok`).
- [ ] Logs sem erros: no primeiro arranque houve `outbox: worker round failed` e `maintenance failed` repetidos (provável `DATABASE_URL` do _branch_ errado, já corrigida); confirmar que desapareceram nos logs seguintes. `HEAD /` e `GET /` a 404 são sondas do Render: normais.

**Saída**: `GET /health` e `GET /health/deep` respondem `200`; nos logs não há erros.

### Etapa 6 — Borda e IP real (sem domínio)

- [ ] `TRUST_PROXY=true` e `EDGE_MODE=none`. Descobrir o número de saltos: ver [servico-render](servico-render.md) §6.
- [ ] Teste de duas redes: esgotar um limite (registo) numa rede e confirmar que **outra rede** (dados móveis) não fica bloqueada; confirmar que um `X-Forwarded-For` forjado não contorna o limite.
- [ ] `CORS_ORIGIN` com a origem do frontend (ou `http://localhost:5173` só enquanto não há frontend).
- [ ] Aviso de arranque de proxy (RB-a) ausente nos logs.

**Saída**: o limite por IP é por cliente, não global, e não é contornável com cabeçalhos forjados.

### Etapa 7 — Smoke test funcional

- [ ] Registo, login, `GET /auth/me`, refresh, logout, recuperação (código e perguntas).
- [ ] Feed, criar partilha, gostar, denunciar, `/sync`.
- [ ] Primeiro admin: **registar primeiro o utilizador pela API de produção**; depois `admin:promote <username>` a partir da máquina do operador com o `DATABASE_URL` de produção (directa, `comunidade_app`; testar a ligação antes, ver `ETIMEDOUT` de 2026-11-24); aprovar e rejeitar uma partilha.
- [ ] Limites: provocar um `429` num fluxo seguro.
- [ ] Medir comandos Redis por fluxo na consola da Upstash (R3).
- [ ] Opcional: _script_ de smoke repetível (_precisa de autorização_).

**Saída**: todos os fluxos verdes em produção e o consumo por fluxo anotado.

### Etapa 8 — Operação ([servico-monitorizacao](servico-monitorizacao.md))

- [ ] Cron de `/health` (14 min, janela decidida) e monitor de disponibilidade.
- [ ] Alertas por email: falha de `/health`, 5xx, quotas (Neon CU-horas, Upstash comandos, Render horas).
- [ ] Backup diário com `pg_dump` (_workflow_ do GitHub: precisa de autorização) e **restauro testado** num _branch_ da Neon.
- [ ] Procedimento de _rollback_ ensaiado ([servico-render](servico-render.md) §7).

**Saída**: um restauro de backup e um _rollback_ ensaiados.

### Etapa 9 — Go/no-go e observação (48 h)

- [ ] Lista de [versoes-e-seguranca](versoes-e-seguranca.md) §5 cumprida e pesquisa de versões repetida.
- [ ] Revisão ao fim de 48 h e de 7 dias: `token_reuse`, 5xx, `rate_limited`, _cold starts_, consumo das quotas (R1 a R3).
- [ ] Decisão registada: manter o plano gratuito ou activar um gatilho de subida.

**Saída**: registo `docs/registos/` da primeira semana em produção.

## 4. Ordem de um deploy normal (depois da Etapa 5)

1. CI verde em `master`.
2. Se há migrações: backup/ponto de retorno e `db:migrate` (compatível com a versão anterior).
3. Deploy manual no Render do _commit_ de `master`.
4. Verificar `/health`, `/health/deep` e os logs; correr o _smoke_.
5. Se falhar: _rollback_ para o deploy anterior (as migrações compatíveis permitem-no).
