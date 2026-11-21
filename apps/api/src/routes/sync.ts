import {
  ErrorResponse,
  SyncBootstrapResponse,
  SyncRequest,
  SyncResponse,
} from "@comunidade/shared";
import type {
  SyncErrorCode,
  SyncOperation,
  SyncResult,
} from "@comunidade/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { JwtService } from "../auth/jwt.js";
import { requireAuth } from "../auth/middleware.js";
import type { RateLimitResult, RateLimiters } from "../auth/rate-limit.js";
import type { CardsCache } from "../cache/cards-cache.js";
import type { FeedCache } from "../cache/feed-cache.js";
import type { Database } from "../db/client.js";
import type { Env } from "../env.js";
import { idempotencyKeysRepo } from "../repositories/outbox.js";
import { postLikesRepo, postsRepo } from "../repositories/posts.js";
import { reportsRepo } from "../repositories/reports.js";
import { usersRepo } from "../repositories/users.js";
import { decorateForViewer } from "../services/feed-view.js";
import { presentPosts } from "../services/post-presenter.js";
import {
  createPostService,
  deletePostService,
  likePostService,
  reportPostService,
  unlikePostService,
  unreportPostService,
} from "../services/posts.js";
import type { ServiceError, ServiceResult } from "../services/posts.js";

export interface SyncRoutesOptions {
  env: Pick<Env, "SYNC_BATCH_TIMEOUT_MS">;
  db: Database;
  jwt: JwtService;
  limiters: RateLimiters;
  feedCache: FeedCache;
  cardsCache: CardsCache;
}

/** Limites da lista de arranque; acima disto o cliente é avisado (`...Truncated`). */
const BOOTSTRAP_MY_POSTS = 50;
const BOOTSTRAP_MY_LIKES = 500;
const BOOTSTRAP_MY_REPORTS = 100;
const BOOTSTRAP_RECENT = 20;

interface OpOutcome {
  result: SyncResult;
  invalidateFeed: boolean;
}

/** O serviço diz «não mudou nada» (`changed`/`replayed`): o cliente vê `duplicate`. */
function done(
  opId: string,
  duplicate: boolean,
  result: SyncResult["result"],
  invalidateFeed = false,
): OpOutcome {
  return {
    result: {
      op_id: opId,
      status: duplicate ? "duplicate" : "applied",
      ...(result ? { result } : {}),
    },
    invalidateFeed: invalidateFeed && !duplicate,
  };
}

function rejected(opId: string, code: SyncErrorCode): OpOutcome {
  return {
    result: { op_id: opId, status: "rejected", error: { code } },
    invalidateFeed: false,
  };
}

/** Fora do prazo ou limite: nada foi tentado, o cliente repete mais tarde. */
function deferred(
  opId: string,
  error?: NonNullable<SyncResult["error"]>,
): OpOutcome {
  return {
    result: {
      op_id: opId,
      status: "deferred",
      ...(error ? { error } : {}),
    },
    invalidateFeed: false,
  };
}

function toSyncCode(error: ServiceError): SyncErrorCode {
  switch (error.code) {
    case "not_found":
    case "forbidden":
    case "own_post":
    case "idempotency_key_conflict":
    case "gospel_card_not_found":
    case "contains_link":
    case "contains_contact":
      return error.code;
    case "account_inactive":
      return "forbidden";
    case "reason_required":
      return "internal";
  }
}

