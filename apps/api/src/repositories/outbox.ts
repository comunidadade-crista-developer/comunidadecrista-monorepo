import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { idempotencyKeys, outbox } from "../db/schema.js";
import type {
  IdempotencyKey,
  NewOutboxEvent,
  OutboxEvent,
} from "../db/schema.js";

type OutboxRow = {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: OutboxEvent["status"];
  attempts: number;
  next_attempt_at: string;
  created_at: string;
  processed_at: string | null;
};

function toOutboxEvent(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: new Date(row.next_attempt_at),
    createdAt: new Date(row.created_at),
    processedAt: row.processed_at ? new Date(row.processed_at) : null,
  };
}

export function outboxRepo(db: Database) {
  return {
    async enqueue(data: NewOutboxEvent): Promise<OutboxEvent> {
      const [row] = await db.insert(outbox).values(data).returning();
      return row!;
    },

    /**
     * Reserva atómica. Os eventos reservados ficam invisíveis durante
     * `visibilityTimeoutS` (next_attempt_at é empurrado para o futuro): se o
     * worker morrer a meio, o evento volta a ser reclamável depois desse prazo
     * — e, antes dele, nenhum outro worker o apanha.
     */
    async claimBatch(
      limit = 20,
      visibilityTimeoutS = 300,
    ): Promise<OutboxEvent[]> {
      const rows = await db.execute<OutboxRow>(sql`
        UPDATE outbox
        SET status = 'processing',
            attempts = attempts + 1,
            next_attempt_at = now() + make_interval(secs => ${visibilityTimeoutS}::double precision)
        WHERE id IN (
          SELECT id FROM outbox
          WHERE status IN ('pending', 'processing')
            AND next_attempt_at <= now()
          ORDER BY next_attempt_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `);
      return rows.rows.map(toOutboxEvent);
    },

    async markDone(id: string): Promise<void> {
      await db
        .update(outbox)
        .set({ status: "done", processedAt: new Date() })
        .where(eq(outbox.id, id));
    },

    /** Apaga eventos concluídos há mais de `olderThan`. 'failed' fica. */
    async purgeDone(olderThan: Date): Promise<number> {
      const rows = await db
        .delete(outbox)
        .where(
          and(eq(outbox.status, "done"), lt(outbox.processedAt, olderThan)),
        )
        .returning({ id: outbox.id });
      return rows.length;
    },

    async markFailed(
      id: string,
      attempts: number,
      delayMs: number,
    ): Promise<void> {
      const next = new Date(Date.now() + delayMs);
      await db
        .update(outbox)
        .set({
          status: attempts >= 6 ? "failed" : "pending",
          nextAttemptAt: next,
        })
        .where(eq(outbox.id, id));
    },
  };
}

export function idempotencyKeysRepo(db: Database) {
  return {
    /** Só devolve chaves do próprio utilizador e ainda não expiradas. */
    async get(userId: string, key: string): Promise<IdempotencyKey | null> {
      const [row] = await db
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.userId, userId),
            eq(idempotencyKeys.key, key),
            gt(idempotencyKeys.expiresAt, new Date()),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async set(
      key: string,
      userId: string,
      operation: string,
      response: Record<string, unknown>,
      ttlMs = 7 * 24 * 60 * 60 * 1000,
    ): Promise<void> {
      const expiresAt = new Date(Date.now() + ttlMs);
      await db
        .insert(idempotencyKeys)
        .values({ key, userId, operation, response, expiresAt })
        .onConflictDoNothing();
    },

    async purgeExpired(now = new Date()): Promise<number> {
      const rows = await db
        .delete(idempotencyKeys)
        .where(lt(idempotencyKeys.expiresAt, now))
        .returning({ key: idempotencyKeys.key });
      return rows.length;
    },
  };
}
