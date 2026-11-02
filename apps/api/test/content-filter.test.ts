import { describe, expect, it } from 'vitest';
import { checkContent } from '@comunidade/shared';

describe('checkContent — link (rejeita)', () => {
  it.each([
    ['https://x.com'],
    ['www.x.com'],
    ['x[.]com'],
    ['ｘ.ｃｏｍ'],
    ['exem\u200Bplo.com'],
    ['igreja.pages.dev'],
    ['bit.ly/abc'],
    ['visita igreja.xyz'],
  ])('rejeita %s', (content) => {
    const r = checkContent('título', content);
    expect(r.reject).toBe(true);
    if (r.reject) {
      expect(r.violations.some((v) => v.kind === 'link')).toBe(true);
    }
  });
});

describe('checkContent — contacto (rejeita)', () => {
  it.each([
    ['user@x.com'],
    ['user＠x.com'],
    ['912345678'],
    ['+351 912 345 678'],
    ['192.168.1.1'],
  ])('rejeita %s', (content) => {
    const r = checkContent('título', content);
    expect(r.reject).toBe(true);
    if (r.reject) {
      expect(r.violations.some((v) => v.kind === 'contact')).toBe(true);
    }
  });
});

describe('checkContent — referências bíblicas (passa)', () => {
  it.each([
    ['Mateus 2:1-12'],
    ['João 3:16'],
    ['Isaías 7:14'],
    ['O Nascimento de Jesus é descrito em Mateus 2'],
    ['comunidade cristã'],
  ])('aceita %s', (content) => {
    const r = checkContent('título', content);
    expect(r.reject).toBe(false);
  });
});

describe('checkContent — spam signals (não rejeita, sinaliza)', () => {
  it('caps excessivas', () => {
    const r = checkContent('título', 'DEUS É MARAVILHOSO E FIEL EM TODAS AS COISAS');
    expect(r.reject).toBe(false);
    if (!r.reject) {
      expect(r.flags.some((f) => f.hint.includes('maiúsculas'))).toBe(true);
    }
  });

  it('repetição', () => {
    const r = checkContent('título', 'aaaaaaaaaaaa');
    expect(r.reject).toBe(false);
    if (!r.reject) {
      expect(r.flags.some((f) => f.hint.includes('repetição'))).toBe(true);
    }
  });

  it('pontuação', () => {
    const r = checkContent('título', 'Aleluia!!!!!!');
    expect(r.reject).toBe(false);
    if (!r.reject) {
      expect(r.flags.some((f) => f.hint.includes('pontuação'))).toBe(true);
    }
  });

  it('palavra spam', () => {
    const r = checkContent('título', 'ganhe dinheiro fácil, prémio garantido');
    expect(r.reject).toBe(false);
    if (!r.reject) {
      expect(r.flags.some((f) => f.hint.includes('spam'))).toBe(true);
    }
  });
});