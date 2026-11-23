# Versões e segurança para o deploy

**Pesquisado em 2026-11-20.** Fontes no fim. Esta pesquisa cobre o runtime, a base de dados e as
dependências com maior superfície (`fastify`, `drizzle-orm`, `vite`). **Não é exaustiva**: a fonte de
verdade contínua é o job `audit` da CI (`pnpm audit --audit-level=high`) e o Dependabot. Repetir a
pesquisa na semana do deploy.

## 1. Runtime e ferramentas

| Componente | Em uso                                  | Estado em 2026-11-20                                                                                                                                                                                     | Recomendação                                                                                                                    |
| ---------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Node.js    | `.nvmrc` = `24`; `engines >=24`         | 24: _Maintenance LTS_ (suporte activo terminou em 20-10-2026; segurança até 30-04-2028), última **24.22.3**. 26: _Active LTS_ até 27-10-2027, segurança até 30-04-2029, última **26.13.1**. 25 já é EOL. | Fixar `NODE_VERSION` no Render para **>= 24.22.3** (aviso de segurança de 11-11-2026). Decidir se se arranca já em 26 (ver §4). |
| pnpm       | 10 (`packageManager: pnpm@10.18.0`)     | pnpm 11 existe: `minimumReleaseAge` de 1 dia por omissão, `strictDepBuilds`, `allowBuilds`; exige Node >= 22; configuração migra do `.npmrc` para `pnpm-workspace.yaml`.                                 | Manter 10 até ao deploy; migrar depois, com o codemod `pnpm-v10-to-v11`, num bloco próprio.                                     |
| PostgreSQL | `postgres:17-alpine` (dev e CI; era 16) | 16.16 é a última 16 (12-11-2026); 14 chegou ao fim de vida; **19 sai a 19-11-2026**. Neon suporta 14 a 18.                                                                                               | **Decidido: 17** na Neon, com `docker-compose.yml` e CI alinhados. Não adoptar 19 já.                                           |
| Redis      | `redis:7-alpine` (dev e CI); Upstash    | **Não pesquisado.**                                                                                                                                                                                      | Verificar a versão suportada pela Upstash e o aviso de segurança do Redis antes do deploy.                                      |

### Node 24.22.3 — o que corrige (11-11-2026)

Actualiza o **llhttp** (o parser HTTP que o Fastify usa) e corrige vários problemas de HTTP/2 e TLS.
Para esta API (HTTP/1.1, TLS terminado no Render/Cloudflare, sem HTTP/2 nem `--permission`) a parte
que conta é o llhttp; mesmo assim, estar na versão corrigida é o mínimo. O aviso anterior
(21-10-2026, corrigido em 24.22.1) inclui uma falha de _Brotli_ em `node:zlib` com possível
execução de código: a API não descomprime corpos de pedidos, mas confirma que não há
`Content-Encoding: br` aceite em nenhuma rota.

### PostgreSQL — actualização de 12-11-2026 (18.7, 17.12, 16.16, 15.20, 14.25)

Mais de 140 correcções. Para o nosso esquema (UUID, `citext`, `timestamptz`, sem GIN nem
`pg_trgm` nem partições), as relevantes são as de planeador e de corrupção após _crash_. Se a Neon
gerir as actualizações menores, nada a fazer; senão, aplicar. Ao subir de versão menor, seguir
as notas de «Updating» do anúncio.

## 2. Dependências do lockfile (versões resolvidas)

| Pacote                                                                                                                                                                                                                                              | Resolvida | Aviso encontrado                                                                                                                                                                                                      | Estado                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `fastify`                                                                                                                                                                                                                                           | 5.12.7    | CVE-2026-76169 (contorna a autenticação via _not-found_ encapsulado, alta, corrigido em 5.12.2); CVE-2026-84428 (validação de cabeçalhos, alta, 5.12.2); CVE-2026-92081 (DoS em HTTP/2 com _trailers_, média, 5.12.5) | Fora do intervalo afectado                        |
| `drizzle-orm`                                                                                                                                                                                                                                       | 0.45.4    | CVE-2026-39356 (SQL injection por identificadores mal escapados, alta, corrigido em 0.45.2)                                                                                                                           | Fora do intervalo afectado                        |
| `vite` (dev, web)                                                                                                                                                                                                                                   | 6.4.5     | CVE-2026-53571 (contorna `server.fs.deny` no Windows, alta, corrigido em 6.4.3); CVE-2026-39363 (corrigido em 6.4.2)                                                                                                  | Fora do intervalo; só servidor de desenvolvimento |
| `@fastify/cors` 10.1.0, `@fastify/helmet` 13.2.0, `@fastify/rate-limit` 10.3.0, `jose` 6.2.13, `pg` 8.23.1, `pino` 9.14.0, `ioredis` 5.11.1, `@node-rs/argon2` 2.2.2, `rate-limiter-flexible` 5.0.5, `zod` 4.6.7, `fastify-type-provider-zod` 7.0.0 | —         | A pesquisa genérica não devolveu avisos para estes pacotes. **Não foi verificada pacote a pacote.**                                                                                                                   | `pnpm audit` na CI é a verificação                |

