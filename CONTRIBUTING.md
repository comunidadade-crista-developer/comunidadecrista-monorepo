# Contribuir

Obrigado pelo interesse. Este é um projeto de código aberto sob AGPL-3.0.

## Fluxo

1. Fork e branch a partir de `master`.
2. Uma feature por PR.
3. Todos os testes verdes (`pnpm test:ci`).
4. Lint e typecheck limpos (`pnpm lint`, `pnpm typecheck`).
5. PR com descrição clara; referir issue se aplicável.

## Setup local

```bash
corepack enable
pnpm install
pnpm docker:up
cp apps/api/.env.example apps/api/.env
pnpm dev
```
* Web: http://localhost:5173

* API: http://localhost:3000

* Health: http://localhost:3000/health

## Estilo de código

* Prettier + ESLint; `pnpm format` antes de commit.

* TypeScript estrito; evitar `any`.

* Linguagem da UI: PT-PT, sem emojis, ícones Lucide.

## DCO

Ao submeter PR aceitas o Developer Certificate of Origin