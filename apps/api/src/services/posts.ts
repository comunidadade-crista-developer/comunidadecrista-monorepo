import type {
  PostCategory,
  PostPublic,
  PostStatus,
  ReportCategory,
  ReportOutcome,
} from '@comunidade/shared';
import { checkContent } from '@comunidade/shared';
import type { Database, Executor } from "../db/client.js";
import { cardsRepo } from "../repositories/cards.js";
import { idempotencyKeysRepo, outboxRepo } from "../repositories/outbox.js";
import { postLikesRepo, postsRepo } from "../repositories/posts.js";
import { reportsRepo } from "../repositories/reports.js";
import { presentOne } from "./post-presenter.js";

export type Tx = Executor;

export interface ServicesDeps {
  db: Database;
}

export type ServiceError =
  | { code: "not_found"; status: 404 }
  | { code: "forbidden"; status: 403 }
  | { code: "own_post"; status: 400 }
  | { code: "idempotency_key_conflict"; status: 409 }
  | { code: "gospel_card_not_found"; status: 400 }
  | { code: "contains_link"; status: 400 }
  | { code: "contains_contact"; status: 400 }
  | { code: "reason_required"; status: 400 };   

export type ServiceResult<T, E extends ServiceError = ServiceError> =
  { ok: true; data: T } | { ok: false; error: E };

export interface CreatePostInput {
  category: PostCategory;
  title: string;
  content: string;
  gospelCardSlug?: string;
}

export interface CreatePostData {
  post: PostPublic;
  status: PostStatus;
}

type CreatePostError = Extract<
  ServiceError,
  {
    code:
      | 'gospel_card_not_found'
      | 'idempotency_key_conflict'
      | 'contains_link'
      | 'contains_contact';
  }
 >;

export async function createPostService(
  deps: ServicesDeps,
  userId: string,
  input: CreatePostInput,
  idempotencyKey: string,
  tx?: Tx,
): Promise<ServiceResult<CreatePostData, CreatePostError>> {
  const db = tx ?? deps.db;
  const idem = idempotencyKeysRepo(db);

  const existing = await idem.get(userId, idempotencyKey);
  if (existing) {
    if (existing.operation !== "post.create") {
      return {
        ok: false,
        error: { code: "idempotency_key_conflict", status: 409 },
      };
    }
    return { ok: true, data: existing.response as unknown as CreatePostData };
  }

  const check = checkContent(input.title, input.content);
  if (check.reject) {
    const first = check.violations[0]!;
    if (first.kind === 'link') {
      return { ok: false, error: { code: 'contains_link', status: 400 } };
    }
    return { ok: false, error: { code: 'contains_contact', status: 400 } };
  }
  const hasSpamSignal = check.flags.some((f) => f.kind === 'spam_signal');

  let gospelCardId: string | null = null;
  if (input.gospelCardSlug) {
    const card = await cardsRepo(db).findBySlug(input.gospelCardSlug);
    if (!card) {
      return {
        ok: false,
        error: { code: "gospel_card_not_found", status: 400 },
      };
    }
    gospelCardId = card.id;
  }

  const post = await postsRepo(db).create({
    authorId: userId,
    category: input.category,
    title: input.title,
    content: input.content,
    status: hasSpamSignal ? 'pending_review' : 'published',
    gospelCardId,
  });

  const presented = await presentOne(post, deps.db);
  const data: CreatePostData = { post: presented, status: post.status };

  await idem.set(
    idempotencyKey,
    userId,
    "post.create",
    data as unknown as Record<string, unknown>,
  );
  await outboxRepo(db).enqueue({
    aggregateType: "post",
    aggregateId: post.id,
    eventType: "post.created",
    payload: { postId: post.id, authorId: userId },
  });

  return { ok: true, data };
}

type DeletePostError = Extract<
  ServiceError,
  { code: "not_found" | "forbidden" }
>;

export async function deletePostService(
  deps: ServicesDeps,
  userId: string,
  postId: string,
  tx?: Tx,
): Promise<ServiceResult<{ ok: true }, DeletePostError>> {
  const db = tx ?? deps.db;
  const posts = postsRepo(db);

  const post = await posts.findById(postId);
  if (!post) return { ok: false, error: { code: "not_found", status: 404 } };
  if (post.authorId !== userId) {
    return { ok: false, error: { code: "forbidden", status: 403 } };
  }

  await posts.delete(postId);
  await outboxRepo(db).enqueue({
    aggregateType: "post",
    aggregateId: postId,
    eventType: "post.deleted",
    payload: { postId },
  });

  return { ok: true, data: { ok: true } };
}

