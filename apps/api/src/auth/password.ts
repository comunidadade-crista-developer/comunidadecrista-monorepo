import { hash, verify } from '@node-rs/argon2';
import type { Env } from '../env.js';

export interface PasswordService {
  hashPassword(password: string): Promise<string>;
  verifyPassword(passwordHash: string, password: string): Promise<boolean>;
  hashAnswer(answer: string): Promise<string>;
  verifyAnswer(answerHash: string, answer: string): Promise<boolean>;
}

export function normalizeAnswer(answer: string): string {
  return answer.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

export function createPasswordService(env: Env): PasswordService {
  const opts = {
    memoryCost: env.ARGON2_MEMORY_KB,
    timeCost: env.ARGON2_TIME_COST,
    parallelism: env.ARGON2_PARALLELISM,
  };

  return {
    async hashPassword(p: string): Promise<string> {
      return hash(p, opts);
    },
    async verifyPassword(stored, p) {
      try {
        return await verify(stored, p, opts);
      } catch {
        return false;
      }
    },
    async hashAnswer(a) {
      return hash(normalizeAnswer(a), opts);
    },
    async verifyAnswer(stored, a) {
      try {
        return await verify(stored, normalizeAnswer(a), opts);
      } catch {
        return false;
      }
    },
  };
}