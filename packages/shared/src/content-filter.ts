export type ContentRejectCode = "link" | "contact";
export type ContentFlagCode =
  | "caps"
  | "repetition"
  | "punctuation"
  | "keywords"
  | "contact_solicitation"
  | "mixed_script";

export interface ContentViolation {
  kind: "link" | "contact" | "spam_signal";
  code: ContentRejectCode | ContentFlagCode;
  hint: string;
}

export type ContentCheckResult =
  | { reject: true; violations: ContentViolation[] }
  | { reject: false; flags: ContentViolation[] };

const INVISIBLES = /[\p{Cf}­]/gu;
const DOT_VARIANTS = /[。｡․﹒։۔]/g;
const BRACKET_DOT = /[[(]\s*\.\s*[\])]/g;
const BRACKET_DOT_WORD = /[[(]\s*(?:dot|ponto)\s*[\])]/g;
const WHITESPACE = /\s+/g;
const ACCENTS = /[̀-ͯ]/g;

const CONFUSABLES: Readonly<Record<string, string>> = {
  а: "a",
  в: "b",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ј: "j",
  ѕ: "s",
  ӏ: "l",
  ԁ: "d",
  ɡ: "g",
  α: "a",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
};
const CONFUSABLE_RE = new RegExp(
  `[${Object.keys(CONFUSABLES).join("")}]`,
  "gu",
);

function clean(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLES, "")
    .replace(DOT_VARIANTS, ".")
    .replace(BRACKET_DOT, ".")
    .replace(BRACKET_DOT_WORD, ".")
    .replace(WHITESPACE, " ")
    .trim();
}

function stripAccents(text: string): string {
  return text.normalize("NFD").replace(ACCENTS, "").normalize("NFC");
}

const TLDS = [
  // gerais
  "com",
  "net",
  "org",
  "info",
  "biz",
  "edu",
  "gov",
  "int",
  "mil",
  // novos gTLDs frequentes em links de spam/phishing/conteúdo
  "app",
  "dev",
  "site",
  "online",
  "store",
  "shop",
  "live",
  "link",
  "click",
  "club",
  "vip",
  "pro",
  "fun",
  "work",
  "life",
  "world",
  "today",
  "rest",
  "cam",
  "cyou",
  "monster",
  "quest",
  "xyz",
  "top",
  "buzz",
  "bond",
  "sbs",
  "cfd",
  "icu",
  "zip",
  "mov",
  "page",
  "cloud",
  "tech",
  "space",
  "website",
  "digital",
  "media",
  "news",
  "blog",
  "church",
  "faith",
  "gives",
  "love",
  // países gratuitos/abusados e encurtadores (bit.ly, t.me, wa.me, youtu.be, linktr.ee…)
  "tk",
  "ml",
  "ga",
  "cf",
  "gq",
  "li",
  "ly",
  "me",
  "to",
  "tv",
  "cc",
  "ws",
  "be",
  "ee",
  "gl",
  "gd",
  "co",
  "io",
  "ai",
  "sh",
  "fm",
  "ru",
  "cn",
  "su",
  // países com mais tráfego
  "uk",
  "us",
  "de",
  "fr",
  "es",
  "it",
  "nl",
  "ch",
  "ie",
  "ca",
  "au",
  "in",
  // lusófonos
  "pt",
  "br",
  "mz",
  "ao",
  "cv",
  "gw",
  "st",
  "tl",
] as const;

const TLD_ALT = TLDS.join("|");
const LABEL_END = "(?![\\p{L}\\p{N}-])";

const DOMAIN = new RegExp(
  `[\\p{L}\\p{N}-]{1,63}(?:\\s+\\.\\s*|\\.)(?:${TLD_ALT})${LABEL_END}`,
  "u",
);
const SCHEME = /\b(?:https?|hxxps?|ftps?|sftp|wss?)\s{0,2}:\s{0,2}\/{1,2}/u;
const WWW = /\bwww\s{0,2}\./u;

const DOT_WORD = new RegExp(`\\s+dot\\s+(?=(?:${TLD_ALT})${LABEL_END})`, "gu");
const PONTO_WORD =
  /\s+ponto\s+(?=(?:com|net|org|info|biz)(?:\s+(?:br|pt|mz|ao)\b)?(?=\s*(?:$|[^\p{L}\s])))/gu;

function deobfuscate(text: string): string {
  return text.replace(DOT_WORD, ".").replace(PONTO_WORD, ".");
}

function toSkeleton(lowerCleaned: string): string {
  return deobfuscate(
    lowerCleaned.replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c),
  );
}

const EMAIL =
  /[\p{L}\p{N}._%+-](?:@|\s{1,3}@\s{1,3}|\s{0,3}[[(]\s*at\s*[\])]\s{0,3}|\sarroba\s)[\p{L}\p{N}]/u;

