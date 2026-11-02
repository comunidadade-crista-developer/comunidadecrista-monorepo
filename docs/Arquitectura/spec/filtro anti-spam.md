# Especificação — E4.6 (filtro anti-spam) e E4.7 (severidade de denúncias)

**Versão**: 1.0 — para aprovação antes de codificar
**Base**: E4 fechado, E5 pendente (vai consumir estes serviços)
**Estado**: proposta fechada; aguarda "ok" para implementar

---

## 1. Princípios

1. **Rejeitar com certeza, sinalizar com dúvida.** Links/emails/telefones/IPs são proibidos sem ambiguidade → `400`. Caps, repetições, keywords de scam podem ser legítimos → `pending_review`.
2. **Servidor como fonte de verdade.** Validação no cliente é UX, não segurança. O `createPostService` revalida sempre — REST e `/sync` partilham a mesma regra.
3. **Sem julgamento doutrinal automático.** A integridade doutrinal passa por **denúncias + admin**, não por filtro de texto. Filtro pré-publicação só lida com spam mecânico.
4. **Defesa em profundidade.** Contas novas vão para `pending_review` mesmo que o conteúdo passe o filtro.
5. **Erros explicáveis.** Cada rejeição tem código claro + mensagem PT-PT que o utilizador compreende.

---

## 2. E4.6 — Filtro anti-spam (pré-publicação)

### 2.1 Onde é aplicado

| Camada | Ficheiro | Comportamento |
|---|---|---|
| Schema partilhado | `packages/shared/src/content-filter.ts` + `CreatePostRequest.superRefine()` | Rejeita no cliente + servidor |
| Serviço | `services/posts.ts → createPostService` | Revalida (defesa em profundidade) |
| Sync | `routes/sync.ts → processOne` | Mesma regra via serviço |

### 2.2 Normalização do texto (antes de qualquer deteção)

```
1. NFKC normalize        (converte full-width, ligaduras, circled chars)
2. Remover zero-width    \u200B-\u200D \uFEFF
3. Remover combining     \u0300-\u036F decorativos após strip
4. Colapsar whitespace   /\s+/g → ' '
5. lowercase
```

Executado em ambas as validações (shared + serviço). Idempotente.

### 2.3 Deteções — 4 famílias

#### A) Links — **rejeição imediata** (`400 contains_link`)

| Padrão | Regex (sobre texto normalizado) |
|---|---|
| Scheme explícito | `\b(https?\|hxxps?\|ftp\|ftps)\s*:\s*/{1,2}` |
| `www.` | `\bwww\s*\.` |
| Domínio com TLD banido | `\.(?:TLDs)\b` (ver lista) |
| Domínio multi-parte | `\.(?:pages\.dev\|vercel\.app\|github\.io\|netlify\.app\|workers\.dev\|dweb\.link\|co\.uk\|com\.br)\b` |
| IPv4 | `\b\d{1,3}(?:\.\d{1,3}){3}\b` |
| IPv6 (forma curta) | `\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9]{1,4}\b` |

**Lista de TLDs banidos** (do user + defaults):

```
com xyz top buzz bond sbs cfd li ru es dev icu tk ml ga cf gq zip mov
```

**Lista multi-parte**:

```
pages.dev vercel.app github.io netlify.app workers.dev dweb.link co.uk com.br
```

**Nota sobre `.com`**: `\b` no final evita falsos positivos em `comunidade`, `comum`, `comparar`. O padrão `\.com\b` só casa quando `.com` termina em boundary (fim de string, espaço, pontuação).

**Trade-off aceite**: `"O site da igreja é igreja.com"` é rejeitado. É uma ligação externa — a regra é clara e o utilizador tem o aviso da UI.

#### B) Contactos — **rejeição imediata** (`400 contains_contact`)

| Padrão | Regex |
|---|---|
| Email | `[a-z0-9._%+-]+\s*(?:@\|＠\|\(at\)\|\[at\])\s*[a-z0-9.-]+\.[a-z]{2,}` |
| Telefone PT (9 dígitos) | `\b(?:9[1236]\d{7})\b` |
| Telefone PT com prefixo | `\b(?:\+351\|00351)?[\s-]?9[1236]\d{7}\b` |
| WhatsApp/Telegram com número | `(?:whatsapp\|telegram\|zap)\b[^\n]{0,20}\b9[1236]\d{7}\b` |