export interface LikeData {
  likesCount: number;
  isLiked: boolean;
}

type LikeError = Extract<ServiceError, { code: "not_found" }>;

export async function likePostService(
  deps: ServicesDeps,
  userId: string,
  postId: string,
  tx?: Tx,
): Promise<ServiceResult<LikeData, LikeError>> {
  const db = tx ?? deps.db;
  const posts = postsRepo(db);
  const likes = postLikesRepo(db);

  const post = await posts.findById(postId);
  if (!post || post.status !== "published") {
    return { ok: false, error: { code: "not_found", status: 404 } };
  }

  const inserted = await likes.like(postId, userId);
  const likesCount = inserted
    ? await posts.incrementLikes(postId, 1)
    : post.likesCount;

  if (inserted) {
    await outboxRepo(db).enqueue({
      aggregateType: "post",
      aggregateId: postId,
      eventType: "post.liked",
      payload: { postId, userId },
    });
  }

  return { ok: true, data: { likesCount, isLiked: true } };
}

export async function unlikePostService(
  deps: ServicesDeps,
  userId: string,
  postId: string,
  tx?: Tx,
): Promise<ServiceResult<LikeData, LikeError>> {
  const db = tx ?? deps.db;
  const posts = postsRepo(db);
  const likes = postLikesRepo(db);

  const post = await posts.findById(postId);
  if (!post) return { ok: false, error: { code: "not_found", status: 404 } };

  const removed = await likes.unlike(postId, userId);
  const likesCount = removed
    ? await posts.incrementLikes(postId, -1)
    : post.likesCount;

  if (removed) {
    await outboxRepo(db).enqueue({
      aggregateType: "post",
      aggregateId: postId,
      eventType: "post.unliked",
      payload: { postId, userId },
    });
  }

  return { ok: true, data: { likesCount, isLiked: false } };
}

type ReportPostError = Extract<
  ServiceError,
  { code: 'own_post' | 'not_found' | 'reason_required' }
>;

export async function reportPostService(
  deps: ServicesDeps,
  userId: string,
  postId: string,
  category: ReportCategory,
  reason: string | undefined,
  tx?: Tx,
): Promise<ServiceResult<{ outcome: ReportOutcome }, ReportPostError>> {
  if (category === 'other' && (!reason || reason.trim().length < 3)) {
    return { ok: false, error: { code: 'reason_required', status: 400 } };
  }

  const db = tx ?? deps.db;

  const post = await postsRepo(db).findById(postId);
  if (!post) {
    return { ok: false, error: { code: "not_found", status: 404 } };
  }

  const result = await reportsRepo(db).file(
    { postId, reporterId: userId, category, reason },
    {},
    tx,
  );

  switch (result.outcome) {
    case "created":
      await outboxRepo(db).enqueue({
        aggregateType: "post",
        aggregateId: postId,
        eventType: "post.reported",
        payload: { postId, reporterId: userId },
      });
      return { ok: true, data: { outcome: "created" } };
    case "duplicate":
      return { ok: true, data: { outcome: "duplicate" } };
    case "own_post":
      return { ok: false, error: { code: "own_post", status: 400 } };
    case "post_not_found":
      return { ok: false, error: { code: "not_found", status: 404 } };
  }
}

type UnreportPostError = Extract<ServiceError, { code: "not_found" }>;

export async function unreportPostService(
  deps: ServicesDeps,
  userId: string,
  postId: string,
  tx?: Tx,
): Promise<ServiceResult<{ cancelled: true }, UnreportPostError>> {
  const db = tx ?? deps.db;
  const reports = reportsRepo(db);

  const existing = await reports.findOpenByPostAndReporter(postId, userId);
  if (!existing)
    return { ok: false, error: { code: "not_found", status: 404 } };

  const cancelled = await reports.cancel(existing.id, userId);
  if (!cancelled)
    return { ok: false, error: { code: "not_found", status: 404 } };

  return { ok: true, data: { cancelled: true } };
}
