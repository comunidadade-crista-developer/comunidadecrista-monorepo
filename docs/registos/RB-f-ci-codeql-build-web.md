# RB-f — CI, CodeQL e build do web

Resultado da verificação no GitHub após a RB-e.

- **Build do `apps/web` falhava na CI.** O alvo por omissão do Vite 6 inclui `safari14`; o `esbuild`
  0.28.2 (forçado pela _override_ do `pnpm-workspace.yaml`) não compila o destructuring do `zod`
  para esse alvo. Testado com o esbuild: `safari14` e `ios14` falham, `safari14.1`/`ios14.5` passam.
  Fix: `build.target` explícito em `apps/web/vite.config.ts`
  (`es2020`, `chrome80`, `edge80`, `firefox78`, `safari14.1`), para manter iPhones antigos
  (iOS 14.5+). Limite e alternativa em `versoes-e-seguranca.md`.
- **CodeQL #2 e #3 (`js/polynomial-redos`).** `/\d+$/` e `/[^a-z]+$/u` substituídas por ciclos
  lineares com resultado idêntico; testes com entradas de 200 000 caracteres.
- **CodeQL #1, #4, #5, #6 (`js/user-controlled-bypass`).** Falsos positivos: o valor do pedido só
  escolhe o ramo; a autorização vem do token (`viewerId`) e da base de dados. Comentários no código
  e _dismiss_ no GitHub como «False positive».
- **`pnpm audit` — `minimatch` (moderada, só dev).** Risco aceite e documentado.
- **`CODE_OF_CONDUCT.md`** passa a usar `seguranca.comunidadecrista@protonmail.com`.

**Não validado aqui**: o `vite build` completo (sem `pnpm install` neste ambiente); só o esbuild
isolado. A primeira CI confirma.
