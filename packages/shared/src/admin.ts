import { z } from "zod";
import {
  CURSOR_MAX_LENGTH,
  PostCategory,
  PostStatus,
  ReportCategory,
  ReportSeverity,
  decodeCursor,
} from "./posts.js";
import type { CursorKind } from "./posts.js";

export const ADMIN_LIST_LIMIT_MAX = 50;
export const ADMIN_LIST_LIMIT_DEFAULT = 20;
export const ADMIN_NOTE_MAX = 500;
export const ADMIN_REJECT_REASON_MIN = 10;
/** Tamanho do excerto do conteúdo nas listas (o texto completo só vem no detalhe). */
export const ADMIN_EXCERPT_MAX = 200;

const NO_NUL = (s: string): boolean => !s.includes("\u0000");

function adminText(min: number, max: number, label: string) {
  return z
    .string()
    .trim()
    .min(min, `${label} demasiado curto`)
    .max(max, `${label} demasiado longo`)
    .refine(NO_NUL, `${label} tem caracteres inválidos`);
}

const CursorParam = z
  .string()
  .max(CURSOR_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, "cursor inválido");

const LimitParam = z.coerce
  .number()
  .int()
  .min(1)
  .max(ADMIN_LIST_LIMIT_MAX)
  .default(ADMIN_LIST_LIMIT_DEFAULT);

/** Um cursor de outra lista (ou adulterado) é um 400 de validação, não um erro interno. */
function checkCursor(
  q: { cursor?: string | undefined },
  kind: CursorKind,
  ctx: z.RefinementCtx,
): void {
  if (q.cursor !== undefined && decodeCursor(q.cursor, kind) === null) {
    ctx.addIssue({
      code: "custom",
      path: ["cursor"],
      message: "cursor inválido",
    });
  }
}

/** Denúncias abertas por categoria (ADR-014): o painel vê a natureza, não só o total. */
export const AdminReportsByCategory = z.object({
  spam: z.number().int().nonnegative(),
  off_topic: z.number().int().nonnegative(),
  offensive: z.number().int().nonnegative(),
  doctrine: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
});
export type AdminReportsByCategory = z.infer<typeof AdminReportsByCategory>;

const AdminUsername = z.object({ username: z.string() });

export const AdminListPostsQuery = z
  .object({
    status: PostStatus.default("pending_review"),
    cursor: CursorParam.optional(),
    limit: LimitParam,
  })
  .superRefine((q, ctx) => checkCursor(q, "admin_posts", ctx));
export type AdminListPostsQuery = z.infer<typeof AdminListPostsQuery>;

export const AdminPostListItem = z.object({
  id: z.uuid(),
  category: PostCategory,
  title: z.string(),
  excerpt: z.string(),
  status: PostStatus,
  author: AdminUsername.nullable(),
  reviewFlags: z.array(z.string()),
  /** Denúncias abertas, no total e por categoria. */
  reportsCount: z.number().int().nonnegative(),
  reportsByCategory: AdminReportsByCategory,
  createdAt: z.iso.datetime(),
});
export type AdminPostListItem = z.infer<typeof AdminPostListItem>;

export const AdminListPostsResponse = z.object({
  posts: z.array(AdminPostListItem),
  nextCursor: z.string().nullable(),
});
export type AdminListPostsResponse = z.infer<typeof AdminListPostsResponse>;

export const AdminReportStatus = z.enum([
  "open",
  "resolved_kept",
  "resolved_removed",
  "withdrawn",
]);
export type AdminReportStatus = z.infer<typeof AdminReportStatus>;

export const AdminReportItem = z.object({
  id: z.uuid(),
  postId: z.uuid(),
  /** `null` se o post já não existe. */
  postTitle: z.string().nullable(),
  reporter: AdminUsername.nullable(),
  category: ReportCategory,
  severity: ReportSeverity,
  reason: z.string().nullable(),
  status: AdminReportStatus,
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type AdminReportItem = z.infer<typeof AdminReportItem>;

export const AdminModerationAction = z.enum([
  "approved",
  "rejected",
  "admin.promoted",
  "admin.demoted",
]);
export type AdminModerationAction = z.infer<typeof AdminModerationAction>;

export const AdminModerationLogItem = z.object({
  id: z.uuid(),
  action: AdminModerationAction,
  postId: z.uuid().nullable(),
  postTitle: z.string().nullable(),
  /** `null` = acção do sistema (CLI) ou moderador removido. */
  moderator: AdminUsername.nullable(),
  target: AdminUsername.nullable(),
  reason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AdminModerationLogItem = z.infer<typeof AdminModerationLogItem>;

export const AdminPostDetail = z.object({
  id: z.uuid(),
  category: PostCategory,
  title: z.string(),
  content: z.string(),
  status: PostStatus,
  author: AdminUsername.nullable(),
  gospelCardSlug: z.string().nullable(),
  reviewFlags: z.array(z.string()),
  likesCount: z.number().int().nonnegative(),
  reportsCount: z.number().int().nonnegative(),
  reportsByCategory: AdminReportsByCategory,
  createdAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().nullable(),
});
export type AdminPostDetail = z.infer<typeof AdminPostDetail>;

export const AdminPostDetailResponse = z.object({
  post: AdminPostDetail,
  /** Todas as denúncias do post (abertas e já tratadas), das mais recentes. */
  reports: z.array(AdminReportItem),
  /** Decisões anteriores sobre este post. */
  moderation: z.array(AdminModerationLogItem),
});
export type AdminPostDetailResponse = z.infer<typeof AdminPostDetailResponse>;

export const AdminApproveRequest = z
  .object({ note: adminText(1, ADMIN_NOTE_MAX, "nota").optional() })
  .strict();
export type AdminApproveRequest = z.infer<typeof AdminApproveRequest>;

export const AdminRejectRequest = z
  .object({
    reason: adminText(ADMIN_REJECT_REASON_MIN, ADMIN_NOTE_MAX, "motivo"),
  })
  .strict();
export type AdminRejectRequest = z.infer<typeof AdminRejectRequest>;

export const AdminModerationResponse = z.object({
  post: z.object({
    id: z.uuid(),
    status: PostStatus,
    publishedAt: z.iso.datetime().nullable(),
  }),
});
export type AdminModerationResponse = z.infer<typeof AdminModerationResponse>;

export const AdminListReportsQuery = z
  .object({
    status: AdminReportStatus.default("open"),
    cursor: CursorParam.optional(),
    limit: LimitParam,
  })
  .superRefine((q, ctx) => checkCursor(q, "admin_reports", ctx));
export type AdminListReportsQuery = z.infer<typeof AdminListReportsQuery>;

export const AdminReportListResponse = z.object({
  reports: z.array(AdminReportItem),
  nextCursor: z.string().nullable(),
});
export type AdminReportListResponse = z.infer<typeof AdminReportListResponse>;

export const AdminModerationLogQuery = z
  .object({
    action: AdminModerationAction.optional(),
    postId: z.uuid().optional(),
    cursor: CursorParam.optional(),
    limit: LimitParam,
  })
  .superRefine((q, ctx) => checkCursor(q, "admin_log", ctx));
export type AdminModerationLogQuery = z.infer<typeof AdminModerationLogQuery>;

export const AdminModerationLogResponse = z.object({
  entries: z.array(AdminModerationLogItem),
  nextCursor: z.string().nullable(),
});
export type AdminModerationLogResponse = z.infer<
  typeof AdminModerationLogResponse
>;