export async function syncRoutes(
  app: FastifyInstance,
  { env, db, jwt, limiters, feedCache, cardsCache }: SyncRoutesOptions,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const authPre = requireAuth(jwt);
  const deps = { db };

  function checkOpLimit(
    userId: string,
    op: SyncOperation,
  ): Promise<RateLimitResult> {
    switch (op.type) {
      case "post.create":
        return limiters.checkPostsCreate(userId);
      case "post.delete":
        return limiters.checkPostsDelete(userId);
      case "post.like":
      case "post.unlike":
        return limiters.checkLikes(userId);
      case "post.report":
      case "post.unreport":
        return limiters.checkReports(userId);
    }
  }

  /** Mesmo tratamento de erro do `ServiceResult`: recusa definitiva com o código mapeado. */
  function fromFailure(opId: string, r: ServiceResult<unknown>): OpOutcome {
    return rejected(opId, r.ok ? "internal" : toSyncCode(r.error));
  }

  async function run(userId: string, op: SyncOperation): Promise<OpOutcome> {
    switch (op.type) {
      case "post.create": {
        const r = await createPostService(
          deps,
          userId,
          op.payload,
          op.idempotency_key,
        );
        if (!r.ok) return fromFailure(op.op_id, r);
        const { replayed, ...body } = r.data;
        return done(op.op_id, replayed, body, body.status === "published");
      }
      case "post.delete": {
        const r = await deletePostService(deps, userId, op.payload.postId);
        if (!r.ok) return fromFailure(op.op_id, r);
        return done(op.op_id, !r.data.changed, { deleted: true }, true);
      }
      case "post.like": {
        const r = await likePostService(deps, userId, op.payload.postId);
        if (!r.ok) return fromFailure(op.op_id, r);
        const { likesCount, isLiked, changed } = r.data;
        return done(op.op_id, !changed, { likesCount, isLiked });
      }
      case "post.unlike": {
        const r = await unlikePostService(deps, userId, op.payload.postId);
        if (!r.ok) return fromFailure(op.op_id, r);
        const { likesCount, isLiked, changed } = r.data;
        return done(op.op_id, !changed, { likesCount, isLiked });
      }
      case "post.report": {
        const r = await reportPostService(
          deps,
          userId,
          op.payload.postId,
          op.payload.category,
          op.payload.reason,
        );
        if (!r.ok) return fromFailure(op.op_id, r);
        return done(
          op.op_id,
          !r.data.changed,
          { outcome: r.data.outcome },
          r.data.escalated,
        );
      }
      case "post.unreport": {
        const r = await unreportPostService(deps, userId, op.payload.postId);
        if (!r.ok) return fromFailure(op.op_id, r);
        return done(op.op_id, !r.data.changed, { withdrawn: true });
      }
    }
  }

  async function hasKeyConflict(
    userId: string,
    op: SyncOperation,
    keysInBatch: Map<string, SyncOperation["type"]>,
  ): Promise<boolean> {
    const earlierType = keysInBatch.get(op.idempotency_key);
    if (earlierType !== undefined && earlierType !== op.type) return true;
    keysInBatch.set(op.idempotency_key, earlierType ?? op.type);
    if (op.type === "post.create") return false; // o serviço trata deste caso
    const stored = await idempotencyKeysRepo(db).get(
      userId,
      op.idempotency_key,
    );
    return stored !== null && stored.operation !== op.type;
  }

  async function processOne(
    userId: string,
    op: SyncOperation,
    keysInBatch: Map<string, SyncOperation["type"]>, // ← NOVO parâmetro
  ): Promise<OpOutcome> {
    const rl = await checkOpLimit(userId, op);
    if (!rl.allowed) {
      return deferred(op.op_id, {
        code: "rate_limited",
        retryAfter: rl.retryAfter ?? 60,
      });
    }
    try {
      if (await hasKeyConflict(userId, op, keysInBatch)) {
        // ← NOVO guard
        return rejected(op.op_id, "idempotency_key_conflict");
      }
      return await run(userId, op);
    } catch (err) {
      app.log.error(
        {
          errorName: err instanceof Error ? err.name : typeof err,
          errorCode:
            typeof err === "object" &&
            err !== null &&
            "code" in err &&
            typeof (err as { code: unknown }).code === "string"
              ? (err as { code: string }).code
              : undefined,
          opType: op.type,
        },
        "sync: operation failed",
      );
      return deferred(op.op_id, { code: "internal" });
    }
  }

  const sendError = (
    reply: object,
    status: number,
    error: string,
    retryAfter?: number,
  ): FastifyReply => {
    const r = (reply as FastifyReply).code(status);
    if (retryAfter !== undefined) r.header("Retry-After", String(retryAfter));
    return r.send({ error });
  };

  f.post(
    "/sync",
    {
      preValidation: authPre,
      schema: {
        body: SyncRequest,
        response: {
          200: SyncResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkSyncBatch(userId);
      if (!rl.allowed) {
        return sendError(reply, 429, "rate_limited", rl.retryAfter ?? 60);
      }

      const deadline = Date.now() + env.SYNC_BATCH_TIMEOUT_MS;
      const results: SyncResult[] = [];
      let invalidateFeed = false;
      const keysInBatch = new Map<string, SyncOperation["type"]>();

      for (const op of request.body.operations) {
        if (Date.now() >= deadline) {
          results.push(deferred(op.op_id).result);
          continue;
        }
        const outcome = await processOne(userId, op, keysInBatch);
        results.push(outcome.result);
        if (outcome.invalidateFeed) invalidateFeed = true;
      }

      // Uma só invalidação por lote.
      if (invalidateFeed) await feedCache.invalidate();

      return reply
        .code(200)
        .send({ results, serverTime: new Date().toISOString() });
    },
  );

  f.get(
    "/sync/bootstrap",
    {
      preValidation: authPre,
      schema: {
        response: {
          200: SyncBootstrapResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const rl = await limiters.checkSyncBatch(userId);
      if (!rl.allowed) {
        return sendError(reply, 429, "rate_limited", rl.retryAfter ?? 60);
      }

      const user = await usersRepo(db).findById(userId);
      if (!user) return sendError(reply, 401, "invalid_token");
      if (user.deletionRequestedAt) {
        return sendError(reply, 403, "account_inactive");
      }

      // Pede-se um a mais do que o limite para saber se houve corte.
      const [cards, recent, myPostRows, liked, myReportRows] =
        await Promise.all([
          cardsCache.list(),
          feedCache.list({ filter: "recent", limit: BOOTSTRAP_RECENT }),
          postsRepo(db).listByAuthor(userId, BOOTSTRAP_MY_POSTS + 1),
          postLikesRepo(db).listLikedPostIds(userId, BOOTSTRAP_MY_LIKES),
          reportsRepo(db).listByReporter(userId, BOOTSTRAP_MY_REPORTS + 1),
        ]);

      const [recentPosts, myPosts] = await Promise.all([
        decorateForViewer(recent, userId, db),
        presentPosts(myPostRows.slice(0, BOOTSTRAP_MY_POSTS), db, userId),
      ]);

      return reply.code(200).send({
        serverTime: new Date().toISOString(),
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          createdAt: user.createdAt.toISOString(),
        },
        cards,
        recentPosts: { posts: recentPosts, nextCursor: recent.nextCursor },
        myPosts,
        myPostsTruncated: myPostRows.length > BOOTSTRAP_MY_POSTS,
        myLikedPostIds: liked.ids,
        myLikedPostIdsTruncated: liked.truncated,
        myReports: myReportRows.slice(0, BOOTSTRAP_MY_REPORTS).map((r) => ({
          id: r.id,
          postId: r.postId,
          category: r.category,
          reason: r.reason,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
        })),
        myReportsTruncated: myReportRows.length > BOOTSTRAP_MY_REPORTS,
      });
    },
  );
}
