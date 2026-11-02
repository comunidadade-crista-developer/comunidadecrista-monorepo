const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
const BRACKET_DOT = /[\[(]\s*[.．。]\s*[\])]/g;
const WHITESPACE = /\s+/g;
const ACCENTS = /[\u0300-\u036F]/g;
const DIGIT_SEPARATORS = /[\s.\-()]/g;

function normalizePreserveCase(text: string): string {
  return text
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(BRACKET_DOT, '.')
    .replace(WHITESPACE, ' ')
    .trim();
}

function normalize(text: string): string {
  return normalizePreserveCase(text).toLowerCase();
}

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(ACCENTS, '').normalize('NFC');
}

const TLD =
  /\.(?:com|xyz|top|buzz|bond|sbs|cfd|li|ru|es|dev|icu|tk|ml|ga|cf|gq|zip|mov)\b/;
const MULTI_PART =
  /\.(?:pages\.dev|vercel\.app|github\.io|netlify\.app|workers\.dev|dweb\.link|co\.uk|com\.br)\b/;
const SCHEME = /\b(?:https?|hxxps?|ftp|ftps)\s*:\s*\/{1,2}/;
const WWW = /\bwww\s*\./;
const SHORTENER =
  /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rb\.gy)\b/;

// ---------- Contactos ----------

const EMAIL = /[a-z0-9._%+-]+\s*(?:@|＠|\(at\)|\[at\])\s*[a-z0-9.-]+\.[a-z]{2,}/;
// Tolera separadores dentro do número (+, 351, 9XXXXXXXX com espaços).
const PHONE_PT = /(?:^|[^\d])(?:\+?351|00351)?9[1236]\d{7}(?!\d)/;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const IPV6_SHORT = /\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9]{1,4}\b/;

const CAPS_MIN_LETTERS = 10;
const CAPS_RATIO = 0.8;
const REPETITION = /(.)\1{9,}/;
const PUNCTUATION_SPAM = /[!?]{5,}/;
const SPAM_KEYWORDS =
  /\b(?:bitcoin|criptomoeda|investimento garantido|ganhe dinheiro|ganhos rapidos|clique aqui|premio|sorteio|renda extra|multiplica teu dinheiro)\b/;

export interface ContentViolation {
  kind: 'link' | 'contact' | 'spam_signal';
  hint: string;
}

export type ContentCheckResult =
  | { reject: true; violations: ContentViolation[] }
  | { reject: false; flags: ContentViolation[] };

export function checkContent(title: string, content: string): ContentCheckResult {
  const combined = `${title} ${content}`;
  const normalized = normalize(combined);
  const preserveCase = normalizePreserveCase(combined);
  const digitsJoined = normalized.replace(DIGIT_SEPARATORS, '');

  if (
    EMAIL.test(normalized) ||
    PHONE_PT.test(digitsJoined) ||
    IPV4.test(normalized) ||
    IPV6_SHORT.test(normalized)
  ) {
    return {
      reject: true,
      violations: [{ kind: 'contact', hint: 'não aceitamos emails, telefones ou IPs' }],
    };
  }

  // ---- Links ----
  if (
    SCHEME.test(normalized) ||
    WWW.test(normalized) ||
    TLD.test(normalized) ||
    MULTI_PART.test(normalized) ||
    SHORTENER.test(normalized)
  ) {
    return {
      reject: true,
      violations: [{ kind: 'link', hint: 'não aceitamos ligações externas' }],
    };
  }

  const flags: ContentViolation[] = [];

  const letters = preserveCase.replace(/[^\p{L}]/gu, '');
  const uppercase = preserveCase.replace(/[^\p{Lu}]/gu, '');
  if (
    letters.length >= CAPS_MIN_LETTERS &&
    uppercase.length / letters.length >= CAPS_RATIO
  ) {
    flags.push({ kind: 'spam_signal', hint: 'demasiadas maiúsculas' });
  }

  if (REPETITION.test(normalized)) {
    flags.push({ kind: 'spam_signal', hint: 'repetição excessiva de caracteres' });
  }
  if (PUNCTUATION_SPAM.test(normalized)) {
    flags.push({ kind: 'spam_signal', hint: 'pontuação excessiva' });
  }
  if (SPAM_KEYWORDS.test(stripAccents(normalized))) {
    flags.push({ kind: 'spam_signal', hint: 'palavras associadas a spam' });
  }

  return { reject: false, flags };
}