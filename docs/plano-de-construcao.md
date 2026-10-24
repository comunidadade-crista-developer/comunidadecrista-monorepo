# Plano de Construção — Comunidade Cristã v1.0

**Base**: Briefing 1.0 + Arquitectura 1.0
**Estratégia**: backend-first, com *test gate* obrigatório entre etapas
**Princípio**: nenhuma etapa avança sem a suite de testes verde e o deploy de preview a funcionar

---

## 1. Princípios de execução

1. **Backend-first**: a API completa e testada antes de o frontend consumir. O frontend entra depois com contrato congelado.
2. **Test gate**: entre etapas, o CI tem de estar verde (lint + typecheck + unit + integração). Não há excepções.
3. **Contrato primeiro**: os schemas Zod em `packages/shared` são a fonte de verdade. Se o teste de contrato falha, o CI falha.
4. **Migrações forward-only**: cada migração é versionada em `apps/api/drizzle/`; nunca editar em retrospectiva.
5. **Um passo, um deploy**: cada etapa termina com deploy em produção a responder (mesmo que só `/health` e uma rota nova).
6. **PRs pequenas**: uma feature por PR; `main` protegida com 1 review + CI verde.

---

## 2. Estratégia de testes

**Pirâmide adaptada**

| Nível | Ferramenta | Cobre |
|---|---|---|
| **Unit** | Vitest | Lógica pura: validators, utils (argon2 wrapper, JWT, normalização), serviços com dependências mockadas |
| **Integração** | Vitest + `supertest` + Postgres real (testcontainers) | Rotas completas: middleware → handler → repositório → DB |
| **Contrato** | Vitest + schemas `packages/shared` | Request/response conformes com a especificação |
| **E2E** | Playwright | Fluxos completos UI→API, executados a partir de E8 |

**Regra mínima por endpoint** (gate obrigatório):
- 1 teste de *happy path*
- 2 testes de erro (validação, auth, not found — pelo menos dois destes)
- 1 teste de contrato (schema Zod)

**Como correr Postgres real no CI**
- **Local**: `docker-compose up` sobe Postgres 16 + Redis 7.
- **CI**: `testcontainers` sobe Postgres efémero por job. Não usamos Neon de teste para não gastar branches.

**Cobertura mínima**
- ≥ **80%** de linhas nos módulos novos.
- **100% dos endpoints** com pelo menos 1 happy + 2 error testes.
- Regra mais importante que a métrica: **cada bug corrigido gera um teste de regressão** no mesmo PR.

---

## 3. Definition of Done (por etapa)

Uma etapa só é dada como concluída quando:

- [ ] Todos os testes verdes no CI (lint + typecheck + unit + integração).
- [ ] Cobertura ≥ 80% nos módulos novos.
- [ ] Contratos em `packages/shared` atualizados e consumidos pelo teste de contrato.
- [ ] Endpoint documentado em `docs/api.md`.
- [ ] Deploy de preview a funcionar; smoke test verde.
- [ ] Logs sem PII; validação Zod em todos os inputs.
- [ ] PR aprovada e merged em `main`.
- [ ] ADR atualizado se alguma decisão mudou.

---

## 4. Etapas de construção

Escala de esforço relativo: **XS** (< ½ dia) · **S** (½–1 dia) · **M** (1–2 dias) · **L** (2–4 dias) · **XL** (> 4 dias)

---

### E0 — Fundação e infraestrutura

**Objectivo**: monorepo a compilar, CI verde, `/health` deployado em produção e cron activo.

| # | Tarefa | Esforço |
|---|---|---|
| T0.1 | pnpm workspace + `apps/web` (placeholder) + `apps/api` + `packages/shared` + `packages/config` | S |
| T0.2 | tsconfig base, ESLint, Prettier partilhados | S |
| T0.3 | Fastify bootstrap: `pino`, `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`, `fastify-type-provider-zod` | S |
| T0.4 | `docker-compose.yml`: Postgres 16 + Redis 7 | XS |
| T0.5 | `GET /health` (leve) e `GET /health/deep` (toca DB + Redis) | XS |
| T0.6 | GitHub Actions: lint → typecheck → test → build | M |
| T0.7 | Criar contas: Neon, Upstash, Render, Cloudflare Pages | XS |
| T0.8 | Render conectado ao repo (deploy API) + Pages conectado (deploy web placeholder) | S |
| T0.9 | Secrets e env vars (GitHub, Render, Pages) | S |
| T0.10 | cron-job.org: ping a `/health` a cada 14 min, 06h–23h | XS |
| T0.11 | `LICENSE` (AGPL-3.0), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `docs/runbook.md` inicial | S |

