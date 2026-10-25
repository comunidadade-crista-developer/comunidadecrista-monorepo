import { describe, expect, it } from 'vitest';
import { createPasswordService, normalizeAnswer } from '../../src/auth/password.js';
import { loadEnv } from '../../src/env.js';

const env = loadEnv({ NODE_ENV: 'test' });
const svc = createPasswordService(env);

describe('password service', () => {
  it('hash + verify correcto', async () => {
    const h = await svc.hashPassword('segredo123');
    expect(h).toMatch(/^\$argon2id\$/);
    expect(await svc.verifyPassword(h, 'segredo123')).toBe(true);
    expect(await svc.verifyPassword(h, 'errado')).toBe(false);
  });

  it('hashes diferentes para o mesmo password (salt)', async () => {
    const a = await svc.hashPassword('x');
    const b = await svc.hashPassword('x');
    expect(a).not.toBe(b);
  });

  it('verify contra hash inválido devolve false', async () => {
    expect(await svc.verifyPassword('lixo', 'x')).toBe(false);
  });

  it('normalizeAnswer: lowercase + trim + colapso', () => {
    expect(normalizeAnswer('  IGREJA   DA   Graça  ')).toBe('igreja da graça');
  });

  it('verifyAnswer normaliza dos dois lados', async () => {
    const h = await svc.hashAnswer('  Azul  ');
    expect(await svc.verifyAnswer(h, 'azul')).toBe(true);
    expect(await svc.verifyAnswer(h, 'AZUL')).toBe(true);
    expect(await svc.verifyAnswer(h, 'verde')).toBe(false);
  });
});