import { z } from 'zod';
import { PostCategory, PostPublic, ReportCategory } from './posts.js';

export const MAX_SYNC_BATCH_OPS = 20;

export const SyncOperationBase = z.object({
  op_id: z.string().uuid(),
  idempotency_key: z.string().min(16).max(128),
});

export const SyncCreatePost = SyncOperationBase.extend({
  type: z.literal('post.create'),
  payload: z
    .object({
      category: PostCategory,
      title: z.string().min(1).max(120),
      content: z.string().min(1).max(5000),
      gospelCardSlug: z.string().min(1).max(100).optional(),
    })
    .strict(),
});

export const SyncDeletePost = SyncOperationBase.extend({
  type: z.literal('post.delete'),
  payload: z.object({ postId: z.string().uuid() }).strict(),
});

export const SyncLikePost = SyncOperationBase.extend({
  type: z.literal('post.like'),
  payload: z.object({ postId: z.string().uuid() }).strict(),
});

export const SyncUnlikePost = SyncOperationBase.extend({
  type: z.literal('post.unlike'),
  payload: z.object({ postId: z.string().uuid() }).strict(),
});

export const SyncReportPost = SyncOperationBase.extend({
  type: z.literal('post.report'),
  payload: z
    .object({
      postId: z.string().uuid(),
      category: ReportCategory,
      reason: z.string().min(3).max(500).optional(),
    })
    .strict(),
});

export const SyncUnreportPost = SyncOperationBase.extend({
  type: z.literal('post.unreport'),
  payload: z.object({ postId: z.string().uuid() }).strict(),
});

export const SyncOperation = z.discriminatedUnion('type', [
  SyncCreatePost,
  SyncDeletePost,
  SyncLikePost,
  SyncUnlikePost,
  SyncReportPost,
  SyncUnreportPost,
]);
export type SyncOperation = z.infer<typeof SyncOperation>;

export const SyncRequest = z.object({
  operations: z.array(SyncOperation).min(1).max(MAX_SYNC_BATCH_OPS),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

export const SyncStatus = z.enum([
  'applied',
  'duplicate',
  'rejected',
  'deferred',
]);
export type SyncStatus = z.infer<typeof SyncStatus>;

export const SyncErrorCode = z.enum([
  'not_found',
  'forbidden',
  'own_post',
  'idempotency_key_conflict',
  'gospel_card_not_found',
  'contains_link',
  'contains_contact',
  'reason_required',
  'rate_limited',
  'internal',
]);
export type SyncErrorCode = z.infer<typeof SyncErrorCode>;

export const SyncResult = z.object({
  op_id: z.string(),
  status: SyncStatus,
  result: z.unknown().optional(),
   error: z
     .object({ code: SyncErrorCode, message: z.string().optional() })
     .optional(),
 });

export type SyncResult = z.infer<typeof SyncResult>;

export const SyncResponse = z.object({
  results: z.array(SyncResult),
  serverTime: z.string().datetime(),
});
export type SyncResponse = z.infer<typeof SyncResponse>;

export const SyncBootstrapResponse = z.object({
  serverTime: z.string().datetime(),
  user: z.object({
    id: z.string().uuid(),
    username: z.string(),
    role: z.enum(['user', 'admin']),
    createdAt: z.string().datetime(),
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
  myLikedPostIds: z.array(z.string().uuid()),
  myReports: z.array(
    z.object({
      id: z.string().uuid(),
      postId: z.string().uuid(),
      category: ReportCategory,
      reason: z.string().nullable(),
      status: z.enum(['open', 'resolved_kept', 'resolved_removed']),
      createdAt: z.string().datetime(),
    }),
  ),
});
export type SyncBootstrapResponse = z.infer<typeof SyncBootstrapResponse>;