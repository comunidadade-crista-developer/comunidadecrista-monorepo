import { describe, expect, it } from "vitest";
import {
  collectFields,
  errorHandler,
  notFoundHandler,
  statusOf,
} from "../src/http-errors.js";

describe("statusOf", () => {
  it("usa statusCode/status válidos (400–599), senão 500", () => {
    expect(statusOf({ statusCode: 404 })).toBe(404);
    expect(statusOf({ status: 429 })).toBe(429);
    expect(statusOf({ statusCode: 200 })).toBe(500);
    expect(statusOf({ statusCode: "400" })).toBe(500);
    expect(statusOf(new Error("x"))).toBe(500);
    expect(statusOf(null)).toBe(500);
    expect(statusOf("erro")).toBe(500);
  });
});

describe("collectFields", () => {
  it("lê issues (ZodError): primeira mensagem por campo, path com ponto", () => {
    const fields = collectFields({
      issues: [
        { path: ["username"], message: "curto" },
        { path: ["username"], message: "segunda (ignorada)" },
        { path: ["a", 0, "b"], message: "aninhado" },
        { path: [], message: "raiz" },
      ],
    });
    expect(fields).toEqual({
      username: "curto",
      "a.0.b": "aninhado",
      _: "raiz",
    });
  });

  it("lê validation (estilo Ajv) pela instancePath", () => {
    const fields = collectFields({
      validation: [
        { instancePath: "/password", message: "curta" },
        { instancePath: "/user/name", message: "obrigatório" },
      ],
    });
    expect(fields).toEqual({ password: "curta", "user.name": "obrigatório" });
  });

  it("prefere params.issue quando existe", () => {
    const fields = collectFields({
      validation: [
        {
          instancePath: "/x",
          message: "genérica",
          params: {
            issue: { path: ["passwordConfirmation"], message: "não coincidem" },
          },
        },
      ],
    });
    expect(fields).toEqual({ passwordConfirmation: "não coincidem" });
  });

  it("limita número de campos e tamanho das mensagens", () => {
    const issues = Array.from({ length: 50 }, (_, i) => ({
      path: [`f${i}`],
      message: "m".repeat(500),
    }));
    const fields = collectFields({ issues });
    expect(Object.keys(fields)).toHaveLength(20);
    expect(Object.values(fields).every((m) => m.length === 200)).toBe(true);
  });

  it("não rebenta com lixo", () => {
    expect(collectFields(null)).toEqual({});
    expect(collectFields({ issues: [null, 1, "x"] })).toEqual({});
    expect(collectFields({ validation: "x" })).toEqual({});
  });
});

// Reply/Request mínimos: o que interessa é o código HTTP, o corpo e o que se regista.
function fakeReply() {
  const out: { status?: number; body?: unknown } = {};
  const reply = {
    code(status: number) {
      out.status = status;
      return reply;
    },
    send(payload: unknown) {
      out.body = payload;
      return reply;
    },
  };
  return { reply, out };
}

function fakeRequest() {
  const logged: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const request = {
    method: "POST",
    routeOptions: { url: "/posts/:id" },
    log: {
      error(obj: Record<string, unknown>, msg: string) {
        logged.push({ obj, msg });
      },
    },
  };
  return { request, logged };
}

describe("errorHandler", () => {
  it("5xx: corpo genérico e log sem mensagem nem valores", () => {
    const { reply, out } = fakeReply();
    const { request, logged } = fakeRequest();
    const err = Object.assign(
      new Error("duplicate key: Key (username)=(SEGREDO) already exists"),
      { code: "23505", detail: "Key (username)=(SEGREDO)" },
    );

    errorHandler(err, request as never, reply as never);

    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: "internal_error" });
    expect(logged).toHaveLength(1);
    const serialized = JSON.stringify(logged[0]);
    expect(serialized).not.toContain("SEGREDO");
    expect(serialized).not.toContain("duplicate key");
    expect(logged[0]!.obj.errorName).toBe("Error");
    expect(logged[0]!.obj.errorCode).toBe("23505");
    expect(logged[0]!.obj.route).toBe("/posts/:id");
  });

  it("503 → service_unavailable", () => {
    const { reply, out } = fakeReply();
    errorHandler(
      { statusCode: 503 },
      fakeRequest().request as never,
      reply as never,
    );
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "service_unavailable" });
  });

  it("valor lançado que não é Error também dá 500 genérico", () => {
    const { reply, out } = fakeReply();
    const { request } = fakeRequest();
    errorHandler("texto com SEGREDO", request as never, reply as never);
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: "internal_error" });
  });

  it.each([
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [413, "payload_too_large"],
    [415, "unsupported_media_type"],
    [429, "rate_limited"],
    [418, "bad_request"],
  ])("4xx %i → %s, sem repetir a mensagem original", (status, code) => {
    const { reply, out } = fakeReply();
    const { request, logged } = fakeRequest();
    errorHandler(
      Object.assign(new Error("detalhe interno SEGREDO"), {
        statusCode: status,
      }),
      request as never,
      reply as never,
    );
    expect(out.status).toBe(status);
    expect(out.body).toEqual({ error: code });
    expect(logged).toHaveLength(0);
  });

  it("validação → 400 validation_error com fields", () => {
    const { reply, out } = fakeReply();
    errorHandler(
      Object.assign(new Error("body invalid"), {
        statusCode: 400,
        code: "FST_ERR_VALIDATION",
        issues: [{ path: ["username"], message: "curto" }],
      }),
      fakeRequest().request as never,
      reply as never,
    );
    expect(out.status).toBe(400);
    expect(out.body).toEqual({
      error: "validation_error",
      fields: { username: "curto" },
    });
  });

  it("validação sem campos extraíveis → validation_error sem fields", () => {
    const { reply, out } = fakeReply();
    errorHandler(
      Object.assign(new Error("x"), {
        statusCode: 400,
        code: "FST_ERR_VALIDATION",
      }),
      fakeRequest().request as never,
      reply as never,
    );
    expect(out.body).toEqual({ error: "validation_error" });
  });
});

describe("notFoundHandler", () => {
  it("404 not_found", () => {
    const { reply, out } = fakeReply();
    notFoundHandler(fakeRequest().request as never, reply as never);
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: "not_found" });
  });
});
