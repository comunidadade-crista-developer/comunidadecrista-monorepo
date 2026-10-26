import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/env.js";
import { buildServer } from "../../src/server.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makeUserWithPassword } from "../helpers/factories.js";

const env = loadEnv({
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  APP_VERSION: "test",
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe("timing: login com utilizador inexistente ≈ utilizador existente", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    await getTestDb();
    app = await buildServer({ env });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  it("diferença de medianas < 5x (mitigação de enumeração por tempo)", async () => {
    await makeUserWithPassword({ username: "existente" });

    // Warm-up (primeira sentinela é gerada aqui)
    for (let i = 0; i < 3; i++) {
      await request(app.server)
        .post("/auth/login")
        .send({ username: "existente", password: "errada" });
      await request(app.server)
        .post("/auth/login")
        .send({ username: "inexistente", password: "errada" });
    }

    const measure = async (username: string): Promise<number[]> => {
      const out: number[] = [];
      for (let i = 0; i < 10; i++) {
        const t0 = performance.now();
        await request(app.server)
          .post("/auth/login")
          .send({ username, password: "errada" });
        out.push(performance.now() - t0);
      }
      return out;
    };

    const existing = await measure("existente");
    const missing = await measure("inexistente");

    const medExisting = median(existing);
    const medMissing = median(missing);
    const ratio =
      Math.max(medExisting, medMissing) /
      Math.max(Math.min(medExisting, medMissing), 1);

    // Com C2 corrigido, ratio ≈ 1.0–1.5. Com o bug antigo, ratio >> 20.
    expect(ratio).toBeLessThan(5);
  });
});
