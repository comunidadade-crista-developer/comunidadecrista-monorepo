import { and, count, eq, isNull, ne } from "drizzle-orm";
import type { Database, DbTransaction } from "../db/client.js";
import { refreshTokens, users } from "../db/schema.js";
import type { User } from "../db/schema.js";
import { lockAdminRoster } from "../repositories/admin-roster.js";
import { moderationLogRepo } from "../repositories/reports.js";

/**
 * Promoção e despromoção de administradores (ADR-015). Só são chamadas pelos scripts
 * `admin:promote` e `admin:demote`: nenhuma rota HTTP eleva privilégio.
 */

export type RoleChangeOutcome =
  "promoted" | "already_admin" | "demoted" | "already_user";

export type RoleChangeError =
  /** O utilizador não existe. */
  | { code: "not_found" }
  /** Conta apagada ou em apagamento: não se promove (nem se mexe nela). */
  | { code: "inactive" }
  /** Despromover deixaria a plataforma sem nenhum admin activo. */
  | { code: "last_admin" };

export type RoleChangeResult =
  | { ok: true; data: { outcome: RoleChangeOutcome; userId: string } }
  | { ok: false; error: RoleChangeError };

const fail = (error: RoleChangeError): RoleChangeResult => ({
  ok: false,
  error,
});

function isActive(u: Pick<User, "deletedAt" | "deletionRequestedAt">): boolean {
  return !u.deletedAt && !u.deletionRequestedAt;
}

/** Linha do utilizador bloqueada até ao fim da transacção (nome insensível a maiúsculas). */
async function lockUserByUsername(
  tx: DbTransaction,
  username: string,
): Promise<User | null> {
  const [row] = await tx
    .select()
    .from(users)
    .where(and(eq(users.username, username), isNull(users.deletedAt)))
    .for("update")
    .limit(1);
  return row ?? null;
}

/** Um papel novo invalida as sessões: o novo login traz o papel certo. */
async function revokeSessions(tx: DbTransaction, userId: string) {
  await tx
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)),
    );
}

export async function promoteAdmin(
  db: Database,
  username: string,
): Promise<RoleChangeResult> {
  return db.transaction(async (tx) => {
    const user = await lockUserByUsername(tx, username);
    if (!user) return fail({ code: "not_found" });
    if (!isActive(user)) return fail({ code: "inactive" });
    if (user.role === "admin") {
      return {
        ok: true,
        data: { outcome: "already_admin", userId: user.id },
      } as const;
    }

    await tx.update(users).set({ role: "admin" }).where(eq(users.id, user.id));
    await revokeSessions(tx, user.id);
    await moderationLogRepo(tx).create({
      action: "admin.promoted",
      moderatorId: null,
      targetUserId: user.id,
      postId: null,
      reason: null,
    });
    return {
      ok: true,
      data: { outcome: "promoted", userId: user.id },
    } as const;
  });
}

export async function demoteAdmin(
  db: Database,
  username: string,
): Promise<RoleChangeResult> {
  return db.transaction(async (tx) => {
    const user = await lockUserByUsername(tx, username);
    if (!user) return fail({ code: "not_found" });
    if (user.role !== "admin") {
      return {
        ok: true,
        data: { outcome: "already_user", userId: user.id },
      } as const;
    }

    // Ordem de bloqueios: linha do utilizador, depois o bloqueio do conjunto de admins (igual
    // ao do apagamento de conta, ver `lockAdminRoster`). Dois `demote` em simultâneo, ou um
    // `demote` e um apagamento, ficam em série e o segundo vê o resultado do primeiro.
    await lockAdminRoster(tx);
    if (isActive(user)) {
      const [others] = await tx
        .select({ c: count() })
        .from(users)
        .where(
          and(
            eq(users.role, "admin"),
            ne(users.id, user.id),
            isNull(users.deletionRequestedAt),
            isNull(users.deletedAt),
          ),
        );
      if (Number(others?.c ?? 0) === 0) return fail({ code: "last_admin" });
    }

    await tx.update(users).set({ role: "user" }).where(eq(users.id, user.id));
    await revokeSessions(tx, user.id);
    await moderationLogRepo(tx).create({
      action: "admin.demoted",
      moderatorId: null,
      targetUserId: user.id,
      postId: null,
      reason: null,
    });
    return {
      ok: true,
      data: { outcome: "demoted", userId: user.id },
    } as const;
  });
}
