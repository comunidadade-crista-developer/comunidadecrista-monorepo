import {
  AdminApproveRequest,
  AdminListPostsQuery,
  AdminListReportsQuery,
  AdminModerationLogQuery,
  AdminRejectRequest,
  decodeCursor,
  encodeCursor,
} from "@comunidade/shared";
import { describe, expect, it } from "vitest";

const T = "2026-01-01T00:00:00.123456Z";
const ID = "0190a0a0-0000-7000-8000-000000000001";

describe("cursores do painel admin", () => {
  it("ida e volta, e cada tipo só serve na sua lista", () => {
    for (const k of ["admin_posts", "admin_reports", "admin_log"] as const) {
      const c = encodeCursor({ k, t: T, id: ID });
      expect(decodeCursor(c, k)).toEqual({ k, t: T, id: ID });
      for (const other of [
        "recent",
        "top",
        "liked",
        "admin_posts",
        "admin_reports",
        "admin_log",
      ] as const) {
        if (other !== k) expect(decodeCursor(c, other)).toBeNull();
      }
    }
  });

  it("um cursor do feed não serve no painel", () => {
    const feed = encodeCursor({ k: "recent", t: T, id: ID });
    expect(decodeCursor(feed, "admin_posts")).toBeNull();
    expect(AdminListPostsQuery.safeParse({ cursor: feed }).success).toBe(false);
  });
});

describe("queries do painel admin", () => {
  it("valores por omissão", () => {
    expect(AdminListPostsQuery.parse({})).toEqual({
      status: "pending_review",
      limit: 20,
    });
    expect(AdminListReportsQuery.parse({})).toEqual({
      status: "open",
      limit: 20,
    });
    expect(AdminModerationLogQuery.parse({})).toEqual({ limit: 20 });
  });

  it("cursor da lista certa passa; de outra lista, texto livre ou limite acima do tecto → inválido", () => {
    const posts = encodeCursor({ k: "admin_posts", t: T, id: ID });
    expect(AdminListPostsQuery.safeParse({ cursor: posts }).success).toBe(true);
    expect(AdminListReportsQuery.safeParse({ cursor: posts }).success).toBe(
      false,
    );
    expect(AdminModerationLogQuery.safeParse({ cursor: posts }).success).toBe(
      false,
    );
    expect(
      AdminListPostsQuery.safeParse({ cursor: "não é um cursor!" }).success,
    ).toBe(false);
    expect(AdminListPostsQuery.safeParse({ limit: "51" }).success).toBe(false);
    expect(AdminListPostsQuery.safeParse({ status: "inventado" }).success).toBe(
      false,
    );
  });
});

describe("decisões do painel admin", () => {
  it("rejeitar exige motivo de 10 a 500 caracteres (aparado) e recusa campos a mais", () => {
    expect(AdminRejectRequest.safeParse({}).success).toBe(false);
    expect(AdminRejectRequest.safeParse({ reason: "curto" }).success).toBe(
      false,
    );
    expect(
      AdminRejectRequest.safeParse({ reason: "          x          " }).success,
    ).toBe(false);
    expect(
      AdminRejectRequest.parse({ reason: "  fora da doutrina  " }),
    ).toEqual({
      reason: "fora da doutrina",
    });
    expect(
      AdminRejectRequest.safeParse({ reason: "x".repeat(501) }).success,
    ).toBe(false);
    expect(
      AdminRejectRequest.safeParse({ reason: "motivo válido", extra: 1 })
        .success,
    ).toBe(false);
    expect(
      AdminRejectRequest.safeParse({ reason: "motivo \u0000 inválido" })
        .success,
    ).toBe(false);
  });

  it("aprovar: corpo vazio ou nota opcional; campos a mais recusados", () => {
    expect(AdminApproveRequest.safeParse({}).success).toBe(true);
    expect(AdminApproveRequest.safeParse({ note: "ok" }).success).toBe(true);
    expect(AdminApproveRequest.safeParse({ note: "   " }).success).toBe(false);
    expect(AdminApproveRequest.safeParse({ x: 1 }).success).toBe(false);
  });
});
