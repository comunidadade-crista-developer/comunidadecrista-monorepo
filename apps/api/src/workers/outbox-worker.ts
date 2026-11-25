import type { Database } from "../db/client.js";
import type { OutboxEvent } from "../db/schema.js";
import { safeErrorFields } from "../errors.js";
import { outboxRepo } from "../repositories/outbox.js";

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

export interface OutboxLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

const VISIBILITY_TIMEOUT_S = 60;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 5 * 60_000;

export interface OutboxBatchResult {
  claimed: number;
  done: number;
  failed: number;
}

export function backoffMs(attempts: number): number {
  return Math.min(
    BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0),
    BACKOFF_MAX_MS,
  );
}

/** Uma ronda: reserva até `batchSize` eventos e processa-os. Exportada para os testes. */
export async function processOutboxBatch(
  db: Database,
  opts: {
    batchSize: number;
    handlers?: Readonly<Record<string, OutboxHandler>>;
    log?: OutboxLogger;
  },
): Promise<OutboxBatchResult> {
  const repo = outboxRepo(db);
  const events = await repo.claimBatch(opts.batchSize, VISIBILITY_TIMEOUT_S);
  const result: OutboxBatchResult = {
    claimed: events.length,
    done: 0,
    failed: 0,
  };

  for (const event of events) {
    const handler = opts.handlers?.[event.eventType];
    try {
      if (handler) await handler(event);
      await repo.markDone(event.id);
      result.done += 1;
    } catch (err) {
      result.failed += 1;
      // Só tipo, nome e código do erro: a mensagem pode trazer dados do utilizador.
      opts.log?.warn(
        {
          eventType: event.eventType,
          attempts: event.attempts,
          ...safeErrorFields(err),
        },
        "outbox: handler failed",
      );
      await repo.markFailed(
        event.id,
        event.attempts,
        backoffMs(event.attempts),
      );
    }
  }
  return result;
}

export function startOutboxWorker(args: {
  db: Database;
  log: OutboxLogger;
  intervalMs: number;
  batchSize: number;
  handlers?: Readonly<Record<string, OutboxHandler>>;
}): () => Promise<void> {
  const { db, log, intervalMs, batchSize, handlers } = args;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> = Promise.resolve();

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      current = tick();
    }, delay);
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    let more = false;
    try {
      const r = await processOutboxBatch(db, {
        batchSize,
        log,
        ...(handlers ? { handlers } : {}),
      });
      // Ronda cheia: provavelmente há mais; continua sem esperar o intervalo.
      more = r.claimed >= batchSize;
    } catch (err) {
      // Nome, código (SQLSTATE, ETIMEDOUT...) e causa; nunca a mensagem (host, dados).
      log.warn(safeErrorFields(err), "outbox: worker round failed");
    }
    schedule(more ? 0 : intervalMs);
  };

  schedule(intervalMs);

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await current;
  };
}
