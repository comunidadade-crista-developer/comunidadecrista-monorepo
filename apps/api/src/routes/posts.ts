import {
  CreatePostRequest,
  CreatePostResponse,
  ErrorResponse,
  IdempotencyKey,
  LikeResponse,
  ListPostsQuery,
  ListPostsResponse,
  PostPublic,
  PostIdParams,
  ReportRequest,
  ReportResponse,
} from "@comunidade/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { JwtService } from "../auth/jwt.js";
import { optionalAuth, requireAuth } from "../auth/middleware.js";
import type { RateLimitResult, RateLimiters } from "../auth/rate-limit.js";
import type { FeedCache } from "../cache/feed-cache.js";
import type { Database } from "../db/client.js";
import { InvalidCursorError, postsRepo } from "../repositories/posts.js";
import { usersRepo } from "../repositories/users.js";
import { decorateForViewer } from "../services/feed-view.js";
import { presentOne, presentPosts } from "../services/post-presenter.js";
import {
  createPostService,
  deletePostService,
  likePostService,
  reportPostService,
  unlikePostService,
  unreportPostService,
  type ServiceError,
} from "../services/posts.js";

export interface PostsRoutesOptions {
  db: Database;
  jwt: JwtService;
  limiters: RateLimiters;
  feedCache: FeedCache;
}

const SinglePostResponse = z.object({ post: PostPublic });
const DeleteResponse = z.object({ deleted: z.literal(true) });
const UnreportResponse = z.object({ withdrawn: z.literal(true) });
const CreateHeaders = z.object({ "idempotency-key": IdempotencyKey });

function sendError(
  reply: object,
  status: number,
  error: string,
  retryAfter?: number,
): FastifyReply {
  const r = (reply as FastifyReply).code(status);
  if (retryAfter !== undefined) r.header("Retry-After", String(retryAfter));
  return r.send({ error });
}

function tooMany(reply: object, rl: RateLimitResult): FastifyReply {
  return sendError(reply, 429, "rate_limited", rl.retryAfter ?? 60);
}

function sendServiceError(reply: object, error: ServiceError): FastifyReply {
  return sendError(reply, error.status, error.code);
}

