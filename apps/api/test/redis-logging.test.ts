import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { attachRedisErrorLogging } from "../src/redis.js";

function setup(intervalMs = 30_000) {
  const redis = new EventEmitter();
  const logged: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  let clock = 1_000_000;
  attachRedisErrorLogging(
    redis as never,
    { warn: (obj, msg) => logged.push({ obj, msg }) },
    { intervalMs, now: () => clock },
  );
  return {
    redis,
    logged,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("attachRedisErrorLogging", () => {
  it("regista sem a mensagem (traz host e porta)", () => {
    const { redis, logged } = setup();
    redis.emit(
      "error",
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:6379"), {
        code: "ECONNREFUSED",
      }),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]!.msg).toBe("redis error");
    expect(logged[0]!.obj.errorCode).toBe("ECONNREFUSED");
    expect(JSON.stringify(logged)).not.toContain("10.0.0.5");
  });

  it("no máximo uma vez por intervalo", () => {
    const { redis, logged, advance } = setup(30_000);
    for (let i = 0; i < 50; i++) redis.emit("error", new Error("x"));
    expect(logged).toHaveLength(1);
    advance(29_999);
    redis.emit("error", new Error("x"));
    expect(logged).toHaveLength(1);
    advance(1);
    redis.emit("error", new Error("x"));
    expect(logged).toHaveLength(2);
  });

  it("valor lançado que não é Error não rebenta", () => {
    const { redis, logged } = setup();
    redis.emit("error", "texto");
    expect(logged[0]!.obj.errorName).toBe("string");
  });
});
