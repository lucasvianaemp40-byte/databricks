# @salon/web

App Next.js 16 (App Router, `src/`) do Agenda Salão (nome provisório). Hoje é um **esqueleto
andante seguro**: landing pública, página 404, health check, CSP com nonce, cabeçalhos de
segurança, env validada e testes (unit, E2E, acessibilidade). Autenticação, banco, filas,
Sentry, WhatsApp e Pix entram nas próximas iterações (ver [Próximos passos](#próximos-passos)).

## Comandos

Rode da raiz do monorepo (`pnpm <script>`) ou só deste pacote (`pnpm --filter @salon/web <script>`).

| Script      | O que faz                                                                        |
| ----------- | -------------------------------------------------------------------------------- |
| `dev`       | `next dev` (Turbopack) em http://localhost:3000                                  |
| `build`     | `next build` (inclui typecheck do Next)                                          |
| `start`     | `next start` do build de produção                                                |
| `typecheck` | `next typegen && tsc` (gera os tipos de rota antes; `next-env.d.ts` é ignorado no git) |
| `lint`      | ESLint type-aware (`eslint.base.mjs` + Next + react-hooks); o Biome roda na raiz |
| `test`      | Vitest: unit de `src/**/*.test.ts` (sem navegador e sem servidor)                |
| `e2e`       | Playwright contra `next build && next start` (ver [E2E](#e2e))                   |

## Estrutura

```
src/
  app/                 App Router: layout, página inicial, 404, erros, /api/health, ícone
  lib/security/        CSP (função pura), nonce, cabeçalhos estáticos (+ testes)
  lib/appointment-status-labels.ts   rótulos pt-BR dos status do @salon/scheduling-core
  env.ts               variáveis de ambiente validadas (Zod, @t3-oss/env-nextjs)
  proxy.ts             Proxy do Next 16: nonce + CSP por requisição
e2e/                   Playwright: home, acessibilidade (axe), cabeçalhos de segurança
```

O `@salon/scheduling-core` é consumido como fonte TypeScript (`transpilePackages`). O app só
importa o tipo `AppointmentStatus` para o mapa exaustivo de rótulos: nenhuma regra de negócio
mora no app.

## Variáveis de ambiente

Validadas em `src/env.ts`. O `next.config.ts` importa esse módulo, então `next build`,
`next dev` e `next start` **falham no boot** com a lista de variáveis inválidas (sem ecoar os
valores). Modelo em [`.env.example`](./.env.example).

| Variável              | Lado             | Padrão                  | Regra                                                                                       |
| --------------------- | ---------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| `APP_ENV`             | servidor         | `development`           | `development`, `test`, `e2e`, `preview` ou `production`. Só `production` é indexável        |
| `NEXT_PUBLIC_APP_URL` | cliente (bundle) | `http://localhost:3000` | origem http(s) sem caminho/barra final; com `APP_ENV=production`, https e host não local |
| `NODE_ENV`            | compartilhada    | `development`           | definida pelo Next                                                                          |

Variável nova: declare o schema em `src/env.ts`, adicione em `turbo.json` deste pacote (o
Turborepo roda em modo estrito de env e filtra o que não estiver declarado) e documente no
`.env.example`. Nada com prefixo `NEXT_PUBLIC_` pode ser segredo.

## Segurança

### Proxy não é autorização

`src/proxy.ts` só gera o nonce e aplica a CSP. O Proxy (ex-middleware) foi burlado várias vezes
em 2025–2026 e um matcher alterado tira a cobertura de rotas e Server Functions sem aviso.
Autenticação e autorização serão feitas **dentro** de cada Server Action, Route Handler e na
camada de acesso a dados.

### Content-Security-Policy (por requisição, com nonce)

Construída em `src/lib/security/csp.ts` (função pura, testada) e aplicada pelo Proxy à resposta
e ao cabeçalho da requisição, de onde o Next extrai o nonce para os próprios scripts.

| Diretiva                    | Produção                                         | Desenvolvimento                                     |
| --------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| `default-src`               | `'self'`                                         | igual                                               |
| `script-src`                | `'self' 'nonce-…' 'strict-dynamic'`              | + `'unsafe-eval'` (pilhas de erro do React)         |
| `style-src`                 | `'self' 'nonce-…'`                               | `'self' 'unsafe-inline'` (HMR injeta `<style>`)     |
| `img-src`                   | `'self' data: blob:`                             | igual                                               |
| `font-src` / `connect-src`  | `'self'`                                         | igual (o WebSocket do HMR é da mesma origem)        |
| `object-src` / `base-uri`   | `'none'`                                         | igual                                               |
| `frame-ancestors`           | `'none'`                                         | igual                                               |
| `form-action`               | `'self'`                                         | igual                                               |
| `upgrade-insecure-requests` | sim                                              | não                                                 |

Decisões e desvios:

- **Nonce de 128 bits** de `crypto.getRandomValues`, base64 de 24 caracteres. O exemplo da doc
  do Next usa `btoa(crypto.randomUUID())` (122 bits aleatórios); preferimos 16 bytes puros.
- **`base-uri 'none'`** em vez do `'self'` do exemplo do Next (ASVS 5.0 3.4.3, nível 2).
- **`style-src` sem `'unsafe-inline'` em produção.** O Tailwind gera um arquivo CSS da própria
  origem e o Next aplica o nonce aos `<style>` que injeta. Consequência: atributos `style="…"`
  são bloqueados, e os E2E falham se aparecer algum (checagem no HTML e no console). Se um
  componente de UI exigir atributos `style`, o desvio previsto no ASVS é `'unsafe-inline'`
  **só em `style-src`**, registrado em [`docs/seguranca/asvs-l2.md`](../../docs/seguranca/asvs-l2.md#desvios-aceitos). Hoje não é necessário.
- Em desenvolvimento o nonce sai de `style-src` porque, com nonce presente, o navegador ignora
  `'unsafe-inline'`. Os relaxamentos só valem com `NODE_ENV=development` explícito.
- **Renderização dinâmica obrigatória.** O nonce é aplicado no SSR; uma página pré-renderizada
  no build sairia sem nonce e a hidratação seria bloqueada. O layout raiz chama
  `await connection()`. Por isso `cacheComponents` (PPR) fica desligado: é incompatível com CSP
  por nonce.
- **Enforce desde o início**, sem fase Report-Only: o app é novo e não há legado a migrar. Um
  endpoint de relatórios (`report-to`) entra com a observabilidade (Sentry).
- Matcher: tudo, inclusive `/api`, exceto `_next/static`, `_next/image`, `favicon.ico` e
  prefetches do `<Link>`.

### Cabeçalhos estáticos (`next.config.ts`)

Definidos em `src/lib/security/headers.ts` e aplicados a toda resposta, inclusive assets:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains` (2 anos), **só no build de
  produção** (em `next dev` com HTTPS local fixaria HTTPS em `localhost`). Sem `preload`:
  entrar na lista exige HTTPS em todos os subdomínios do domínio definitivo e é difícil de
  reverter. Decidir quando o domínio existir.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
- `Permissions-Policy` negando câmera, microfone, geolocalização, pagamento, USB, sensores etc.
  **Não** bloqueia `publickey-credentials-get/create` (passkeys da equipe) nem
  `otp-credentials` (WebOTP). Recursos aposentados do Privacy Sandbox ficam fora porque o
  Chrome acusa erro no console para nomes que não reconhece.
- `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-site`,
  `X-Frame-Options: DENY` (legado; o controle real é `frame-ancestors`).
- `poweredByHeader: false`: sem `X-Powered-By`.

### Outros pontos

- `/api/health`: `{"status":"ok"}`, `Cache-Control: no-store`, sem versão, commit, uptime ou
  estado de dependências. Só GET (POST devolve 405).
- Sem fontes nem imagens de terceiros: nenhum IP de visitante vai para outro controlador
  (LGPD) e a CSP continua `'self'`. `images.remotePatterns` vazio.
- Fora de `APP_ENV=production`, as páginas saem com `noindex, nofollow`.
- Páginas de erro em pt-BR mostram só o `digest` (o Next não envia a mensagem de erros do
  servidor ao navegador em produção).

## Testes

- **Unit (Vitest)**: CSP, nonce, cabeçalhos estáticos, env (servidor e cliente), Proxy (nonce
  novo por requisição, descarte de `x-nonce` forjado, matcher) e rótulos de status (exaustivos
  em relação ao domínio).
- **E2E (Playwright)**, projetos `chromium` (desktop) e `mobile` (Galaxy A55):
  - `home.spec.ts`: título, `lang="pt-BR"`, landmarks, h1 único, `noindex`, link "Pular para
    o conteúdo", 404 em pt-BR e navegação no cliente pelo `<Link>` (prova que o JS carregou
    sob a CSP).
  - `a11y.spec.ts`: axe com `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, temas claro
    e escuro, sem violações. O axe não substitui auditoria manual (teclado, leitor de tela,
    zoom de 200%).
  - `security-headers.spec.ts`: CSP com nonce diferente por requisição e presente em todos os
    `<script>`, nonce forjado ignorado, todos os cabeçalhos acima, health `no-store`, sem
    `X-Powered-By`.
  - Fixture automática: qualquer erro de console ou exceção na página reprova o teste. Pega
    violações de CSP, falhas de hidratação e recursos 404.

### E2E

O `webServer` do Playwright roda `next build && next start` em `127.0.0.1:3100` com
`APP_ENV=e2e` e nunca reaproveita um servidor aberto (um `next dev` na porta teria outra CSP).
Variáveis opcionais: `E2E_PORT`, `E2E_BASE_URL` (testa um ambiente já no ar),
`E2E_SKIP_BUILD=1` (reaproveita o build) e `E2E_CHROMIUM_EXECUTABLE_PATH`.

Navegadores: em CI, `pnpm --filter @salon/web exec playwright install --with-deps chromium`.
Fora de CI, se o Chromium da versão do Playwright não estiver baixado, a config usa a maior
revisão em `PLAYWRIGHT_BROWSERS_PATH` (padrão `/opt/pw-browsers`) e avisa no console. Nesse
modo o vídeo fica desligado (o ffmpeg da versão também costuma faltar). O CI, com o navegador
certo, é a referência.

## Próximos passos

Documentados aqui, **não implementados** nesta iteração:

- Better Auth (organizações = tenants, 2FA, passkeys) com autorização no DAL e nas actions;
  o Proxy, no máximo, redireciona quem não tem cookie de sessão (conveniência, não segurança).
- `server-only` nos módulos de dados e autenticação (sai do `package.json` enquanto não há uso).
- `assertSameOrigin` (Fetch Metadata + `Origin` + `Content-Type: application/json`) em todo
  Route Handler não-GET; `Cache-Control: no-store` nas páginas autenticadas;
  `Clear-Site-Data: "cache", "storage"` no logout.
- Endpoint de relatórios de CSP via Sentry; avaliar Trusted Types
  (`require-trusted-types-for 'script'`) quando a UI crescer.
- Rota `/embed/*` com `frame-ancestors` por tenant, só se o iframe virar requisito (hoje o
  agendamento abre em nova aba e `frame-ancestors 'none'` vale para tudo).

## Arquivos gerados

- `next-env.d.ts` e `.next/`: gerados pelo Next, ignorados no git.
- `AGENTS.md`: bloco gerado pelo `next dev` quando detecta um agente de IA (`agentRules`,
  padrão ligado), apontando para a documentação do Next na versão instalada
  (`node_modules/next/dist/docs/`). Fica versionado para o `next dev` não sujar a árvore.
  O `experimental.agentFeedback` (relatos ao time do Next via telemetria) fica desligado.
