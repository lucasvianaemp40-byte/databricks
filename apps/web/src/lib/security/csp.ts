/**
 * Construtor da Content-Security-Policy. Função pura: recebe o nonce e o modo, devolve o valor
 * do cabeçalho. Quem gera o nonce e anexa o cabeçalho é o Proxy (src/proxy.ts).
 *
 * Política estrita baseada em nonce (CSP3, ASVS 5.0 3.4.3 nível 2):
 * - script-src com 'nonce-…' e 'strict-dynamic': só executam scripts com o nonce desta resposta
 *   e os que eles carregarem. O 'self' é ignorado por navegadores com CSP3 e serve de
 *   compatibilidade para CSP2. Nunca 'unsafe-inline' em script-src.
 * - style-src 'self' + nonce em produção: o Tailwind gera um arquivo CSS servido pela própria
 *   origem e o Next aplica o nonce aos <style> que ele mesmo injeta. Não usamos atributos
 *   style="…" (proibidos pela política; os E2E falham se houver violação de CSP).
 *   Desvio previsto no ASVS 3.4.3: se um componente de UI exigir atributos style, a saída é
 *   'unsafe-inline' SÓ em style-src, registrado em docs/seguranca/asvs-l2.md; hoje não é necessário.
 * - object-src 'none', base-uri 'none' (o exemplo do Next usa 'self'; o ASVS L2 pede 'none'),
 *   frame-ancestors 'none' (o embed em site do salão, se vier, terá rota e política próprias),
 *   form-action 'self'.
 * - upgrade-insecure-requests só em produção.
 *
 * Desenvolvimento (NODE_ENV=development, nunca em build de produção):
 * - script-src ganha 'unsafe-eval': o React usa eval para reconstruir pilhas de erro do
 *   servidor no navegador.
 * - style-src troca o nonce por 'unsafe-inline': o HMR injeta <style> sem nonce. Os dois não
 *   podem coexistir, porque a presença de um nonce faz o navegador ignorar 'unsafe-inline'.
 * - O HMR usa WebSocket na mesma origem; connect-src 'self' já cobre ws:/wss: do mesmo host.
 */
import { isValidNonce } from './nonce';

export type CspMode = 'production' | 'development';

export interface CspOptions {
  /** Nonce desta resposta, gerado por generateNonce(). */
  readonly nonce: string;
  /** 'development' relaxa o necessário para o HMR; qualquer outro ambiente usa 'production'. */
  readonly mode: CspMode;
}

/** Diretivas na ordem em que são serializadas (ordem estável facilita revisão e testes). */
export type CspDirectives = ReadonlyArray<readonly [directive: string, sources: readonly string[]]>;

/** Monta as diretivas da política. Exportado para testes e para revisão de segurança. */
export function cspDirectives({ nonce, mode }: CspOptions): CspDirectives {
  if (!isValidNonce(nonce)) {
    // Um nonce fora do formato pode injetar diretivas (";") ou quebrar o cabeçalho (CR/LF).
    throw new TypeError('Nonce de CSP inválido: use generateNonce().');
  }
  const isDevelopment = mode === 'development';
  const nonceSource = `'nonce-${nonce}'`;

  const directives: Array<readonly [string, readonly string[]]> = [
    ['default-src', ["'self'"]],
    [
      'script-src',
      ["'self'", nonceSource, "'strict-dynamic'", ...(isDevelopment ? ["'unsafe-eval'"] : [])],
    ],
    ['style-src', ["'self'", isDevelopment ? "'unsafe-inline'" : nonceSource]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
    ['form-action', ["'self'"]],
  ];
  if (!isDevelopment) {
    directives.push(['upgrade-insecure-requests', []]);
  }
  return directives;
}

/** Serializa as diretivas no formato do cabeçalho Content-Security-Policy. */
export function serializeCsp(directives: CspDirectives): string {
  return directives.map(([directive, sources]) => [directive, ...sources].join(' ')).join('; ');
}

/** Valor do cabeçalho Content-Security-Policy para uma resposta. */
export function buildContentSecurityPolicy(options: CspOptions): string {
  return serializeCsp(cspDirectives(options));
}
