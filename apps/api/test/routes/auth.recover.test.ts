import { sql } from "drizzle-orm";
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
type Answers = { q1: string; q2: string; q3: string };

async function verifyCode(
  app: App,
  username: string,
  code: string,
): Promise<string> {
  const v = await request(app.server)
    .post("/auth/recover/verify")
    .send({ mode: "code", username, code });
  expect(v.status).toBe(200);
  return v.body.recoverySession as string;
}

async function verifyQuestions(
  app: App,
  username: string,
  a: Answers,
): Promise<string> {
  const v = await request(app.server).post("/auth/recover/verify").send({
    mode: "questions",
    username,
    answer1: a.q1,
    answer2: a.q2,
    answer3: a.q3,
  });
  expect(v.status).toBe(200);
  return v.body.recoverySession as string;
}

function reset(app: App, recoverySession: string, newPassword: string) {
  return request(app.server)
    .post("/auth/recover/reset")
    .send({
      recoverySession,
      newPassword,
      newPasswordConfirmation: newPassword,
    });
}

function login(app: App, username: string, password: string) {
  return request(app.server).post("/auth/login").send({ username, password });
}

async function makePendingDue(userId: string): Promise<void> {
  const db = await getTestDb();
  await db.execute(
    sql`UPDATE pending_password_resets SET effective_at = now() - interval '1 minute' WHERE user_id = ${userId}`,
  );
}

describe("recover flow", () => {
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

  it("recover via código: verify → reset → login com nova password", async () => {
    const { user, recoveryCode } = await makeUserWithPassword({
      username: "recover1",
    });

    const v = await request(app.server).post("/auth/recover/verify").send({
      mode: "code",
      username: "recover1",
      code: recoveryCode,
    });
    expect(v.status).toBe(200);
    expect(v.body.recoverySession).toBeTruthy();

    const r = await request(app.server).post("/auth/recover/reset").send({
      recoverySession: v.body.recoverySession,
      newPassword: "novasenha99",
      newPasswordConfirmation: "novasenha99",
    });
    expect(r.status).toBe(200);
    expect(r.body.recoveryCode).toMatch(/^[A-Z2-7-]+$/);
    expect(r.body.recoveryCode).not.toBe(recoveryCode); // novo código

    // login com nova password
    const l = await request(app.server)
      .post("/auth/login")
      .send({ username: "recover1", password: "novasenha99" });
    expect(l.status).toBe(200);
    expect(l.body.user.id).toBe(user.id);
  });

  it("recover via perguntas: verify → reset", async () => {
    const { answers } = await makeUserWithPassword({ username: "recover2" });
    const v = await request(app.server).post("/auth/recover/verify").send({
      mode: "questions",
      username: "recover2",
      answer1: answers.q1,
      answer2: answers.q2,
      answer3: answers.q3,
    });
    expect(v.status).toBe(200);
    expect(v.body.recoverySession).toBeTruthy();
  });

  it("respostas normalizadas (case + espaços)", async () => {
    const { answers } = await makeUserWithPassword({ username: "recover3" });
    const v = await request(app.server)
      .post("/auth/recover/verify")
      .send({
        mode: "questions",
        username: "recover3",
        answer1: `  ${answers.q1.toUpperCase()}  `,
        answer2: answers.q2,
        answer3: `  ${answers.q3.toLowerCase()}  `,
      });
    expect(v.status).toBe(200);
  });

  it("código errado → 401", async () => {
    await makeUserWithPassword({ username: "recover4" });
    const v = await request(app.server).post("/auth/recover/verify").send({
      mode: "code",
      username: "recover4",
      code: "AAAA-BBBB-CCCC-DDDD",
    });
    expect(v.status).toBe(401);
    expect(v.body.error).toBe("invalid_recovery");
  });

  it("após reset, código antigo não funciona mais", async () => {
    const { recoveryCode } = await makeUserWithPassword({
      username: "recover5",
    });
    const v = await request(app.server).post("/auth/recover/verify").send({
      mode: "code",
      username: "recover5",
      code: recoveryCode,
    });
    await request(app.server).post("/auth/recover/reset").send({
      recoverySession: v.body.recoverySession,
      newPassword: "novasenha77",
      newPasswordConfirmation: "novasenha77",
    });
    const again = await request(app.server).post("/auth/recover/verify").send({
      mode: "code",
      username: "recover5",
      code: recoveryCode,
    });
    expect(again.status).toBe(401);
  });

  it("reset com sessão inválida → 401", async () => {
    const r = await request(app.server).post("/auth/recover/reset").send({
      recoverySession: "inventado",
      newPassword: "qualquer123",
      newPasswordConfirmation: "qualquer123",
    });
    expect(r.status).toBe(401);
  });
});

