import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { users } from "../../src/db/schema.js";
import { loadEnv } from "../../src/env.js";
import { buildServer } from "../../src/server.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";

const env = loadEnv({
  NODE_ENV: "test",
  LOG_LEVEL: "fatal",
  APP_VERSION: "test",
});

type App = Awaited<ReturnType<typeof buildServer>>;

function registerBody(username: string) {
  return {
    username,
    password: "uma-frase-passe-longa-42",
    passwordConfirmation: "uma-frase-passe-longa-42",
    securityQ1: "azul",
    securityQ2: "7",
    securityQ3: "igreja central",
  };
}

describe("POST /auth/register — nomes reservados", () => {
  let app: App;
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

  it.each(["admin", "Moderador", "4dm1n", "suporte-oficial", "removido"])(
    "recusa %s com 400 e não cria conta",
    async (name) => {
      const res = await request(app.server)
        .post("/auth/register")
        .send(registerBody(name));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("validation_error");
      expect(res.body.fields.username).toBe(
        "este nome de utilizador não está disponível",
      );
      const db = await getTestDb();
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.username, name));
      expect(rows).toHaveLength(0);
    },
  );

  it("aceita um nome normal", async () => {
    const res = await request(app.server)
      .post("/auth/register")
      .send(registerBody("ana_maria"));
    expect(res.status).toBe(201);
  });

  it("o login de uma conta antiga com nome reservado continua a funcionar", async () => {
    const { makeUserWithPassword } = await import("../helpers/factories.js");
    const { user, plainPassword } = await makeUserWithPassword({
      username: "admin",
    });
    const res = await request(app.server)
      .post("/auth/login")
      .send({ username: user.username, password: plainPassword });
    expect(res.status).toBe(200);
  });
});
