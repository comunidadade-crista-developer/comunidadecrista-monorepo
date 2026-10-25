import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { refreshTokens, users } from '../db/schema.js';
import type { NewRefreshToken, NewUser, RefreshToken, User } from '../db/schema.js';

export function usersRepo(db: Database) {
  return {
    async findById(id: string): Promise<User | null> {
      const [row] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, id), isNull(users.deletedAt)))
        .limit(1);
      return row ?? null;
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

    async softDelete(id: string): Promise<void> {
      await db
        .update(users)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    async touchLastLogin(id: string): Promise<void> {
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
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
        .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
        .limit(1);
      return row ?? null;
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
        .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
    },
  };
}