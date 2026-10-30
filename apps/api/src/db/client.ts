import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

/** Subconjunto do logger do Fastify: nunca recebe a mensagem do erro (pode ter dados). */
export interface DbLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface DbOptions {
  /** Ligações máximas do pool. */
  poolMax?: number;
  /**
   * Tempo máximo (ms) que o cliente espera por uma query. 0 = sem limite (migrações, seed).
   * É uma válvula de segurança do lado do cliente: não cancela a query no servidor. O limite
   * a sério (`statement_timeout`, `idle_in_transaction_session_timeout`) define-se no
   * role da base de dados, porque os poolers (PgBouncer/Neon) recusam esses parâmetros
   * no arranque da ligação — ver o runbook.
   */
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

  // Sem este handler, um erro numa ligação ociosa (reinício do Postgres, failover, ligação
  // cortada pela rede) é um evento 'error' sem listener e derruba o processo. O pool já
  // descarta a ligação avariada; aqui só se regista, sem a mensagem (pode ter dados do
  // utilizador).
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
