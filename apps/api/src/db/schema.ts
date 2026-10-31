import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

const id = () =>
  uuid("id")
    .primaryKey()
    .notNull()
    .$defaultFn(() => uuidv7());

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());

export const roleEnum = pgEnum("role", ["user", "admin"]);
export const postStatusEnum = pgEnum("post_status", [
  "published",
  "pending_review",
  "hidden",
  "rejected",
]);
// O que fazer às partilhas quando a conta é apagada (escolha do utilizador).
export const deletionPostsModeEnum = pgEnum("deletion_posts_mode", [
  "anonymize",
  "delete",
]);
export const postCategoryEnum = pgEnum("post_category", [
  "entendimento",
  "ensinamento",
  "letra_cancao",
]);
export const reportStatusEnum = pgEnum("report_status", [
  "open",
  "resolved_kept",
  "resolved_removed",
]);
export const moderationActionEnum = pgEnum("moderation_action", [
  "approved",
  "rejected",
]);
export const outboxStatusEnum = pgEnum("outbox_status", [
  "pending",
  "processing",
  "done",
  "failed",
]);

export const users = pgTable(
  "users",
  {
    id: id(),
    username: citext("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    recoveryCodeHash: text("recovery_code_hash"),
    securityQ1Hash: text("security_q1_hash").notNull(),
    securityQ2Hash: text("security_q2_hash").notNull(),
    securityQ3Hash: text("security_q3_hash").notNull(),
    avatarSeed: text("avatar_seed").notNull(),
    role: roleEnum("role").notNull().default("user"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Pedido de apagamento: a conta fica «pendente» (sem sessões, sem acesso) e um login com
    // a palavra-passe correcta nos 30 dias seguintes reactiva-a. Passado o prazo, um job
    // apaga-a de vez. Nulo = conta activa.
    deletionRequestedAt: timestamp("deletion_requested_at", {
      withTimezone: true,
    }),
    deletionPostsMode: deletionPostsModeEnum("deletion_posts_mode"),
  },
  (t) => [
    uniqueIndex("users_username_unique").on(t.username),
    index("users_role_idx").on(t.role),
    index("users_deletion_requested_idx").on(t.deletionRequestedAt),
  ],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    familyId: uuid("family_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("refresh_tokens_token_hash_unique").on(t.tokenHash),
    index("refresh_tokens_user_id_idx").on(t.userId),
    index("refresh_tokens_family_idx").on(t.familyId),
    index("refresh_tokens_expires_idx").on(t.expiresAt),
  ],
);

// Pedido de nova palavra-passe feito via perguntas de segurança. Só produz efeito depois de
// `effective_at` e é cancelado se o dono entrar com a palavra-passe actual.
export const pendingPasswordResets = pgTable(
  "pending_password_resets",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    passwordHash: text("password_hash").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("pending_password_resets_effective_idx").on(t.effectiveAt)],
);

// jti das sessões de recuperação já usadas (uso único). Linhas expiradas são purgadas.
export const usedRecoverySessions = pgTable(
  "used_recovery_sessions",
  {
    jti: text("jti").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("used_recovery_sessions_expires_idx").on(t.expiresAt)],
);

export const gospelCards = pgTable(
  "gospel_cards",
  {
    id: id(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    gospelReference: text("gospel_reference").notNull(),
    summary: text("summary").notNull(),
    otReferences: jsonb("ot_references")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    ntReferences: jsonb("nt_references")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    orderIndex: integer("order_index").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("gospel_cards_slug_unique").on(t.slug),
    index("gospel_cards_order_idx").on(t.orderIndex),
  ],
);

export const posts = pgTable(
  "posts",
  {
    id: id(),
    // Nulo = autor removido (purga da conta após 30 dias): a partilha fica anónima.
    authorId: uuid("author_id").references(() => users.id, {
      onDelete: "set null",
    }),
    gospelCardId: uuid("gospel_card_id").references(() => gospelCards.id, {
      onDelete: "set null",
    }),
    category: postCategoryEnum("category").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    status: postStatusEnum("status").notNull().default("published"),
    likesCount: integer("likes_count").notNull().default(0),
    reportsCount: integer("reports_count").notNull().default(0),
    // Conta em apagamento com «manter anónimas»: a partilha continua visível mas sem autor.
    // Volta a falso se a conta for reactivada.
    authorHidden: boolean("author_hidden").notNull().default(false),
    // Conta em apagamento com «apagar partilhas»: guarda o estado anterior enquanto o post
    // fica oculto (status = hidden). Nulo = o post não foi ocultado por esta razão.
    suspendedStatus: postStatusEnum("suspended_status"),
    createdAt: createdAt(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    index("posts_status_created_idx").on(t.status, t.createdAt),
    index("posts_card_status_idx").on(t.gospelCardId, t.status),
    index("posts_author_created_idx").on(t.authorId, t.createdAt),
    index("posts_category_status_idx").on(t.category, t.status),
  ],
);

export const postLikes = pgTable(
  "post_likes",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.userId] }),
    index("post_likes_user_id_idx").on(t.userId),
  ],
);

export const reports = pgTable(
  "reports",
  {
    id: id(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    reporterId: uuid("reporter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    status: reportStatusEnum("status").notNull().default("open"),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("reports_post_reporter_unique").on(t.postId, t.reporterId),
    index("reports_post_status_idx").on(t.postId, t.status),
    index("reports_reporter_status_idx").on(t.reporterId, t.status),
  ],
);

export const moderationLog = pgTable(
  "moderation_log",
  {
    id: id(),
    // A auditoria não pode desaparecer com a partilha nem com o moderador:
    // ficam a nulo.
    postId: uuid("post_id").references(() => posts.id, {
      onDelete: "set null",
    }),
    moderatorId: uuid("moderator_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: moderationActionEnum("action").notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("moderation_log_post_created_idx").on(t.postId, t.createdAt)],
);

export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: outboxStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("outbox_status_next_attempt_idx").on(t.status, t.nextAttemptAt),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  // A chave vem do cliente: só é única dentro de cada utilizador (senão um
  // utilizador podia ler ou bloquear as operações de outro).
  (t) => [
    primaryKey({ columns: [t.userId, t.key] }),
    index("idempotency_keys_expires_idx").on(t.expiresAt),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;
export type GospelCard = typeof gospelCards.$inferSelect;
export type NewGospelCard = typeof gospelCards.$inferInsert;
export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type PostLike = typeof postLikes.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
export type ModerationLogEntry = typeof moderationLog.$inferSelect;
export type OutboxEvent = typeof outbox.$inferSelect;
export type NewOutboxEvent = typeof outbox.$inferInsert;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type PendingPasswordReset = typeof pendingPasswordResets.$inferSelect;
