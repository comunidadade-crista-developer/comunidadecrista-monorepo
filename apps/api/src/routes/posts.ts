type ReportOutcome = "created" | "duplicate" | "own_post" | "post_not_found";
import type {
  PostPublic} from "@comunidade/shared";
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
} from "@comunidade/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { JwtService } from "../auth/jwt.js";
import { requireAuth } from "../auth/middleware.js";
import type { RateLimiters } from "../auth/rate-limit.js";
import type { FeedCache } from "../cache/feed-cache.js";
import type { Database } from "../db/client.js";
import type { Env } from "../env.js";
import { postLikesRepo, postsRepo } from "../repositories/posts.js";
import {
  createPostService,
  deletePostService,
  likePostService,
  reportPostService,
  unlikePostService,
  unreportPostService,
} from "../services/posts.js";
import { presentOne, presentPosts } from "../services/post-presenter.js";

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
  const authPre = requireAuth(jwt);
  const deps = { db };

  f.get(
    "/posts",
    {
      schema: {
        querystring: ListPostsQuery,
        response: {
          200: ListPostsResponse,
          401: ErrorResponse,
          429: ErrorResponse,
        },
      },
      preHandler: async (request) => {
        const auth = request.headers.authorization;
        if (!auth) return;
        try {
          const payload = await jwt.verifyAccessToken(
            auth.replace(/^Bearer\s+/i, "").trim(),
          );
          request.user = { id: payload.sub, role: payload.role };
        } catch {
          /* leitura pública */
        }
      },
    },
    async (request, reply) => {
      const rl = await limiters.checkReadFeed(request.clientIp);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header("Retry-After", String(rl.retryAfter ?? 60))
          .send({ error: "rate_limited" });
      }

      const { gospelCardId, category, filter, cursor, limit } = request.query;
      const viewerId = request.user?.id ?? null;

      let items: PostPublic[];
      let nextCursor: string | null;

      if (filter === "liked") {
        if (!viewerId) return reply.code(401).send({ error: "auth_required" });
        const result = await posts.list({
          filter: "liked",
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

      if (viewerId && items.length > 0) {
        const likedIds = await likes.findLikedPostIds(
          viewerId,
          items.map((p) => p.id),
        );
        const likedSet = new Set(likedIds);
        items = items.map((p) => ({ ...p, isLiked: likedSet.has(p.id) }));
      }

      if (filter === "recent" && viewerId) {
        const own = await posts.findLatestByAuthorInFilter(viewerId, {
          gospelCardId,
          category,
          statuses: ["published", "pending_review"],
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
    "/posts/:id",
    {
      schema: {
        params: PostIdParams,
        response: {
          200: z.object({ post: ListPostsResponse.shape.posts.element }),
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
          .header("Retry-After", String(rl.retryAfter ?? 60))
          .send({ error: "rate_limited" });
      }
      const post = await posts.findById(request.params.id);
      if (
        !post ||
        (post.status !== "published" && post.status !== "pending_review")
      ) {
        return reply.code(404).send({ error: "not_found" });
      }
      const [presented] = await presentPosts([post], db);
      return reply.code(200).send({ post: presented! });
    },
  );

  f.post(
    "/posts",
    {
      preHandler: authPre,
      schema: {
        headers: z.object({ "idempotency-key": z.string().min(16).max(128) }),
        body: CreatePostRequest,
        response: {
          201: CreatePostResponse,
          400: z.union([ErrorResponse, z.object({ error: z.string() })]),
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
          .header("Retry-After", String(rl.retryAfter ?? 60))
          .send({ error: "rate_limited" });
      }

      const idemKey = request.headers["idempotency-key"] as string;
      const result = await createPostService(
        deps,
        userId,
        request.body,
        idemKey,
      );

      if (!result.ok) {
        const code = result.error.status;
        return reply.code(code).send({ error: result.error.code });
      }

      await feedCache.invalidate();
      return reply.code(201).send(result.data);
    },
  );

  f.delete(
    "/posts/:id",
    {
      preHandler: authPre,
      schema: {
        params: PostIdParams,
        response: {
          200: z.object({ ok: z.literal(true) }),
          403: ErrorResponse,
          404: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkPostsDelete(userId);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header("Retry-After", String(rl.retryAfter ?? 60))
          .send({ error: "rate_limited" });
      }

      const result = await deletePostService(deps, userId, request.params.id);
      if (!result.ok)
        return reply
          .code(result.error.status)
          .send({ error: result.error.code });

      await feedCache.invalidate();
      return reply.code(200).send({ ok: true });
    },
  );

  f.post(
    "/posts/:id/like",
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
          .header("Retry-After", String(rl.retryAfter ?? 60))
          .send({ error: "rate_limited" });
      }

      const result = await likePostService(deps, userId, request.params.id);
      if (!result.ok)
        return reply
          .code(result.error.status)
          .send({ error: result.error.code });

      await feedCache.invalidate();
      return reply.code(200).send(result.data);
    },
  );

  f.delete(
    "/posts/:id/like",
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
          .header("Retry-After", String(rl.retryAfter ?? 60))
          .send({ error: "rate_limited" });
      }

      const result = await unlikePostService(deps, userId, request.params.id);
      if (!result.ok)
        return reply
          .code(result.error.status)
          .send({ error: result.error.code });

      await feedCache.invalidate();
      return reply.code(200).send(result.data);
    },
  );

  f.post(
    "/posts/:id/report",
    {
      preHandler: authPre,
      schema: {
        params: PostIdParams,
        body: ReportRequest,
        response: {
          200: ReportResponse,
          400: z.union([ReportResponse, ErrorResponse]),
          404: z.union([ReportResponse, ErrorResponse]),
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
          .header("Retry-After", String(rl.retryAfter ?? 60))
          .send({ error: "rate_limited" });
      }

      const result = await reportPostService(
        deps,
        userId,
        request.params.id,
        request.body.reason,
      );
      if (!result.ok) {
        return reply
          .code(result.error.status)
          .send({
            outcome:
              result.error.code === "not_found"
                ? ("post_not_found" as ReportOutcome)
                : (result.error.code as ReportOutcome),
          });
      }   

      if (result.data.outcome === "created") await feedCache.invalidate();
      return reply.code(200).send(result.data);
    },
  );

  f.delete(
    "/posts/:id/report",
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
          .header("Retry-After", String(rl.retryAfter ?? 60))
          .send({ error: "rate_limited" });
      }

      const result = await unreportPostService(deps, userId, request.params.id);
      if (!result.ok)
        return reply
          .code(result.error.status)
          .send({ error: result.error.code });

      await feedCache.invalidate();
      return reply.code(200).send(result.data);
    },
  );
}
