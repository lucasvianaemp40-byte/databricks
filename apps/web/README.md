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
e2e/                   Playwright: home, acessibilidade (axe), cabeçalhos de segurança, env em
                       runtime, fixture de console (support/)
```

O `@salon/scheduling-core` é consumido como fonte TypeScript (`transpilePackages`). O app só
importa o tipo `AppointmentStatus` para o mapa exaustivo de rótulos: nenhuma regra de negócio
mora no app.

## Variáveis de ambiente

Validadas em `src/env.ts`. O `next.config.ts` importa esse módulo, então `next build`,
`next dev` e `next start` **falham no boot** com a lista de variáveis inválidas (sem ecoar os
valores). Modelo em [`.env.example`](./.env.example).

| Variável   | Lado                    | Padrão                  | Regra                                                                                    |
| ---------- | ----------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `APP_ENV`  | servidor (runtime)      | `development`           | `development`, `test`, `e2e`, `preview` ou `production`. Só `production` é indexável     |
| `APP_URL`  | servidor (runtime)      | `http://localhost:3000` | origem http(s) sem caminho/barra final; com `APP_ENV=production`, https e host não local |
| `NODE_ENV` | compartilhada           | `development`           | definida pelo Next (`production` no build e no `next start`)                             |

Variáveis de servidor são lidas em **runtime**: a validação do boot e o valor usado pelo
servidor são sempre os mesmos, e o mesmo build serve em outra origem ou ambiente sem rebuild
(`e2e/runtime-env.spec.ts` sobe o build de e2e como produção e confere). Variáveis
`NEXT_PUBLIC_` são o oposto: o `next build` as **embute em todos os bundles, inclusive o do
servidor**, e o valor de runtime é ignorado. Por isso a origem pública é `APP_URL`, não
`NEXT_PUBLIC_APP_URL`: embutida, um build de e2e iniciado como produção passava na validação
do boot e respondia 500 em toda rota. Crie uma `NEXT_PUBLIC_` só quando código de cliente
precisar dela, documentada como "embutida no build; mudar exige rebuild".

Variável nova: declare o schema em `src/env.ts` (e em `src/types/process-env.d.ts`), adicione
em `turbo.json` deste pacote (o Turborepo roda em modo estrito de env e filtra o que não
estiver declarado) e documente no `.env.example`. Nada com prefixo `NEXT_PUBLIC_` pode ser
segredo.

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
- Matcher: `/((?!_next/static/).*)`, ou seja, tudo (inclusive `/api`, `/_next/image` e
  prefetches do `<Link>`) exceto os assets com hash **dentro** de `/_next/static/` (arquivo
  ausente ali devolve 404 `text/plain`, sem HTML). Sem exclusão por prefixo solto nem `.` sem
  escape: o matcher antigo (`_next/static|_next/image|favicon.ico` e `missing` para
  `next-router-prefetch`/`purpose`) deixava sem CSP a página 404 em `/favicon.ico.bak`,
  `/_next/staticX`, `/favicon-ico-studio` (um futuro `/[slug]`) e o HTML pedido com um
  cabeçalho de prefetch, e nesses casos o Next aceitava o nonce enviado pelo cliente. O teste
  unitário compila o matcher com as regras do Next (`unstable_doesMiddlewareMatch`) e o E2E
  confere a CSP nesses caminhos.

### Cabeçalhos estáticos (`next.config.ts`)

Definidos em `src/lib/security/headers.ts` e aplicados a toda resposta gerada pelo Next,
inclusive assets. Exceções, fora do alcance do app: erros do parser HTTP do Node (`TRACK`,
requisição malformada: 400 sem cabeçalhos) e `TRACE`/`CONNECT`, que o adaptador do Proxy do
Next 16.4 não consegue montar como `Request` (o Fetch proíbe esses métodos) e responde 500
sem cabeçalhos, antes de `proxy()` rodar. O corpo é fixo (`Internal Server Error`), sem eco da
requisição nem stack (E2E `método TRACE`), mas cada uma grava um `TypeError` no log do
servidor. **Na hospedagem, bloqueie `TRACE`, `TRACK` e `CONNECT` com 405 na borda** (CDN ou
reverse proxy) antes de expor o app.

- `Strict-Transport-Security: max-age=63072000; includeSubDomains` (2 anos), **só no build de
  produção** (em `next dev` com HTTPS local fixaria HTTPS em `localhost`). Sem `preload`:
  entrar na lista exige HTTPS em todos os subdomínios do domínio definitivo e é difícil de
  reverter. Decidir quando o domínio existir.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
- `Permissions-Policy` negando câmera, microfone, geolocalização, pagamento, USB, sensores etc.
  **Não** bloqueia `publickey-credentials-get/create` (passkeys da equipe) nem
  `otp-credentials` (WebOTP). Recursos aposentados do Privacy Sandbox ficam fora: o Chrome
  registra um aviso no console ("Unrecognized feature") para nomes que não reconhece, e os E2E
  reprovam esse aviso. `bluetooth` é a exceção tolerada: o Chromium do Linux não o reconhece
  (Web Bluetooth desligado ali), mas o Chrome do Android, Windows e macOS sim.
