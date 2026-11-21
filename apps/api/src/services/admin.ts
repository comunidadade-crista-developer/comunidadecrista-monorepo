import type {
  AdminListPostsQuery,
  AdminListPostsResponse,
  AdminListReportsQuery,
  AdminModerationLogQuery,
  AdminModerationLogResponse,
  AdminModerationResponse,
  AdminPostDetailResponse,
  AdminReportListResponse,
  AdminReportsByCategory,
} from "@comunidade/shared";
import { ADMIN_EXCERPT_MAX } from "@comunidade/shared";
import type { Executor } from "../db/client.js";
import type { ModerationLogEntry, Report, User } from "../db/schema.js";
import { adminRepo, EMPTY_REPORTS_BY_CATEGORY } from "../repositories/admin.js";
import { cardsRepo } from "../repositories/cards.js";
import { outboxRepo } from "../repositories/outbox.js";
import { InvalidCursorError, postsRepo } from "../repositories/posts.js";
import { moderationLogRepo, reportsRepo } from "../repositories/reports.js";
import { usersRepo } from "../repositories/users.js";

export type AdminServiceError =
  | { code: "not_found"; status: 404 }
  /** Só se decide sobre posts em `pending_review`. */
  | { code: "invalid_state"; status: 409 }
  | { code: "invalid_cursor"; status: 400 };

export type AdminResult<T> =
  { ok: true; data: T } | { ok: false; error: AdminServiceError };

const ok = <T>(data: T): AdminResult<T> => ({ ok: true, data });
const fail = (error: AdminServiceError): AdminResult<never> => ({
  ok: false,
  error,
});

type Username = { username: string } | null;

/** Contas removidas (ou inexistentes) aparecem como `null` («[removido]»). */
function usernameOf(user: User | undefined): Username {
  return user && !user.deletedAt ? { username: user.username } : null;
}

async function usersById(
  db: Executor,
  ids: (string | null)[],
): Promise<Map<string, User>> {
  const unique = Array.from(
    new Set(ids.filter((id): id is string => id !== null)),
  );
  const rows = await usersRepo(db).findManyByIds(unique);
  return new Map(rows.map((u) => [u.id, u]));
}

/** Excerto sem cortar um par substituto (emoji) ao meio. */
function excerpt(content: string): string {
  const chars = Array.from(content);
  if (chars.length <= ADMIN_EXCERPT_MAX) return content;
  return `${chars.slice(0, ADMIN_EXCERPT_MAX).join("").trimEnd()}…`;
}

function sumReports(by: AdminReportsByCategory): number {
  return by.spam + by.off_topic + by.offensive + by.doctrine + by.other;
}

function reportItem(
  r: Report,
  titles: Map<string, string>,
  users: Map<string, User>,
) {
  return {
    id: r.id,
    postId: r.postId,
    postTitle: titles.get(r.postId) ?? null,
    reporter: usernameOf(users.get(r.reporterId)),
    category: r.category,
    severity: r.severity,
    reason: r.reason,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
  };
}

function logItem(
  e: ModerationLogEntry,
  titles: Map<string, string>,
  users: Map<string, User>,
) {
  return {
    id: e.id,
    action: e.action,
    postId: e.postId,
    postTitle: e.postId ? (titles.get(e.postId) ?? null) : null,
    moderator: e.moderatorId ? usernameOf(users.get(e.moderatorId)) : null,
    target: e.targetUserId ? usernameOf(users.get(e.targetUserId)) : null,
    reason: e.reason,
    createdAt: e.createdAt.toISOString(),
  };
}

// ---------- Posts ----------

