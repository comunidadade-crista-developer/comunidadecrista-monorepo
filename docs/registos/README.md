# Registos de fase

Um registo por feature refactorada ou revista (check → fix → refactory → update). Serve para
quem chegar depois perceber **o que mudou, porquê, que decisões se tomaram e o que ficou por
fazer**, sem ler o histórico de commits.

Cada registo segue o modelo abaixo e vive em `docs/registos/<fase>-<assunto>.md`.

## Modelo

1. **Contexto** — o que a feature faz e de onde veio (branch, versão antiga).
2. **Check** — o que se encontrou ao rever (bugs, riscos, desvios do plano).
3. **Decisões** — alternativas, escolha e porquê (quem decidiu).
4. **Alterações** — ficheiros e comportamento novo.
5. **Segurança e privacidade** — o que foi considerado.
6. **Testes** — o que cobrem e o que ficou por cobrir.
7. **Operação** — variáveis de ambiente, comandos, passos de deploy.
8. **Pendente** — o que ficou por fazer.

## Índice

| Fase  | Assunto                                                                                                   | Estado |
| ----- | --------------------------------------------------------------------------------------------------------- | ------ |
| E3    | [Gospel cards e cache](E3-gospel-cards-cache.md)                                                          | Feito  |
| E4-a  | [Base de posts, denúncias e filtro](E4a-base-posts-denuncias.md)                                          | Feito  |
| E4-b  | [Repositórios e serviços de posts](E4b-servicos-posts.md)                                                 | Feito  |
| E4-c  | [Rotas, cache do feed e /sync](E4c-rotas-cache-sync.md)                                                   | Feito  |
| E4-d  | [Documentação: ADRs, arquitectura, API](E4d-documentacao.md)                                              | Feito  |
| E5+E6 | [`/sync`, worker e administração (ADR-015)](E5-E6-sync-worker-admin.md)                                   | Feito  |
| RB-a  | [Endurecimento do backend](RB-a-hardening.md)                                                             | Feito  |
| RB-b  | [Migrações em produção e tolerância no refresh](RB-b-migracoes-refresh.md)                                | Feito  |
| RB-c  | [Revisão do backend](RB-revisao-backend.md) e [versões para o deploy](../runbooks/versoes-e-seguranca.md) | Feito  |
| RB-d  | [Plano de deploy, runbooks por serviço e gestão](RB-d-plano-deploy.md)                                    | Feito  |
| RB-e  | [Postgres 17 e contacto de segurança](RB-e-postgres17.md)                                                 | Feito  |
| RB-f  | [CI, CodeQL e build do web](RB-f-ci-codeql-build-web.md)                                                  | Feito  |
