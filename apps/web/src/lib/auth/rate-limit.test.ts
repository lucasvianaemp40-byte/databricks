import { describe, expect, it } from 'vitest';
import { clientIp, SlidingWindowLimiter } from './rate-limit';

function limiter(limit: number, windowMs: number, maxKeys = 100) {
  let now = 1_000_000;
  const instance = new SlidingWindowLimiter({ limit, windowMs, maxKeys }, () => now);
  return {
    instance,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('SlidingWindowLimiter', () => {
  it('aceita até o limite na janela e recusa a próxima tentativa', () => {
    const { instance } = limiter(3, 60_000);
    expect([1, 2, 3].map(() => instance.hit('ip:1'))).toEqual([true, true, true]);
    expect(instance.hit('ip:1')).toBe(false);
  });

  it('janela deslizante: as tentativas antigas saem da conta', () => {
    const { instance, advance } = limiter(2, 60_000);
    instance.hit('k');
    advance(30_000);
    instance.hit('k');
    expect(instance.hit('k')).toBe(false);
    // A recusada (em +30 s) também conta: só depois que ela sai da janela a porta reabre.
    advance(59_999);
    expect(instance.hit('k')).toBe(false);
    advance(60_001);
    expect(instance.hit('k')).toBe(true);
  });

  it('tentativa recusada também conta (insistir não abre a porta mais cedo)', () => {
    const { instance, advance } = limiter(1, 60_000);
    instance.hit('k');
    advance(50_000);
    expect(instance.hit('k')).toBe(false);
    advance(20_000);
    expect(instance.hit('k')).toBe(false);
  });

  it('chaves independentes', () => {
    const { instance } = limiter(1, 60_000);
    expect(instance.hit('email:a')).toBe(true);
    expect(instance.hit('email:b')).toBe(true);
    expect(instance.hit('email:a')).toBe(false);
  });

  it('memória limitada: não guarda mais chaves que o teto', () => {
    const { instance } = limiter(5, 60_000, 10);
    for (let index = 0; index < 1000; index += 1) {
      instance.hit(`ip:${index}`);
    }
    expect(instance.size).toBeLessThanOrEqual(10);
  });
});

describe('clientIp', () => {
  it('usa x-real-ip, depois o primeiro x-forwarded-for, e "desconhecido" sem cabeçalho', () => {
    expect(
      clientIp(new Headers({ 'x-real-ip': '203.0.113.5', 'x-forwarded-for': '1.1.1.1' })),
    ).toBe('203.0.113.5');
    expect(clientIp(new Headers({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }))).toBe(
      '198.51.100.7',
    );
    expect(clientIp(new Headers())).toBe('desconhecido');
  });

  it('corta valores enormes (a chave fica em memória)', () => {
    expect(clientIp(new Headers({ 'x-real-ip': 'x'.repeat(500) })).length).toBeLessThanOrEqual(64);
  });
});
