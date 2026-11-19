import {
  AdminApproveRequest,
  AdminListPostsQuery,
  AdminListPostsResponse,
  AdminListReportsQuery,
  AdminModerationLogQuery,
  AdminModerationLogResponse,
  AdminModerationResponse,
  AdminPostDetailResponse,
  AdminRejectRequest,
  AdminReportListResponse,
  ErrorResponse,
  PostIdParams,
} from "@comunidade/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { JwtService } from "../auth/jwt.js";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import type { RateLimitResult, RateLimiters } from "../auth/rate-limit.js";
import type { FeedCache } from "../cache/feed-cache.js";
import type { Database } from "../db/client.js";
import {
  approvePost,
  getAdminPostDetail,
  listAdminModerationLog,
  listAdminPosts,
  listAdminReports,
  rejectPost,
  type AdminServiceError,
} from "../services/admin.js";

export interface AdminRoutesOptions {
  db: Database;
  jwt: JwtService;
  limiters: RateLimiters;
  feedCache: FeedCache;
}

/** Erro no formato único `{ error }` (o `ErrorResponse` de cada rota já o declara). */
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

function sendServiceError(reply: object, e: AdminServiceError): FastifyReply {
  return sendError(reply, e.status, e.code);
}

const ReadErrors = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  429: ErrorResponse,
} as const;

const DecisionErrors = {
  ...ReadErrors,
  404: ErrorResponse,
  409: ErrorResponse,
} as const;

/**
 * Painel de administração (ADR-015). Todas as rotas exigem sessão válida E papel de admin
 * revalidado na base de dados, em `preValidation`: sem isso o pedido é recusado (401/403)
 * antes de se olhar para o corpo ou a query, e quem não é admin não aprende nada sobre o
 * formato dos pedidos.
 */
export async function adminRoutes(
  app: FastifyInstance,
  { db, jwt, limiters, feedCache }: AdminRoutesOptions,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const adminPre = [requireAuth(jwt), requireAdmin(db)];

  f.get(
    "/admin/posts",
    {
      preValidation: adminPre,
      schema: {
        querystring: AdminListPostsQuery,
        response: { 200: AdminListPostsResponse, ...ReadErrors },
      },
    },
    async (request, reply) => {
      const rl = await limiters.checkAdminRead(request.user!.id);
      if (!rl.allowed) return tooMany(reply, rl);
      const r = await listAdminPosts(db, request.query);
      if (!r.ok) return sendServiceError(reply, r.error);
      return reply.code(200).send(r.data);
    },
  );

  f.get(
    "/admin/posts/:id",
    {
      preValidation: adminPre,
      schema: {
        params: PostIdParams,
        response: { 200: AdminPostDetailResponse, ...DecisionErrors },
      },
    },
    async (request, reply) => {
      const rl = await limiters.checkAdminRead(request.user!.id);
      if (!rl.allowed) return tooMany(reply, rl);
      const r = await getAdminPostDetail(db, request.params.id);
      if (!r.ok) return sendServiceError(reply, r.error);
      return reply.code(200).send(r.data);
    },
  );

  f.post(
    "/admin/posts/:id/approve",
    {
      preValidation: adminPre,
      schema: {
        params: PostIdParams,
        body: AdminApproveRequest,
        response: { 200: AdminModerationResponse, ...DecisionErrors },
      },
    },
    async (request, reply) => {
      const adminId = request.user!.id;
      const rl = await limiters.checkAdminWrite(adminId);
      if (!rl.allowed) return tooMany(reply, rl);
      const r = await approvePost(db, adminId, request.params.id, request.body);
      if (!r.ok) return sendServiceError(reply, r.error);
      // Só a aprovação muda o que o feed público mostra (passa a haver um post novo).
      await feedCache.invalidate();
      return reply.code(200).send(r.data);
    },
  );

  f.post(
    "/admin/posts/:id/reject",
    {
      preValidation: adminPre,
      schema: {
        params: PostIdParams,
        body: AdminRejectRequest,
        response: { 200: AdminModerationResponse, ...DecisionErrors },
      },
    },
    async (request, reply) => {
      const adminId = request.user!.id;
      const rl = await limiters.checkAdminWrite(adminId);
      if (!rl.allowed) return tooMany(reply, rl);
      const r = await rejectPost(db, adminId, request.params.id, request.body);
      if (!r.ok) return sendServiceError(reply, r.error);
      // Um post em revisão nunca esteve no feed público: não há nada a invalidar.
      return reply.code(200).send(r.data);
    },
  );

  f.get(
    "/admin/reports",
    {
      preValidation: adminPre,
      schema: {
        querystring: AdminListReportsQuery,
        response: { 200: AdminReportListResponse, ...ReadErrors },
      },
    },
    async (request, reply) => {
      const rl = await limiters.checkAdminRead(request.user!.id);
      if (!rl.allowed) return tooMany(reply, rl);
      const r = await listAdminReports(db, request.query);
      if (!r.ok) return sendServiceError(reply, r.error);
      return reply.code(200).send(r.data);
    },
  );

  f.get(
    "/admin/moderation-log",
    {
      preValidation: adminPre,
      schema: {
        querystring: AdminModerationLogQuery,
        response: { 200: AdminModerationLogResponse, ...ReadErrors },
      },
    },
    async (request, reply) => {
      const rl = await limiters.checkAdminRead(request.user!.id);
      if (!rl.allowed) return tooMany(reply, rl);
      const r = await listAdminModerationLog(db, request.query);
      if (!r.ok) return sendServiceError(reply, r.error);
      return reply.code(200).send(r.data);
    },
  );
}
