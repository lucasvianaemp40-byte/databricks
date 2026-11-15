/**
 * Limite de tentativas em memória para login e cadastro (threat model A2 e A13, provisório).
 *
 * O limitador do Better Auth só roda no roteador HTTP, e as Server Actions chamam a API dele
 * direto (não há rota /api/auth). Este cobre a lacuna até a 2ª entrega do ADR-0004, que traz
 * o limite em banco (vale entre instâncias) e o Turnstile. Limitações conhecidas: conta por
 * processo (cada instância tem a sua), e o IP vem de cabeçalho que só a plataforma deve
 * definir (x-real-ip na Vercel, não verificado).
 */

export interface LimitRule {
  /** Tentativas aceitas por chave dentro da janela. */
  readonly limit: number;
  readonly windowMs: number;
  /** Teto de chaves em memória (protege contra estouro com IPs ou e-mails aleatórios). */
  readonly maxKeys: number;
}

export class SlidingWindowLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly rule: LimitRule;
  private readonly now: () => number;

  constructor(rule: LimitRule, now: () => number = Date.now) {
    this.rule = rule;
    this.now = now;
  }

  get size(): number {
    return this.attempts.size;
  }

  /** Registra a tentativa e diz se ela está dentro do limite. Recusada também conta. */
  hit(key: string): boolean {
    const now = this.now();
    const since = now - this.rule.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter((at) => at > since);
    recent.push(now);
    // Reinsere no fim: a ordem do Map vira "menos recente primeiro" para o despejo.
    this.attempts.delete(key);
    this.attempts.set(key, recent);
    this.evict(since);
    return recent.length <= this.rule.limit;
  }

  private evict(since: number): void {
    if (this.attempts.size <= this.rule.maxKeys) {
      return;
    }
    for (const [key, times] of this.attempts) {
      if ((times.at(-1) ?? 0) <= since) {
        this.attempts.delete(key);
      }
    }
    for (const key of this.attempts.keys()) {
      if (this.attempts.size <= this.rule.maxKeys) {
        break;
      }
      this.attempts.delete(key);
    }
  }
}

const MAX_IP_LENGTH = 64;

/** IP do cliente para o limite: x-real-ip, senão o primeiro x-forwarded-for. */
export function clientIp(headers: Headers): string {
  const direct = headers.get('x-real-ip')?.trim();
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = direct || forwarded || 'desconhecido';
  return ip.slice(0, MAX_IP_LENGTH);
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

/** Instâncias do processo. Os limites folgam para uso real e seguram força bruta e custo de scrypt. */
export const authLimits = {
  signInByIp: new SlidingWindowLimiter({ limit: 30, windowMs: FIFTEEN_MINUTES, maxKeys: 10_000 }),
  signInByEmail: new SlidingWindowLimiter({
    limit: 10,
    windowMs: FIFTEEN_MINUTES,
    maxKeys: 10_000,
  }),
  signUpByIp: new SlidingWindowLimiter({ limit: 30, windowMs: ONE_HOUR, maxKeys: 10_000 }),
};