**Testes obrigatórios**
- Integração: `/health` responde `200 { status, version }`; `/health/deep` responde com DB e Redis OK.
- CI: pipeline corre em PR e falha correctamente quando há erro de lint.

**Gate**: CI verde + `/health` em produção + cron activo + docs base commitados.

**Riscos**: configuração inicial de secrets é tediosa e propensa a erro; mitigar documentando cada passo no `runbook.md` durante a configuração.

---

### E1 — Modelo de dados e persistência

**Objectivo**: schema completo em Drizzle, migrações, repositórios base com testes.

| # | Tarefa | Esforço |
|---|---|---|
| T1.1 | Drizzle schema: `users`, `refresh_tokens`, `gospel_cards`, `posts`, `post_likes`, `reports`, `moderation_log`, `outbox`, `idempotency_keys` | M |
| T1.2 | Scripts `drizzle-kit generate` e `drizzle-kit migrate` | S |
| T1.3 | Pool `pg` configurado para Neon (pooler, pool pequeno ~10) | S |
| T1.4 | Repositórios: `usersRepo`, `refreshTokensRepo`, `postsRepo`, `likesRepo`, `reportsRepo`, `outboxRepo`, `idempotencyRepo`, `moderationRepo`, `cardsRepo` | L |
| T1.5 | Seed idempotente de `gospel_cards` (conteúdo a fornecer) | S |
| T1.6 | Setup de test DB (testcontainers) + helpers `truncateAll()` | S |
| T1.7 | `/health/deep` a tocar na DB via repositório | XS |

**Testes obrigatórios**
- Integração: cada repositório com 1 happy + 2 edge cases (not found, constraint violation, etc.).
- Migrações: teste de up limpo em DB vazia.
- Seed: correr 2x não duplica.
- Índices existem (query de catálogo do Postgres a confirmar).

**Gate**: migrações aplicam em Neon limpo; repositórios com testes verdes; seed corre em produção.

---

### E2 — Autenticação (o bloco mais crítico)

**Objectivo**: registo, login, refresh, recuperação (código + perguntas), middlewares, rate limit.

| # | Tarefa | Esforço |
|---|---|---|
| T2.1 | Wrapper argon2id (hash + verify, params OWASP) | S |
| T2.2 | Wrapper JWT EdDSA (gerar par de chaves, sign, verify) + comando CLI de geração | S |
| T2.3 | `POST /auth/register`: Zod, hash argon2id, gera recovery code (base32, 16 chars), devolve `{ access, refresh, recovery_code }` | M |
| T2.4 | `POST /auth/login`: rate limit Upstash (5/15min por IP+username), devolve tokens | M |
| T2.5 | `POST /auth/refresh`: rotação atómica, deteção de reuso → revoga família | L |
| T2.6 | `POST /auth/logout` | XS |
| T2.7 | `GET /auth/me` | XS |
| T2.8 | `POST /auth/recover/verify`: modo `code` (recovery code) **ou** modo `questions` (3 perguntas normalizadas) → devolve `recovery_session` (JWT curto, 5 min) | M |
| T2.9 | `POST /auth/recover/reset`: usa `recovery_session` para nova password; revoga todos os refresh tokens | M |
| T2.10 | Middleware `requireAuth` (parse + verify JWT, anexa `user`) | S |
| T2.11 | Middleware `requireAdmin` (revalida role na DB a cada pedido — defesa contra JWT antigo) | S |

