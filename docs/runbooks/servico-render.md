# Serviço: Render (API)

**Função**: corre a API Fastify, o worker do outbox e a manutenção (todos no mesmo processo).
**Região**: Frankfurt. **Plano**: gratuito (MVP). **Responsável**: operador.

## 1. Limites do plano gratuito (documentação do Render, 2026-11-20)

| Limite                             | Valor                                                                                                                                      | Efeito                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Uso em produção                    | A documentação do Render diz «não usar em aplicações de produção»                                                                          | Aceitamos no MVP com gatilhos de subida ([gestao-e-controlo](gestao-e-controlo.md) §5). |
| Adormece                           | Após **15 min** sem tráfego; demora **~1 min** a acordar                                                                                   | O cron mantém-na acordada na janela activa; fora dela, o primeiro pedido espera.        |
| Horas                              | **750 horas de instância por mês** (instâncias adormecidas não contam); sem horas, os serviços gratuitos são suspensos até ao mês seguinte | Janela de 17 h/dia ≈ 510 h; 24/7 ≈ 744 h (cabe, mas sem folga para um segundo serviço). |
| Instâncias                         | Uma só; sem _scaling_                                                                                                                      | Sem alta disponibilidade.                                                               |
| Shell/SSH, _jobs_ pontuais, discos | Indisponíveis                                                                                                                              | Os comandos de administração correm **a partir da máquina do operador** (secção 5).     |
| Sistema de ficheiros               | Perde-se a cada _redeploy_, reinício ou adormecer                                                                                          | Nada se guarda em disco (a API já não guarda).                                          |
| Reinícios                          | O Render pode reiniciar o serviço a qualquer momento                                                                                       | O arranque tem de ser seguro (é: migrações são manuais, o worker é idempotente).        |
| Portas de saída                    | 25, 465 e 587 bloqueadas                                                                                                                   | Sem SMTP directo (não usamos; email futuro só por API HTTPS).                           |
| Largura de banda e _build_         | Contam para a quota mensal do espaço de trabalho; sem método de pagamento, esgotar suspende os serviços                                    | Vigiar no painel de utilização.                                                         |

## 2. Criação (Etapa 5)

1. Render → **New → Web Service** → ligar o repositório GitHub, ramo `master`.
2. **Region**: Frankfurt. **Instance type**: Free.
3. **Root directory**: raiz do repositório.
4. **Build command**: `pnpm install --frozen-lockfile && pnpm --filter @comunidade/api build`
5. **Start command**: `node apps/api/dist/index.js`
6. **Health check path**: `/health`.
7. **Auto-Deploy**: **desligado** (deploy manual): as migrações têm de correr **antes** do código novo
   (ver «Migrações da base de dados» no [runbook principal](runbook.md)). Confirmar o nome exacto da opção na consola.
8. **Node**: variável `NODE_VERSION=24.22.3`. A ordem de precedência do Render é `NODE_VERSION` > `.node-version` >
   `.nvmrc` > `engines`; um `.nvmrc` com `24` não indica o _patch_ e serviços novos arrancam com 24.22.1 (anterior ao aviso de
   segurança de 11-11-2026). Confirmar no log de build: `node -v`. Subir de versão é uma decisão explícita.

## 2.1 Benchmark do argon2 (Etapa 5)

O alvo é **menos de 500 ms por hash** no CPU do Render (o plano gratuito tem CPU partilhado e pouca
memória; o argon2id com 19 MiB e 2 iterações pode demorar bastante mais do que num portátil). O Render
gratuito não tem shell, por isso o script `apps/api/scripts/benchmark-argon2.ts` corre **uma vez, como
início temporário** do serviço, e lê-se o resultado nos logs. Não toca na base de dados nem no Redis.

1. Render → Settings → **Start Command** → trocar, temporariamente, por:
   `apps/api/node_modules/.bin/tsx apps/api/scripts/benchmark-argon2.ts; node apps/api/dist/index.js`
   (se o `tsx` não existir em execução, alternativa: `pnpm --filter @comunidade/api benchmark:argon2; node apps/api/dist/index.js`;
   **por confirmar** qual funciona no Render).
