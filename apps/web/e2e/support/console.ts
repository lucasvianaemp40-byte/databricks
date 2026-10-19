import type { ConsoleMessage } from '@playwright/test';

/**
 * Classificação das mensagens de console que reprovam um teste (usada pela fixture
 * `failOnConsoleErrors`). Separada da fixture para ser testada com mensagens reais do
 * Chromium em e2e/console-guard.spec.ts.
 *
 * O que o Chromium registra e com que nível (conferido no Chromium 141):
 * - violação de CSP ("Refused to execute…"), recurso 404, falha de hidratação: `error`;
 * - Permissions-Policy malformada ("Parse of permissions policy failed…"): `error`;
 * - Permissions-Policy com recurso que o navegador não reconhece ("Unrecognized feature"):
 *   só `warning`. Por isso avisos de Permissions-Policy também reprovam.
 */

/**
 * Recursos da Permissions-Policy (src/lib/security/headers.ts) que o Chromium do Linux, onde
 * os E2E rodam, não reconhece porque a API está desligada por padrão nessa plataforma. No
 * Chrome do Android, Windows e macOS (o público do app) o nome é reconhecido e a negação vale,
 * então eles continuam no cabeçalho e só o aviso EXATO de cada um é tolerado aqui.
 */
export const PLATFORM_GATED_PERMISSIONS: readonly string[] = ['bluetooth'];

/** Rota sem página no app: o navegador registra no console o 404 do próprio documento. */
export const MISSING_PAGE_PATH = '/pagina-que-nao-existe';

/**
 * Só o 404 do DOCUMENTO em MISSING_PAGE_PATH (o texto termina com a URL que falhou). Um 404 de
 * CSS, JS ou imagem nessa página tem outra URL e continua reprovando o teste.
 */
export const MISSING_PAGE_DOCUMENT_404 =
  /status of 404 \(Not Found\) \(https?:\/\/[^/\s]+\/pagina-que-nao-existe\)$/;

export type ConsoleMessageLike = Pick<ConsoleMessage, 'location' | 'text' | 'type'>;

function isPlatformGatedWarning(text: string): boolean {
  return PLATFORM_GATED_PERMISSIONS.some(
    (feature) =>
      text === `Error with Permissions-Policy header: Unrecognized feature: '${feature}'.`,
  );
}

/**
 * Devolve a descrição do problema (nível, texto e URL de origem) ou `undefined` quando a
 * mensagem não reprova o teste. `allowed` casa com "texto (URL)", sem o nível.
 */
export function consoleProblem(
  message: ConsoleMessageLike,
  allowed: readonly RegExp[] = [],
): string | undefined {
  const type = message.type();
  const text = message.text();
  const isPermissionsPolicyWarning = type === 'warning' && text.includes('Permissions-Policy');
  if (type !== 'error' && !isPermissionsPolicyWarning) {
    return undefined;
  }
  if (isPermissionsPolicyWarning && isPlatformGatedWarning(text)) {
    return undefined;
  }
  const described = `${text} (${message.location().url})`;
  if (allowed.some((pattern) => pattern.test(described))) {
    return undefined;
  }
  return `${type}: ${described}`;
}
