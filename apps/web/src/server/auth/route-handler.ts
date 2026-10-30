import { authRoutePath, clientIp, isAllowedAuthRoute, requiresClientIp } from './http-policy';

/**
 * Handler HTTP de `/api/auth/*` em volta do Better Auth (testado sem servidor). Nega por
 * padrão: rota fora da lista fechada responde 404 antes de chegar à biblioteca.
 */
export interface AuthHandlerOptions {
  readonly appEnv: string;
  readonly handle: (request: Request) => Promise<Response>;
  /** Padrão: `console.error`. Recebe só a rota, o nome do erro e o SQLSTATE. */
  readonly logFailure?: (line: string) => void;
}

/**
 * Nome do erro e SQLSTATE (procurado na cadeia `cause`), nunca a mensagem: a do
 * `DrizzleQueryError` traz os parâmetros da consulta (e-mail, nome, IP).
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'erro desconhecido';
  }
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Object; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return `${error.name} (SQLSTATE ${code})`;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return error.name;
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function json(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message }), { status, headers: JSON_HEADERS });
}

/** Cabeçalhos de toda resposta de autenticação (LC-17, LC-34). */
function secureResponse(response: Response, path: string | undefined): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  // O link de confirmação leva o token na URL: nunca vai em Referer.
  headers.set('referrer-policy', 'no-referrer');
  if (path === '/sign-out' && response.ok) {
    // Apaga cache e armazenamento do navegador: "voltar" não mostra o painel.
    headers.set('clear-site-data', '"cache", "storage"');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createAuthRouteHandler(options: AuthHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!isAllowedAuthRoute(request.method, url)) {
      return json(404, 'NOT_FOUND', 'Não encontrado.');
    }
    if (requiresClientIp(options.appEnv) && clientIp(request.headers) === undefined) {
      return json(400, 'CLIENT_IP_REQUIRED', 'Requisição inválida.');
    }
    const path = authRoutePath(url);
    let response: Response;
    try {
      response = await options.handle(request);
    } catch (error) {
      // Sem isto, o Next registraria o erro cru (com os parâmetros da consulta) no log.
      const log = options.logFailure ?? ((line: string) => console.error(line));
      log(`[auth] falha em ${request.method.toUpperCase()} ${path ?? ''}: ${describeError(error)}`);
      return json(500, 'INTERNAL_ERROR', 'Não foi possível concluir agora.');
    }
    return secureResponse(response, path);
  };
}
