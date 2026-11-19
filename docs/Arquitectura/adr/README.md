# Decisões de arquitectura (ADRs)

Um ficheiro por decisão. Estado: **Aceite** salvo indicação em contrário. Uma decisão que mude não se apaga: acrescenta-se uma nota de revisão no próprio ADR (ou um ADR novo que o substitui e é referido no antigo).

| ADR                       | Decisão                                                     |
| ------------------------- | ----------------------------------------------------------- |
| [ADR-001](ADR-001.md) | PWA em vez de app nativa                                    |
| [ADR-002](ADR-002.md) | Monorepo com pnpm workspaces                                |
| [ADR-003](ADR-003.md) | Neon em vez de Supabase                                     |
| [ADR-004](ADR-004.md) | Upstash Redis apenas para cache e rate limit                |
| [ADR-005](ADR-005.md) | Outbox table em Postgres + worker in-process                |
| [ADR-006](ADR-006.md) | Autenticação: JWT EdDSA + refresh rotativo + argon2id       |
| [ADR-007](ADR-007.md) | Offline-first com outbox local + idempotency keys           |
| [ADR-008](ADR-008.md) | Conteúdo bíblico apenas por referência                      |
| [ADR-009](ADR-009.md) | Avatar gerado, sem upload                                   |
| [ADR-010](ADR-010.md) | Admin na mesma app, role `admin`                            |
| [ADR-011](ADR-011.md) | Recuperação de conta: código imediato, perguntas com atraso |
| [ADR-012](ADR-012.md) | Apagamento de conta: período de graça de 30 dias            |
| [ADR-013](ADR-013.md) | Filtro anti-spam no conteúdo                                |
| [ADR-014](ADR-014.md) | Severidade de denúncias                                     |
| [ADR-015](ADR-015.md) | Admin: criação e promoção só por CLI, mesmo login           |
