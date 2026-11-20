import { describe, expect, it } from "vitest";
import {
  isUniqueViolation,
  pgErrorCode,
  safeErrorFields,
} from "../src/errors.js";

describe("isUniqueViolation", () => {
  it("reconhece 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    const err = Object.assign(new Error("dup"), { code: "23505" });
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("não confunde outros códigos", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation({ code: "42P01" })).toBe(false);
  });

  it("não rebenta com inputs inválidos", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("erro")).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
  });
});

describe("isUniqueViolation — erros embrulhados (DrizzleQueryError)", () => {
  it("encontra o código na cadeia de `cause`", () => {
    const wrapped = Object.assign(new Error("Failed query: insert ..."), {
      cause: Object.assign(new Error("dup"), { code: "23505" }),
    });
    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(pgErrorCode(wrapped)).toBe("23505");
  });

  it("ignora códigos que não são SQLSTATE (ex.: ECONNRESET)", () => {
    expect(pgErrorCode({ code: "ECONNRESET" })).toBeUndefined();
    expect(isUniqueViolation({ cause: { code: "ECONNRESET" } })).toBe(false);
  });

  it("não entra em ciclo nem desce sem limite", () => {
    const a: Record<string, unknown> = {};
    a.cause = a;
    expect(pgErrorCode(a)).toBeUndefined();
    let deep: Record<string, unknown> = { code: "23505" };
    for (let i = 0; i < 10; i++) deep = { cause: deep };
    expect(pgErrorCode(deep)).toBeUndefined();
  });
});

describe("safeErrorFields", () => {
  it("só nomes e código, nunca mensagem nem parâmetros", () => {
    const err = Object.assign(new Error("Failed query: params SEGREDO"), {
      params: ["SEGREDO"],
      cause: Object.assign(new Error("Key (username)=(SEGREDO)"), {
        name: "DatabaseError",
        code: "23505",
      }),
    });
    const out = safeErrorFields(err);
    expect(out).toEqual({
      errorName: "Error",
      errorCode: "23505",
      causeName: "DatabaseError",
    });
    expect(JSON.stringify(out)).not.toContain("SEGREDO");
  });

  it("valores que não são erros", () => {
    expect(safeErrorFields("x")).toEqual({ errorName: "string" });
  });
});
