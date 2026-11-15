import type { Database } from "./db/client.js";
import type { Env } from "./env.js";
import { accountDeletionRepo } from "./repositories/account-deletion.js";
import { idempotencyKeysRepo, outboxRepo } from "./repositories/outbox.js";
import { postsRepo } from "./repositories/posts.js";
import { refreshTokensRepo } from "./repositories/users.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const OUTBOX_DONE_RETENTION_DAYS = 7;
const STARTUP_DELAY_MS = 30_000;
const DEFAULT_POSTS_DELETED_RETENTION_DAYS = 30;
/** Lotes de purga de posts apagados por execução: limita o trabalho de um tick. */
const POSTS_PURGE_BATCH = 500;
const POSTS_PURGE_MAX_BATCHES = 20;

export interface MaintenanceSummary {
  idempotencyKeys: number;
  outboxDone: number;
  refreshTokens: number;
  accounts: number;
  postsDeleted: number;
  failedAccounts: number;
  /** Partilhas apagadas pelo autor cuja retenção terminou (eliminadas de vez). */
  softDeletedPosts: number;
}

export interface MaintenanceLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export async function runMaintenance(
  db: Database,
  opts: {
    now?: Date;
    accountGraceDays: number;
    accountBatch?: number;
    postsDeletedRetentionDays?: number;
  },
): Promise<MaintenanceSummary> {
  const now = opts.now ?? new Date();

  const idempotency = await idempotencyKeysRepo(db).purgeExpired(now);
  const outboxDone = await outboxRepo(db).purgeDone(
    new Date(now.getTime() - OUTBOX_DONE_RETENTION_DAYS * DAY_MS),
  );
  const tokens = await refreshTokensRepo(db).purgeExpired(
    new Date(now.getTime() - DAY_MS),
  );
  const accounts = await accountDeletionRepo(db).purgeDue({
    now,
    graceDays: opts.accountGraceDays,
    ...(opts.accountBatch !== undefined ? { batch: opts.accountBatch } : {}),
  });

  const retentionDays =
    opts.postsDeletedRetentionDays ?? DEFAULT_POSTS_DELETED_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  let softDeletedPosts = 0;
  for (let i = 0; i < POSTS_PURGE_MAX_BATCHES; i++) {
    const removed = await postsRepo(db).purgeDeleted(cutoff, POSTS_PURGE_BATCH);
    softDeletedPosts += removed;
    if (removed < POSTS_PURGE_BATCH) break;
  }

  return {
    idempotencyKeys: idempotency,
    outboxDone,
    refreshTokens: tokens,
    accounts: accounts.accounts,
    postsDeleted: accounts.postsDeleted,
    failedAccounts: accounts.failed,
    softDeletedPosts,
  };
}

export function startMaintenance(args: {
  db: Database;
  env: Pick<
    Env,
    | "ACCOUNT_DELETION_GRACE_DAYS"
    | "MAINTENANCE_INTERVAL_MINUTES"
    | "POSTS_DELETED_RETENTION_DAYS"
  >;
  log: MaintenanceLogger;
}): () => void {
  const { db, env, log } = args;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runMaintenance(db, {
        accountGraceDays: env.ACCOUNT_DELETION_GRACE_DAYS,
        postsDeletedRetentionDays: env.POSTS_DELETED_RETENTION_DAYS,
      });
      log.info({ ...summary }, "maintenance done");
    } catch (err) {
      // Sem a mensagem: pode trazer dados.
      log.warn(
        { errorName: err instanceof Error ? err.name : typeof err },
        "maintenance failed",
      );
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void tick(), STARTUP_DELAY_MS);
  const timer = setInterval(
    () => void tick(),
    env.MAINTENANCE_INTERVAL_MINUTES * 60_000,
  );
  first.unref();
  timer.unref();

  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
