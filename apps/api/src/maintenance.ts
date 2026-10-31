import type { Database } from "./db/client.js";
import type { Env } from "./env.js";
import { accountDeletionRepo } from "./repositories/account-deletion.js";
import { idempotencyKeysRepo, outboxRepo } from "./repositories/outbox.js";
import { refreshTokensRepo } from "./repositories/users.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const OUTBOX_DONE_RETENTION_DAYS = 7;
const STARTUP_DELAY_MS = 30_000;

export interface MaintenanceSummary {
  idempotencyKeys: number;
  outboxDone: number;
  refreshTokens: number;
  accounts: number;
  postsDeleted: number;
  failedAccounts: number;
}

export interface MaintenanceLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export async function runMaintenance(
  db: Database,
  opts: { now?: Date; accountGraceDays: number; accountBatch?: number },
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

  return {
    idempotencyKeys: idempotency,
    outboxDone,
    refreshTokens: tokens,
    accounts: accounts.accounts,
    postsDeleted: accounts.postsDeleted,
    failedAccounts: accounts.failed,
  };
}

export function startMaintenance(args: {
  db: Database;
  env: Pick<
    Env,
    "ACCOUNT_DELETION_GRACE_DAYS" | "MAINTENANCE_INTERVAL_MINUTES"
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
