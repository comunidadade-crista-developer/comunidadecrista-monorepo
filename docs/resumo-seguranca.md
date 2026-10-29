# Comunidade Cristã — Revisão de segurança: resumo e backlog

Data: 2026-10-28 · Âmbito: monorepo (API Fastify, shared, CI) · Estado: `pnpm audit` sem vulnerabilidades, testes verdes.

---

## 1. O que foi feito

### 1.1 Cloudflare à frente da API (modo de borda)
- Novo `EDGE_MODE=none|cloudflare`. Em `cloudflare`, a API só aceita pedidos com o cabeçalho secreto `X-Origin-Auth` (Transform Rule da Cloudflare) e lê o IP real em `CF-Connecting-IP`; sem o segredo responde `403`.
- Comparação do segredo em tempo constante; rotação sem downtime com `CF_ORIGIN_SECRET_PREVIOUS`.
- `/health` fica aberto (health check da plataforma); `/health/deep` exige o segredo.
- `request.clientIp` é a única fonte do IP (rate limit incluído). `X-Forwarded-For` forjado é ignorado.
- Ficheiros: `src/net/edge.ts`, `src/server.ts`, `src/env.ts`, runbook com passos e verificações por `curl`.

### 1.2 `trustProxy`
- Corrigido o erro original: o `env` transformava o boolean `true` em `false`.
- `trustProxy` passou a função `(addr, hop) => hop < TRUST_PROXY_HOPS`, porque a forma numérica foi desactivada no Fastify ≥ 5.12.1 (CVE-2026-16732).
- `TRUST_PROXY` e `EDGE_MODE=cloudflare` não podem ser combinados (validação no arranque).

### 1.3 Privacidade (projecto open source, sem recolher dados de clientes)
- Logs sem IP, sem cabeçalhos sensíveis e sem query string (serializers + `redact` do pino). Há teste que garante que nenhuma linha de log contém IP, token, segredo ou query.
- Chaves do rate limit no Redis são HMAC-SHA256 truncado com `IP_HASH_SECRET` — contam tentativas, mas o IP e o username não são recuperáveis. `IP_HASH_SECRET` obrigatório em produção.
- Todas as respostas levam `Cache-Control: no-store`.

### 1.4 Rate limit
- Três baldes por operação: por IP, por IP+utilizador e por conta (login; recuperação com baldes separados por modo `questions`/`code`). Registo por IP.
- Pontos devolvidos em caso de sucesso; falha do limitador **fecha** (recusa) em vez de deixar passar; fallback em memória se o Redis cair.
- Corrigida a corrida de arranque (Redis ainda não pronto → limite falhava em aberto): `waitUntilReady`.

### 1.5 Recuperação de conta (ADR-011)
- Por código de recuperação: reset imediato, numa só transacção, com `jti` de sessão de uso único (anti-replay), rotação do código e revogação de todas as sessões.
- Por perguntas de segurança: **efeito só após 24 h** (`RECOVERY_QUESTIONS_DELAY_HOURS`), guardado como pedido pendente; um login com a palavra-passe actual cancela o pedido e avisa (`pendingRecoveryCancelled`); novo código de recuperação só é emitido quando o pedido produz efeito.
- Trabalho constante no Argon2 nos ramos de utilizador inexistente (sem enumeração por tempo).
- Novas tabelas: `pending_password_resets`, `used_recovery_sessions`.

### 1.6 Idempotência, cascatas e outbox
- `idempotency_keys`: chave primária composta `(user_id, key)` — uma chave de um utilizador não colide nem revela a de outro.
- `posts.author_id` e `moderation_log.post_id/moderator_id` passam a `ON DELETE SET NULL` (apagar um utilizador não apaga conteúdo nem o histórico de moderação).
- Outbox: `claimBatch` com visibility timeout (evita eventos presos em `processing`), mapeamento camelCase, métodos de purga (idempotência, outbox concluído, refresh tokens expirados).
- Migração corrigida: o `drizzle-kit` não largava a PK antiga de `idempotency_keys` (erro `42P16`); acrescentado o `DROP CONSTRAINT idempotency_keys_pkey`.

