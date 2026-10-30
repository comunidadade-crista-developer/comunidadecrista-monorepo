import { z } from 'zod';

export const PostCategory = z.enum(['entendimento', 'ensinamento', 'letra_cancao']);
export type PostCategory = z.infer<typeof PostCategory>;

export const PostStatus = z.enum(['published', 'pending_review', 'hidden', 'rejected']);
export type PostStatus = z.infer<typeof PostStatus>;

export const FeedFilter = z.enum(['recent', 'top', 'liked']);
export type FeedFilter = z.infer<typeof FeedFilter>;

export const IdempotencyKey = z
  .string()
  .min(16, 'Idempotency-Key tem de ter pelo menos 16 caracteres')
  .max(128, 'Idempotency-Key tem no máximo 128 caracteres');

export const PostPublic = z.object({
  id: z.string().uuid(),
  category: PostCategory,
  title: z.string(),
  content: z.string(),
  status: PostStatus,
  likesCount: z.number().int().nonnegative(),
  isLiked: z.boolean(),
  authorId: z.string().uuid().nullable(),
  authorUsername: z.string(),
  gospelCardSlug: z.string().nullable(),
  createdAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
});
export type PostPublic = z.infer<typeof PostPublic>;

export const ListPostsQuery = z.object({
  gospelCardId: z.string().uuid().optional(),
  category: PostCategory.optional(),
  filter: FeedFilter.default('recent'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListPostsQuery = z.infer<typeof ListPostsQuery>;

export const ListPostsResponse = z.object({
  posts: z.array(PostPublic),
  nextCursor: z.string().nullable(),
});
export type ListPostsResponse = z.infer<typeof ListPostsResponse>;

export const CreatePostRequest = z.object({
  category: PostCategory,
  title: z.string().min(1, 'título vazio').max(120, 'título demasiado longo'),
  content: z.string().min(1, 'conteúdo vazio').max(5000, 'conteúdo demasiado longo'),
  gospelCardSlug: z.string().min(1).max(100).optional(),
});
export type CreatePostRequest = z.infer<typeof CreatePostRequest>;

export const CreatePostResponse = z.object({
  post: PostPublic,
  status: PostStatus,
});
export type CreatePostResponse = z.infer<typeof CreatePostResponse>;

export const PostIdParams = z.object({ id: z.string().uuid() });
export type PostIdParams = z.infer<typeof PostIdParams>;

export const LikeResponse = z.object({
  likesCount: z.number().int().nonnegative(),
  isLiked: z.boolean(),
});
export type LikeResponse = z.infer<typeof LikeResponse>;

export const ReportRequest = z.object({
  reason: z.string().min(3, 'razão demasiado curta').max(500),
});
export type ReportRequest = z.infer<typeof ReportRequest>;

export const ReportOutcome = z.enum(['created', 'duplicate', 'own_post', 'post_not_found']);
export type ReportOutcome = z.infer<typeof ReportOutcome>;

export const ReportResponse = z.object({ outcome: ReportOutcome });
export type ReportResponse = z.infer<typeof ReportResponse>;