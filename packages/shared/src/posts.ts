import { z } from "zod";
import { CardSlug } from "./cards.js";

export const PostCategory = z.enum([
  "entendimento",
  "ensinamento",
  "letra_cancao",
]);
export type PostCategory = z.infer<typeof PostCategory>;

export const PostStatus = z.enum([
  "published",
  "pending_review",
  "hidden",
  "rejected",
]);
export type PostStatus = z.infer<typeof PostStatus>;

export const FeedFilter = z.enum(["recent", "top", "liked"]);
export type FeedFilter = z.infer<typeof FeedFilter>;

export const IdempotencyKey = z
  .string()
  .min(16, "Idempotency-Key tem de ter pelo menos 16 caracteres")
  .max(128, "Idempotency-Key tem no máximo 128 caracteres")
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "Idempotency-Key só aceita letras, números, hífen e underscore",
  );

/** O Postgres não guarda NUL em `text` (erro 22021 → 500): recusa-se à entrada. */
const NO_NUL = (s: string): boolean => !s.includes("\u0000");

/** Texto de utilizador: sem espaços nas pontas, não vazio, sem NUL. */
function userText(min: number, max: number, label: string) {
  return z
    .string()
    .trim()
    .min(min, `${label} vazio`)
    .max(max, `${label} demasiado longo`)
    .refine(NO_NUL, `${label} tem caracteres inválidos`);
}

export const POST_TITLE_MAX = 120;
export const POST_CONTENT_MAX = 5000;
export const REPORT_REASON_MIN = 3;
export const REPORT_REASON_MAX = 500;

export const PostAuthor = z.object({ username: z.string() });
export type PostAuthor = z.infer<typeof PostAuthor>;

export const PostPublic = z.object({
  id: z.uuid(),
  category: PostCategory,
  title: z.string(),
  content: z.string(),
  status: PostStatus,
  likesCount: z.number().int().nonnegative(),
  isLiked: z.boolean(),
  isMine: z.boolean(),
  author: PostAuthor.nullable(),
  gospelCardSlug: z.string().nullable(),
  createdAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().nullable(),
});
export type PostPublic = z.infer<typeof PostPublic>;

const CursorTimestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/,
  );

export const CursorPayload = z.discriminatedUnion("k", [
  z.object({ k: z.literal("recent"), t: CursorTimestamp, id: z.uuid() }),
  z.object({
    k: z.literal("top"),
    l: z.number().int().nonnegative(),
    t: CursorTimestamp,
    id: z.uuid(),
  }),
  /** `t` é o momento do like (não do post): a ordem é «curtidos mais recentemente». */
  z.object({ k: z.literal("liked"), t: CursorTimestamp, id: z.uuid() }),
]);
export type CursorPayload = z.infer<typeof CursorPayload>;

export const CURSOR_MAX_LENGTH = 256;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBase64Url(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 3) {
    const c0 = text.charCodeAt(i);
    const c1 = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
    const c2 = i + 2 < text.length ? text.charCodeAt(i + 2) : 0;
    if (c0 > 127 || c1 > 127 || c2 > 127) {
      throw new Error("cursor: só ASCII");
    }
    const n = (c0 << 16) | (c1 << 8) | c2;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < text.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < text.length) out += B64[n & 63]!;
  }
  return out;
 }

function fromBase64Url(text: string): string | null {
  if (text.length % 4 === 1) return null;
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const byte = (buffer >> bits) & 255;
      if (byte > 127) return null;
      out += String.fromCharCode(byte);
    }
   }
  return out;
}

export function encodeCursor(payload: CursorPayload): string {
  return toBase64Url(JSON.stringify(CursorPayload.parse(payload)));
}

export function decodeCursor(
  cursor: string,
  expected: FeedFilter,
): CursorPayload | null {
  if (cursor.length === 0 || cursor.length > CURSOR_MAX_LENGTH) return null;
  const json = fromBase64Url(cursor);
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = CursorPayload.safeParse(raw);
  if (!parsed.success || parsed.data.k !== expected) return null;
  return parsed.data;
}

export const ListPostsQuery = z
  .object({
    gospelCardId: z.uuid().optional(),
    category: PostCategory.optional(),
    filter: FeedFilter.default("recent"),
    cursor: z
      .string()
      .max(CURSOR_MAX_LENGTH)
      .regex(/^[A-Za-z0-9_-]+$/, "cursor inválido")
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .superRefine((q, ctx) => {
    if (q.cursor !== undefined && decodeCursor(q.cursor, q.filter) === null) {
      ctx.addIssue({
        code: "custom",
        path: ["cursor"],
        message: "cursor inválido",
      });
    }
  });
export type ListPostsQuery = z.infer<typeof ListPostsQuery>;

export const ListPostsResponse = z.object({
  posts: z.array(PostPublic),
  nextCursor: z.string().nullable(),
});
export type ListPostsResponse = z.infer<typeof ListPostsResponse>;

export const CreatePostRequest = z.object({
  category: PostCategory,
  title: userText(1, POST_TITLE_MAX, "título"),
  content: userText(1, POST_CONTENT_MAX, "conteúdo"),
  gospelCardSlug: CardSlug.optional(),
});
export type CreatePostRequest = z.infer<typeof CreatePostRequest>;

export const CreatePostResponse = z.object({
  post: PostPublic,
  status: PostStatus,
});
export type CreatePostResponse = z.infer<typeof CreatePostResponse>;

export const PostIdParams = z.object({ id: z.uuid() });
export type PostIdParams = z.infer<typeof PostIdParams>;

export const LikeResponse = z.object({
  likesCount: z.number().int().nonnegative(),
  isLiked: z.boolean(),
});
export type LikeResponse = z.infer<typeof LikeResponse>;

export const ReportCategory = z.enum([
  "spam",
  "off_topic",
  "offensive",
  "doctrine",
  "other",
]);
export type ReportCategory = z.infer<typeof ReportCategory>;

export const ReportSeverity = z.enum(["basic", "medium", "high"]);
export type ReportSeverity = z.infer<typeof ReportSeverity>;

export const CATEGORY_TO_SEVERITY: Readonly<
  Record<ReportCategory, ReportSeverity>
> = {
  spam: "basic",
  off_topic: "basic",
  offensive: "medium",
  doctrine: "high",
  other: "basic",
};

export const ReportReason = userText(
  REPORT_REASON_MIN,
  REPORT_REASON_MAX,
  "motivo",
);

export const REASON_REQUIRED_FOR_OTHER = {
  check: (d: { category: ReportCategory; reason?: string | undefined }) =>
    d.category !== "other" || d.reason !== undefined,
  params: {
    message: 'o motivo é obrigatório para a categoria "outro"',
    path: ["reason"] as PropertyKey[],
  },
} as const;

export const ReportRequest = z
  .object({
    category: ReportCategory,
    reason: ReportReason.optional(),
  })
  .refine(REASON_REQUIRED_FOR_OTHER.check, REASON_REQUIRED_FOR_OTHER.params);
export type ReportRequest = z.infer<typeof ReportRequest>;

export const ReportOutcome = z.enum(["created", "duplicate"]);
export type ReportOutcome = z.infer<typeof ReportOutcome>;

export const ReportResponse = z.object({ outcome: ReportOutcome });
export type ReportResponse = z.infer<typeof ReportResponse>;
