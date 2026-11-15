# Especificação — filtro anti-spam (E4.6) e severidade de denúncias (E4.7)

**Versão**: 2.0 — alinhada com o que foi implementado (E4-a a E4-c)
**Estado**: implementado. Esta especificação é histórica e de referência; **em caso de divergência prevalecem os ADRs** ([ADR-013](../adr/ADR-013.md) e [ADR-014](../adr/ADR-014.md)) e o código.

> A versão 1.0 era uma proposta anterior à implementação. Divergia dos ADRs em quatro pontos, **corrigidos aqui**:
>
> 1. Havia um «pendente automático por conta» (conta com menos de 7 dias ou sem partilhas): **foi rejeitado** (ADR-013 §D); não existe.
> 2. O limiar de `doctrine` era 2: passou a **3** (ADR-014).
> 3. Listas e limiares configuráveis por variáveis de ambiente (`REPORT_THRESHOLD_*`, `SPAM_KEYWORDS`): **são constantes fixas no código**.
> 4. Retirar uma denúncia apagava a linha: agora fica `withdrawn` (registo) e conta como «já denunciou».

---

## 1. Princípios

1. **Rejeitar com certeza, sinalizar com dúvida.** Ligações, emails, telefones e IPs são proibidos sem ambiguidade (`400`); maiúsculas, repetições e palavras de esquema podem ser legítimas (`pending_review`).
2. **O servidor é a fonte de verdade.** A validação no cliente é conforto, não segurança. `createPostService` revalida sempre; o REST e o `/sync` partilham o mesmo serviço.
3. **Sem julgamento doutrinal automático.** A integridade doutrinal passa por denúncias e administrador, não por filtro de texto.
4. **Defesa em profundidade sem «pendente por conta».** Limite de criação por utilizador, filtro, denúncias por gravidade e administrador.
5. **Erros explicáveis.** Cada recusa tem um código estável e o cliente mostra a mensagem em PT-PT.

---

## 2. Filtro anti-spam (pré-publicação)

### 2.1 Onde é aplicado

| Camada            | Ficheiro                                             | Comportamento                                                    |
| ----------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| Função partilhada | `packages/shared/src/content-filter.ts`              | `checkContent(título, conteúdo)`; igual no cliente e no servidor |
| Serviço           | `apps/api/src/services/posts.ts → createPostService` | Aplica-o sempre (REST e `/sync`)                                 |
| Sync              | `apps/api/src/routes/sync.ts`                        | `post.create` usa o serviço: devolve `rejected` + código         |

### 2.2 Normalização

NFKC → remoção de invisíveis (`\p{Cf}`) → pontos disfarçados (`。`, `[.]`, `(.)`, `[dot]`, `(ponto)`) → `.` → colapso de espaços → minúsculas. Para ligações e contactos usa-se ainda um «esqueleto»: letras cirílicas/gregas idênticas a latinas passam a latinas e `dot com`/`ponto com` passam a `.com`.

### 2.3 Famílias de detecção

Detalhe e tabelas em [ADR-013](../adr/ADR-013.md). Resumo:

| Família        | Resultado                            | Exemplos                                                                                                          |
| -------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Contactos      | `400 contains_contact` (precedência) | `a@b.pt`, `a (at) b.pt`, `+258 84 123 4567`, `whatsapp 912 345 678`, `192.168.1.1`                                |
| Ligações       | `400 contains_link`                  | `https://x.com`, `www.x`, `igreja.com`, `igreja . com`, `igreja[.]com`, `igreja dot com`, `igreja.cоm` (cirílico) |
| Sinais de spam | `201` com `status: pending_review`   | `caps`, `repetition`, `punctuation`, `keywords`, `contact_solicitation`, `mixed_script`                           |
| Passa limpo    | `201` com `status: published`        | `Mateus 2:1-12`, `João 3:16`, `comunidade cristã`, `obrigado @maria`, `Amém. Com isso…`                           |