export async function listAdminPosts(
  db: Executor,
  query: AdminListPostsQuery,
): Promise<AdminResult<AdminListPostsResponse>> {
  try {
    const page = await adminRepo(db).listPostsPage({
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    const [counts, users] = await Promise.all([
      adminRepo(db).openReportsByPosts(page.items.map((p) => p.id)),
      usersById(
        db,
        page.items.map((p) => p.authorId),
      ),
    ]);
    return ok({
      posts: page.items.map((p) => {
        const by = counts.get(p.id) ?? { ...EMPTY_REPORTS_BY_CATEGORY };
        return {
          id: p.id,
          category: p.category,
          title: p.title,
          excerpt: excerpt(p.content),
          status: p.status,
          author: p.authorId ? usernameOf(users.get(p.authorId)) : null,
          reviewFlags: p.reviewFlags ?? [],
          reportsCount: sumReports(by),
          reportsByCategory: by,
          createdAt: p.createdAt.toISOString(),
        };
      }),
      nextCursor: page.nextCursor,
    });
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      return fail({ code: "invalid_cursor", status: 400 });
    }
    throw err;
  }
}

export async function getAdminPostDetail(
  db: Executor,
  postId: string,
): Promise<AdminResult<AdminPostDetailResponse>> {
  const repo = adminRepo(db);
  const post = await repo.findPost(postId);
  if (!post) return fail({ code: "not_found", status: 404 });

  const [reportRows, logRows, counts, cards] = await Promise.all([
    repo.reportsForPost(postId),
    repo.logForPost(postId),
    repo.openReportsByPosts([postId]),
    post.gospelCardId
      ? cardsRepo(db).findByIds([post.gospelCardId])
      : Promise.resolve([]),
  ]);
  const users = await usersById(db, [
    post.authorId,
    ...reportRows.map((r) => r.reporterId),
    ...logRows.map((e) => e.moderatorId),
  ]);
  const titles = new Map([[post.id, post.title]]);
  const by = counts.get(postId) ?? { ...EMPTY_REPORTS_BY_CATEGORY };

  return ok({
    post: {
      id: post.id,
      category: post.category,
      title: post.title,
      content: post.content,
      status: post.status,
      author: post.authorId ? usernameOf(users.get(post.authorId)) : null,
      gospelCardSlug: cards[0]?.slug ?? null,
      reviewFlags: post.reviewFlags ?? [],
      likesCount: post.likesCount,
      reportsCount: sumReports(by),
      reportsByCategory: by,
      createdAt: post.createdAt.toISOString(),
      publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
    },
    reports: reportRows.map((r) => reportItem(r, titles, users)),
    moderation: logRows.map((e) => logItem(e, titles, users)),
  });
}

// ---------- Decisões ----------

type Decision = "approve" | "reject";

/**
 * Decide um post em revisão. Tudo numa transacção: bloqueio da linha, mudança de estado,
 * resolução das denúncias abertas, registo de auditoria e evento no outbox. Só se decide
 * sobre `pending_review`: um post `hidden` (suspenso por apagamento de conta) ou já decidido
 * dá `invalid_state`, para uma decisão não ressuscitar o que outra regra escondeu.
 */
async function decide(
  db: Executor,
  adminId: string,
  postId: string,
  decision: Decision,
  text: string | undefined,
): Promise<AdminResult<AdminModerationResponse>> {
  return db.transaction(async (tx) => {
    const locked = await adminRepo(tx).lockPostForDecision(postId);
    if (!locked) return fail({ code: "not_found", status: 404 });
    if (locked.status !== "pending_review") {
      return fail({ code: "invalid_state", status: 409 });
    }

    const approve = decision === "approve";
    const updated = await postsRepo(tx).setStatus(
      postId,
      approve ? "published" : "rejected",
    );
    if (!updated) return fail({ code: "not_found", status: 404 });

    await reportsRepo(tx).resolveAllForPost(
      postId,
      approve ? "resolved_kept" : "resolved_removed",
      adminId,
    );
    await moderationLogRepo(tx).create({
      postId,
      moderatorId: adminId,
      action: approve ? "approved" : "rejected",
      reason: text ?? null,
    });
    await outboxRepo(tx).enqueue({
      aggregateType: "post",
      aggregateId: postId,
      eventType: approve ? "post.approved" : "post.rejected",
      payload: { postId },
    });

    return ok({
      post: {
        id: updated.id,
        status: updated.status,
        publishedAt: updated.publishedAt
          ? updated.publishedAt.toISOString()
          : null,
      },
    });
  });
}

export function approvePost(
  db: Executor,
  adminId: string,
  postId: string,
  body: { note?: string | undefined },
): Promise<AdminResult<AdminModerationResponse>> {
  return decide(db, adminId, postId, "approve", body.note);
}

export function rejectPost(
  db: Executor,
  adminId: string,
  postId: string,
  body: { reason: string },
): Promise<AdminResult<AdminModerationResponse>> {
  return decide(db, adminId, postId, "reject", body.reason);
}

// ---------- Denúncias e auditoria ----------

export async function listAdminReports(
  db: Executor,
  query: AdminListReportsQuery,
): Promise<AdminResult<AdminReportListResponse>> {
  try {
    const page = await adminRepo(db).listReportsPage({
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    const [titles, users] = await Promise.all([
      adminRepo(db).titlesByIds(page.items.map((r) => r.postId)),
      usersById(
        db,
        page.items.map((r) => r.reporterId),
      ),
    ]);
    return ok({
      reports: page.items.map((r) => reportItem(r, titles, users)),
      nextCursor: page.nextCursor,
    });
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      return fail({ code: "invalid_cursor", status: 400 });
    }
    throw err;
  }
}

export async function listAdminModerationLog(
  db: Executor,
  query: AdminModerationLogQuery,
): Promise<AdminResult<AdminModerationLogResponse>> {
  try {
    const page = await adminRepo(db).listLogPage({
      action: query.action,
      postId: query.postId,
      cursor: query.cursor,
      limit: query.limit,
    });
    const [titles, users] = await Promise.all([
      adminRepo(db).titlesByIds(
        page.items.map((e) => e.postId).filter((id): id is string => !!id),
      ),
      usersById(db, [
        ...page.items.map((e) => e.moderatorId),
        ...page.items.map((e) => e.targetUserId),
      ]),
    ]);
    return ok({
      entries: page.items.map((e) => logItem(e, titles, users)),
      nextCursor: page.nextCursor,
    });
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      return fail({ code: "invalid_cursor", status: 400 });
    }
    throw err;
  }
}
