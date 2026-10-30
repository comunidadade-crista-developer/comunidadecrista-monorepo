import "dotenv/config";
import { describe, expect, it } from "vitest";
import { createDb } from "../../src/db/client.js";
import { loadEnv } from "../../src/env.js";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL não definido (ver apps/api/.env.example).");
}

describe("createDb — pool", () => {
  it("erro numa ligação ociosa não derruba o processo e não regista a mensagem", async () => {
    const logged: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const { pool } = createDb(url, {
      log: { warn: (obj, msg) => logged.push({ obj, msg }) },
    });
    try {
      // Sem listener de 'error', o emit lançaria e o processo cairia.
      expect(() =>
        pool.emit(
          "error",
          Object.assign(new Error("Key (username)=(SEGREDO)"), {
            code: "57P01",
          }),
          {} as never,
        ),
      ).not.toThrow();
    } finally {
      await pool.end();
    }
    expect(logged).toHaveLength(1);
    expect(logged[0]!.msg).toBe("postgres idle client error");
    expect(logged[0]!.obj.errorCode).toBe("57P01");
    expect(JSON.stringify(logged)).not.toContain("SEGREDO");
  });

  it("sem logger também não rebenta", async () => {
    const { pool } = createDb(url);
    try {
      expect(() =>
        pool.emit("error", new Error("x"), {} as never),
      ).not.toThrow();
    } finally {
      await pool.end();
    }
  });

  it("applicationName chega ao Postgres", async () => {
    const { pool } = createDb(url, { applicationName: "comunidade-test" });
    try {
      const res = await pool.query("SHOW application_name");
      expect(res.rows[0].application_name).toBe("comunidade-test");
    } finally {
      await pool.end();
    }
  });

  it("queryTimeoutMs limita a espera do cliente", async () => {
    const { pool } = createDb(url, { queryTimeoutMs: 100 });
    try {
      await expect(pool.query("SELECT pg_sleep(1)")).rejects.toThrow(
        /timeout/i,
      );
    } finally {
      await pool.end();
    }
  });

  it("por omissão não há limite de query (migrações, seed)", async () => {
    const { pool } = createDb(url);
    try {
      const res = await pool.query("SELECT pg_sleep(0.2), 1 AS ok");
      expect(res.rows[0].ok).toBe(1);
    } finally {
      await pool.end();
    }
  });
});

describe("env — pool", () => {
  const CLEAN = {
    EDGE_MODE: "none",
    CF_ORIGIN_SECRET: undefined,
    CF_ORIGIN_SECRET_PREVIOUS: undefined,
    IP_HASH_SECRET: undefined,
  } as const;

  it("valores por omissão", () => {
    const env = loadEnv({
      ...CLEAN,
      DB_POOL_MAX: undefined,
      DB_QUERY_TIMEOUT_MS: undefined,
    });
    expect(env.DB_POOL_MAX).toBe(10);
    expect(env.DB_QUERY_TIMEOUT_MS).toBe(15_000);
  });

  it("string de process.env é convertida; 0 desactiva o limite", () => {
    const env = loadEnv({
      ...CLEAN,
      DB_POOL_MAX: "20" as unknown as number,
      DB_QUERY_TIMEOUT_MS: "0" as unknown as number,
    });
    expect(env.DB_POOL_MAX).toBe(20);
    expect(env.DB_QUERY_TIMEOUT_MS).toBe(0);
  });
});
