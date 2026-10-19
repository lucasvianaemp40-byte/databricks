// Fixture de `semgrep --test` para server-timezone-date. Código errado de propósito.
declare const startsAt: Date;
declare const priceCents: number;
declare const timeZone: string;

export function wrong(): unknown[] {
  return [
    // ruleid: server-timezone-date
    startsAt.getHours(),
    // ruleid: server-timezone-date
    startsAt.getDay(),
    // ruleid: server-timezone-date
    startsAt.getTimezoneOffset(),
    // ruleid: server-timezone-date
    startsAt.toLocaleDateString('pt-BR'),
    // ruleid: server-timezone-date
    startsAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    // ruleid: server-timezone-date
    startsAt.toLocaleString('pt-BR'),
    // ruleid: server-timezone-date
    new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }),
    // ruleid: server-timezone-date
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    // ruleid: server-timezone-date
    new Date(2026, 10, 3, 9, 0),
    // Data-hora em texto sem Z/offset: interpretada no fuso do processo.
    // ruleid: server-timezone-date
    new Date('2026-10-17T10:00:00'),
    // ruleid: server-timezone-date
    Date.parse('2026-10-17 10:00'),
    // ruleid: server-timezone-date
    new Date('2026-10-17T10:00:00.123'),
    // ruleid: server-timezone-date
    new Date(`2026-10-17T10:00`),
    // ruleid: server-timezone-date
    new Date(`${String(priceCents)}T10:00`),
    // O V8 também lê no fuso local o 't' minúsculo e o ano expandido (±AAAAAA).
    // ruleid: server-timezone-date
    new Date('2026-10-17t10:00'),
    // ruleid: server-timezone-date
    Date.parse('+002026-10-17T10:00:00'),
    // ruleid: server-timezone-date
    new Date('-000001-01-01 00:00'),
    // ruleid: server-timezone-date
    new Date(`${String(priceCents)}t10:00`),
  ];
}

export function right(): unknown[] {
  return [
    // ok: server-timezone-date
    startsAt.getTime(),
    // ok: server-timezone-date
    startsAt.getUTCHours(),
    // ok: server-timezone-date
    startsAt.toISOString(),
    // ok: server-timezone-date
    startsAt.toLocaleDateString('pt-BR', { timeZone }),
    // ok: server-timezone-date
    startsAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    // ok: server-timezone-date
    new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone }),
    // ok: server-timezone-date
    (priceCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    // ok: server-timezone-date
    new Date(Date.UTC(2026, 10, 3, 12, 0)),
    // Com Z ou offset explícito, ou só data (ECMA-262 trata 'AAAA-MM-DD' como UTC).
    // ok: server-timezone-date
    new Date('2026-10-17T10:00:00Z'),
    // ok: server-timezone-date
    new Date('2026-10-17T10:00:00-03:00'),
    // ok: server-timezone-date
    Date.parse('2026-10-17T10:00:00.000+00:00'),
    // ok: server-timezone-date
    new Date('2026-10-17'),
    // ok: server-timezone-date
    new Date(startsAt.getTime()),
    // ok: server-timezone-date
    new Date(`${String(priceCents)}T10:00:00Z`),
    // ok: server-timezone-date
    new Date('+002026-10-17T10:00:00Z'),
    // ok: server-timezone-date
    new Date('2026-10-17t10:00z'),
    // ok: server-timezone-date
    new Date('+002026-10-17'),
  ];
}