**Testes obrigatórios**
- Registo: username duplicado → `409`; username inválido → `400`; password < 6 → `400`.
- Registo: `recovery_code` devolvido uma vez; hash guardado em DB ≠ plaintext.
- Login: 5 tentativas falhadas → `429` com `Retry-After`; 6ª tentativa mesmo com password correcta → `429`.
- Refresh: rotação devolve novo par; reusar o antigo → `401` + família revogada (verifica que os seguintes também falham).
- Recuperação: código correcto; código errado → `401`; perguntas normalizadas (lowercase + trim + colapso de espaços); sessão de recuperação expira em 5 min.
- Middleware: sem header → `401`; token expirado → `401`; token com assinatura inválida → `401`; `requireAdmin` com user comum → `403`.
- Rate limit persiste entre instâncias (Upstash).

**Gate**: todos os fluxos de auth cobertos; contrato em `packages/shared` congelado; teste de benchmark de argon2id < 500ms no Render free (se não, ajustar params).

**Riscos**:
- argon2id em CPU limitada do Render → benchmark obrigatório em T2.1; params ajustáveis via env.
- Rotação de chaves EdDSA → documentar no `runbook.md` (T0.11).
- Recuperação sem email é o ponto mais frágil → recovery code tem de ser **muito visível** no registo (UX crítica no E8).

---

### E3 — Conteúdo (gospel cards) + cache

**Objectivo**: leitura pública de cards com cache Upstash.

| # | Tarefa | Esforço |
|---|---|---|
| T3.1 | `GET /gospel-cards` (lista ordenada, paginação) | S |
| T3.2 | `GET /gospel-cards/:slug` | S |
| T3.3 | Camada de cache: `cache.get(key, ttl, loader)` com fallback se Redis falha | S |
| T3.4 | Cache de `cards:list` (TTL 1h) e `card:{slug}` (TTL 1h) | XS |
| T3.5 | Invalidação em seed | XS |

**Testes obrigatórios**
- Cache hit: segunda chamada não vai à DB (mock/spy).
- Cache miss: vai à DB e popula.
- Redis offline: endpoint responde igual (fallback).
- Contrato: schema de `GospelCard` conforme.

**Gate**: endpoints em produção; latência p95 < 50ms para cache hit.

---

### E4 — Posts, likes e denúncias

**Objectivo**: CRUD de posts com idempotência, likes, denúncias e moderação automática.

| # | Tarefa | Esforço |
|---|---|---|
| T4.1 | `POST /posts`: `Idempotency-Key` obrigatório; Zod; insere como `published` (ou `pending_review` se o user estiver marcado) | M |
| T4.2 | `GET /posts`: cursor pagination (`created_at, id`), filtro por `category` e `filter=recent\|top\|liked` | M |
| T4.3 | `GET /posts/:id` | XS |
| T4.4 | `DELETE /posts/:id` (só autor) | S |
| T4.5 | `POST /posts/:id/like` e `DELETE` (idempotentes, noop se já existe/inexiste) | S |
| T4.6 | `POST /posts/:id/report` e `DELETE` (unique `(post_id, reporter_id)`) | S |
| T4.7 | Lógica automática: ao atingir 10 denúncias válidas → `status = pending_review` | S |
| T4.8 | Anti-abuso: denúncia de user com conta < 7 dias ou sem posts **não conta** para o limiar | S |
| T4.9 | Cache de feed com TTL 60s; invalidação ao publicar/apagar | S |
| T4.10 | Contadores `likes_count`/`reports_count` mantidos em Postgres (transacção no like) | S |
| T4.11 | Feed de user autenticado inclui sempre o primeiro item como o próprio post (com estado) | XS |

**Testes obrigatórios**
- Idempotência: 2 POSTs com mesma key → 1 post na DB, mesma resposta.
- Autor tenta apagar post alheio → `403`.
- Like duplo → `noop` (`200` com `likes_count` correcto).
- Report duplicado mesmo user → `409`.
- 10 reports de users válidos → `status = pending_review` e post oculto do feed público.
- 10 reports incluindo users inválidos → `status = published`.
- Cursor pagination: nunca duplica, nunca falha items (teste com 100 posts inseridos, 5 páginas).
- Filtro `top` (mais likes) e `liked` (que o user amou) devolvem ordem correcta.

**Gate**: fluxo completo a funcionar; testes de idempotência e de moderação automática verdes.

---

### E5 — Sync e worker (bloco mais complexo)

**Objectivo**: `/sync` idempotente + outbox server-side + worker com `SKIP LOCKED`.

