import {
  ErrorResponse,
  SyncBootstrapResponse,
  SyncRequest,
  SyncResponse,
  type SyncErrorCode,
  type SyncOperation,
  type SyncResult, 
} from '@comunidade/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { JwtService } from '../auth/jwt.js';
import { requireAuth } from '../auth/middleware.js';
import type { RateLimiters } from '../auth/rate-limit.js';
import type { CardsCache } from '../cache/cards-cache.js';
import type { FeedCache } from '../cache/feed-cache.js';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { postLikesRepo, postsRepo } from '../repositories/posts.js';
import { reportsRepo } from '../repositories/reports.js';
import { usersRepo } from '../repositories/users.js';
import {
  createPostService,
  deletePostService,
  likePostService,
  reportPostService,
  unlikePostService,
  unreportPostService,
  type ServiceError,
  type ServicesDeps,
} from '../services/posts.js';
import { presentPosts } from '../services/post-presenter.js';

export interface SyncRoutesOptions {
  env: Env;
  db: Database;
  jwt: JwtService;
  limiters: RateLimiters;
  feedCache: FeedCache;
  cardsCache: CardsCache;
}

export async function syncRoutes(
  app: FastifyInstance,
  { env, db, jwt, limiters, feedCache, cardsCache }: SyncRoutesOptions,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const authPre = requireAuth(jwt);
  const deps: ServicesDeps = { db };
  const logger = app.log;

  function rejected(
    opId: string,
    code: SyncErrorCode,
  ): { result: SyncResult; invalidateFeed: boolean } {
    return {
      result: { op_id: opId, status: 'rejected', error: { code } },
      invalidateFeed: false,
    };
  }

  function mapServiceErrorToSyncCode(error: ServiceError): SyncErrorCode {
    return error.code as SyncErrorCode;
  }

  async function processOne(
    userId: string,
    op: SyncOperation,
  ): Promise<{ result: SyncResult; invalidateFeed: boolean }> {
    try {
      return await db.transaction(async (tx) => {
        switch (op.type) {
          case 'post.create': {
            const r = await createPostService(
              deps,
              userId,
              {
                category: op.payload.category,
                title: op.payload.title,
                content: op.payload.content,
                gospelCardSlug: op.payload.gospelCardSlug,
              },
              op.idempotency_key,
              tx,
            );
            if (!r.ok) return rejected(op.op_id, mapServiceErrorToSyncCode(r.error));
            return {
              result: { op_id: op.op_id, status: 'applied', result: r.data },
              invalidateFeed: true,
            };
          }
          case 'post.delete': {
            const r = await deletePostService(deps, userId, op.payload.postId, tx);
            if (!r.ok) return rejected(op.op_id, mapServiceErrorToSyncCode(r.error));
            return {
              result: { op_id: op.op_id, status: 'applied', result: r.data },
              invalidateFeed: true,
            };
          }
          case 'post.like': {
            const r = await likePostService(deps, userId, op.payload.postId, tx);
            if (!r.ok) return rejected(op.op_id, mapServiceErrorToSyncCode(r.error));
            return {
              result: { op_id: op.op_id, status: 'applied', result: r.data },
              invalidateFeed: true,
            };
          }
          case 'post.unlike': {
            const r = await unlikePostService(deps, userId, op.payload.postId, tx);
            if (!r.ok) return rejected(op.op_id, mapServiceErrorToSyncCode(r.error));
            return {
              result: { op_id: op.op_id, status: 'applied', result: r.data },
              invalidateFeed: true,
            };
          }
          case 'post.report': {
            const r = await reportPostService(
              deps,
              userId,
              op.payload.postId,
              op.payload.category,
              op.payload.reason,
              tx,
            );
            if (!r.ok) return rejected(op.op_id, mapServiceErrorToSyncCode(r.error));
            return {
              result: { op_id: op.op_id, status: 'applied', result: r.data },
              invalidateFeed: r.data.outcome === 'created',
            };
          }
          case 'post.unreport': {
            const r = await unreportPostService(deps, userId, op.payload.postId, tx);
            if (!r.ok) return rejected(op.op_id, mapServiceErrorToSyncCode(r.error));
            return {
              result: { op_id: op.op_id, status: 'applied', result: r.data },
              invalidateFeed: true,
            };
          }
        }
      });
    } catch (err) {
      logger.error({ err, opType: op.type }, 'sync: op failed');
      return rejected(op.op_id, 'internal');
    }
  }

  f.post(
    '/sync',
    {
      preHandler: authPre,
      schema: {
        body: SyncRequest,
        response: { 200: SyncResponse, 401: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkSyncBatch(userId);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfter ?? 60))
          .send({ error: 'rate_limited' });
      }

      const started = Date.now();
      const deadline = started + env.SYNC_BATCH_TIMEOUT_MS;
      const results: SyncResult[] = [];
      let invalidateFeed = false;

      for (const op of request.body.operations) {
        if (Date.now() >= deadline) {
          results.push({ op_id: op.op_id, status: 'deferred' });
          continue;
        }
        const outcome = await processOne(userId, op);
        results.push(outcome.result);
        if (outcome.invalidateFeed) invalidateFeed = true;
      }

      if (invalidateFeed) await feedCache.invalidate();

      return reply
        .code(200)
        .send({ results, serverTime: new Date().toISOString() });
    },
  );

  f.get(
    '/sync/bootstrap',
    {
      preHandler: authPre,
      schema: {
        response: {
          200: SyncBootstrapResponse,
          401: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkSyncBatch(userId);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfter ?? 60))
          .send({ error: 'rate_limited' });
      }

      const users = usersRepo(db);
      const posts = postsRepo(db);
      const likesRepo = postLikesRepo(db);
      const reports = reportsRepo(db);

      const [user, cards, recent, myPostsRows, myLikedPostIds, myReports] =
        await Promise.all([
          users.findById(userId),
          cardsCache.list(),
          feedCache.list({ filter: 'recent', limit: 20 }),
          posts.listByAuthor(userId, 50),
          likesRepo.getAllLikedPostIdsBy(userId, 500),
          reports.listByReporter(userId),
        ]);

      if (!user) return reply.code(401).send({ error: 'invalid_token' });

      const myPosts = await presentPosts(myPostsRows, db);

      return reply.code(200).send({
        serverTime: new Date().toISOString(),
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          createdAt: user.createdAt.toISOString(),
        },
        cards,
        recentPosts: { posts: recent.items, nextCursor: recent.nextCursor },
        myPosts,
        myLikedPostIds,
        myReports: myReports.map((r) => ({
          id: r.id,
          postId: r.postId,
          category: r.category,
          reason: r.reason,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
        })),
      });
    },
  );
}