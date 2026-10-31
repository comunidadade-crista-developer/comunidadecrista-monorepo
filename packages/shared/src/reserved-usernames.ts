// Minúsculas, sem acentos, sem separadores. Aumenta-se por PR.
const RESERVED: ReadonlySet<string> = new Set([
  // Equipa e papéis
  "admin",
  "adm",
  "administrador",
  "administradora",
  "administrator",
  "administracao",
  "sysadmin",
  "superadmin",
  "superuser",
  "root",
  "owner",
  "dono",
  "moderador",
  "moderadora",
  "moderator",
  "mod",
  "mods",
  "moderacao",
  "moderation",
  "suporte",
  "support",
  "helpdesk",
  "ajuda",
  "help",
  "staff",
  "equipa",
  "team",
  "oficial",
  "official",
  "sistema",
  "system",
  "bot",
  // Contacto e infra-estrutura habitual
  "contacto",
  "contato",
  "contact",
  "info",
  "security",
  "seguranca",
  "abuse",
  "postmaster",
  "webmaster",
  "hostmaster",
  "noreply",
  "naoresponder",
  "api",
  "www",
  "app",
  "login",
  "logout",
  "register",
  "registo",
  "auth",
  "me",
  "eu",
  // Valores que confundem código, interface ou outros utilizadores
  "null",
  "undefined",
  "none",
  "nan",
  "anonymous",
  "anonimo",
  "anonima",
  "removido",
  "removida",
  "apagado",
  "apagada",
  "deleted",
  "removed",
  "unknown",
  "desconhecido",
  // Marca
  "comunidade",
  "comunidadecrista",
  "comunidadecristao",
  "gekkodreamers",
]);

// Prefixos/sufixos que não mudam a quem o nome «se parece»: «admin-oficial», «theadmin».
const AFFIXES: readonly string[] = [
  "oficial",
  "official",
  "the",
  "real",
  "equipa",
  "team",
  "app",
];

const MIN_RESERVED_LENGTH_WITH_AFFIX = 5;

const LEET: Readonly<Record<string, string>> = {
  "0": "o",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
};

function stripAccents(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function squash(value: string): string {
  return stripAccents(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function stripEdgeDigits(value: string): string {
  return value.replace(/^\d+/, "").replace(/\d+$/, "");
}

function leet(value: string, one: "i" | "l"): string {
  let out = "";
  for (const ch of value) {
    out += ch === "1" ? one : (LEET[ch] ?? ch);
  }
  return out;
}

function candidates(username: string): Set<string> {
  const base = squash(username);
  const forms = [base, leet(base, "i"), leet(base, "l")];
  const out = new Set<string>();
  for (const form of forms) {
    out.add(form);
    out.add(stripEdgeDigits(form));
  }
  out.delete("");
  return out;
}

function matchesReserved(form: string): boolean {
  if (RESERVED.has(form)) return true;
  const isReservedWithAffix = (rest: string): boolean => {
    const core = stripEdgeDigits(rest);
    return core.length >= MIN_RESERVED_LENGTH_WITH_AFFIX && RESERVED.has(core);
  };
  for (const affix of AFFIXES) {
    if (form.length > affix.length && form.startsWith(affix)) {
      if (isReservedWithAffix(form.slice(affix.length))) return true;
    }
    if (form.length > affix.length && form.endsWith(affix)) {
      if (isReservedWithAffix(form.slice(0, -affix.length))) return true;
    }
  }
  return false;
}

export function isReservedUsername(username: string): boolean {
  for (const form of candidates(username)) {
    if (matchesReserved(form)) return true;
  }
  return false;
}

export const RESERVED_USERNAME_MESSAGE =
  "este nome de utilizador não está disponível";
