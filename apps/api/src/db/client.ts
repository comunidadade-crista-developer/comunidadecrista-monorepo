import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export interface DbLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface DbOptions {
  poolMax?: number;
  queryTimeoutMs?: number;
  /** Aparece em `pg_stat_activity`; ajuda a distinguir a API das migrações. */
  applicationName?: string;
  log?: DbLogger;
}

export function createDb(connectionString: string, options: DbOptions = {}) {
  const { poolMax = 10, queryTimeoutMs = 0, applicationName, log } = options;
  const pool = new Pool({
    connectionString,
    max: poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
    ...(queryTimeoutMs > 0 ? { query_timeout: queryTimeoutMs } : {}),
    ...(applicationName ? { application_name: applicationName } : {}),
  });

  pool.on("error", (err: unknown) => {
    log?.warn(
      {
        errorName: err instanceof Error ? err.name : typeof err,
        errorCode:
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          typeof (err as { code: unknown }).code === "string"
            ? (err as { code: string }).code
            : undefined,
      },
      "postgres idle client error",
    );
  });

  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Database = ReturnType<typeof createDb>["db"];

export type DbTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export type Executor = Database | DbTransaction;
