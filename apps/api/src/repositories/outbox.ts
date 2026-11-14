import { and, eq, gt, lt, lte, sql } from "drizzle-orm";
import type { Executor } from "../db/client.js";
import { idempotencyKeys, outbox } from "../db/schema.js";
import type {
  IdempotencyKey,
  NewOutboxEvent,
  OutboxEvent,
} from "../db/schema.js";

/** Quanto tempo uma chave de idempotência vale (o cliente pode repetir durante este prazo). */
export const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

export function outboxRepo(db: Executor) {
  return {
    async enqueue(data: NewOutboxEvent): Promise<OutboxEvent> {
      const [row] = await db.insert(outbox).values(data).returning();
      return row!;
    },

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

export function idempotencyKeysRepo(db: Executor) {
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

    /**
     * Reserva a chave ANTES de fazer o trabalho (dentro da mesma transacção que o faz).
     * `reserved`: a chave é nossa. `exists`: já havia uma chave viva (de um pedido anterior
     * ou de um pedido concorrente que entretanto fez commit — o INSERT espera por ele).
     * Uma chave expirada é reaproveitada.
     */
    async reserve(args: {
      userId: string;
      key: string;
      operation: string;
      requestHash: string;
      ttlMs?: number;
    }): Promise<"reserved" | "exists"> {
      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + (args.ttlMs ?? IDEMPOTENCY_TTL_MS),
      );
      const rows = await db
        .insert(idempotencyKeys)
        .values({
          key: args.key,
          userId: args.userId,
          operation: args.operation,
          requestHash: args.requestHash,
          response: {},
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [idempotencyKeys.userId, idempotencyKeys.key],
          set: {
            operation: args.operation,
            requestHash: args.requestHash,
            response: {},
            createdAt: now,
            expiresAt,
          },
          setWhere: lte(idempotencyKeys.expiresAt, now),
        })
        .returning({ key: idempotencyKeys.key });
      return rows.length > 0 ? "reserved" : "exists";
    },

    /** Guarda a resposta na chave reservada (na mesma transacção que a reservou). */
    async complete(
      userId: string,
      key: string,
      response: Record<string, unknown>,
    ): Promise<void> {
      await db
        .update(idempotencyKeys)
        .set({ response })
        .where(
          and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)),
        );
    },

    async set(
      key: string,
      userId: string,
      operation: string,
      response: Record<string, unknown>,
      ttlMs = IDEMPOTENCY_TTL_MS,
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