**Fora da lista por falso positivo**: números soltos curtos (`"João 3:16"` contém `16` mas não é telefone). Só o padrão 9 dígitos com `9[1236]` — que é o prefixo móvel PT e não aparece em referências bíblicas.

#### C) Sinais de spam — **sinaliza para review** (não rejeita)

| Sinal | Regra | Nota |
|---|---|---|
| ALL CAPS | `len > 50` AND `> 50%` são letras maiúsculas | Pode ser legítimo ("JESUS VOLTARÁ!") |
| Repetição excessiva | `/(.)\1{9,}/` (mesmo char 10×) | Falso positivo baixo |
| Pontuação excessiva | `/[!?]{5,}/` | "Aleluia!!!!!" é spam |
| Keyword scam | `/bitcoin\|criptomoeda\|investimento garantido\|ganhe dinheiro\|ganhos rápidos\|clique aqui\|prémio\|sorteio\|renda extra\|multiplica teu dinheiro/i` | Aplicar sobre normalizado |

**Consequência**: post não é rejeitado mas vai para `pending_review`.

#### D) AUTO-FLAG por conta — **sinaliza para review**

Independente do conteúdo:

- Conta com `createdAt` < 7 dias atrás
- Conta com 0 posts publicados (primeira publicação)

→ `status = 'pending_review'` no `createPostService`.

O post **é** criado (o utilizador não perde o conteúdo), só não aparece imediatamente no feed público. Admin aprova ou rejeita em E6.

### 2.4 Ordem de avaliação no `createPostService`

```
1. Normalizar conteúdo + título
2. A) Se containsLink        → rejeitar 400 contains_link
3. B) Se containsContact     → rejeitar 400 contains_contact
4. C) Se spamSignals         → flag pending_review (não rejeitar)
5. D) Se conta nova          → flag pending_review
6. Se pending_review         → status = 'pending_review'
   Senão                     → status = 'published'
```

### 2.5 Códigos de erro (`ServiceError`)

Adicionar a `ServiceError` em `services/posts.ts`:

```ts
| { code: 'contains_link'; status: 400 }
| { code: 'contains_contact'; status: 400 }
```

O `CreatePostResponse` ganha `status: 'published' | 'pending_review'` (já tem).

### 2.6 Mapeamento para resposta HTTP

| Erro do serviço | HTTP | Body |
|---|---|---|
| `contains_link` | 400 | `{ error: 'contains_link' }` |
| `contains_contact` | 400 | `{ error: 'contains_contact' }` |
| Sucesso (`published`) | 201 | `{ post, status: 'published' }` |
| Sucesso (`pending_review`) | 201 | `{ post, status: 'pending_review' }` |

**Mensagens PT-PT para a UI (E8+)** — a definir no cliente, não no backend:

- `contains_link` → *"Por segurança, não aceitamos ligações externas nesta fase. Descreve em texto o recurso que queres partilhar."*
- `contains_contact` → *"Não é possível partilhar emails, telefones ou IPs. A comunhão acontece aqui dentro."*
- `pending_review` → *"A tua partilha está em revisão pela equipa. Aparecerá em breve."*

### 2.7 Integração com `/sync` (E5)

O `post.create` no `/sync` passa pela mesma `createPostService`, logo herda o filtro. Se rejeitado:

```json
{ "op_id": "...", "status": "rejected", "error": { "code": "contains_link" } }
```

Cliente (E10) mostra o motivo e remove do outbox.

### 2.8 Interface pública (`packages/shared/src/content-filter.ts`)

```ts
export interface ContentViolation {
  kind: 'link' | 'contact' | 'spam_signal';
  hint: string;   // mensagem curta PT-PT
}

export interface ContentCheckResult {
  reject: false;
  flags: ContentViolation[];      // sinalizações (spam signals)
} | {
  reject: true;
  violations: ContentViolation[]; // rejeições (link, contact)
};

export function checkContent(content: string, title: string): ContentCheckResult;
```

**Nota**: o título também é verificado. Um título `"Visita exemplo.com"` deve rejeitar.

---

## 3. E4.7 — Severidade de denúncias

### 3.1 Categorias de denúncia (user-facing, PT-PT)

