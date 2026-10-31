import { z } from 'zod';
import {
  CreatePostRequest,
  CreatePostResponse,
  ErrorResponse,
  LikeResponse,
  ListPostsQuery,
  ListPostsResponse,
  PostIdParams,
  ReportRequest,
  ReportResponse,
} from '@comunidade/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireAuth } from '../auth/middleware.js';
import type { JwtService } from '../auth/jwt.js';
import type { RateLimiters } from '../auth/rate-limit.js';
import type { FeedCache } from '../cache/feed-cache.js';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { cardsRepo } from '../repositories/cards.js';
import { idempotencyKeysRepo, outboxRepo } from '../repositories/outbox.js';
import { postLikesRepo, postsRepo } from '../repositories/posts.js';
import { reportsRepo } from '../repositories/reports.js';
import { presentOne, presentPosts } from '../services/post-presenter.js';

export interface PostsRoutesOptions {
  env: Env;
  db: Database;
  jwt: JwtService;
  limiters: RateLimiters;
  feedCache: FeedCache;
}

export async function postsRoutes(
  app: FastifyInstance,
  { db, jwt, limiters, feedCache }: PostsRoutesOptions,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const posts = postsRepo(db);
  const likes = postLikesRepo(db);
  const reports = reportsRepo(db);
  const cards = cardsRepo(db);
  const outbox = outboxRepo(db);
  const idem = idempotencyKeysRepo(db);

  const authPre = requireAuth(jwt);

  f.get(
    '/posts',
    {
      schema: {
        querystring: ListPostsQuery,
        response: { 200: ListPostsResponse, 401: ErrorResponse, 429: ErrorResponse },
      },
      preHandler: async (request, reply) => {
        const auth = request.headers.authorization;
        if (!auth) return;
        try {
          const payload = await jwt.verifyAccessToken(auth.replace(/^Bearer\s+/i, '').trim());
          request.user = { id: payload.sub, role: payload.role };
        } catch {
        }
        void reply;
      },
    },
    async (request, reply) => {
      const rl = await limiters.checkReadFeed(request.clientIp);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfter ?? 60))
          .send({ error: 'rate_limited' });
      }

      const { gospelCardId, category, filter, cursor, limit } = request.query;
      const viewerId = request.user?.id ?? null;

      let items;
      let nextCursor: string | null;

      if (filter === 'liked') {
        if (!viewerId) {
          return reply.code(401).send({ error: 'auth_required' });
        }
        const result = await posts.list({
          filter: 'liked',
          viewerId,
          gospelCardId,
          category,
          limit,
        });
        items = await presentPosts(result.items, db);
        nextCursor = result.nextCursor;
      } else {
        const result = await feedCache.list({
          filter,
          gospelCardId,
          category,
          cursor,
          limit,
        });
        items = result.items;
        nextCursor = result.nextCursor;
      }

      // Patch isLiked por viewer
      if (viewerId && items.length > 0) {
        const likedIds = await likes.findLikedPostIds(
          viewerId,
          items.map((p) => p.id),
        );
        const likedSet = new Set(likedIds);
        items = items.map((p) => ({ ...p, isLiked: likedSet.has(p.id) }));
      }

      if (filter === 'recent' && viewerId) {
        const own = await posts.findLatestByAuthorInFilter(viewerId, {
          gospelCardId,
          category,
          statuses: ['published', 'pending_review'],
        });
        if (own && !items.some((p) => p.id === own.id)) {
          const ownPublic = await presentOne(own, db);
          items = [{ ...ownPublic, isLiked: false }, ...items];
        }
      }

      return reply.code(200).send({ posts: items, nextCursor });
    },
  );

  f.get(
    '/posts/:id',
    {
      schema: {
        params: PostIdParams,
        response: {
          200: ListPostsResponse.shape.posts.element.transform((p) => ({ post: p })),
          404: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const rl = await limiters.checkReadFeed(request.clientIp);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfter ?? 60))
          .send({ error: 'rate_limited' });
      }

      const post = await posts.findById(request.params.id);
      if (!post || (post.status !== 'published' && post.status !== 'pending_review')) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const [presented] = await presentPosts([post], db);
      return reply.code(200).send({ post: presented! });
    },
  );

  f.post(
    '/posts',
    {
      preHandler: authPre,
      schema: {
        headers: z.object({ 'idempotency-key': z.string().min(16).max(128) }),
        body: CreatePostRequest,
        response: {
          201: CreatePostResponse,
          400: ErrorResponse,
          409: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkPostsCreate(userId);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfter ?? 60))
          .send({ error: 'rate_limited' });
      }

      const idemKey = request.headers['idempotency-key'] as string;
      const existing = await idem.get(userId, idemKey);
      if (existing) {
        return reply.code(201).send(existing.response as CreatePostResponse);
      }

      const body = request.body;
      let gospelCardId: string | null = null;
      if (body.gospelCardSlug) {
        const card = await cards.findBySlug(body.gospelCardSlug);
        if (!card) return reply.code(400).send({ error: 'gospel_card_not_found' });
        gospelCardId = card.id;
      }

      const post = await posts.create({
        authorId: userId,
        category: body.category,
        title: body.title,
        content: body.content,
        status: 'published',
        gospelCardId,
      });

      const presented = await presentOne(post, db);
      const response: CreatePostResponse = {
        post: presented,
        status: post.status,
      };

      await idem.set(idemKey, userId, 'post.create', response);
      await feedCache.invalidate();
      await outbox.enqueue({
        aggregateType: 'post',
        aggregateId: post.id,
        eventType: 'post.created',
        payload: { postId: post.id, authorId: userId },
      });

      return reply.code(201).send(response);
    },
  );

  f.delete(
    '/posts/:id',
    {
      preHandler: authPre,
      schema: {
        params: PostIdParams,
        response: { 200: z.object({ ok: z.literal(true) }), 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkPostsDelete(userId);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfter ?? 60))
          .send({ error: 'rate_limited' });
      }

      const post = await posts.findById(request.params.id);
      if (!post) return reply.code(404).send({ error: 'not_found' });
      if (post.authorId !== userId) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      await posts.delete(post.id);
      await feedCache.invalidate();
      await outbox.enqueue({
        aggregateType: 'post',
        aggregateId: post.id,
        eventType: 'post.deleted',
        payload: { postId: post.id },
      });

      return reply.code(200).send({ ok: true });
    },
  );

  f.post(
    '/posts/:id/like',
    {
      preHandler: authPre,
      schema: {
        params: PostIdParams,
        response: { 200: LikeResponse, 404: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkLikes(userId);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfter ?? 60))
          .send({ error: 'rate_limited' });
      }

      const post = await posts.findById(request.params.id);
      if (!post || post.status !== 'published') {
        return reply.code(404).send({ error: 'not_found' });
      }

      const inserted = await likes.like(post.id, userId);
      const likesCount = inserted
        ? await posts.incrementLikes(post.id, 1)
        : post.likesCount;

      if (inserted) await feedCache.invalidate();

      return reply.code(200).send({ likesCount, isLiked: true });
    },
  );

  f.delete(
    '/posts/:id/like',
    {
      preHandler: authPre,
      schema: {
        params: PostIdParams,
        response: { 200: LikeResponse, 404: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkLikes(userId);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfter ?? 60))
          .send({ error: 'rate_limited' });
      }

      const post = await posts.findById(request.params.id);
      if (!post) return reply.code(404).send({ error: 'not_found' });

      const removed = await likes.unlike(post.id, userId);
      const likesCount = removed
        ? await posts.incrementLikes(post.id, -1)
        : post.likesCount;

      if (removed) await feedCache.invalidate();

      return reply.code(200).send({ likesCount, isLiked: false });
    },
  );

  f.post(
    '/posts/:id/report',
    {
      preHandler: authPre,
      schema: {
        params: PostIdParams,
        body: ReportRequest,
        response: {
          200: ReportResponse,
          400: z.union([ReportResponse, ErrorResponse]),
          404: ReportResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkReports(userId);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfter ?? 60))
          .send({ error: 'rate_limited' });
      }

      const result = await reports.file({
        postId: request.params.id,
        reporterId: userId,
        reason: request.body.reason,
      });

      switch (result.outcome) {
        case 'created':
          await feedCache.invalidate();
          return reply.code(200).send({ outcome: 'created' });
        case 'duplicate':
          return reply.code(200).send({ outcome: 'duplicate' });
        case 'own_post':
          return reply.code(400).send({ outcome: 'own_post' });
        case 'post_not_found':
          return reply.code(404).send({ outcome: 'post_not_found' });
      }
    },
  );

  f.delete(
    '/posts/:id/report',
    {
      preHandler: authPre,
      schema: {
        params: PostIdParams,
        response: {
          200: z.object({ cancelled: z.literal(true) }),
          404: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkReports(userId);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfter ?? 60))
          .send({ error: 'rate_limited' });
      }

      const existing = await reports.findOpenByPostAndReporter(
        request.params.id,
        userId,
      );
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const cancelled = await reports.cancel(existing.id, userId);
      if (!cancelled) return reply.code(404).send({ error: 'not_found' });

      await feedCache.invalidate();
      return reply.code(200).send({ cancelled: true });
    },
  );
}