- `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-site`,
  `X-Frame-Options: DENY` (legado; o controle real é `frame-ancestors`).
- `poweredByHeader: false`: sem `X-Powered-By`.

### Outros pontos

- `/api/health`: `{"status":"ok"}`, `Cache-Control: no-store`, sem versão, commit, uptime ou
  estado de dependências. Só GET (POST devolve 405; `TRACE` devolve 500 por limitação do
  Next, ver acima).
- Sem fontes nem imagens de terceiros: nenhum IP de visitante vai para outro controlador
  (LGPD) e a CSP continua `'self'`.
- Otimizador de imagens **desligado** (`images.unoptimized: true`): `/_next/image` responde a
  página 404 do app e o sharp/libvips sai do caminho das requisições. O antigo
  `images.remotePatterns: []` não fazia nada (já é o padrão do Next) e deixava o endpoint
  buscando qualquer caminho local. Ao adotar `next/image`, religue com `localPatterns`
  restrito, `qualities`/`formats` mínimos e `remotePatterns` só com caso de uso real.
- Fora de `APP_ENV=production`, as páginas saem com `noindex, nofollow`.
- Páginas de erro em pt-BR mostram só o `digest` (o Next não envia a mensagem de erros do
  servidor ao navegador em produção).

## Testes

- **Unit (Vitest)**: CSP, nonce, cabeçalhos estáticos, env (servidor e cliente), Proxy (nonce
  novo por requisição, descarte de `x-nonce` forjado, matcher compilado pelo Next com casos
  negativos), `next.config.ts` (otimizador desligado) e rótulos de status (exaustivos em
  relação ao domínio). Rodam em **ordem aleatória** (`sequence.shuffle`; o Vitest imprime a
  seed e `pnpm --filter @salon/web test --sequence.seed=<n>` reproduz) e `.only` reprova
  também fora do CI (`allowOnly: false`).
- **Higiene da suíte pelo TEXTO** (`src/test-hygiene.test.ts`): varre `src/` e `e2e/`, linha a
  linha, atrás de dicas de exclusão de cobertura e de teste focado, pulado, pendente,
  "esperado falhando" ou lento escrito por:
  - modificador (`.only`, `.skip`, `.skipIf`, `.runIf`, `.todo`, `.fails`, `.fixme`, `.fail`,
    `.slow`), inclusive encadeado (`it.skip.prop`) ou entre colchetes;
  - pulo ou pendência em tempo de execução pelo contexto ou pelo `testInfo` (`ctx.skip()`,
    `skip()` desestruturado, `testInfo.skip()`, `test.info().fixme()`, `.fail(`, `.slow(`);
  - chave `skip`, `todo`, `fails` ou `only` no objeto de opções do Vitest (literal, entre
    aspas, computada, numa variável, em linha própria ou abreviada no início ou no fim do
    objeto);
  - anotação do Playwright com tipo `skip`, `fixme`, `fail` ou `slow`
    (`annotation: { type: ... }`), que o Playwright aplica como o próprio modificador.

  Vale mesmo sob `biome-ignore`/`eslint-disable`; exceção só pela allowlist explícita do
  arquivo, com motivo. O texto NÃO vê opção espalhada (`...opcoes`) ou abreviada no meio do
  objeto, pulo computado (`const pular = ctx.skip; pular()`) nem tipo de anotação montado em
  variável.
- **Portão pelo RESULTADO** (só Vitest): `vitest.config.ts` liga, ao lado dos reporters
  padrão, o reporter compartilhado `test-support/vitest-no-disabled-tests-reporter.ts` (na raiz
  do monorepo, o mesmo do core e do db; provado em
  `packages/scheduling-core/test/no-disabled-tests-reporter.test.ts`). Ele faz
  `pnpm --filter @salon/web test` sair com 1 e lista cada teste que terminou pulado, pendente
  ou com falha esperada, qualquer que seja a sintaxe, o que fecha no unit as lacunas do texto
  acima. Lacunas por desenho: em execução filtrada (`-t`, `arquivo:linha`, `--tags-filter`)
  só os testes selecionados contam, e `--reporter` na linha de comando substitui a lista. Os
  **E2E do Playwright não têm portão pelo resultado** (`playwright test` sai com 0 com teste
  pulado): em `e2e/`, as lacunas do texto continuam abertas.
- **Configs fixadas** pela higiene: no Vitest, `allowOnly: false`, `shuffle`, os reporters, o
  script `test` (`vitest run`) e as chaves da config (nenhum filtro como `testNamePattern`,
  `tagsFilter` ou `exclude`, que tiraria teste da execução e cegaria o reporter); no
  Playwright, `forbidOnly: true`, a tag `@desktop-only` fora do projeto `mobile` e
  o `runtime-env.spec.ts` só com build local. Uma tabela fixa em que projeto roda cada spec de
  `e2e/` (com e sem build local) e é conferida duas vezes: pelo `testIgnore` da config e pela
  listagem real do `playwright test --list --reporter=json`, que também prova que o `mobile`
  recebe os testes do `chromium` menos os `@desktop-only`. Fora dos projetos não pode haver
  filtro (`testIgnore`, `grep`, `grepInvert`, `shard`), e cada projeto só usa os filtros
  previstos. Spec novo ou exclusão nova reprova até a tabela mudar no mesmo PR.