| Label ao utilizador | Código interno | Severidade | Threshold |
|---|---|---|---|
| **Spam ou publicidade** | `spam` | `basic` | 10 |
| **Fora do tema** | `off_topic` | `basic` | 10 |
| **Ofensa ou desrespeito** | `offensive` | `medium` | 5 |
| **Ensino contrário à Palavra** | `doctrine` | `high` | 2 |
| **Outro motivo** (requer descrição) | `other` | `basic` | 10 |

O `reason` (descrição livre) passa a ser **opcional**, obrigatório apenas quando `category = 'other'`.

### 3.2 Porque estes thresholds

- **`basic` (10)** — o comportamento actual. Spam/fora-do-tema não é perigoso, é ruído. 10 é uma amostra razoável da comunidade.
- **`medium` (5)** — ofensa afecta pessoas. 5 reportes diferentes é sinal forte.
- **`high` (2)** — doutrina é o núcleo do projecto. 2 reportes de irmãos estabelecidos justifica revisão imediata.

**Risco aceite**: dois utilizadores mal-intencionados podem silenciar um post temporariamente. Mitigações activas:
- 1 denúncia por user por post
- Conta < 7 dias ou 0 posts **não conta** para o limiar (regra existente)
- Post escondido continua visível para o autor
- Admin revê em E6
- Log de denúncias falsas permite suspender utilizadores reincidentes (pós-MVP)

### 3.3 Lógica de escalonamento

Um post passa a `pending_review` se **qualquer** condição for verdadeira, contando apenas denúncias de utilizadores válidos (as mesmas regras de hoje: conta ≥ 7 dias e ≥ 1 post):

```
count(open reports WHERE category ∈ {spam, off_topic, other}) ≥ 10
count(open reports WHERE category = offensive)               ≥ 5
count(open reports WHERE category = doctrine)                ≥ 2
```

- Não há somas cruzadas. 4 basic + 4 medium + 1 high = não escala. 9 basic + 2 high = escala (high atinge 2).
- O escalonamento é **irreversível** para `pending_review` no MVP (igual ao comportamento actual). Cancelar denúncias após escalonamento não reverte.
- `reports_count` no `posts` continua a existir como **total** (todas as categorias juntas), para métrica interna.
- Contadores por severidade **não** são mantidos em coluna — são calculados por query na hora da denúncia (transacção). O volume (10-20 denúncias por post) justifica o cálculo, não justifica desnormalização.

### 3.4 Alteração da API

#### `POST /posts/:id/report`

**Antes**:
```json
{ "reason": "conteúdo impróprio" }
```

**Depois**:
```json
{
  "category": "spam" | "off_topic" | "offensive" | "doctrine" | "other",
  "reason": "texto opcional (obrigatório se category=other, min 3, max 500)"
}
```

**Regra**: `category` obrigatório. `reason` obrigatório quando `category === 'other'`. Para as outras categorias, `reason` é opcional e truncado a 500.

**Compatibilidade**: os testes actuais enviam `{ reason: 'motivo de teste' }`. Serão actualizados para incluir `category`. **Sem default** — a API é breaking, e é o momento certo (pré-release).

#### `SyncReportPost` (E5)

Payload do sync ganha o mesmo campo:

```ts
payload: z.object({
  postId: z.string().uuid(),
  category: ReportCategory,     // novo
  reason: z.string().min(3).max(500).optional(),
}).strict()
```

### 3.5 `reportsRepo.file` — nova assinatura

```ts
interface FileReportArgs {
  postId: string;
  reporterId: string;
  category: ReportCategory;
  reason?: string;
}

interface FileReportRules {
  thresholds?: {
    basic?: number;   // default 10
    medium?: number;  // default 5
    high?: number;    // default 2
  };
}

file(args: FileReportArgs, rules?: FileReportRules): Promise<FileReportOutcome>;
```

**`FileReportOutcome`** (mantém shape existente):
```ts
| { outcome: 'created'; report: Report; reportsCount: number; validReports: number; escalated: boolean }
| { outcome: 'duplicate' }
| { outcome: 'own_post' }
| { outcome: 'post_not_found' }
```

O `validReports` no `created` continua a ser o **total** de denúncias válidas (todas as categorias), para compatibilidade com testes existentes. Adicionar um `validReportsBySeverity: { basic: number; medium: number; high: number }` para o admin (opcional, pós-MVP).

