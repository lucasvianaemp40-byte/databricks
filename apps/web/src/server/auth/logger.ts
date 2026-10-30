import 'server-only';

/**
 * Logger do Better Auth sem dado pessoal (LC-12), até o logger com redaction do T2.
 *
 * O Better Auth interpola o e-mail em mensagens ("Sign-up attempt for existing email: …") e
 * passa erros do banco como argumentos extras (o `DrizzleQueryError` traz os parâmetros da
 * consulta). Aqui só sai o nível e a mensagem com e-mails, IPs e tokens mascarados; os
 * argumentos extras nunca são impressos, só o nome do erro e o SQLSTATE quando houver.
 */

type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error';

const EMAIL = /[^\s@<>()"']+@[^\s@<>()"']+/g;
// eslint-disable-next-line security/detect-unsafe-regex -- repetição fixa ({3}) de grupo com quantificador limitado: linear.
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
/** Sequências longas sem espaço (tokens, JWTs, hashes). */
const TOKEN = /[A-Za-z0-9_\-.]{32,}/g;

function redactAuthLog(message: string): string {
  return message
    .replaceAll(EMAIL, '[e-mail]')
    .replaceAll(IPV4, '[ip]')
    .replaceAll(TOKEN, '[token]');
}

function describeArgument(argument: unknown): string | undefined {
  if (!(argument instanceof Error)) {
    return undefined;
  }
  let current: unknown = argument;
  for (let depth = 0; depth < 8 && current instanceof Object; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return `${argument.name} (SQLSTATE ${code})`;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return argument.name;
}

export function formatAuthLog(level: LogLevel, message: string, args: readonly unknown[]): string {
  const details = args.map(describeArgument).filter((detail) => detail !== undefined);
  const suffix = details.length > 0 ? ` [${details.join(', ')}]` : '';
  return `[auth] ${level}: ${redactAuthLog(message)}${suffix}`;
}

export const authLogger = {
  level: 'warn' as const,
  log(level: LogLevel, message: string, ...args: unknown[]): void {
    const line = formatAuthLog(level, message, args);
    if (level === 'error') {
      console.error(line);
    } else {
      console.warn(line);
    }
  },
};