| # | Tarefa | Esforço |
|---|---|---|
| T5.1 | `POST /sync`: recebe até 20 operações; dedup por `idempotency_key`; aplica em ordem; devolve estado por operação | L |
| T5.2 | Tipos de operação suportados: `post.create`, `post.like`, `post.unlike`, `post.report`, `post.unreport`, `post.delete` | M |
| T5.3 | Tabela `outbox` + processor worker dentro do Fastify (via `setInterval`), `SELECT ... FOR UPDATE SKIP LOCKED` | M |
| T5.4 | Handlers da outbox: cache invalidation, notificações internas, purgas | S |
| T5.5 | Purga periódica (`outbox` > 7 dias, `idempotency_keys` > 7 dias) | XS |
| T5.6 | Testes de concorrência: 2 `/sync` simultâneos com mesma key → 1 aplicação | M |

**Testes obrigatórios**
- Batch misto: 1 válido + 1 inválido → resposta por operação; o válido aplica, o inválido devolve `rejected` com motivo.
- Concorrência: `Promise.all` de 2 requests com mesma key → 1 post na DB, 2 respostas idênticas.
- Worker: insere outbox, corre o processor, evento processado; falha → `attempts++`, `next_attempt_at` no futuro.
- Worker com 2 instâncias simultâneas → `SKIP LOCKED` garante que cada evento é processado 1x.
- Ordem: operações no batch são aplicadas pela ordem do array.

**Gate**: concorrência testada; worker estável; endpoint em produção.

**Riscos**:
- Concorrência de `/sync` é o ponto mais difícil → **testes de concorrência são obrigatórios antes de avançar**.
- Worker dentro do processo Fastify: se o processo reiniciar a meio, eventos ficam `processing` para sempre → implementar *stale lock recovery* (eventos `processing` há > 5 min voltam a `pending`).

---

### E6 — Admin e moderação

**Objectivo**: rotas `/admin` com fila de revisão e log de auditoria.

| # | Tarefa | Esforço |
|---|---|---|
| T6.1 | `GET /admin/posts?status=pending_review` | S |
| T6.2 | `POST /admin/posts/:id/approve` | S |
| T6.3 | `POST /admin/posts/:id/reject` (com `reason` obrigatório, min 10 chars) | S |
| T6.4 | `GET /admin/reports` (abertas e resolvidas) | S |
| T6.5 | `GET /admin/moderation-log` | S |
| T6.6 | Script de promoção a admin (via CLI/DB) — não há endpoint público | XS |

**Testes obrigatórios**
- User comum em `/admin/*` → `403`.
- Admin aprova → `status = published`; log criado.
- Admin rejeita → `status = rejected`; log com motivo.
- Aprovar/rejeitar post já resolvido → `409`.

**Gate**: fluxo de moderação completo; auditoria a funcionar.

---

**Backend completo.** Contrato congelado. Frontend pode arrancar com estabilidade.

---

### E7 — Frontend scaffold

| # | Tarefa | Esforço |
|---|---|---|
| T7.1 | Vite + React 18 + TS + Tailwind + Radix primitives + Lucide | S |
| T7.2 | Router (TanStack Router — type-safe com Zod) | S |
| T7.3 | API client gerado a partir de `packages/shared` + `fetch` wrapper com refresh automático | M |
| T7.4 | `vite-plugin-pwa` + Workbox: precache do app shell, runtime caching para API | M |
| T7.5 | Dexie setup (schemas: `outbox`, `postsCache`, `cardsCache`) | S |
| T7.6 | Tema claro/escuro (Radix + CSS vars) | XS |
| T7.7 | Playwright instalado + 1 smoke test (splash renderiza) | S |

**Gate**: PWA instalável em Android + Pages preview; splash a renderizar; service worker registado.

---

### E8 — Frontend autenticação

