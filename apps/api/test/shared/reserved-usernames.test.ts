import { isReservedUsername, NewUsername, Username } from "@comunidade/shared";
import { describe, expect, it } from "vitest";

describe("isReservedUsername", () => {
  const reserved = [
    "admin",
    "Admin",
    "ADMIN",
    "ad.min",
    "a_d-m_i-n",
    "4dm1n",
    "adm1n",
    "admin2024",
    "2admin",
    "admin-oficial",
    "theadmin",
    "admin-team",
    "realsuporte",
    "moderador",
    "Moderador123",
    "m0d3r4d0r",
    "suporte",
    "Suporte_Oficial",
    "support",
    "r00t",
    "removido",
    "comunidade-crista",
    "gekko.dreamers",
    "mod",
    "m0d",
  ];
  it.each(reserved)("recusa %s", (name) => {
    expect(isReservedUsername(name)).toBe(true);
  });

  const allowed = [
    "ana",
    "joao_silva",
    "maria.admin.x",
    "badminton",
    "admiral",
    "adminton",
    "modesto",
    "moderno",
    "helpful",
    "sistemas",
    "teamo",
    "bota",
    "dome",
    "dame",
    "dono-da-casa",
    "themeu",
    "teammod",
    "pedro123",
    "comunidade_viva",
  ];
  it.each(allowed)(
    "aceita %s (não procura dentro de outras palavras)",
    (name) => {
      expect(isReservedUsername(name)).toBe(false);
    },
  );
});

describe("schemas de username", () => {
  it("NewUsername (registo) recusa reservados com mensagem genérica", () => {
    const res = NewUsername.safeParse("Admin");
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.message).toBe(
        "este nome de utilizador não está disponível",
      );
    }
  });

  it("NewUsername continua a validar o formato", () => {
    expect(NewUsername.safeParse("ab").success).toBe(false);
    expect(NewUsername.safeParse("com espaço").success).toBe(false);
    expect(NewUsername.safeParse("ana_maria").success).toBe(true);
  });

  it("Username (login/recuperação) NÃO aplica a reserva: contas antigas entram", () => {
    expect(Username.safeParse("admin").success).toBe(true);
  });
});
