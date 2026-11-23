# Serviço: GitHub (repositório, CI e segurança)

**Função**: código, CI, análise de segurança e actualizações de dependências. O Render não deploya
sozinho a partir daqui (ver [servico-render](servico-render.md)): o deploy é manual.
**Responsável**: operador. **Contas com acesso**: só o operador (MVP).

## 1. Configuração obrigatória (Etapa 1)

| Onde (Settings)                                 | Valor                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branches → regra para `master`                  | Exigir _pull request_; exigir os checks **Lint, Typecheck, Test, Build**, **Dependency audit** e **Analyze (javascript-typescript)** (CodeQL); exigir ramo actualizado; bloquear _force push_ e apagar. Com um só operador, a revisão obrigatória por outra pessoa não é possível: exigir PR e checks, e rever o diff antes de fundir. |
| Branches → regra para `dev`                     | Exigir os mesmos checks; permitir _force push_ só se necessário.                                                                                                                                                                                                                                                                       |
| Code security → Secret scanning                 | Activo, com **push protection**.                                                                                                                                                                                                                                                                                                       |
| Code security → Dependabot                      | _Alerts_ e _security updates_ activos (o `dependabot.yml` já agenda as versões, com _cooldown_ de 3 dias).                                                                                                                                                                                                                             |
| Code security → Code scanning                   | CodeQL já corre por `.github/workflows/codeql.yml` (semanal e em PR).                                                                                                                                                                                                                                                                  |
| Code security → Private vulnerability reporting | Activo (canal para reportar falhas sem as tornar públicas).                                                                                                                                                                                                                                                                            |
| Actions → General                               | Permissões por omissão de leitura; permitir só _actions_ fixadas por SHA (já é a prática do repositório).                                                                                                                                                                                                                              |
| Conta do operador                               | 2FA com chave de segurança ou _app_; códigos de recurso no cofre.                                                                                                                                                                                                                                                                      |

## 2. Ficheiros a preencher

- `SECURITY.md`: **feito**, com `seguranca.comunidadecrista@protonmail.com` (Proton Mail). O `CODE_OF_CONDUCT.md` usa o mesmo contacto (RB-f). O `SECURITY.md` já refere o _private vulnerability reporting_, que tem de estar activo (secção 1).
- Gitleaks na CI: opcional, além do _secret scanning_ (avaliar depois do deploy).

## 3. Fluxo de trabalho

1. Trabalho em ramo a partir de `dev`; PR para `dev` com a CI verde.
2. Para lançar: PR de `dev` para `master` (CI verde); fundir.
3. Deploy manual no Render do _commit_ de `master` (ver [deploy-backend](deploy-backend.md) §4).
4. Marcar versões com _tag_ (`vX.Y.Z`) quando houver _release_.

## 4. Operação

- **PR do Dependabot**: rever, correr a CI, fundir um de cada vez; _patches_ de segurança têm prioridade.
- **Alerta de _secret scanning_**: tratar como incidente (ver [gestao-e-controlo](gestao-e-controlo.md) §6): revogar o
  segredo no serviço de origem, rodar e só depois fechar o alerta.
- **CI vermelha em `master`**: não fazer deploy; corrigir à frente.

## 5. Verificação

- [ ] Tentar _push_ directo para `master` é recusado.
- [ ] Um PR com a CI vermelha não se funde.
- [ ] Um segredo de teste no código é bloqueado pela _push protection_.
