import {
  LoginRequest,
  NewPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MESSAGES,
  PASSWORD_MIN_LENGTH,
  RecoverResetRequest,
  RegisterRequest,
  containsUsername,
  isCommonPassword,
} from "@comunidade/shared";
import { describe, expect, it } from "vitest";

describe("isCommonPassword", () => {
  it.each([
    "password",
    "Password123!",
    "PASSWORD1",
    "12345678",
    "123456789012",
    "aaaaaaaa",
    "Qwertyui",
    "Jesus2024",
    "jesuscristo",
    "MAPUTO_1",
    "Mocambique2025!",
    "Moçambique123",
    "Comunidade123",
    "DeusEFiel",
  ])("recusa %s", (value) => {
    expect(isCommonPassword(value)).toBe(true);
  });

  it.each([
    "Frase-de-teste-42",
    "banana-azul-tijolo",
    "o meu cavalo come cenouras",
    "correcto cavalo bateria",
    "Cavalo-azul-bateria-77",
    "jesus-cristo-e-o-senhor-da-minha-vida",
    "novasenha99",
    "qualquer123",
  ])("aceita %s", (value) => {
    expect(isCommonPassword(value)).toBe(false);
  });
});

describe("containsUsername", () => {
  it("igual, sem diferenciar maiúsculas", () => {
    expect(containsUsername("Maria", "maria")).toBe(true);
    expect(containsUsername("ANA", "ana")).toBe(true);
  });

  it("contém um nome com 4+ caracteres", () => {
    expect(containsUsername("ruben-silva-2025", "ruben-silva")).toBe(true);
    expect(containsUsername("xxMARIAxx", "maria")).toBe(true);
  });

  it("nomes curtos só contam se forem iguais (evita «ana» em «banana»)", () => {
    expect(containsUsername("banana-azul-tijolo", "ana")).toBe(false);
    expect(containsUsername("ana-e-o-rio-grande", "ana")).toBe(false);
  });

  it("não rebenta com nome vazio", () => {
    expect(containsUsername("qualquer-coisa", "")).toBe(false);
  });
});

describe("NewPassword", () => {
  it(`mínimo ${PASSWORD_MIN_LENGTH}, máximo ${PASSWORD_MAX_LENGTH}`, () => {
    expect(NewPassword.safeParse("x".repeat(7) + "!").success).toBe(true);
    const short = NewPassword.safeParse("abc-123");
    expect(short.success).toBe(false);
    if (!short.success) {
      expect(short.error.issues[0]!.message).toBe(PASSWORD_MESSAGES.tooShort);
    }
    expect(NewPassword.safeParse("ab".repeat(64)).success).toBe(true);
    const long = NewPassword.safeParse("ab".repeat(64) + "c");
    expect(long.success).toBe(false);
  });

  it("sem regras de composição: só letras minúsculas e espaços servem", () => {
    expect(NewPassword.safeParse("correcto cavalo bateria").success).toBe(true);
  });

  it("aceita Unicode (acentos, ç, emoji)", () => {
    expect(NewPassword.safeParse("Ação-e-fé-na-comunidade").success).toBe(true);
    expect(NewPassword.safeParse("minha frase 🙏 muito longa").success).toBe(
      true,
    );
  });

  it("comum → mensagem própria", () => {
    const r = NewPassword.safeParse("Password123!");
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe(PASSWORD_MESSAGES.common);
    }
  });
});

describe("LoginRequest — aceita as palavras-passe antigas", () => {
  it("6 caracteres e até ao máximo; rejeita vazio e acima do máximo", () => {
    expect(
      LoginRequest.safeParse({ username: "abc", password: "abc123" }).success,
    ).toBe(true);
    expect(
      LoginRequest.safeParse({ username: "abc", password: "x" }).success,
    ).toBe(true);
    expect(
      LoginRequest.safeParse({ username: "abc", password: "" }).success,
    ).toBe(false);
    expect(
      LoginRequest.safeParse({
        username: "abc",
        password: "x".repeat(PASSWORD_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("palavra-passe comum ainda entra (conta antiga)", () => {
    expect(
      LoginRequest.safeParse({ username: "abc", password: "password123" })
        .success,
    ).toBe(true);
  });
});

function registerBody(overrides: Record<string, unknown> = {}) {
  const password = "Cavalo-azul-bateria-77";
  return {
    username: "ruben-silva",
    password,
    passwordConfirmation: password,
    securityQ1: "Azul",
    securityQ2: "7",
    securityQ3: "Igreja",
    ...overrides,
  };
}

describe("RegisterRequest", () => {
  it("aceita uma frase-passe", () => {
    expect(RegisterRequest.safeParse(registerBody()).success).toBe(true);
  });

  it("recusa palavra-passe comum no campo password", () => {
    const r = RegisterRequest.safeParse(
      registerBody({
        password: "Password123!",
        passwordConfirmation: "Password123!",
      }),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path[0] === "password")).toBe(true);
    }
  });

  it("recusa palavra-passe que contém o nome de utilizador", () => {
    const pw = "ruben-silva-2025-xyz";
    const r = RegisterRequest.safeParse(
      registerBody({ password: pw, passwordConfirmation: pw }),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path[0] === "password");
      expect(issue?.message).toBe(PASSWORD_MESSAGES.containsUsername);
    }
  });

  it("username curto não bloqueia frases que o contêm por acaso", () => {
    const pw = "banana-azul-tijolo";
    expect(
      RegisterRequest.safeParse(
        registerBody({
          username: "ana",
          password: pw,
          passwordConfirmation: pw,
        }),
      ).success,
    ).toBe(true);
  });

  it("confirmação diferente continua a ser recusada", () => {
    const r = RegisterRequest.safeParse(
      registerBody({ passwordConfirmation: "outra-frase-qualquer-1" }),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => i.path[0] === "passwordConfirmation"),
      ).toBe(true);
    }
  });
});

describe("RecoverResetRequest", () => {
  it("aplica a política à nova palavra-passe", () => {
    const base = { recoverySession: "s" };
    expect(
      RecoverResetRequest.safeParse({
        ...base,
        newPassword: "Cavalo-azul-bateria-77",
        newPasswordConfirmation: "Cavalo-azul-bateria-77",
      }).success,
    ).toBe(true);
    expect(
      RecoverResetRequest.safeParse({
        ...base,
        newPassword: "password123",
        newPasswordConfirmation: "password123",
      }).success,
    ).toBe(false);
    expect(
      RecoverResetRequest.safeParse({
        ...base,
        newPassword: "curta1",
        newPasswordConfirmation: "curta1",
      }).success,
    ).toBe(false);
  });
});