export async function postsRoutes(
  app: FastifyInstance,
  { db, jwt, limiters, feedCache }: PostsRoutesOptions,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const posts = postsRepo(db);
  const users = usersRepo(db);
  const deps = { db };
  // `preValidation`: sem sessão válida o pedido é recusado (401) antes de se olhar para o corpo.
  const authPre = requireAuth(jwt);
  const maybeAuth = optionalAuth(jwt);

  f.get(
    "/posts",
    {
      preValidation: maybeAuth,
      schema: {
        querystring: ListPostsQuery,
        response: {
          200: ListPostsResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const viewerId = request.user?.id;
      const rl = await limiters.checkReadFeed(request.clientIp, viewerId);
      if (!rl.allowed) return tooMany(reply, rl);

      const { gospelCardId, category, filter, cursor, limit } = request.query;

      try {
        // CodeQL js/user-controlled-bypass: falso positivo. `filter` só escolhe QUE lista devolver;
        // a autorização é a verificação seguinte (`viewerId` vem do token, nunca do pedido).
        if (filter === "liked") {
          if (!viewerId) return sendError(reply, 401, "missing_token");
          const result = await posts.list({
            filter: "liked",
            viewerId,
            limit,
            ...(gospelCardId ? { gospelCardId } : {}),
            ...(category ? { category } : {}),
            ...(cursor ? { cursor } : {}),
          });
          return reply.code(200).send({
            posts: await presentPosts(result.items, db, viewerId),
            nextCursor: result.nextCursor,
          });
        }

        const page = await feedCache.list({
          filter,
          limit,
          category,
          gospelCardId,
          cursor,
        });

        let items = await decorateForViewer(page, viewerId, db);

        // CodeQL js/user-controlled-bypass: falso positivo. `filter`/`cursor` só decidem se esta é a
        // primeira página do feed; a consulta é sempre limitada ao `viewerId` do token, por isso
        // ninguém vê posts em revisão de outro autor, qualquer que seja o valor enviado.
        if (viewerId && filter === "recent" && cursor === undefined) {
          const pending = await posts.findLatestByAuthorInFilter(viewerId, {
            statuses: ["pending_review"],
            ...(gospelCardId ? { gospelCardId } : {}),
            ...(category ? { category } : {}),
          });
          if (pending) {
            items = [await presentOne(pending, db, viewerId), ...items];
          }
        }

        return reply
          .code(200)
          .send({ posts: items, nextCursor: page.nextCursor });
      } catch (err) {
        // A rota já valida o cursor; isto é a rede de segurança.
        if (err instanceof InvalidCursorError) {
          return sendError(reply, 400, "validation_error");
        }
        throw err;
      }
    },
  );

  f.get(
    "/posts/:id",
    {
      preValidation: maybeAuth,
      schema: {
        params: PostIdParams,
        response: {
          200: SinglePostResponse,
          401: ErrorResponse,
          404: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const viewer = request.user;
      const rl = await limiters.checkReadFeed(request.clientIp, viewer?.id);
      if (!rl.allowed) return tooMany(reply, rl);

      // `findById` nunca devolve posts apagados pelo autor.
      const post = await posts.findById(request.params.id);
      if (!post) return sendError(reply, 404, "not_found");

      if (post.status !== "published") {
        let allowed = viewer !== undefined && post.authorId === viewer.id;
        if (!allowed && viewer?.role === "admin") {
          // O papel do JWT pode estar desactualizado: revalida-se na base de dados.
          const user = await users.findById(viewer.id);
          allowed =
            user !== null &&
            user.role === "admin" &&
            user.deletedAt === null &&
            user.deletionRequestedAt === null;
        }
        if (!allowed) return sendError(reply, 404, "not_found");
      }

      return reply
        .code(200)
        .send({ post: await presentOne(post, db, viewer?.id) });
    },
  );

  f.post(
    "/posts",
    {
      preValidation: authPre,
      schema: {
        headers: CreateHeaders,
        body: CreatePostRequest,
        response: {
          200: CreatePostResponse,
          201: CreatePostResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkPostsCreate(userId);
      if (!rl.allowed) return tooMany(reply, rl);

      const result = await createPostService(
        deps,
        userId,
        request.body,
        request.headers["idempotency-key"],
      );
      if (!result.ok) return sendServiceError(reply, result.error);

      const { replayed, ...body } = result.data;
      if (!replayed && body.status === "published") {
        await feedCache.invalidate();
      }
      return reply.code(replayed ? 200 : 201).send(body);
    },
  );

  f.delete(
    "/posts/:id",
    {
      preValidation: authPre,
      schema: {
        params: PostIdParams,
        response: {
          200: DeleteResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkPostsDelete(userId);
      if (!rl.allowed) return tooMany(reply, rl);

      const result = await deletePostService(deps, userId, request.params.id);
      if (!result.ok) return sendServiceError(reply, result.error);

      if (result.data.changed) await feedCache.invalidate();
      return reply.code(200).send({ deleted: true });
    },
  );

  f.post(
    "/posts/:id/like",
    {
      preValidation: authPre,
      schema: {
        params: PostIdParams,
        response: {
          200: LikeResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkLikes(userId);
      if (!rl.allowed) return tooMany(reply, rl);

      const result = await likePostService(deps, userId, request.params.id);
      if (!result.ok) return sendServiceError(reply, result.error);

      // Likes não invalidam o feed (D7): o contador público atrasa-se no máximo o TTL.
      const { likesCount, isLiked } = result.data;
      return reply.code(200).send({ likesCount, isLiked });
    },
  );

  f.delete(
    "/posts/:id/like",
    {
      preValidation: authPre,
      schema: {
        params: PostIdParams,
        response: {
          200: LikeResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkLikes(userId);
      if (!rl.allowed) return tooMany(reply, rl);

      const result = await unlikePostService(deps, userId, request.params.id);
      if (!result.ok) return sendServiceError(reply, result.error);

      const { likesCount, isLiked } = result.data;
      return reply.code(200).send({ likesCount, isLiked });
    },
  );

  f.post(
    "/posts/:id/report",
    {
      preValidation: authPre,
      schema: {
        params: PostIdParams,
        body: ReportRequest,
        response: {
          200: ReportResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkReports(userId);
      if (!rl.allowed) return tooMany(reply, rl);

      const result = await reportPostService(
        deps,
        userId,
        request.params.id,
        request.body.category,
        request.body.reason,
      );
      if (!result.ok) return sendServiceError(reply, result.error);

      // Só quando esta denúncia fez o post sair do feed público (passou o limiar).
      if (result.data.escalated) await feedCache.invalidate();
      return reply.code(200).send({ outcome: result.data.outcome });
    },
  );

  f.delete(
    "/posts/:id/report",
    {
      preValidation: authPre,
      schema: {
        params: PostIdParams,
        response: {
          200: UnreportResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkReports(userId);
      if (!rl.allowed) return tooMany(reply, rl);

      const result = await unreportPostService(deps, userId, request.params.id);
      if (!result.ok) return sendServiceError(reply, result.error);

      return reply.code(200).send({ withdrawn: true });
    },
  );
}
