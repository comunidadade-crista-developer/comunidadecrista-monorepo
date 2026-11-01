import { Redis } from "ioredis";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { loadEnv } from "../../src/env.js";
import { cardsRepo } from "../../src/repositories/cards.js";
import { buildServer } from "../../src/server.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";

type App = Awaited<ReturnType<typeof buildServer>>;

const baseEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  APP_VERSION: "test",
} as const;

let redis: Redis;

async function flushKeys(): Promise<void> {
  for (const pattern of ["cc:v1:cards:*", "rl:cards*"]) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
}

async function seed(count: number): Promise<void> {
  const repo = cardsRepo(await getTestDb());
  for (let i = 1; i <= count; i++) {
    await repo.create({
      slug: `card-${String(i).padStart(3, "0")}`,
      title: `Card ${i}`,
      gospelReference: "Mateus 2",
      summary: "Resumo",
      otReferences: ["Isaías 7:14"],
      ntReferences: ["Mateus 2:1-12"],
      orderIndex: i,
    });
  }
}

beforeAll(async () => {
  await getTestDb();
  redis = new Redis(process.env.REDIS_URL!);
});

afterAll(async () => {
  await redis.quit();
  await closeTestDb();
});

beforeEach(async () => {
  await truncateAll();
  await flushKeys();
});

describe("GET /gospel-cards", () => {
  let app: App;
  // App nova por teste: a cache L1 vive no processo e não pode passar de um teste para o outro.
  beforeEach(async () => {
    app = await buildServer({ env: loadEnv(baseEnv) });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it("lista vazia → 200 sem cabeçalhos de cache (seed por correr)", async () => {
    const res = await request(app.server).get("/gospel-cards");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cards: [] });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["etag"]).toBeUndefined();
  });

  it("devolve os cards ordenados por orderIndex, com cache pública e ETag", async () => {
    await seed(3);
    const res = await request(app.server).get("/gospel-cards");
    expect(res.status).toBe(200);
    expect(
      res.body.cards.map((c: { orderIndex: number }) => c.orderIndex),
    ).toEqual([1, 2, 3]);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=300, stale-while-revalidate=86400",
    );
    expect(res.headers["etag"]).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
  });

  it("só expõe os campos públicos (sem id nem createdAt)", async () => {
    await seed(1);
    const res = await request(app.server).get("/gospel-cards");
    expect(Object.keys(res.body.cards[0]).sort()).toEqual(
      [
        "gospelReference",
        "ntReferences",
        "orderIndex",
        "otReferences",
        "slug",
        "summary",
        "title",
      ].sort(),
    );
  });

  it("guarda a lista na cache Redis versionada", async () => {
    await seed(2);
    await request(app.server).get("/gospel-cards");
    expect(await redis.exists("cc:v1:cards:v0:list")).toBe(1);
  });

  it("If-None-Match igual → 304 sem corpo; diferente → 200", async () => {
    await seed(2);
    const first = await request(app.server).get("/gospel-cards");
    const etag = first.headers["etag"] as string;

    const same = await request(app.server)
      .get("/gospel-cards")
      .set("If-None-Match", etag);
    expect(same.status).toBe(304);
    expect(same.text).toBe("");
    expect(same.headers["etag"]).toBe(etag);
    expect(same.headers["cache-control"]).toContain("public");

    const strong = await request(app.server)
      .get("/gospel-cards")
      .set("If-None-Match", `"x", ${etag.replace(/^W\//, "")}`);
    expect(strong.status).toBe(304);

    const other = await request(app.server)
      .get("/gospel-cards")
      .set("If-None-Match", 'W/"outro"');
    expect(other.status).toBe(200);
    expect(other.body.cards).toHaveLength(2);
  });
});

describe("GET /gospel-cards/:slug", () => {
  let app: App;
  beforeEach(async () => {
    app = await buildServer({ env: loadEnv(baseEnv) });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it("devolve o card, com cache pública e ETag", async () => {
    await seed(2);
    const res = await request(app.server).get("/gospel-cards/card-002");
    expect(res.status).toBe(200);
    expect(res.body.card.slug).toBe("card-002");
    expect(res.body.card.otReferences).toEqual(["Isaías 7:14"]);
    expect(res.headers["cache-control"]).toContain("public");
    expect(res.headers["etag"]).toBeDefined();

    const again = await request(app.server)
      .get("/gospel-cards/card-002")
      .set("If-None-Match", res.headers["etag"] as string);
    expect(again.status).toBe(304);
  });

  it("404 para slug inexistente, sempre no-store", async () => {
    const res = await request(app.server).get("/gospel-cards/nao-existe");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  // (Um segmento com mais de 100 caracteres nem chega à rota: o Fastify responde 404.)
  it.each(["slug%20com%20espacos", "MAIUSCULAS", "a_b"])(
    "400 validation_error para slug inválido (%s), no-store",
    async (slug) => {
      const res = await request(app.server).get(`/gospel-cards/${slug}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("validation_error");
      expect(res.headers["cache-control"]).toBe("no-store");
    },
  );
});

describe("GET /gospel-cards — rate limit", () => {
  let app: App;
  beforeEach(async () => {
    app = await buildServer({
      env: loadEnv({ ...baseEnv, RATE_LIMIT_CARDS_MAX: 3 }),
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it("acima do limite → 429 com Retry-After, formato de erro único e no-store", async () => {
    await seed(1);
    for (let i = 0; i < 3; i++) {
      const ok = await request(app.server).get("/gospel-cards");
      expect(ok.status).toBe(200);
    }
    const blocked = await request(app.server).get("/gospel-cards");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "rate_limited" });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.headers["cache-control"]).toBe("no-store");

    const item = await request(app.server).get("/gospel-cards/card-001");
    expect(item.status).toBe(429); // o balde é partilhado entre lista e detalhe
  });
});