const DIGIT_RUN = /\+?\(?\d(?:[\s.\-()_,/|]{0,2}\d){6,}/gu;

const PHONE_NATIONAL: readonly RegExp[] = [
  /^(?:00351|351)?9[1236]\d{7}$/, // Portugal
  /^(?:00258|258)?8[2-7]\d{7}$/, // Moçambique
  /^(?:00244|244)?9[1-5]\d{7}$/, // Angola
  /^(?:0055|55)?[1-9]{2}9\d{8}$/, // Brasil (móvel: DDD + 9 + 8 dígitos)
];

function hasPhone(text: string): boolean {
  for (const match of text.matchAll(DIGIT_RUN)) {
    const run = match[0];
    const digits = run.replace(/\D/g, "");
    if (digits.length > 15) continue;
    if (run.startsWith("+") && digits.length >= 8) return true;
    if (PHONE_NATIONAL.some((re) => re.test(digits))) return true;
  }
  return false;
}

const MESSENGER_WITH_NUMBER =
  /(?:whats\s?app|zap|telegram|signal|viber)\b.{0,40}?\d(?:[^\d]{0,2}\d){5,}/u;

const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(
  `(?<![\\d.])(?<!\\bv(?:ers[aã]o|ersion)?\\s{0,2})(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}(?![\\d]|\\.\\d)`,
  "u",
);
const IPV6 =
  /(?<![\p{L}\p{N}:])(?:(?:[a-f0-9]{1,4}:){3,7}[a-f0-9]{1,4}|(?:[a-f0-9]{1,4}:){1,6}:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){0,5})(?![\p{L}\p{N}:])/u;

const CAPS_MIN_LENGTH = 50; // len > 50
const CAPS_RATIO = 0.5; // > 50 % das letras em maiúsculas
const REPETITION = /(.)\1{9,}/u;
const PUNCTUATION_SPAM = /[!?]{5,}/u;
const SPAM_KEYWORDS =
  /\b(?:bitcoins?|criptomoedas?|investimento garantido|ganhe dinheiro|ganhos rapidos|clique aqui|premios?|sorteios?|renda extra|multiplica teu dinheiro)\b/u;
const MESSENGER_WORD = /\b(?:whats\s?app|zap|telegram|signal|viber)\b/u;

function hasMixedScript(text: string): boolean {
  // Por palavra (linear): letras latinas misturadas com cirílico/grego na mesma palavra.
  for (const token of text.split(" ")) {
    if (
      /\p{Script=Latin}/u.test(token) &&
      /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(token)
    ) {
      return true;
    }
  }
  return false;
}

function capsSignal(text: string): boolean {
  if (text.length <= CAPS_MIN_LENGTH) return false;
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return false;
  const upper = text.match(/\p{Lu}/gu)?.length ?? 0;
  return upper / letters > CAPS_RATIO;
}

const REJECT_LINK: ContentViolation = {
  kind: "link",
  code: "link",
  hint: "não aceitamos ligações externas (se foi só falta de espaço depois do ponto, acrescenta-o)",
};
const REJECT_CONTACT: ContentViolation = {
  kind: "contact",
  code: "contact",
  hint: "não aceitamos emails, telefones ou IPs",
};

export function checkContent(
  title: string,
  content: string,
): ContentCheckResult {
  const cleaned = clean(`${title} ${content}`);
  const lower = cleaned.toLowerCase();
  const skeleton = toSkeleton(lower);

  if (
    EMAIL.test(skeleton) ||
    hasPhone(skeleton) ||
    MESSENGER_WITH_NUMBER.test(skeleton) ||
    IPV4.test(skeleton) ||
    IPV6.test(skeleton)
  ) {
    return { reject: true, violations: [REJECT_CONTACT] };
  }

  if (SCHEME.test(skeleton) || WWW.test(skeleton) || DOMAIN.test(skeleton)) {
    return { reject: true, violations: [REJECT_LINK] };
  }

  const flags: ContentViolation[] = [];
  const signal = (code: ContentFlagCode, hint: string): void => {
    flags.push({ kind: "spam_signal", code, hint });
  };

  if (capsSignal(cleaned)) signal("caps", "demasiadas maiúsculas");
  if (REPETITION.test(lower)) {
    signal("repetition", "repetição excessiva de caracteres");
  }
  if (PUNCTUATION_SPAM.test(lower))
    signal("punctuation", "pontuação excessiva");
  if (SPAM_KEYWORDS.test(stripAccents(lower))) {
    signal("keywords", "palavras associadas a spam");
  }
  if (MESSENGER_WORD.test(skeleton)) {
    signal("contact_solicitation", "pedido de contacto por mensagens privadas");
  }
  if (hasMixedScript(lower)) {
    signal("mixed_script", "mistura de alfabetos na mesma palavra");
  }

  return { reject: false, flags };
}

/** Códigos dos sinais, para guardar em `posts.review_flags`. */
export function flagCodes(result: ContentCheckResult): ContentFlagCode[] {
  if (result.reject) return [];
  return result.flags
    .map((f) => f.code)
    .filter((c): c is ContentFlagCode => c !== "link" && c !== "contact");
}