| # | Tarefa | Esforço |
|---|---|---|
| T8.1 | Splash com efeito typewriter + footer | S |
| T8.2 | Vídeo introdutório bundled (AV1 + H.264 fallback), botão *Saltar* após 3s | M |
| T8.3 | Ecrã de login + estados de loading progressivos | M |
| T8.4 | Ecrã de registo (validação client-side, botão desabilitado, anti-duplo-clique) | M |
| T8.5 | Ecrã de apresentação do recovery code (uma vez, com botão copiar + aviso "guarda isto") | S |
| T8.6 | Ecrã de recuperação (código + perguntas) | M |
| T8.7 | Auth store: tokens em `IndexedDB` cifrado via WebCrypto; hash argon2id local (`hash-wasm`) para validação offline | L |
| T8.8 | Interceptor de refresh automático + logout em falha | S |

**Testes obrigatórios**
- Playwright: registo → recovery code mostrado → dashboard.
- Playwright: login errado → mensagem; login correcto → dashboard.
- Playwright: recuperação por código + por perguntas → nova password → login.
- Offline: simular `navigator.onLine = false`, login com credenciais cacheadas → dashboard.

**Gate**: fluxo completo E2E verde; `recovery_code` visível e copiável.

**Riscos**:
- Argon2id no cliente pesa o bundle (`hash-wasm` ~ 30KB wasm) → aceitável, mas medir.
- iOS Safari: WebCrypto e IndexedDB têm quirks → testar cedo.

---

### E9 — Frontend leitura de conteúdo

| # | Tarefa | Esforço |
|---|---|---|
| T9.1 | Home: hero do vídeo (thumbnail, sem autoplay) + Card Ensinamentos + Card Explorar + Área de apoio | M |
| T9.2 | Lista de ensinamentos com cards (estado lido/entendimento vazio/preenchido) | M |
| T9.3 | Ecrã de estudo com referências + 2 botões | S |
| T9.4 | Explorar: feed só leitura, filtros | M |
| T9.5 | TanStack Query com `staleTime` + cache offline (SWR); persistência em Dexie para leitura offline | M |
| T9.6 | Navbar fixo + header fixo com ícones | S |

**Testes obrigatórios**
- Playwright: abrir app offline (após primeiro uso) → home carrega de cache.
- Playwright: navegar ensinamentos → estudo → voltar, sem rede.

**Gate**: leitura offline funcional.

---

### E10 — Frontend escrita + sync

**Objectivo**: o bloco mais importante do frontend. Publicar offline, sincronizar sem duplicados.

| # | Tarefa | Esforço |
|---|---|---|
| T10.1 | Composer de entendimento (estilo Facebook, simplificado) | M |
| T10.2 | Composer de partilha em Explorar (título, categoria, conteúdo) | S |
| T10.3 | Outbox local em Dexie: enqueue, estado `pending` | M |
| T10.4 | Sync client: dispara em `online`, em intervalo, e em foco; retry exponencial | L |
| T10.5 | UI de estados: *Aguardando envio*, *Publicado*, *Em revisão* | S |
| T10.6 | Likes (Amém) optimistas com rollback em falha | S |
| T10.7 | Denúncias com confirmação e cancelamento | S |
| T10.8 | Filtros do feed + primeiro item = próprio post | S |

**Testes obrigatórios (críticos)**
- Playwright: publicar offline → aparece com *Aguardando envio* → activar rede → *Publicado*, 1 único post na UI e na DB.
- Playwright: fechar app durante fila, reabrir → fila persiste e sincroniza.
- Playwright: like offline → contador optimista → sync correcto.
- Playwright: conflito simulado (post apagado no servidor) → UI mostra erro com motivo.

**Gate**: zero duplicados em cenários de rede intermitente.

**Riscos**:
- Sincronização é o ponto mais frágil do sistema → testes Playwright com throttling de rede são obrigatórios.

---

### E11 — Frontend perfil, suporte, contribuir e admin UI

| # | Tarefa | Esforço |
|---|---|---|
| T11.1 | Perfil: avatar gerado, alterar username, alterar password | M |
| T11.2 | Gestão de posts (pesquisa, estado por post) | M |
| T11.3 | Gestão de denúncias (abertas/fechadas, cancelar) | S |
| T11.4 | Suporte: fala connosco, FAQ, como funcionam as denúncias | S |
| T11.5 | Contribuir: intro + formas (técnica, sugestões, financeira via env) | S |
| T11.6 | Admin UI: `/admin` lazy-loaded, protegido, fila de revisão + aprovar/rejeitar | M |