2. **Manual Deploy** e abrir os logs: aparece `== Benchmark do argon2id ==` e, no fim, `RESULTADO: OK` ou
   `RESULTADO: ATENÇÃO`. O serviço arranca depois do benchmark (pode demorar cerca de um minuto).
3. **Repor** o Start Command para `node apps/api/dist/index.js` e fazer novo **Manual Deploy**.
4. Anotar os números (mediana, p95, 4 em simultâneo) no registo da etapa.

Se a mediana for >= 500 ms: **não** baixar `ARGON2_MEMORY_KB` (19456) nem `ARGON2_TIME_COST` (2), são os
mínimos de produção e a API recusa arrancar abaixo. As opções são aceitar (e registar), ou um plano com mais
CPU. Para comparar variantes sem mexer no ambiente, o script aceita `--memory-kb`, `--time-cost`,
`--parallelism` e `--rounds`. Localmente: `pnpm --filter @comunidade/api benchmark:argon2`.

## 3. Variáveis de ambiente de produção

Introduzir em Render → Environment; guardar uma cópia **no cofre**. A API recusa arrancar se faltar uma obrigatória.

| Variável                             | Valor                                                                    | Notas                                                  |
| ------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| `NODE_ENV`                           | `production`                                                             | Obrigatória.                                           |
| `NODE_VERSION`                       | `24.22.3`                                                                | Lida pelo Render, não pela API.                        |
| `APP_VERSION`                        | _commit_ ou _tag_ lançada                                                | Atualizar em cada deploy.                              |
| `LOG_LEVEL`                          | `info`                                                                   |                                                        |
| `CORS_ORIGIN`                        | origem(ns) do frontend, separadas por vírgula                            | Sem `*`.                                               |
| `DATABASE_URL`                       | Neon, **role `comunidade_app`**, ligação com _pooler_, `sslmode=require` | Obrigatória.                                           |
| `REDIS_URL`                          | Upstash `rediss://…`                                                     | Obrigatória.                                           |
| `JWT_PRIVATE_JWK` / `JWT_PUBLIC_JWK` | par gerado por `generate-jwt-keys`                                       | Obrigatórias.                                          |
| `IP_HASH_SECRET`                     | `openssl rand -base64 48`                                                | Obrigatória (≥ 32 caracteres).                         |
| `EDGE_MODE`                          | `none`                                                                   | Sem domínio não há Cloudflare à frente.                |
| `TRUST_PROXY`                        | `true`                                                                   | Sem isto todos os clientes partilham o IP do proxy.    |
| `TRUST_PROXY_HOPS`                   | **`3`** (validado em 2026-11-25, secção 6)                               | Por omissão 1; 1 e 2 não chegam no Render.             |
| `DB_POOL_MAX`                        | `5` a `10`                                                               | Uma instância; confirmar o limite de ligações da Neon. |
| `ARGON2_*`                           | por omissão (19456 KiB, 2 iterações, 1)                                  | Mínimos de produção; medir o tempo por hash (Etapa 5). |
| `OUTBOX_WORKER_INTERVAL_MS`          | `5000` (ver risco R2)                                                    | Alargar se a Neon gastar as CU-horas.                  |
| restantes                            | valores por omissão do `.env.example`                                    |                                                        |

`PORT` e `HOST`: o Render fornece a porta; a API escuta em `0.0.0.0`.

## 4. Primeiro deploy e verificação

1. Neon migrada e privilégios atribuídos ([servico-neon](servico-neon.md)).
2. **Manual Deploy** → _Deploy latest commit_.
3. Nos logs: `node -v` = 24.22.3; arranque sem avisos de Redis, base de dados ou proxy.
4. `curl -i https://<servico>.onrender.com/health` → `200`; `/health/deep` → `200` com `db: ok` e `redis: ok`.

## 5. Comandos de administração (sem shell no Render)

Correm **na máquina do operador**, com o repositório na versão em produção:

