import { randomBytes } from "node:crypto";
import type { PasswordService } from "./password.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export interface GeneratedRecoveryCode {
  formatted: string; // XXXX-XXXX-XXXX-XXXX (mostrado ao utilizador)
  canonical: string; // XXXXXXXXXXXXXXXXXX (usado para hash)
}

export function generateRecoveryCode(): GeneratedRecoveryCode {
  const bytes = randomBytes(10); // 80 bits
  const canonical = base32Encode(bytes);
  const formatted = canonical.match(/.{1,4}/g)!.join("-");
  return { formatted, canonical };
}

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

export interface RecoveryService {
  generate(): GeneratedRecoveryCode;
  hashCode(code: string): Promise<string>;
  verifyCode(storedHash: string, code: string): Promise<boolean>;
}

export function createRecoveryService(
  passwordService: PasswordService,
): RecoveryService {
  return {
    generate: generateRecoveryCode,
    async hashCode(code) {
      return passwordService.hashAnswer(normalizeRecoveryCode(code));
    },
    async verifyCode(storedHash, code) {
      return passwordService.verifyAnswer(
        storedHash,
        normalizeRecoveryCode(code),
      );
    },
  };
}
