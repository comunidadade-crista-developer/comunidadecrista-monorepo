# Plano de deploy do backend

**Estado** (2026-11-25): decisões aprovadas em 2026-11-20; **Etapas 0 a 6 fechadas** (API no Render, IP real validado); **próxima: Etapa 7**; execução por etapas. Cada etapa tem critério de
saída: só se avança com ele cumprido. Os runbooks por serviço estão ligados em cada etapa; o controlo
contínuo depois do deploy está em [gestao-e-controlo](gestao-e-controlo.md).

## 1. Decisões tomadas

| Tema     | Decisão                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domínio  | **Sem domínio** no arranque. API em `*.onrender.com`; `EDGE_MODE=none`, `TRUST_PROXY=true`, `TRUST_PROXY_HOPS=3` (validado na Etapa 6). Cloudflare à frente só quando houver domínio. |
| Node     | **24.22.3** fixado com `NODE_VERSION` no Render (o Render usa 24.22.1 por omissão em serviços novos, anterior ao aviso de 11-11-2026).                                                |
| Postgres | **17** na Neon; `docker-compose.yml` e CI alinhados (bloco próprio, Etapa 1).                                                                                                         |
| Região   | **Frankfurt** para Render, Neon e Upstash (uma só região; multi-região fica para quando houver adesão).                                                                               |
| Operação | **Um operador** no MVP; o plano de gestão prevê o risco e o crescimento.                                                                                                              |
| Branches | `master` = produção; `dev` = integração.                                                                                                                                              |
| Frontend | Fora deste plano (Cloudflare Pages, depois).                                                                                                                                          |

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

**Nota (2026-11-25)**: as migrações, as permissões e o seed tinham sido feitos num _branch_ de teste e não no **principal**, que é onde o Render liga. Esta etapa só está cumprida quando as quatro verificações (8 migrações, tabelas, privilégios, `SELECT slug FROM gospel_cards`) passam **no branch da `DATABASE_URL` do Render**. Confirmado no principal em 2026-11-25 (1 card).

### Etapa 5 — API no Render ([servico-render](servico-render.md)) ✅

- [x] Serviço criado em Frankfurt, com `NODE_VERSION=24.22.3` (confirmado no log de build), _health check_ em `/health` e **Auto-Deploy desligado** (confirmados na consola).
- [x] Variáveis de produção introduzidas (secção 3 do runbook do Render).
- [x] **Benchmark do argon2** no CPU do Render (2026-11-25, 1 CPU visível): hash mediana **203 ms** (mín 198 ms), verify mediana 204 ms; **4 em simultâneo: mediana 1490 ms**, máx 1798 ms; RSS 89 MiB. Parâmetros mantidos (19456 KiB, 2 iterações, paralelismo 1). Logins simultâneos enfileiram num só CPU: gatilho de subida se o p95 de login passar de ~3 s com tráfego real (script `benchmark-argon2`, procedimento em [servico-render](servico-render.md) §2.1).
- [x] Primeiro deploy manual: `/health` e `/health/deep` respondem `200` (`db: ok`, `redis: ok`).
- [x] Logs sem erros: o primeiro arranque tinha `outbox: worker round failed` e `maintenance failed` com `errorCode: "42P01"` (tabela inexistente). Causa: o branch principal da Neon, onde o Render liga, não tinha as migrações (tinham corrido num _branch_ de teste); o `/health/deep` deu `ok` porque faz só `SELECT 1`. Resolvido ao migrar o principal; logs de 2026-11-25 limpos (`maintenance done`). `HEAD /` e `GET /` a 404 são sondas do Render: normais.
- [ ] Adiado (decisão de 2026-11-25): `/health/deep` verificar também que o esquema existe (por exemplo `to_regclass('public.users')`), para apanhar uma base vazia ou do _branch_ errado.

**Saída**: `GET /health` e `GET /health/deep` respondem `200`; nos logs não há erros.

### Etapa 6 — Borda e IP real (sem domínio) ✅

- [x] `TRUST_PROXY=true` e `EDGE_MODE=none`. Número de saltos descoberto: **`TRUST_PROXY_HOPS=3`** (1 e 2 não chegam; ver [servico-render](servico-render.md) §6).
- [x] Teste de duas redes (2026-11-25): rede A (cabo) `401` ×5 e `429` à sexta; rede B (dados móveis) `401`; `X-Forwarded-For` forjado a partir de A manteve o `429`.
- [x] `CORS_ORIGIN=http://localhost:5173` (só enquanto não há frontend; passa à origem real quando houver).
- [x] Aviso de arranque de proxy (RB-a) ausente nos logs (arranque de 2026-11-25, sem erros).

**Saída**: o limite por IP é por cliente, não global, e não é contornável com cabeçalhos forjados. **Repetir o teste** se a plataforma, o domínio ou a borda mudarem.

### Etapa 7 — Smoke test funcional

- [ ] _Script_ de smoke repetível (`pnpm --filter @comunidade/api smoke --base-url=https://<serviço>.onrender.com`, ver abaixo): registo, login, `GET /auth/me`, refresh (rotação, tolerância e reutilização), logout, recuperação (código e perguntas), cards (ETag/304), feed, criar partilha (idempotência), gostar, denunciar, `/sync` e `/sync/bootstrap`, limpeza.
- [ ] Primeiro admin: **registar primeiro o utilizador pela API de produção**; depois `admin:promote <username>` a partir da máquina do operador com o `DATABASE_URL` de produção (directa, `comunidade_app`; testar a ligação antes, ver `ETIMEDOUT` de 2026-11-24); aprovar e rejeitar uma partilha.
- [ ] Limites: provocar um `429` num fluxo seguro.
- [ ] Medir comandos Redis por fluxo na consola da Upstash (R3).

**Como correr o _script_** (`apps/api/scripts/smoke.ts`, a partir da máquina do operador; não precisa de variáveis do projecto):

- Cria **duas contas descartáveis** (`smoke-<sufixo>-a` e `-b`) na base de produção, percorre os fluxos e, no fim, apaga as partilhas e pede o apagamento das contas (ficam `pending_deletion` até ao fim do período de graça; o _job_ de manutenção purga-as).
- Só imprime `OK`/`FALHA`/`SALTADO`, o código HTTP e o código de erro da API; nunca palavras-passe, tokens, códigos de recuperação nem corpos de resposta. Os segredos são gerados ao acaso e vivem só em memória.
- O primeiro passo espera que a API acorde (plano gratuito: até ~1 min; `--wake-timeout-s`). O passo da reutilização do refresh espera a janela de tolerância (`--reuse-grace-s`, 10 s por omissão) e demora cerca de 12 s.
- `--rate-limit` acrescenta o passo do `429` (esgota o limite de `/gospel-cards`, por omissão 120 pedidos por 60 s e por IP, até ao `429` com `Retry-After`; se `RATE_LIMIT_CARDS_MAX` for outro, usar `--rate-limit-max`; ~160 pedidos, uns centenas de comandos Redis); cumpre o item «Limites» sem tocar em fluxos de conta.
- **Cabem 2 execuções por hora** (registo: 5 por hora e por IP; cada execução usa 2). Cada execução deixa **2 avisos `token_reuse`** nos logs (reutilização propositada e _refresh_ depois do _logout_): não contam para a revisão da Etapa 9 se coincidirem com a hora do smoke.
- Sai com código `0` só se todos os passos forem `OK`; `FALHA` ou `SALTADO` dão `1`.
- Fora do _script_ (manual): `admin:promote`, aprovar e rejeitar uma partilha, e medir os comandos Redis na consola da Upstash (anotar o consumo antes e depois de uma execução).

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
