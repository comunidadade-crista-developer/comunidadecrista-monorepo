# Serviço: Upstash (Redis)

**Função**: contadores do rate limit (partilhados entre instâncias), cache do feed e dos _gospel cards_
(L2). **Plano**: gratuito (MVP). **Região**: Frankfurt (confirmar disponibilidade na consola).
Variável: `REDIS_URL`.

## 1. Limites do plano gratuito (pesquisa de 2026-11-20; confirmar na consola)

| Limite         | Valor                                      | Efeito para nós                                                               |
| -------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| Dados          | 250 MB                                     | Folgado: chaves de limite e cache têm TTL.                                    |
| Comandos       | **500 mil por mês**                        | **Risco R3**: o limite e a cache gastam comandos em quase todos os pedidos.   |
| Pedido         | 10 MB; 10 000 comandos/s; 10 GB de tráfego | Sem impacto.                                                                  |
| Bases de dados | 1                                          | Uma por ambiente: produção usa a gratuita; dev usa o Redis do docker-compose. |
| TLS            | sim                                        | Usar `rediss://`.                                                             |

A documentação consultada não indica o que acontece ao esgotar os comandos: **confirmar na consola e
registar aqui** antes do deploy.

## 2. Criação (Etapa 2)

1. Upstash → **Create database**: tipo Redis, região Frankfurt (`eu-central-1`) se existir, TLS activo.
2. Copiar a _connection string_ `rediss://…` para o cofre (nunca no repositório) e usá-la em `REDIS_URL`.
3. Não activar _eviction_ por omissão sem confirmar: as chaves do rate limit têm TTL próprio.

## 3. O que a API faz com o Redis

- Rate limit por IP, por IP+utilizador e por conta (rate-limiter-flexible), com **fallback em memória** se o Redis falhar
  (a contagem passa a ser por instância).
- Cache do feed e dos cards, versionada (`cc:v1:feed:version`); sem Redis a leitura vai à base de dados.
- O cliente (`ioredis`) tem `maxRetriesPerRequest: 3`, ligação com _timeout_ de 3 s e fila offline desligada: com o Redis em baixo o
  pedido falha depressa em vez de ficar à espera.

## 4. Operação

- **Consumo**: consola da Upstash (comandos e dados). Alerta interno a 70 % (ver [gestao-e-controlo](gestao-e-controlo.md) §5).
- **Medir por fluxo** (Etapa 7): anotar a variação de comandos antes e depois de um login, de uma leitura do feed e de uma
  partilha; extrapolar para o tráfego esperado.
- **Se esgotar**: a API continua (limitador em memória, cache em L1), mas com limites por instância; subir de plano ou
  baixar o consumo é a decisão do operador.
- **Rodar a palavra-passe**: gerar novo _token_/password na consola, actualizar `REDIS_URL` no Render e redeploy.
- **Forçar a invalidação do feed**: `INCR cc:v1:feed:version` (ver incidentes no runbook principal).

## 5. Verificação

- [ ] `redis-cli --tls -u <REDIS_URL> PING` devolve `PONG`.
- [ ] `/health/deep` devolve `redis: ok`.
- [ ] Após um login falhado, aparecem chaves com prefixo do limitador e TTL definido (sem IP legível: são HMAC).