```
DATABASE_URL='<ligação directa da Neon, role comunidade_app>' \
  pnpm --filter @comunidade/api admin:promote <username>
```

Cuidados: não deixar o `DATABASE_URL` no histórico da _shell_ (usar o cofre ou `read -s`); ligação directa,
não a do _pooler_; fechar a sessão no fim.

## 6. IP real do cliente sem Cloudflare (Etapa 6)

A API resolve o IP com `TRUST_PROXY_HOPS` proxies de confiança. O Render documenta mal a cadeia, por isso **valida-se
na prática**:

1. Arrancar com `TRUST_PROXY=true`, `TRUST_PROXY_HOPS=1`.
2. **Duas redes**: da rede A (por exemplo cabo) fazer 6 logins falhados seguidos com um utilizador que não existe
   (`POST /auth/login`, o balde IP+utilizador é de 5 por 15 min): o 6.º tem de dar `429`. Da rede B (**dados
   móveis**; Wi-Fi e cabo do mesmo router partilham o IP público e não contam como duas redes) fazer **um** login
   falhado com o mesmo utilizador: tem de dar `401`. Se A não chegar ao `429`, ou se B der `429`, o IP não é o do
   cliente (vê-se o da borda do proxy): subir `TRUST_PROXY_HOPS` de um em um (máximo 5) e repetir com **um utilizador
   novo** em cada ronda (os baldes duram 15 min no Redis e sobrevivem a um redeploy).
3. **Cabeçalho forjado**: com o balde da rede A esgotado, repetir o login a partir de A mudando
   `X-Forwarded-For: 1.2.3.4`, depois `5.6.7.8`. O `429` tem de manter-se. Se deixar de actuar, há saltos a mais
   (`TRUST_PROXY_HOPS` demasiado alto): baixar.
4. Registar o valor final neste documento e o resultado do teste.

**Resultado (2026-11-25, `onrender.com`, sem domínio):** com `TRUST_PROXY_HOPS=1` a API via o IP da borda do
Cloudflare do Render (o Render responde com `server: cloudflare` e `cf-ray`): o 6.º login da rede A deu `401`
(as tentativas repartiam-se por várias bordas) e a rede B levou `429` sem ter tentado antes. Com `2` a rede A continuou sem `429`.
Com **`3`**: rede A `401` ×5 e `429` à sexta; rede B (dados móveis) `401`; `X-Forwarded-For: 1.2.3.4`
a partir de A manteve o `429`. Valor final: **`TRUST_PROXY_HOPS=3`**.

O número de saltos depende da infra-estrutura do Render e pode mudar: **repetir este teste** depois de mudanças na
plataforma, de adicionar um domínio ou Cloudflare próprio (passa a `EDGE_MODE=cloudflare`) e se o limite por IP
parecer global (muitos `429` a utilizadores sem relação) ou deixar de actuar.

## 7. Rollback

1. Render → **Events/Deploys** → escolher o deploy anterior → **Rollback** (confirmar o nome da opção na consola).
2. Como as migrações são compatíveis com a versão anterior (_expand/contract_), a versão antiga volta a funcionar com a
   base de dados nova. Se a migração for incompatível, **não** fazer _rollback_ de código: corrigir em frente com
   outra migração, ou restaurar a base (ver [servico-monitorizacao](servico-monitorizacao.md) §4).
3. Registar o incidente ([gestao-e-controlo](gestao-e-controlo.md) §6).

## 8. Rotação de segredos no Render

Ver «Rotação de chaves JWT» no [runbook principal](runbook.md) e [gestao-e-controlo](gestao-e-controlo.md) §3. Alterar
variáveis no Render reinicia o serviço.

## 9. Verificação

- [ ] `NODE_VERSION` 24.22.3 confirmado no log de build.
- [ ] Auto-Deploy desligado.
- [ ] Health check `/health` verde.
- [ ] Teste das duas redes cumprido e o valor de `TRUST_PROXY_HOPS` registado.
- [ ] Rollback ensaiado uma vez com um deploy trivial.
