import { describe, expect, it } from "vitest";
import { checkContent, flagCodes } from "@comunidade/shared";

const rejectedAs = (text: string, title = "Título") => {
  const result = checkContent(title, text);
  return result.reject ? result.violations[0]?.code : null;
};

describe("checkContent — ligações rejeitadas", () => {
  it.each([
    "veja igreja.org",
    "acesse sitedaigreja.net",
    "https://exemplo.pt/pagina",
    "wa.me/grupo-igreja",
    "t.me/canal",
    "youtu.be/abc123",
    "linktr.ee/igreja",
    "bit.ly/xyz",
    "igreja.com.br",
    "WWW . igreja . net",
    "hxxp://exemplo",
    "igreja . com",
    "igreja [.] com",
    "igreja(.)com",
    "igreja dot com",
    "igreja[dot]com",
    "visite igreja ponto com",
    "visite igreja ponto com.",
    "igreja​.com", // zero-width
    "igreja．com", // ponto de largura total
    "igreja.cоm", // «о» cirílico
  ])("rejeita %j como link", (text) => {
    expect(rejectedAs(text)).toBe("link");
  });

  it("apanha o link também no título", () => {
    expect(rejectedAs("texto normal", "veja igreja.org")).toBe("link");
  });
});

describe("checkContent — contactos rejeitados", () => {
  it.each([
    "ligue 912345678", // PT
    "ligue +351 912 345 678",
    "ligue +258 84 123 4567", // MZ
    "ligue 84 123 4567",
    "ligue 82-123-4567",
    "ligue 923456789", // AO
    "zap: (11) 91234-5678", // BR
    "ligue +27 82 123 4567", // internacional explícito
    "9 1 2 3 4 5 6 7 8", // dígitos separados
    "whatsapp 99887766", // mensageiro + número de formato desconhecido
    "wa.me/258841234567", // ligação que já traz o número
    "email: joao@gmail.com",
    "joao (at) gmail . com",
    "joao arroba gmail",
    "joao @ gmail . com",
    "IP 192.168.0.1",
    "host 2001:db8::1",
  ])("rejeita %j como contacto", (text) => {
    expect(rejectedAs(text)).toBe("contact");
  });
});

describe("checkContent — texto legítimo passa", () => {
  it.each([
    "Amém, Deus é bom.",
    "O culto é às 10:30:15 de domingo",
    "A versão 1.2.3.4 do estudo",
    "Salmo 91 verso 2345678",
    "João 3:16-17 e Mateus 5.3",
    "esse ponto com certeza é importante",
    "Jesus é o Senhor. Com ele tudo é possível",
    "Em 2026, 1.5 milhões de pessoas",
    "Gênesis 1.1 diz que",
    "Ex.: entendimento de Rm 8.28",
    "Capítulo 12.3.4 do livro",
    "Deus.é amor",
    "@joao respondeu bem", // menção sem email
    "Obrigado @maria pela partilha",
  ])("aceita %j", (text) => {
    const result = checkContent("Reflexão", text);
    expect(result.reject).toBe(false);
  });

  it("«AMÉM ALELUIA» curto não é sinal de caps (ADR-013: len > 50)", () => {
    const result = checkContent("Louvor", "AMÉM ALELUIA");
    expect(result.reject).toBe(false);
    expect(flagCodes(result)).toEqual([]);
  });
});

describe("checkContent — sinais de spam (não rejeitam)", () => {
  it("caps: texto longo com mais de 50 % de maiúsculas", () => {
    const text =
      "GLÓRIA A DEUS PARA SEMPRE, SENHOR NOSSO CRIADOR E PAI DE TODOS";
    const result = checkContent("Louvor", text);
    expect(result.reject).toBe(false);
    expect(flagCodes(result)).toContain("caps");
  });

  it("repetição, pontuação, palavras de spam e pedido de contacto", () => {
    const result = checkContent(
      "Oferta",
      "ganhe dinheiro rápido!!!!! aaaaaaaaaaaa chama no whatsapp",
    );
    expect(result.reject).toBe(false);
    expect(flagCodes(result)).toEqual([
      "repetition",
      "punctuation",
      "keywords",
      "contact_solicitation",
    ]);
  });

  it("palavras de spam sem acentos e no plural", () => {
    const result = checkContent("x", "Prémios e sorteios de bitcoins");
    expect(flagCodes(result)).toContain("keywords");
  });

  it("mistura de alfabetos na mesma palavra", () => {
    const result = checkContent("x", "palavra mistuаda"); // «а» cirílico
    expect(flagCodes(result)).toContain("mixed_script");
  });

  it("texto limpo não tem sinais", () => {
    const result = checkContent(
      "Entendimento",
      "Hoje li Romanos 8 e fiquei em paz.",
    );
    expect(result).toEqual({ reject: false, flags: [] });
  });
});

describe("checkContent — desempenho em entradas adversariais", () => {
  const MAX_MS = 250; // folgado: serve para apanhar regressões quadráticas, não micro-variações
  it.each([
    ["pontos repetidos", "a.".repeat(2500)],
    ["espaços", "a ".repeat(2500)],
    ["dígitos", "1".repeat(5000)],
    ["arrobas", "a@".repeat(2500)],
    ["dígitos separados", "9 ".repeat(2500)],
    ["uma palavra enorme", "a".repeat(5000)],
    ["dois-pontos", "x:".repeat(2500)],
    ["hífens", "a-".repeat(2500)],
    ["pontos com espaços", "a .".repeat(1600)],
  ])("%s", (_name, text) => {
    const start = performance.now();
    checkContent("t", text);
    expect(performance.now() - start).toBeLessThan(MAX_MS);
  });
});
