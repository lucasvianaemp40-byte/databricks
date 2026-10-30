/**
 * Endereço público do salão (`/<slug>`, página de agendamento futura): derivado do nome e
 * validado com o MESMO padrão do CHECK do banco (`SLUG_PATTERN` do @salon/db; teste de
 * paridade em slug.test.ts). Este módulo é puro e roda também no navegador (prévia do
 * endereço no formulário): não importe o @salon/db aqui.
 */

/** Igual a `SLUG_PATTERN` do @salon/db (o teste de paridade falha se divergir). */
// eslint-disable-next-line security/detect-unsafe-regex -- quantificador limitado a 61 e sem aninhamento: linear (e é o CHECK do banco).
export const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** O banco aceita 1 caractere; o produto exige 3 para reduzir a disputa por nomes curtos. */
const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 63;

/**
 * Reservados: segmentos de rota do app e do Next (a página `/[slug]` não pode sombrear uma
 * rota), arquivos especiais e nomes que imitam a plataforma. O teste confere que todo
 * segmento de topo de src/app está aqui: rota nova sem reserva reprova o unit.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // Rotas do app (src/app) e do Better Auth.
  'api',
  'app',
  'auth',
  'cadastro',
  'entrar',
  'sair',
  // Arquivos especiais e convenções do Next.
  'apple-icon',
  'favicon',
  'icon',
  'manifest',
  'opengraph-image',
  'robots',
  'sitemap',
  'twitter-image',
  'static',
  'public',
  'assets',
  // Plataforma e páginas institucionais futuras.
  'admin',
  'administrador',
  'agenda',
  'agenda-salao',
  'agendasalao',
  'ajuda',
  'blog',
  'conta',
  'configuracoes',
  'contato',
  'dashboard',
  'docs',
  'equipe',
  'health',
  'login',
  'logout',
  'minha-conta',
  'oficial',
  'painel',
  'planos',
  'precos',
  'privacidade',
  'seguranca',
  'signup',
  'sobre',
  'status',
  'suporte',
  'termos',
  'www',
]);

const COMBINING_MARKS = /\p{M}/gu;
const NOT_SLUG_CHARACTERS = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;

/** Nome -> slug: sem acento, minúsculas, `[a-z0-9-]`, até 63 caracteres. Pode devolver ''. */
export function slugify(text: string): string {
  const base = text
    .normalize('NFD')
    .replaceAll(COMBINING_MARKS, '')
    .toLowerCase()
    .replaceAll(NOT_SLUG_CHARACTERS, '-')
    .replaceAll(EDGE_HYPHENS, '');
  return base.slice(0, SLUG_MAX_LENGTH).replaceAll(EDGE_HYPHENS, '');
}

/**
 * 8 ou mais dígitos, ignorando hífens: CPF, CNPJ ou telefone viraria URL pública (LGPD,
 * minimização; docs/lgpd/inventario-de-dados.md).
 */
const LONG_DIGIT_RUN = /\d{8,}/;

/** Formato do banco, mínimo de 3 caracteres, sem documento/telefone e fora dos reservados. */
export function isUsableSalonSlug(slug: string): boolean {
  return (
    slug.length >= SLUG_MIN_LENGTH &&
    SLUG_REGEX.test(slug) &&
    !RESERVED_SLUGS.has(slug) &&
    !LONG_DIGIT_RUN.test(slug.replaceAll('-', ''))
  );
}