- **E2E (Playwright)**, projetos `chromium` (desktop) e `mobile` (Galaxy A55):
  - `home.spec.ts`: título, `lang="pt-BR"`, landmarks, h1 único, `noindex`, link "Pular para
    o conteúdo" (Tab de teclado físico: tag `@desktop-only`, só no projeto `chromium`), 404
    em pt-BR e navegação no cliente pelo `<Link>` (prova que o JS carregou sob a CSP).
  - `a11y.spec.ts`: axe com `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, temas claro
    e escuro, sem violações. O axe não substitui auditoria manual (teclado, leitor de tela,
    zoom de 200%).
  - `security-headers.spec.ts`: CSP com nonce diferente por requisição e presente em todos os
    `<script>`, nonce forjado ignorado, CSP também nos caminhos que o matcher antigo deixava
    de fora e com cabeçalhos de prefetch, `/_next/image` desligado, `TRACE` sem eco nem
    stack, todos os cabeçalhos acima, health `no-store`, sem `X-Powered-By`.
  - `runtime-env.spec.ts`: sobe um segundo `next start` sobre o build de e2e com
    `APP_ENV=production` e outra `APP_URL` e confere que o servidor usa os valores de runtime.
  - Fixture automática: qualquer erro de console, aviso de Permissions-Policy ou exceção na
    página reprova o teste. Pega violações de CSP, falhas de hidratação, recursos 404 e
    Permissions-Policy malformada ou com recurso desconhecido. A exceção do 404 vale só para o
    próprio documento (`MISSING_PAGE_DOCUMENT_404`), nunca para CSS ou JS. Regras em
    `e2e/support/console.ts`, testadas com mensagens reais do Chromium em
    `console-guard.spec.ts`.

### E2E

O `webServer` do Playwright roda `next build && next start` em `127.0.0.1:3100` com
`APP_ENV=e2e` e nunca reaproveita um servidor aberto (um `next dev` na porta teria outra CSP).
Variáveis opcionais: `E2E_PORT`, `E2E_BASE_URL` (testa um ambiente já no ar; sem build local,
a config tira o `runtime-env.spec.ts` de todos os projetos), `E2E_SKIP_BUILD=1` (reaproveita
o build) e `E2E_CHROMIUM_EXECUTABLE_PATH`.

O que não se aplica a um projeto sai **pela config**, nunca por `test.skip` no corpo (o lint e
a higiene da suíte reprovam): os specs que não dependem do dispositivo (`security-headers`,
`console-guard`, `runtime-env`) ficam no `testIgnore` do `mobile`, e teste só de desktop leva
`{ tag: '@desktop-only' }`, que o `grepInvert` do `mobile` exclui. Confira o que roda em cada
projeto com `pnpm --filter @salon/web exec playwright test --list`. Spec novo entra na tabela
`SPEC_PROJECTS_LOCAL` de `src/test-hygiene.test.ts` no mesmo PR; sem isso, o unit reprova.

Navegadores: rode uma vez `pnpm --filter @salon/web exec playwright install --with-deps
chromium`, **em CI e localmente**; ele baixa o Chromium e o ffmpeg da versão do Playwright
(`--with-deps` instala as bibliotecas do sistema e, no Linux, pede `sudo`). O resto é
**fallback de container** sem acesso ao download: fora de CI, se o Chromium da versão do
Playwright não estiver baixado, a config usa a maior revisão em `PLAYWRIGHT_BROWSERS_PATH`
(padrão `/opt/pw-browsers`) e avisa no console. Nesse modo o vídeo fica desligado (o ffmpeg da
versão também costuma faltar) e o navegador pode divergir em detalhes. O CI, com o navegador
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
- Página pública `/[slug]`: além do slug validado com zod, reservar nomes que colidem com
  rotas do app e do Next (`_next`, `api`, `icon*`, `favicon*`, `robots`, `sitemap` etc.). O
  matcher do Proxy já não depende disso para aplicar a CSP.
- Rota `/embed/*` com `frame-ancestors` por tenant, só se o iframe virar requisito (hoje o
  agendamento abre em nova aba e `frame-ancestors 'none'` vale para tudo).

## Arquivos gerados

- `next-env.d.ts` e `.next/`: gerados pelo Next, ignorados no git.
- `AGENTS.md`: bloco gerado pelo `next dev` quando detecta um agente de IA (`agentRules`,
  padrão ligado), apontando para a documentação do Next na versão instalada
  (`node_modules/next/dist/docs/`). Fica versionado para o `next dev` não sujar a árvore.
  O `experimental.agentFeedback` (relatos ao time do Next via telemetria) fica desligado.