**Testes obrigatórios**
- Playwright: admin aprova post em revisão → aparece no feed público.
- Playwright: user comum em `/admin` → redirect.
- Playwright: alterar username → propaga em posts e perfil.

**Gate**: fluxos completos; admin UI funcional.

---

### E12 — Polimento e entrega

| # | Tarefa | Esforço |
|---|---|---|
| T12.1 | Acessibilidade: contraste, foco visível, labels ARIA, tamanho de toque | M |
| T12.2 | Revisão de copy PT-PT (todo o texto de UI) | S |
| T12.3 | Política de privacidade e termos de utilização (páginas estáticas) | S |
| T12.4 | `docs/api.md` completo (OpenAPI opcional) | S |
| T12.5 | `docs/runbook.md`: rotação de chaves, recuperação de incidentes, backups | S |
| T12.6 | Backup: export diário do Neon via GitHub Action (pg_dump → artefacto) | S |
| T12.7 | UptimeRobot a monitorizar `/health` | XS |
| T12.8 | Smoke test de produção (Playwright contra prod) | S |
| T12.9 | Tag `v1.0.0` + release notes | XS |

**Gate**: auditoria de acessibilidade (Lighthouse ≥ 90); docs publicados; smoke verde; tag cortada.

---

## 5. Ordem e dependências

```
Backend:  E0 → E1 → E2 → E3 → E4 → E5 → E6 ─┐
                                             │
Frontend:                       E7 → E8 ─────┤
                                     │       │
                                     E9 → E10 → E11 → E12
```

- **E7 pode arrancar após E2 fechar** (auth é o mínimo para o frontend testar).
- **E8 depende de E2** (auth no backend) e **E7** (scaffold).
- **E9 depende de E3** (conteúdo no backend).
- **E10 depende de E4 e E5** (posts e sync no backend).
- **E11 depende de E6** (admin no backend).
- **E12 depende de tudo.**

**Paralelização possível** (se houver mais pessoas):
- Frontend (E8) em paralelo com backend (E3/E4) — o contrato já está em `packages/shared`.
- Não recomendado no MVP: sem estabilidade de contrato, o frontend sofre.

---

## 6. Registo de riscos por etapa

| Risco | Etapa | Impacto | Mitigação |
|---|---|---|---|
| Cold start do Render | E0, E8 | Alto | `/health` leve + cron 14 min + UI local primeiro |
| argon2id lento em Render free | E2 | Médio | Benchmark em T2.1; params ajustáveis via env |
| Rotação de chaves EdDSA esquecida | E2 | Alto | Documentar no runbook; teste de arranque com chave expirada |
| Concorrência em `/sync` | E5 | Crítico | `SKIP LOCKED` + idempotency keys + testes de concorrência |
| Worker preso em `processing` após restart | E5 | Médio | *Stale lock recovery* (eventos > 5 min voltam a `pending`) |
| Vídeo grande no bundle | E8 | Médio | AV1 + H.264 fallback; target < 20 MB total |
| Bundle PWA grande | E8 | Médio | Code splitting; `/admin` lazy; rota de estudo lazy |
| iOS offline quirks | E8, E10 | Alto | Testar em Safari iOS desde E8 |
| Recovery code não guardado pelo utilizador | E8 | Alto | Ecrã dedicado, botão copiar, aviso explícito, opção de *download* |
| Rate limit Upstash estoura | E2, E4 | Médio | Limitar a login/registo/posts; não limitar leituras |
| Sem email = suporte manual | E11 | Médio | FAQ detalhado + email do suporte visível |

---

## 7. Antes de arrancar E0

Coisas que precisam de existir antes da primeira linha de código:

1. **Conteúdo dos gospel cards** (texto, slug, referências, resumo) — formato JSON, enviado por ti.
2. **Vídeo introdutório comprimido** — MP4 (H.264) + WebM/AV1, target < 20 MB total.
3. **Email de suporte** (Proton Mail, já decidido) — para docs e suporte.
4. **Dados bancários para contribuição** — via env vars no Render.
5. **Confirmação do domínio**: subdomínio Pages (`comunidade-crista.pages.dev`) + Render (`comunidade-crista-api.onrender.com`), ou comprar domínio? (Ainda em aberto.)
