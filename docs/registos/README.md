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

| Fase | Assunto                                                | Estado |
| ---- | ------------------------------------------------------ | ------ |
| E3   | [Gospel cards e cache](E3-gospel-cards-cache.md)       | Feito  |
| E4-a | [Base de posts, denúncias e filtro](E4a-base-posts-denuncias.md) | Feito  |   