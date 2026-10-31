import { PASSWORD_MAX_LENGTH } from "@comunidade/shared";
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

type App = Awaited<ReturnType<typeof buildServer>>;

function register(app: App, overrides: Record<string, unknown> = {}) {
  const password =
    (overrides.password as string | undefined) ?? "Cavalo-azul-bateria-77";
  return request(app.server)
    .post("/auth/register")
    .send({
      username: "ruben-silva",
      password,
      passwordConfirmation: password,
      securityQ1: "Azul",
      securityQ2: "7",
      securityQ3: "Igreja",
      ...overrides,
    });
}

function login(app: App, username: string, password: string) {
  return request(app.server).post("/auth/login").send({ username, password });
}

describe("política de palavras-passe — rotas", () => {
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

  it("registo com palavra-passe comum → 400 validation_error em password", async () => {
    const res = await register(app, { password: "Password123!" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.fields.password).toBeTruthy();
  });

  it("registo com a palavra-passe a conter o username → 400", async () => {
    const res = await register(app, { password: "ruben-silva-2025-xyz" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(res.body.fields.password).toContain("nome de utilizador");
  });

  it("frase-passe longa (128) regista e depois entra", async () => {
    const password = "frase-longa-".padEnd(PASSWORD_MAX_LENGTH, "x");
    const reg = await register(app, { username: "maria-longa", password });
    expect(reg.status).toBe(201);
    const res = await login(app, "maria-longa", password);
    expect(res.status).toBe(200);
  });

  it("conta antiga com palavra-passe de 6 caracteres continua a entrar", async () => {
    const { user } = await makeUserWithPassword({
      username: "antigo",
      password: "abc123",
    });
    const res = await login(app, user.username, "abc123");
    expect(res.status).toBe(200);
  });

  it("login com palavra-passe acima do máximo → 400 (sem trabalho de Argon2)", async () => {
    const res = await login(app, "antigo", "x".repeat(PASSWORD_MAX_LENGTH + 1));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("reset com o username na palavra-passe → 400 e a sessão NÃO é consumida", async () => {
    const { user, recoveryCode } = await makeUserWithPassword({
      username: "ruben-silva",
    });
    const verify = await request(app.server)
      .post("/auth/recover/verify")
      .send({ mode: "code", username: user.username, code: recoveryCode });
    expect(verify.status).toBe(200);
    const recoverySession = verify.body.recoverySession as string;

    const bad = "ruben-silva-2025-xyz";
    const rejected = await request(app.server)
      .post("/auth/recover/reset")
      .send({
        recoverySession,
        newPassword: bad,
        newPasswordConfirmation: bad,
      });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("validation_error");
    expect(rejected.body.fields.newPassword).toContain("nome de utilizador");

    const good = "Cavalo-azul-bateria-77";
    const ok = await request(app.server).post("/auth/recover/reset").send({
      recoverySession,
      newPassword: good,
      newPasswordConfirmation: good,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("completed");
    expect((await login(app, user.username, good)).status).toBe(200);
  });

  it("reset com palavra-passe comum → 400 (schema)", async () => {
    const { user, recoveryCode } = await makeUserWithPassword({
      username: "outro-user",
    });
    const verify = await request(app.server)
      .post("/auth/recover/verify")
      .send({ mode: "code", username: user.username, code: recoveryCode });
    const res = await request(app.server).post("/auth/recover/reset").send({
      recoverySession: verify.body.recoverySession,
      newPassword: "password123",
      newPasswordConfirmation: "password123",
    });
    expect(res.status).toBe(400);
    expect(res.body.fields.newPassword).toBeTruthy();
  });
});
