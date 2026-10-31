import { and, count, eq, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  outbox,
  pendingPasswordResets,
  posts,
  refreshTokens,
  users,
} from "../db/schema.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type DeletionPostsMode = "anonymize" | "delete";

export const ACCOUNT_DELETION_GRACE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RequestDeletionResult =
  | { outcome: "requested"; purgeAt: Date }
  | { outcome: "already_pending"; purgeAt: Date }
  | { outcome: "last_admin" }
  | { outcome: "not_found" };

export type RestoreResult = "restored" | "already_active" | "gone";

export interface PurgeSummary {
  accounts: number;
  postsDeleted: number;
  failed: number;
}

export function publicAuthorId(post: {
  authorId: string | null;
  authorHidden: boolean;
}): string | null {
  return post.authorHidden ? null : post.authorId;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function accountDeletionRepo(db: Database) {
  return {
    async request(args: {
      userId: string;
      postsMode: DeletionPostsMode;
      graceDays?: number;
    }): Promise<RequestDeletionResult> {
      const graceDays = args.graceDays ?? ACCOUNT_DELETION_GRACE_DAYS;

      return db.transaction(async (tx) => {
        const [user] = await tx
          .select({
            role: users.role,
            deletionRequestedAt: users.deletionRequestedAt,
            deletedAt: users.deletedAt,
          })
          .from(users)
          .where(eq(users.id, args.userId))
          .for("update")
          .limit(1);
        if (!user || user.deletedAt) return { outcome: "not_found" as const };
        if (user.deletionRequestedAt) {
          return {
            outcome: "already_pending" as const,
            purgeAt: addDays(user.deletionRequestedAt, graceDays),
          };
        }

        if (user.role === "admin") {
          // Serializa pedidos de administradores: sem isto, dois admins a apagar-se ao mesmo
          // tempo veriam cada um o outro como «activo» e a plataforma ficava sem admin.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext('account-deletion:admin'))`,
          );
          const [others] = await tx
            .select({ c: count() })
            .from(users)
            .where(
              and(
                eq(users.role, "admin"),
                ne(users.id, args.userId),
                isNull(users.deletionRequestedAt),
                isNull(users.deletedAt),
              ),
            );
          if (Number(others?.c ?? 0) === 0) {
            return { outcome: "last_admin" as const };
          }
        }

        const now = new Date();
        await tx
          .update(users)
          .set({
            deletionRequestedAt: now,
            deletionPostsMode: args.postsMode,
            updatedAt: now,
          })
          .where(eq(users.id, args.userId));
        await tx
          .update(refreshTokens)
          .set({ revokedAt: now })
          .where(
            and(
              eq(refreshTokens.userId, args.userId),
              isNull(refreshTokens.revokedAt),
            ),
          );
        await tx
          .delete(pendingPasswordResets)
          .where(eq(pendingPasswordResets.userId, args.userId));

        if (args.postsMode === "delete") {
          await tx
            .update(posts)
            .set({ suspendedStatus: sql`${posts.status}`, status: "hidden" })
            .where(
              and(eq(posts.authorId, args.userId), ne(posts.status, "hidden")),
            );
        } else {
          await tx
            .update(posts)
            .set({ authorHidden: true })
            .where(eq(posts.authorId, args.userId));
        }

        await tx.insert(outbox).values({
          aggregateType: "user",
          aggregateId: args.userId,
          eventType: "user.deletion_requested",
          payload: { postsMode: args.postsMode },
        });

        return {
          outcome: "requested" as const,
          purgeAt: addDays(now, graceDays),
        };
      });
    },

    async restore(userId: string): Promise<RestoreResult> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({ pending: users.deletionRequestedAt })
          .from(users)
          .where(eq(users.id, userId))
          .for("update")
          .limit(1);
        if (!row) return "gone" as const;
        if (!row.pending) return "already_active" as const;

        await tx
          .update(users)
          .set({
            deletionRequestedAt: null,
            deletionPostsMode: null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));
        await tx
          .update(posts)
          .set({ status: sql`${posts.suspendedStatus}`, suspendedStatus: null })
          .where(
            and(eq(posts.authorId, userId), isNotNull(posts.suspendedStatus)),
          );
        await tx
          .update(posts)
          .set({ authorHidden: false })
          .where(and(eq(posts.authorId, userId), eq(posts.authorHidden, true)));
        await tx.insert(outbox).values({
          aggregateType: "user",
          aggregateId: userId,
          eventType: "user.deletion_cancelled",
          payload: {},
        });
        return "restored" as const;
      });
    },

    async purgeDue(
      opts: { now?: Date; graceDays?: number; batch?: number } = {},
    ): Promise<PurgeSummary> {
      const now = opts.now ?? new Date();
      const graceDays = opts.graceDays ?? ACCOUNT_DELETION_GRACE_DAYS;
      const cutoff = new Date(now.getTime() - graceDays * DAY_MS);

      const due = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            isNotNull(users.deletionRequestedAt),
            lte(users.deletionRequestedAt, cutoff),
          ),
        )
        .orderBy(users.deletionRequestedAt)
        .limit(opts.batch ?? 50);

      const summary: PurgeSummary = { accounts: 0, postsDeleted: 0, failed: 0 };
      for (const { id } of due) {
        try {
          const result = await purgeOne(db, id, cutoff);
          if (result) {
            summary.accounts += 1;
            summary.postsDeleted += result.postsDeleted;
          }
        } catch {
          summary.failed += 1;
        }
      }
      return summary;
    },
  };
}

async function purgeOne(
  db: Database,
  userId: string,
  cutoff: Date,
): Promise<{ postsDeleted: number } | null> {
  return db.transaction(async (tx: Tx) => {
    const [user] = await tx
      .select({ mode: users.deletionPostsMode })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          isNotNull(users.deletionRequestedAt),
          lte(users.deletionRequestedAt, cutoff),
        ),
      )
      .for("update", { skipLocked: true })
      .limit(1);
    if (!user) return null;

    await tx.execute(sql`
      UPDATE posts p
      SET likes_count = GREATEST(p.likes_count - 1, 0)
      FROM post_likes l
      WHERE l.post_id = p.id AND l.user_id = ${userId}
    `);
    await tx.execute(sql`
      UPDATE posts p
      SET reports_count = GREATEST(p.reports_count - 1, 0)
      FROM reports r
      WHERE r.post_id = p.id AND r.reporter_id = ${userId} AND r.status = 'open'
    `);

    let postsDeleted = 0;
    if (user.mode === "delete") {
      const removed = await tx
        .delete(posts)
        .where(eq(posts.authorId, userId))
        .returning({ id: posts.id });
      postsDeleted = removed.length;
    }

    await tx.delete(users).where(eq(users.id, userId));
    return { postsDeleted };
  });
}