describe("recover flow — sessão de uso único e transacção", () => {
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

  it("a sessão de recuperação só pode ser usada uma vez", async () => {
    const { recoveryCode } = await makeUserWithPassword({ username: "once1" });
    const session = await verifyCode(app, "once1", recoveryCode);

    const first = await reset(app, session, "primeira123");
    expect(first.status).toBe(200);
    const replay = await reset(app, session, "segunda456");
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("invalid_recovery_session");

    expect((await login(app, "once1", "primeira123")).status).toBe(200);
    expect((await login(app, "once1", "segunda456")).status).toBe(401);
  });

  it("reset por código revoga as sessões existentes", async () => {
    const { plainPassword, recoveryCode } = await makeUserWithPassword({
      username: "revoke1",
    });
    const l = await login(app, "revoke1", plainPassword);
    const oldRefresh = l.body.refreshToken as string;

    const session = await verifyCode(app, "revoke1", recoveryCode);
    expect((await reset(app, session, "novasenha11")).status).toBe(200);

    const r = await request(app.server)
      .post("/auth/refresh")
      .send({ refreshToken: oldRefresh });
    expect(r.status).toBe(401);
  });

  it("reset por código devolve status completed", async () => {
    const { recoveryCode } = await makeUserWithPassword({
      username: "status1",
    });
    const session = await verifyCode(app, "status1", recoveryCode);
    const r = await reset(app, session, "novasenha22");
    expect(r.body.status).toBe("completed");
    expect(r.body.recoveryCode).toBeTruthy();
  });
});

describe("recover flow — perguntas de segurança com atraso", () => {
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

  it("reset por perguntas fica pendente: sem código novo e sem mudar já a palavra-passe", async () => {
    const { answers } = await makeUserWithPassword({ username: "delay1" });
    const session = await verifyQuestions(app, "delay1", answers);

    const r = await reset(app, session, "novasenha33");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("pending");
    expect(r.body.recoveryCode).toBeUndefined();
    const hours =
      (new Date(r.body.effectiveAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);
  });

  it("a sessão de perguntas também é de uso único", async () => {
    const { answers } = await makeUserWithPassword({ username: "delay2" });
    const session = await verifyQuestions(app, "delay2", answers);
    expect((await reset(app, session, "novasenha44")).status).toBe(200);
    expect((await reset(app, session, "outrasenha55")).status).toBe(401);
  });

  it("antes do prazo a nova palavra-passe não entra (recovery_pending)", async () => {
    const { answers } = await makeUserWithPassword({ username: "delay3" });
    const session = await verifyQuestions(app, "delay3", answers);
    await reset(app, session, "novasenha66");

    const l = await login(app, "delay3", "novasenha66");
    expect(l.status).toBe(401);
    expect(l.body.error).toBe("recovery_pending");
    expect(l.body.effectiveAt).toBeTruthy();
  });

  it("login com a palavra-passe actual cancela o pedido e avisa o dono", async () => {
    const { answers, plainPassword } = await makeUserWithPassword({
      username: "delay4",
    });
    const session = await verifyQuestions(app, "delay4", answers);
    await reset(app, session, "novasenha77");

    const owner = await login(app, "delay4", plainPassword);
    expect(owner.status).toBe(200);
    expect(owner.body.pendingRecoveryCancelled).toBe(true);

    // o pedido já não existe: a palavra-passe do pedido deixa de servir
    const attacker = await login(app, "delay4", "novasenha77");
    expect(attacker.status).toBe(401);
    expect(attacker.body.error).toBe("invalid_credentials");

    // e um login normal seguinte já não traz o aviso
    const again = await login(app, "delay4", plainPassword);
    expect(again.body.pendingRecoveryCancelled).toBeUndefined();
  });

  it("depois do prazo a nova palavra-passe é aplicada, com código novo e sessões revogadas", async () => {
    const { user, answers, plainPassword } = await makeUserWithPassword({
      username: "delay5",
    });
    const old = await login(app, "delay5", plainPassword);
    const oldRefresh = old.body.refreshToken as string;

    const session = await verifyQuestions(app, "delay5", answers);
    await reset(app, session, "novasenha88");
    await makePendingDue(user.id);

    const l = await login(app, "delay5", "novasenha88");
    expect(l.status).toBe(200);
    expect(l.body.recoveryCode).toMatch(/^[A-Z2-7-]+$/);
    expect(l.body.recoveryCodeWarning).toBeTruthy();

    // palavra-passe antiga deixou de funcionar; o refresh antigo foi revogado
    expect((await login(app, "delay5", plainPassword)).status).toBe(401);
    const r = await request(app.server)
      .post("/auth/refresh")
      .send({ refreshToken: oldRefresh });
    expect(r.status).toBe(401);

    // o código novo só é mostrado uma vez
    const next = await login(app, "delay5", "novasenha88");
    expect(next.status).toBe(200);
    expect(next.body.recoveryCode).toBeUndefined();
  });

  it("recuperação por código cancela um pedido pendente por perguntas", async () => {
    const { answers, recoveryCode } = await makeUserWithPassword({
      username: "delay6",
    });
    const qSession = await verifyQuestions(app, "delay6", answers);
    await reset(app, qSession, "daspergun99");

    const cSession = await verifyCode(app, "delay6", recoveryCode);
    expect((await reset(app, cSession, "docodigo123")).status).toBe(200);

    expect((await login(app, "delay6", "docodigo123")).status).toBe(200);
    const stale = await login(app, "delay6", "daspergun99");
    expect(stale.status).toBe(401);
    expect(stale.body.error).toBe("invalid_credentials");
  });
});
