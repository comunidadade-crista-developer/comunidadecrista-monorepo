import { z } from "zod";
import {
  CreatePostRequest,
  CreatePostResponse,
  IdempotencyKey,
  LikeResponse,
  PostPublic,
  REASON_REQUIRED_FOR_OTHER,
  ReportCategory,
  ReportReason,
  ReportResponse,
} from "./posts.js";

export const MAX_SYNC_BATCH_OPS = 20;

const SyncOperationBase = z.object({
  op_id: z.uuid(),
  idempotency_key: IdempotencyKey,
});

const PostIdPayload = z.object({ postId: z.uuid() }).strict();

export const SyncCreatePost = SyncOperationBase.extend({
  type: z.literal("post.create"),
  payload: CreatePostRequest.strict(),
});

export const SyncDeletePost = SyncOperationBase.extend({
  type: z.literal("post.delete"),
  payload: PostIdPayload,
});

export const SyncLikePost = SyncOperationBase.extend({
  type: z.literal("post.like"),
  payload: PostIdPayload,
});

export const SyncUnlikePost = SyncOperationBase.extend({
  type: z.literal("post.unlike"),
  payload: PostIdPayload,
});

export const SyncReportPost = SyncOperationBase.extend({
  type: z.literal("post.report"),
  payload: z
    .object({
      postId: z.uuid(),
      category: ReportCategory,
      reason: ReportReason.optional(),
    })
    .strict()
    .refine(REASON_REQUIRED_FOR_OTHER.check, REASON_REQUIRED_FOR_OTHER.params),
});

export const SyncUnreportPost = SyncOperationBase.extend({
  type: z.literal("post.unreport"),
  payload: PostIdPayload,
});

export const SyncOperation = z.discriminatedUnion("type", [
  SyncCreatePost,
  SyncDeletePost,
  SyncLikePost,
  SyncUnlikePost,
  SyncReportPost,
  SyncUnreportPost,
]);
export type SyncOperation = z.infer<typeof SyncOperation>;
export type SyncOperationType = SyncOperation["type"];

export const SyncRequest = z.object({
  operations: z.array(SyncOperation).min(1).max(MAX_SYNC_BATCH_OPS),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

export const SyncStatus = z.enum([
  /** Aplicada agora. */
  "applied",
  /** Já tinha sido aplicada antes (mesma chave de idempotência): resultado repetido. */
  "duplicate",
  /** Recusada de forma definitiva: não vale a pena o cliente tentar de novo. */
  "rejected",
  /** Não chegou a ser tentada (tempo do lote esgotado ou limite): tentar de novo mais tarde. */
  "deferred",
]);
export type SyncStatus = z.infer<typeof SyncStatus>;

export const SyncErrorCode = z.enum([
  "not_found",
  "forbidden",
  "own_post",
  "idempotency_key_conflict",
  "gospel_card_not_found",
  "contains_link",
  "contains_contact",
  "rate_limited",
  "internal",
]);
export type SyncErrorCode = z.infer<typeof SyncErrorCode>;

/** Resultado de cada tipo de operação (o `type` do pedido diz qual). */
export const SyncOpResult = z.union([
  CreatePostResponse,
  LikeResponse,
  ReportResponse,
  z.object({ deleted: z.literal(true) }),
  z.object({ withdrawn: z.literal(true) }),
]);
export type SyncOpResult = z.infer<typeof SyncOpResult>;

export const SyncResult = z.object({
  op_id: z.string(),
  status: SyncStatus,
  result: SyncOpResult.optional(),
  error: z
    .object({
      code: SyncErrorCode,
      message: z.string().optional(),
      /** Só em `rate_limited`: segundos até poder tentar de novo. */
      retryAfter: z.number().int().positive().optional(),
    })
    .optional(),
});
export type SyncResult = z.infer<typeof SyncResult>;

export const SyncResponse = z.object({
  results: z.array(SyncResult),
  serverTime: z.iso.datetime(),
});
export type SyncResponse = z.infer<typeof SyncResponse>;

export const SyncBootstrapResponse = z.object({
  serverTime: z.iso.datetime(),
  user: z.object({
    id: z.uuid(),
    username: z.string(),
    role: z.enum(["user", "admin"]),
    createdAt: z.iso.datetime(),
  }),
  cards: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      gospelReference: z.string(),
      summary: z.string(),
      otReferences: z.array(z.string()),
      ntReferences: z.array(z.string()),
      orderIndex: z.number(),
    }),
  ),
  recentPosts: z.object({
    posts: z.array(PostPublic),
    nextCursor: z.string().nullable(),
  }),
  myPosts: z.array(PostPublic),
  myLikedPostIds: z.array(z.uuid()),
  myReports: z.array(
    z.object({
      id: z.uuid(),
      postId: z.uuid(),
      category: ReportCategory,
      reason: z.string().nullable(),
      status: z.enum(["open", "resolved_kept", "resolved_removed"]),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type SyncBootstrapResponse = z.infer<typeof SyncBootstrapResponse>;
