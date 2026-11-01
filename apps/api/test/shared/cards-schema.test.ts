import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CardSlugParams,
  GospelCardsSeedFile,
  MAX_GOSPEL_CARDS,
} from "@comunidade/shared";
import { describe, expect, it } from "vitest";

function card(i: number, overrides: Record<string, unknown> = {}) {
  return {
    slug: `card-${i}`,
    title: `Card ${i}`,
    gospelReference: "Mateus 2",
    summary: "Resumo",
    otReferences: ["Isaías 7:14"],
    ntReferences: ["Mateus 2:1-12"],
    orderIndex: i,
    ...overrides,
  };
}

describe("GospelCardsSeedFile", () => {
  it("o seed-data/cards.json do repositório é válido", () => {
    const file = fileURLToPath(
      new URL("../../src/db/seed-data/cards.json", import.meta.url),
    );
    const parsed = GospelCardsSeedFile.safeParse(
      JSON.parse(readFileSync(file, "utf-8")),
    );
    expect(parsed.success).toBe(true);
  });

  it("aceita um conjunto válido, até ao máximo", () => {
    const cards = Array.from({ length: MAX_GOSPEL_CARDS }, (_, i) =>
      card(i + 1),
    );
    expect(GospelCardsSeedFile.safeParse(cards).success).toBe(true);
  });

  it("recusa mais do que o máximo (excesso visível no seed, não corte na leitura)", () => {
    const cards = Array.from({ length: MAX_GOSPEL_CARDS + 1 }, (_, i) =>
      card(i + 1),
    );
    expect(GospelCardsSeedFile.safeParse(cards).success).toBe(false);
  });

  it("recusa vazio, slugs repetidos e orderIndex repetido", () => {
    expect(GospelCardsSeedFile.safeParse([]).success).toBe(false);

    const dupSlug = GospelCardsSeedFile.safeParse([
      card(1),
      card(2, { slug: "card-1" }),
    ]);
    expect(dupSlug.success).toBe(false);
    if (!dupSlug.success) {
      expect(dupSlug.error.issues[0]?.message).toContain("slug repetido");
    }

    const dupOrder = GospelCardsSeedFile.safeParse([
      card(1),
      card(2, { orderIndex: 1 }),
    ]);
    expect(dupOrder.success).toBe(false);
  });

  it.each([
    ["slug com maiúsculas", { slug: "Natal" }],
    ["slug com espaço", { slug: "o natal" }],
    ["título vazio", { title: "" }],
    ["orderIndex negativo", { orderIndex: -1 }],
    ["orderIndex decimal", { orderIndex: 1.5 }],
    ["referência vazia", { otReferences: [""] }],
    ["resumo gigante", { summary: "x".repeat(1001) }],
  ])("recusa %s", (_name, overrides) => {
    expect(GospelCardsSeedFile.safeParse([card(1, overrides)]).success).toBe(
      false,
    );
  });
});

describe("CardSlugParams", () => {
  it("valida o formato do slug", () => {
    expect(
      CardSlugParams.safeParse({ slug: "o-nascimento-de-jesus" }).success,
    ).toBe(true);
    expect(CardSlugParams.safeParse({ slug: "Com Espaço" }).success).toBe(
      false,
    );
  });
});
