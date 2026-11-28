# RB-k — Etapa 7: _script_ de smoke repetível

- **O que é.** `apps/api/scripts/smoke.ts` (`pnpm --filter @comunidade/api smoke --base-url=<URL>`): percorre
  os fluxos públicos da API em execução só por HTTP (`fetch` do Node 24, sem dependências novas) e valida cada
  resposta contra os esquemas de `@comunidade/shared`. Cobre registo, login, `/auth/me`, refresh (rotação,
  tolerância, reutilização), logout, recuperação por código e por perguntas, cards (ETag/304), feed, criar
  partilha com `Idempotency-Key`, gostar, denunciar, `/sync`, `/sync/bootstrap` e limpeza.
- **Segurança.** Só `https` (ou `localhost`), sem seguir redireccionamentos, sem credenciais no URL. Segredos
  aleatórios só em memória; a saída tem apenas `OK`/`FALHA`/`SALTADO`, código HTTP e o código de erro da API.
- **Contas descartáveis.** Duas por execução (`smoke-<sufixo>-a`/`-b`); no fim apagam-se as partilhas e pede-se
  o apagamento das contas (`pending_deletion` até ao fim da graça). Limite de registo: 2 execuções por hora e IP.
  Cada execução gera 2 avisos `token_reuse` esperados nos logs.
- **Fora do script.** `admin:promote`, aprovar/rejeitar e medir comandos Redis (Etapa 7 do deploy-backend).
- **Também.** Comentário do CodeQL em `routes/posts.ts` passado para cima do `if` a que se refere.
- **Validação.** `tsc` estrito e execução completa contra um servidor simulado (51 passos). **Por correr em
  produção**: o resultado real fecha o item da Etapa 7.
