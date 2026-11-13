import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  pendingPasswordResets,
  refreshTokens,
  usedRecoverySessions,
  users,
} from "../db/schema.js";
import type { PendingPasswordReset } from "../db/schema.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface ConsumedSession {
  jti: string;
  expiresAt: Date;
}

export type ResetOutcome = "ok" | "replayed";

async function consumeSession(
  tx: Tx,
  session: ConsumedSession,
): Promise<boolean> {
  // Higiene: o jti só precisa de ser lembrado até o JWT expirar.
  await tx
    .delete(usedRecoverySessions)
    .where(lt(usedRecoverySessions.expiresAt, new Date()));
  const inserted = await tx
    .insert(usedRecoverySessions)
    .values({ jti: session.jti, expiresAt: session.expiresAt })
    .onConflictDoNothing()
    .returning({ jti: usedRecoverySessions.jti });
  return inserted.length > 0;
}

async function revokeAllTokens(tx: Tx, userId: string): Promise<void> {
  await tx
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)),
    );
}

export function recoveryRepo(db: Database) {
  return {
    async completeResetWithCode(args: {
      session: ConsumedSession;
      userId: string;
      passwordHash: string;
      recoveryCodeHash: string;
    }): Promise<ResetOutcome> {
      return db.transaction(async (tx) => {
        if (!(await consumeSession(tx, args.session)))
          return "replayed" as const;
        await tx
          .update(users)
          .set({
            passwordHash: args.passwordHash,
            recoveryCodeHash: args.recoveryCodeHash,
            updatedAt: new Date(),
          })
          .where(eq(users.id, args.userId));
        await revokeAllTokens(tx, args.userId);
        await tx
          .delete(pendingPasswordResets)
          .where(eq(pendingPasswordResets.userId, args.userId));
        return "ok" as const;
      });
    },

    async requestDelayedReset(args: {
      session: ConsumedSession;
      userId: string;
      passwordHash: string;
      effectiveAt: Date;
    }): Promise<ResetOutcome> {
      return db.transaction(async (tx) => {
        if (!(await consumeSession(tx, args.session)))
          return "replayed" as const;
        await tx
          .insert(pendingPasswordResets)
          .values({
            userId: args.userId,
            passwordHash: args.passwordHash,
            effectiveAt: args.effectiveAt,
          })
          .onConflictDoUpdate({
            target: pendingPasswordResets.userId,
            set: {
              passwordHash: args.passwordHash,
              requestedAt: sql`now()`,
              effectiveAt: args.effectiveAt,
            },
          });
        return "ok" as const;
      });
    },

    async getPending(userId: string): Promise<PendingPasswordReset | null> {
      const [row] = await db
        .select()
        .from(pendingPasswordResets)
        .where(eq(pendingPasswordResets.userId, userId))
        .limit(1);
      return row ?? null;
    },

    async cancelPending(userId: string): Promise<boolean> {
      const rows = await db
        .delete(pendingPasswordResets)
        .where(eq(pendingPasswordResets.userId, userId))
        .returning({ userId: pendingPasswordResets.userId });
      return rows.length > 0;
    },

    async applyPendingIfDue(args: {
      userId: string;
      recoveryCodeHash: string;
    }): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [pending] = await tx
          .select()
          .from(pendingPasswordResets)
          .where(eq(pendingPasswordResets.userId, args.userId))
          .for("update")
          .limit(1);
        if (!pending || pending.effectiveAt > new Date()) return false;

        await tx
          .update(users)
          .set({
            passwordHash: pending.passwordHash,
            recoveryCodeHash: args.recoveryCodeHash,
            updatedAt: new Date(),
          })
          .where(eq(users.id, args.userId));
        await revokeAllTokens(tx, args.userId);
        await tx
          .delete(pendingPasswordResets)
          .where(eq(pendingPasswordResets.userId, args.userId));
        return true;
      });
    },
  };
}