Notas:

- **Risco aceite — `minimatch` (GHSA-g3hv-75wg-m249, moderada, DoS por amplificação de _globparts_,
  intervalo >=7.0.0 <11.0.1).** Aparece em `typescript-eslint > @typescript-eslint/typescript-estree >
minimatch`: só ferramentas de desenvolvimento (lint), nunca no runtime nem no bundle, e abaixo do
  limiar `high` da CI. Não se força uma _override_ para >=11.0.1 sem a poder testar (compatibilidade
  com o `typescript-estree`). Acompanhar: aceitar o PR do Dependabot que actualize `typescript-eslint`
  e reavaliar na revisão da semana do deploy. Decidido em 2026-11-23.
- **Navegadores do web (RB-f).** `build.target` = `es2020`, `chrome80`, `edge80`, `firefox78`,
  `safari14.1`. O esbuild 0.28 não compila destructuring para Safari <= 14.0 (iOS <= 14.4), por isso
  iPhones que não passem de iOS 12–14.4 (iPhone 5s/6) ficam sem suporte; iPhone 6s e posteriores
  (iOS 15) funcionam. Cobri-los exigiria `@vitejs/plugin-legacy` (bundle maior): decisão adiada.
- O `trustProxy` já usa função por causa do CVE-2026-16732 (ver `resumo-seguranca.md`).
- Os majors pendentes listados em `resumo-seguranca.md` (`@fastify/cors` 11, `pino` 10, `react` 19,
  `vite` 8, etc.) não têm vulnerabilidade associada; actualizar um de cada vez, depois do deploy.
- O `vite` 6 só corre em desenvolvimento e na build; o que se serve em produção é estático.

## 3. Cadeia de fornecimento (supply chain)

Já em vigor: `minimumReleaseAge: 4320` (3 dias) no pnpm, `cooldown` de 3 dias no Dependabot, actions
fixadas por SHA, `permissions: contents: read` e job `audit`. O mundo npm teve vários ataques em
2025–2026 (família Shai-Hulud, incluindo pacotes com proveniência válida), pelo que convém:

- manter o `pnpm-lock.yaml` versionado e usar sempre `--frozen-lockfile` (já é assim);
- listar explicitamente, quando se migrar para o pnpm 11, os pacotes autorizados a correr scripts de
  _build_ (`allowBuilds`); hoje o único com binário nativo é `@node-rs/argon2`;
- considerar `trustPolicy: no-downgrade` e subir `minimumReleaseAge` para 7 dias antes do deploy
  (decisão pendente: atrasa também os _patches_ de segurança, que se podem excluir à mão);
- activar _secret scanning_ e _push protection_ no GitHub e proteger as branches.

## 4. Decisões pendentes (antes do deploy)

1. **Node 24 ou 26?** Node 24 é seguro e suportado até 2028 mas já só recebe correcções; Node 26 é a
   linha activa (até 2027) e dura mais. O código e o `engines` aceitam ambas; testar a CI em 26
   antes de decidir.
2. **Postgres 17 ou 18 na Neon**, e alinhar dev/CI.
3. **`minimumReleaseAge` de 3 ou 7 dias** e `trustPolicy`.

## 5. Lista de verificação na semana do deploy

- [ ] `pnpm audit --audit-level=high` sem resultados; rever os PRs do Dependabot em aberto.
- [ ] `NODE_VERSION` fixado no Render (>= 24.22.3) e `node -v` confirmado no log de build.
- [ ] Versão do Postgres da Neon escolhida e igual à do `docker-compose.yml`/CI; migrações aplicadas
      pelo procedimento do runbook («Migrações da base de dados»).
- [ ] Redis/Upstash: versão e avisos verificados.
- [ ] `NODE_ENV=production` com todas as variáveis obrigatórias (a API recusa arrancar sem elas).
- [ ] `SECURITY.md` com o contacto real; _secret scanning_ activo; branches protegidas.
- [ ] Repetir esta pesquisa (fastify, drizzle-orm, vite, Node, Postgres).

## Fontes

- Node.js: [endoflife.date/nodejs](https://endoflife.date/nodejs) · [avisos de 21-10-2026](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) · [avisos de 11-11-2026](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases)
- PostgreSQL: [anúncio de 12-11-2026](https://www.postgresql.org/message-id/attachment/208544/20261112updaterelease.md) · [versões na Neon](https://neon.com/docs/postgresql/postgres-version-support)
- Fastify: [CVE-2026-76169](https://advisories.gitlab.com/npm/fastify/CVE-2026-76169/) · [CVE-2026-84428](https://advisories.gitlab.com/npm/fastify/CVE-2026-84428/) · [CVE-2026-92081](https://advisories.gitlab.com/npm/fastify/CVE-2026-92081/)
- drizzle-orm: [CVE-2026-39356](https://osv.dev/vulnerability/CVE-2026-39356)
- Vite: [CVE-2026-53571](https://osv.dev/vulnerability/CVE-2026-53571)
- pnpm: [pnpm 11](https://pnpm.io/blog/releases/11.0) · [supply chain](https://pnpm.io/supply-chain-security)
