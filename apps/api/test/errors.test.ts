import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "../src/errors.js";

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