### 3.6 Alterações ao schema (`reports`)

```sql
ALTER TABLE reports ADD COLUMN category report_category NOT NULL DEFAULT 'other';
ALTER TABLE reports ADD COLUMN severity report_severity NOT NULL DEFAULT 'basic';

CREATE TYPE report_category AS ENUM ('spam', 'off_topic', 'offensive', 'doctrine', 'other');
CREATE TYPE report_severity AS ENUM ('basic', 'medium', 'high');
```

**Migração de dados existentes**: denúncias actuais ficam `category='other'`, `severity='basic'`. Comportamento idêntico ao actual (threshold 10).

`severity` é **derivada** de `category` no insert (regra de negócio) e guardada para query rápida. Se um dia o mapping mudar (ex.: `offensive` passar a `high`), migração de dados é trivial (`UPDATE reports SET severity = 'high' WHERE category = 'offensive'`).

### 3.7 Admin (E6)

O dashboard mostra, por post:
- Total de denúncias abertas
- Breakdown por categoria: 3 spam, 2 ofensivo, 1 doutrina
- Estado: `published` / `pending_review`
- Autor das denúncias (para detetar abuso)

### 3.8 Cancelamento de denúncia

`DELETE /posts/:id/report` cancela a denúncia do próprio user. Não altera o status do post (já é irreversível, como hoje). Decrementa `reports_count`.

---

## 4. Alterações à base de dados

**Migração 1** (E4.6 + E4.7 numa só, para evitar janelas de inconsistência):

```sql
-- Reports: categoria + severidade
CREATE TYPE report_category AS ENUM ('spam', 'off_topic', 'offensive', 'doctrine', 'other');
CREATE TYPE report_severity AS ENUM ('basic', 'medium', 'high');

ALTER TABLE reports
  ADD COLUMN category report_category NOT NULL DEFAULT 'other',
  ADD COLUMN severity report_severity NOT NULL DEFAULT 'basic';

CREATE INDEX reports_post_category_status_idx ON reports (post_id, category, status);

-- Posts: nada muda estruturalmente.
--   status='pending_review' já existe.
--   reports_count continua a ser total.
```

**Nota**: o `drizzle-kit` gera o SQL; confirmar que não tenta recriar `reports_count` nem apagar dados.

---

## 5. Env vars

```dotenv
# Severidade de denúncias (E4.7)
REPORT_THRESHOLD_BASIC=10
REPORT_THRESHOLD_MEDIUM=5
REPORT_THRESHOLD_HIGH=2

# Filtro anti-spam (E4.6) — só lista de keywords, o resto é fixo
SPAM_KEYWORDS=bitcoin,criptomoeda,investimento garantido,ganhe dinheiro,ganhos rápidos,clique aqui,prémio,sorteio,renda extra,multiplica teu dinheiro
```

**Defaults em código** (se envs não existirem). `.env.example` documenta.

Não exponho TLDs por env — são estáveis, hardcoded em `content-filter.ts`. Se um dia crescerem muito, avaliamos.

---

## 6. Plano de testes

### 6.1 Filtro (novo — `packages/shared/test/content-filter.test.ts` + `apps/api/test/services/content-filter.test.ts`)

| # | Caso |
|---|---|
| 1 | `https://x.com` → reject `link` |
| 2 | `www.x.com` → reject `link` |
| 3 | `x[.]com` → reject `link` |
| 4 | `ｘ.ｃｏｍ` (full-width) → reject `link` após normalização |
| 5 | `exem\u200Bplo.com` (zero-width) → reject `link` |
| 6 | `igreja.pages.dev` → reject `link` (multi-parte) |
| 7 | `bit.ly/abc` → reject `link` |
| 8 | `user@x.com` → reject `contact` |
| 9 | `user＠x.com` → reject `contact` |
| 10 | `912345678` → reject `contact` |
| 11 | `+351 912 345 678` → reject `contact` |
| 12 | `192.168.1.1` → reject `contact` |
| 13 | `Mateus 2:1-12` → passa |
| 14 | `João 3:16` → passa |
| 15 | `"comunidade cristã"` → passa (não confunde `.com` em `comunidade`) |
| 16 | `"DEUS É MARAVILHOSO"` (> 50% caps) → não rejeita, sinaliza `spam_signal` |
| 17 | `"aaaaaaaaaaaa"` → sinaliza `spam_signal` |
| 18 | `"Aleluia!!!!!!"` → sinaliza `spam_signal` |
| 19 | `"ganhe dinheiro fácil"` → sinaliza `spam_signal` |
| 20 | `"O Nascimento de Jesus é descrito em Mateus 2"` → passa limpo |