### 1.7 Dependências (`pnpm audit`: 20 → 0)
| Bloco | Alteração |
|---|---|
| A | `drizzle-orm` 0.38 → ^0.45.2 (SQL injection por identificadores); `drizzle-kit` → ^0.31.3 |
| B | `vitest` 2 → ^4.1.12 (críticos de `vitest`/`tinypool`, `vite`); `vitest.config` sem `poolOptions`; override `esbuild: ^0.28.1` |
| C | `minimumReleaseAge: 4320` (3 dias) no pnpm contra pacotes recém-publicados comprometidos |
| D | CI: `permissions: contents: read`, `persist-credentials: false`, actions fixadas por SHA de commit, job `audit` (`--audit-level=high`), porta do Postgres corrigida (5432), Dependabot (npm + actions, com cooldown), CodeQL (`security-extended`, semanal) |
| E | `zod` 3 → ^4.6.7 (DoS de memória); `fastify-type-provider-zod` → ^7.0.0 |

---

## 2. Backlog priorizado

### Alta prioridade
1. **Denúncias (reports)** — *em curso (patch F1)*. Regra do briefing: ao atingir **10 denúncias distintas de contas válidas** (conta com ≥ 7 dias **e** pelo menos uma partilha) o post passa a `pending_review`; sem auto-denúncia; uma por utilizador e post. Feito: `reportsRepo.file` transaccional (post bloqueado, contador e limiar sem corridas), `cancel` só de denúncias abertas com contador, `countOpenByPost` com `COUNT`, `resolveAllForPost` a zerar `reports_count`. Falta: rotas (E4) e limite de pedidos de denúncias por utilizador.
2. **Handler de erros** — esconder detalhes de erros 5xx ao cliente (mensagens internas, stack); formato de erro único e consistente.
3. **`pg.Pool`: handler de `'error'`** — sem ele, um erro numa ligação ociosa pode derrubar o processo.
4. **Política de palavras-passe** — 6–20 caracteres é fraco para Argon2 e limita frases-passe. Recomendado: mínimo ≥ 8–10, máximo ~128 (o limite de 20 não dá segurança nenhuma), recusar passwords muito comuns. Exige alterar `shared` e o web.
5. **Eliminação de conta** — job de purga e recálculo de contadores (likes/denúncias) após `SET NULL`; ligar os métodos `purge*` ao worker do outbox (hoje existem, mas nada os chama).
6. **Rotação de chaves JWT** — adicionar `kid` e aceitar duas chaves públicas durante a rotação.

### Média prioridade
7. **Utilizadores reservados** — impedir `admin`, `moderador`, `suporte`, etc., e variantes (maiúsculas, pontuação) no registo.
8. **Posts** — validar o cursor de paginação; verificar autoria no delete.
9. **Futuro endpoint "alterar palavra-passe"** — tem de cancelar qualquer reset pendente (`cancelPending`) e revogar sessões.
10. **Estilo/format** — o Prettier local usa aspas duplas e 80 colunas; a configuração do repo diz aspas simples e 100. Alinhar uma só e fixar no CI (`format:check`).
11. **Testes em falta** — concorrência (duas recuperações simultâneas), limites do rate limit sob Redis em baixo, purge jobs.

### Operacional (sem código)
12. **Cloudflare em produção** — criar a Transform Rule com `X-Origin-Auth`, definir `CF_ORIGIN_SECRET` e `IP_HASH_SECRET` na plataforma, confirmar por `curl` que o acesso directo à origem devolve 403 (runbook).
13. **GitHub** — activar *Code scanning*, *Secret scanning + push protection*, *Dependabot alerts*; proteger `master`/`dev` com checks obrigatórios (CI, audit, CodeQL) e revisão; 2FA para todos os contributors.
14. **Segredos** — nunca no repositório; rotação planeada de `CF_ORIGIN_SECRET`, `IP_HASH_SECRET` e chaves JWT.

### Dependências — majors pendentes (sem vulnerabilidade conhecida; um de cada vez)
`@fastify/cors` 11 · `@fastify/rate-limit` 11 · `rate-limiter-flexible` 5 → 11 (testar à parte: é a base do rate limit) · `pino` 10 · `ioredis` 6 · `dotenv` 18 · `tsup` 9 · `eslint` 10 · `typescript` 7 · `vitest` 5 · `@types/node` 26 · web: `react`/`react-dom` 19, `vite` 8, `@vitejs/plugin-react` 6. O Dependabot já abre estes PRs; rever com os testes verdes antes de fundir.

### Notas
- O `apps/web` é, por agora, apenas scaffold; a revisão de segurança do frontend (armazenamento de tokens, CSP, XSS) fica para quando tiver funcionalidades.
- O `/health/deep` já exige o segredo em modo Cloudflare; em modo `none` continua aberto — proteger se a API for exposta sem Cloudflare.
