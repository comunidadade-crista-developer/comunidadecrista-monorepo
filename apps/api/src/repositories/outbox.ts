import { and, eq, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { idempotencyKeys, outbox } from '../db/schema.js';
import type { IdempotencyKey, NewOutboxEvent, OutboxEvent } from '../db/schema.js';

export function outboxRepo(db: Database) {
  return {
    async enqueue(data: NewOutboxEvent): Promise<OutboxEvent> {
      const [row] = await db.insert(outbox).values(data).returning();
      return row!;
    },

    async claimBatch(limit = 20): Promise<OutboxEvent[]> {
      // Reserva atómica: marca como processing e devolve
      const rows = await db.execute<OutboxEvent>(sql`
        UPDATE outbox
        SET status = 'processing', attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM outbox
          WHERE (status = 'pending' AND next_attempt_at <= now())
             OR (status = 'processing' AND next_attempt_at < now() - interval '5 minutes')
          ORDER BY next_attempt_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `);
      return rows.rows;
    },

    async markDone(id: string): Promise<void> {
      await db
        .update(outbox)
        .set({ status: 'done', processedAt: new Date() })
        .where(eq(outbox.id, id));
    },

    async markFailed(id: string, attempts: number, delayMs: number): Promise<void> {
      const next = new Date(Date.now() + delayMs);
      await db
        .update(outbox)
        .set({
          status: attempts >= 6 ? 'failed' : 'pending',
          nextAttemptAt: next,
        })
        .where(eq(outbox.id, id));
    },
  };
}

export function idempotencyKeysRepo(db: Database) {
  return {
    async get(key: string): Promise<IdempotencyKey | null> {
      const [row] = await db
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, key))
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
  };
}