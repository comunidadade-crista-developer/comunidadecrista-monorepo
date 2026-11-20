import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import type { Database, Executor } from "../db/client.js";
import { refreshTokens, users } from "../db/schema.js";
import type {
  NewRefreshToken,
  NewUser,
  RefreshToken,
  User,
} from "../db/schema.js";

export type RotateResult =
  | {
      status: "ok";
      newTokenId: string;
      userId: string;
      familyId: string;
      /** O token apresentado já tinha sido rotacionado, mas dentro da janela de tolerância. */
      withinGrace: boolean;
    }
  | { status: "not_found" }
  | { status: "reuse_detected"; familyId: string }
  | { status: "expired" };

export function usersRepo(db: Executor) {
  return {
    async findById(id: string): Promise<User | null> {
      const [row] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, id), isNull(users.deletedAt)))
        .limit(1);
      return row ?? null;
    },

    async findManyByIds(ids: string[]): Promise<User[]> {
      if (ids.length === 0) return [];
      return db.select().from(users).where(inArray(users.id, ids));
    },

    async findByUsername(username: string): Promise<User | null> {
      const [row] = await db
        .select()
        .from(users)
        .where(and(eq(users.username, username), isNull(users.deletedAt)))
        .limit(1);
      return row ?? null;
    },

    async create(data: NewUser): Promise<User> {
      const [row] = await db.insert(users).values(data).returning();
      return row!;
    },

    async updateUsername(id: string, username: string): Promise<User | null> {
      const [row] = await db
        .update(users)
        .set({ username, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning();
      return row ?? null;
    },

    async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
      await db
        .update(users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    async updateRecoveryCodeHash(
      id: string,
      hash: string | null,
    ): Promise<void> {
      await db
        .update(users)
        .set({ recoveryCodeHash: hash, updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    async softDelete(id: string): Promise<void> {
      await db
        .update(users)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    async touchLastLogin(id: string): Promise<void> {
      await db
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, id));
    },
  };
}

export function refreshTokensRepo(db: Database) {
  return {
    async create(data: NewRefreshToken): Promise<RefreshToken> {
      const [row] = await db.insert(refreshTokens).values(data).returning();
      return row!;
    },

    async findActiveByHash(tokenHash: string): Promise<RefreshToken | null> {
      const [row] = await db
        .select()
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.tokenHash, tokenHash),
            isNull(refreshTokens.revokedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async rotate(
      oldHash: string,
      newHash: string,
      newExpiresAt: Date,
      graceMs = 0,
    ): Promise<RotateResult> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, oldHash))
          .for("update")
          .limit(1);

        if (!row) return { status: "not_found" as const };

        const now = new Date();

        if (row.revokedAt) {
          if (
            graceMs > 0 &&
            row.rotatedAt &&
            now.getTime() - row.rotatedAt.getTime() <= graceMs &&
            row.expiresAt > now
          ) {
            const [alive] = await tx
              .select({ id: refreshTokens.id })
              .from(refreshTokens)
              .where(
                and(
                  eq(refreshTokens.familyId, row.familyId),
                  isNull(refreshTokens.revokedAt),
                  gt(refreshTokens.expiresAt, now),
                ),
              )
              .limit(1);
            if (alive) {
              const [created] = await tx
                .insert(refreshTokens)
                .values({
                  userId: row.userId,
                  tokenHash: newHash,
                  familyId: row.familyId,
                  expiresAt: newExpiresAt,
                })
                .returning();
              return {
                status: "ok" as const,
                newTokenId: created!.id,
                userId: row.userId,
                familyId: row.familyId,
                withinGrace: true,
              };
            }
          }

          await tx
            .update(refreshTokens)
            .set({ revokedAt: now })
            .where(
              and(
                eq(refreshTokens.familyId, row.familyId),
                isNull(refreshTokens.revokedAt),
              ),
            );
          return { status: "reuse_detected" as const, familyId: row.familyId };
        }

        if (row.expiresAt < now) {
          return { status: "expired" as const };
        }

        await tx
          .update(refreshTokens)
          .set({ revokedAt: now, rotatedAt: now })
          .where(eq(refreshTokens.id, row.id));

        const [created] = await tx
          .insert(refreshTokens)
          .values({
            userId: row.userId,
            tokenHash: newHash,
            familyId: row.familyId,
            expiresAt: newExpiresAt,
          })
          .returning();

        return {
          status: "ok" as const,
          newTokenId: created!.id,
          userId: row.userId,
          familyId: row.familyId,
          withinGrace: false,
        };
      });
    },

    async revoke(id: string): Promise<void> {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.id, id));
    },

    async revokeFamily(familyId: string): Promise<void> {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(refreshTokens.familyId, familyId),
            isNull(refreshTokens.revokedAt),
          ),
        );
    },

    /** Apaga tokens que expiraram antes de `olderThan` (revogados ou não). */
    async purgeExpired(olderThan: Date): Promise<number> {
      const rows = await db
        .delete(refreshTokens)
        .where(lt(refreshTokens.expiresAt, olderThan))
        .returning({ id: refreshTokens.id });
      return rows.length;
    },

    async revokeAllForUser(userId: string): Promise<void> {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(refreshTokens.userId, userId),
            isNull(refreshTokens.revokedAt),
          ),
        );
    },
  };
}