Um número de telefone é reconhecido por: prefixo internacional explícito (`+…`, 8+ dígitos) ou número nacional completo de Portugal, Moçambique, Angola ou Brasil. Uma referência bíblica nunca é um número de telefone.

### 2.4 Ordem de avaliação no `createPostService`

```
1. Conta activa (sem apagamento pendente)        → senão 403 account_inactive
2. Chave de idempotência já usada                → devolve a resposta guardada (ou 409 se o corpo mudou)
3. checkContent(título, conteúdo)
   contacto → 400 contains_contact
   ligação  → 400 contains_link
4. Sinais de spam                                → status = pending_review, review_flags = [códigos]
   Senão                                         → status = published
```

Não existe passo «conta nova». O post em revisão **é** criado; o autor vê-o no topo da 1.ª página do feed, os outros não.

### 2.5 Respostas

| Situação                        | REST                                     | `/sync`                                       |
| ------------------------------- | ---------------------------------------- | --------------------------------------------- |
| Ligação                         | `400 { error: "contains_link" }`         | `rejected`, `error.code = "contains_link"`    |
| Contacto                        | `400 { error: "contains_contact" }`      | `rejected`, `error.code = "contains_contact"` |
| Publicada                       | `201 { post, status: "published" }`      | `applied`, `result.status = "published"`      |
| Em revisão                      | `201 { post, status: "pending_review" }` | `applied`, `result.status = "pending_review"` |
| Repetição (mesma chave e corpo) | `200` com a resposta original            | `duplicate`                                   |

Mensagens sugeridas para a UI (definidas no cliente): ligação — _«Por segurança, não aceitamos ligações externas. Descreve em texto o que queres partilhar.»_; contacto — _«Não é possível partilhar emails, telefones ou IPs.»_; revisão — _«A tua partilha está em revisão pela equipa. Aparecerá em breve.»_

### 2.6 Interface (`packages/shared/src/content-filter.ts`)

```ts
export type ContentCheckResult =
  | { reject: true; violations: ContentViolation[] }
  | { reject: false; flags: ContentViolation[] };

export function checkContent(
  title: string,
  content: string,
): ContentCheckResult;
export function flagCodes(result: ContentCheckResult): ContentFlagCode[];
```

O título também é verificado: um título `«Visita igreja.com»` é rejeitado.

---

## 3. Severidade de denúncias

### 3.1 Categorias e limiares

| Etiqueta (UI)              | Código      | Gravidade | Limiar |
| -------------------------- | ----------- | --------- | ------ |
| Spam ou publicidade        | `spam`      | `basic`   | 10     |
| Fora do tema               | `off_topic` | `basic`   | 10     |
| Ofensa ou desrespeito      | `offensive` | `medium`  | 5      |
| Ensino contrário à Palavra | `doctrine`  | `high`    | **3**  |
| Outro motivo               | `other`     | `basic`   | 10     |

`reason` é opcional, **obrigatório em `other`** (3–500 caracteres).

### 3.2 Quem conta e como se escala

- Só contam denúncias **abertas** de utilizadores com conta de **7 ou mais dias** E **pelo menos uma partilha publicada e não apagada**.
- Por gravidade, sem somas cruzadas: `basic ≥ 10` ou `medium ≥ 5` ou `high ≥ 3` → o post passa de `published` a `pending_review`, com `reports_<gravidade>` em `review_flags`.
- 4 `basic` + 4 `medium` + 2 `high` não escala. 9 `basic` + 3 `high` escala (`high` atinge 3).
- Só se denunciam partilhas `published` e não apagadas. Não se denuncia a própria partilha.
- Escalar é **irreversível automaticamente**: retirar denúncias não devolve o post ao feed; decide o administrador.
- `reports_count` é o total de denúncias abertas (métrica interna); a contagem por gravidade faz-se por consulta, na transacção.

### 3.3 Uma denúncia por utilizador e por post

A unicidade `(post_id, reporter_id)` vale **em qualquer estado**: depois de retirar, denunciar de novo devolve `duplicate` (não se repõe o contador à vontade). Retirar passa a denúncia a `withdrawn` (`withdrawn_at`); a linha fica como registo.