### 6.2 Serviço — `createPostService` com filtro

| # | Caso |
|---|---|
| 21 | Conteúdo com link → 400 `contains_link`, nada criado |
| 22 | Conteúdo com email → 400 `contains_contact` |
| 23 | Título com link → 400 `contains_link` |
| 24 | Conta nova (< 7 dias) → `status='pending_review'` mesmo com conteúdo limpo |
| 25 | Conta com 0 posts → `status='pending_review'` |
| 26 | Conta estabelecida + conteúdo limpo → `status='published'` |
| 27 | Conta estabelecida + caps → `status='pending_review'` |
| 28 | `/sync` `post.create` com link → `rejected` + code |
| 29 | `/sync` `post.create` com conta nova → `applied` mas `status='pending_review'` no result |

### 6.3 Reports severity

| # | Caso |
|---|---|
| 30 | 10 spam → escala |
| 31 | 5 offensive → escala |
| 32 | 2 doctrine → escala |
| 33 | 9 spam + 1 doctrine = não escala (spam 9<10, doctrine 1<2) |
| 34 | 4 spam + 4 offensive + 1 doctrine = não escala |
| 35 | 9 spam + 2 doctrine = escala (doctrine atinge 2) |
| 36 | Denúncia `duplicate` mantém contadores |
| 37 | Denúncia `own_post` mantém contadores |
| 38 | Conta nova reporta doctrine → não conta para threshold |
| 39 | Conta antiga sem posts reporta doctrine → não conta |
| 40 | Cancelar denúncia decrementa `reports_count`, não reverte `pending_review` |
| 41 | Threshold customizado por rules (`{ basic: 2, medium: 2, high: 2 }`) |
| 42 | Endpoint REST `POST /posts/:id/report` com `category` válida → 200 |
| 43 | Endpoint REST sem `category` → 400 |
| 44 | Endpoint REST `category='other'` sem `reason` → 400 |
| 45 | Endpoint REST `category='spam'` sem `reason` → 200 (reason é opcional) |

### 6.4 Testes existentes a actualizar

| Ficheiro | Actualização |
|---|---|
| `reports.rules.test.ts` | Adicionar `category` em todos os `file({...})`. Testes com `{ threshold: 2 }` passam a `{ thresholds: { basic: 2 } }` |
| `reports.test.ts` | Adicionar `category` |
| `routes/posts.test.ts` | Report: `{ category: 'spam', reason: '...' }` |
| `services/posts.test.ts` | Report com `category: 'spam'` |

**Total estimado**: +45 testes novos, ~15 actualizados. Suite final ~260-270.

---

## 7. Fora de âmbito (pós-MVP)

- Blocklist doutrinal (decidido: não)
- Filtro semântico / NLP
- Confidence score por utilizador (reputação de repórter)
- Suspensão automática de repórteres abusivos
- Painel de transparência ("quantos posts rejeitados por X motivo")
- Deteção de coordenadas de brigading (vários IPs, mesmo ASN)
- Configuração dinâmica de TLDs/keywords via admin UI

---

## 8. Riscos

| # | Risco | Mitigação |
|---|---|---|
| R1 | 2 users maliciosos silenciam post via `doctrine` | Admin revê rapidamente; logs de denúncia falsa; suspensão pós-MVP |
| R2 | Falsos positivos do filtro de links (contexto legítimo) | UI mostra razão clara; sem penalização do utilizador; feedback via suporte |
| R3 | Utilizador contorna via imagem | Já não há imagens no MVP; se houver upload (E11), revemos |
| R4 | `ALL CAPS` legítimo cai em review | Admin aprova; custo de tempo do admin |
| R5 | Migração quebra dados existentes | `DEFAULT 'other'` + `DEFAULT 'basic'` mantém comportamento |
| R6 | Sync quebra por payload sem `category` | Nova versão do schema é breaking; E10 envia sempre `category`; `/sync` rejeita com `400` envelope se faltar |