### 3.4 API

- `POST /posts/:id/report` `{ category, reason? }` → `200 { outcome: "created" | "duplicate" }`; erros: `400 own_post`, `404 not_found`, `400 validation_error`.
- `DELETE /posts/:id/report` → `200 { withdrawn: true }` (idempotente); `404` se nunca denunciou.
- `/sync`: `post.report` com o mesmo payload; `post.unreport` com `{ postId }`.

### 3.5 Base de dados (migração `0004`)

`report_category`, `report_severity`; `report_status` + `withdrawn`; `reports.category` obrigatória; `reports.severity` **coluna gerada** a partir da categoria; `reports.reason` nullable com `CHECK` para `other`; `withdrawn_at`; índice `(post_id, category, status)`. Denúncias antigas migram como `other` (com o `reason` que já tinham), gravidade `basic`. Detalhe em [ADR-014](../adr/ADR-014.md).

---

## 4. Constantes (sem variáveis de ambiente)

Limiares (`REPORT_THRESHOLDS`), idade mínima do denunciante (`REPORTER_MIN_AGE_DAYS = 7`), TLDs, palavras de spam e limites de maiúsculas/repetição/pontuação estão no código e mudam por _pull request_. As únicas variáveis relacionadas são os limites de pedidos por hora (`RATE_LIMIT_POSTS_CREATE_*`, `RATE_LIMIT_REPORTS_*`, …).

---

## 5. Plano de testes (cobertura actual)

| Área                                                                                                                  | Onde                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Filtro: rejeições, ofuscações, falsos positivos, sinais, carga adversarial                                            | `apps/api/test/shared/content-filter.test.ts`                                                     |
| Serviço de criação: ligação, contacto, título, spam → revisão, publicada, idempotência, conflito, conta em apagamento | `apps/api/test/services/posts.test.ts`                                                            |
| Escalada por gravidade (10/5/3, sem somas cruzadas), denunciante válido, `duplicate`, `own_post`, retirada            | `apps/api/test/repositories/reports.severity.test.ts`, `reports.rules.test.ts`, `reports.test.ts` |
| Rotas REST (feed, post, criar, apagar, likes, denúncias)                                                              | `apps/api/test/routes/posts.test.ts`                                                              |
| `/sync`: `applied`/`duplicate`/`rejected`/`deferred`, limites por operação, bootstrap                                 | `apps/api/test/routes/sync.test.ts`                                                               |

Os casos 24, 25 e 29 da versão 1.0 («conta nova → `pending_review`») **foram removidos**: a regra não existe. Em seu lugar, os testes garantem que uma conta nova com conteúdo limpo publica directamente.

---

## 6. Fora de âmbito (pós-MVP)

Lista de palavras doutrinais; filtro semântico; reputação e suspensão automática de denunciantes; detecção de ataques coordenados; painel de transparência; configuração dinâmica de TLDs e palavras pelo admin; upload de imagem.

## 7. Riscos

| #   | Risco                                         | Mitigação                                                                                     |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| R1  | 3 utilizadores válidos silenciam uma partilha | Denunciante com 7 dias e partilha publicada; 1 denúncia por post; limite por hora; admin revê |
| R2  | Falso positivo do filtro de ligações          | Mensagem clara (diz como corrigir, ex.: espaço depois do ponto); sem penalização              |
| R3  | Contornar o filtro com símbolos parecidos     | Normalização NFKC, invisíveis, pontos disfarçados, esqueleto cirílico/grego                   |
| R4  | Texto legítimo em maiúsculas cai em revisão   | O admin aprova; custo de tempo do admin                                                       |
| R5  | Migração quebra dados existentes              | Denúncias antigas → `other` com o `reason`; `DEFAULT` só no preenchimento                     |
| R6  | Spam sem sinais passa o filtro                | Denúncias por gravidade + admin; rever se houver abuso por contas novas                       |
