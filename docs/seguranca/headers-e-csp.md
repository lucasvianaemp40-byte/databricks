# Cabeçalhos HTTP, CSP, CSRF e cookies

O que está implementado e por quê. A fonte de verdade é o código:
[`apps/web/src/lib/security/csp.ts`](../../apps/web/src/lib/security/csp.ts),
[`headers.ts`](../../apps/web/src/lib/security/headers.ts),
[`apps/web/src/proxy.ts`](../../apps/web/src/proxy.ts) e
[`apps/web/next.config.ts`](../../apps/web/next.config.ts). Os requisitos de referência são o
ASVS 5.0, capítulo V3 ([checklist](asvs-l2.md#v3-segurança-do-frontend-web)), e o
[OWASP HTTP Headers Cheat Sheet](https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/HTTP_Headers_Cheat_Sheet.md).

## 1. Content-Security-Policy (por requisição, com nonce) [fundação]

O Proxy do Next 16 (`src/proxy.ts`) gera um **nonce de 128 bits** (`crypto.getRandomValues`,
base64) a cada requisição e monta a CSP com uma função pura (`buildContentSecurityPolicy`). A
mesma política vai no cabeçalho da **requisição**, de onde o Next extrai o nonce e o aplica aos
próprios scripts, e no da **resposta**. O Proxy sobrescreve qualquer `x-nonce` ou CSP enviado
pelo cliente em todo documento HTML, inclusive a página 404 e caminhos sob `/_next/*` (testado
no E2E).

| Diretiva | Produção | Desenvolvimento (`NODE_ENV=development` explícito) |
|---|---|---|
| `default-src` | `'self'` | igual |
| `script-src` | `'self' 'nonce-…' 'strict-dynamic'` | + `'unsafe-eval'` (pilhas de erro do React) |
| `style-src` | `'self' 'nonce-…'` | `'self' 'unsafe-inline'` (o HMR injeta `<style>` sem nonce) |
| `img-src` | `'self' data: blob:` | igual |
| `font-src`, `connect-src` | `'self'` | igual (o WebSocket do HMR é da mesma origem) |
| `object-src`, `base-uri` | `'none'` | igual |
| `frame-ancestors` | `'none'` | igual |
| `form-action` | `'self'` | igual |
| `upgrade-insecure-requests` | sim | não |

Decisões:

- **`base-uri 'none'`**, e não o `'self'` do exemplo oficial do Next. É o que o ASVS 3.4.3
  nível 2 pede.
- **`'strict-dynamic'`:** só executam scripts com o nonce desta resposta e os que eles
  carregarem. O `'self'` serve de compatibilidade com CSP2. **Nunca** `'unsafe-inline'` em
  `script-src`.
- **`style-src` sem `'unsafe-inline'` em produção.** O Tailwind gera CSS da própria origem e o
  Next aplica o nonce aos `<style>` que injeta. Por isso atributos `style="…"` são bloqueados,
  e os E2E falham se algum aparecer. Se uma biblioteca de UI exigir atributo `style`, o desvio
  previsto é `'unsafe-inline'` **só em `style-src`**, registrado em
  [asvs-l2.md](asvs-l2.md#desvios-aceitos) (desvio D5). Hoje não é necessário.
- **Renderização dinâmica obrigatória.** O nonce é aplicado no SSR, então uma página
  pré-renderizada sairia sem nonce e a hidratação seria bloqueada. O layout raiz chama
  `await connection()`, e `cacheComponents` (PPR) fica desligado, porque é incompatível com CSP
  por nonce.
- **Enforce desde o início**, sem fase Report-Only. O app é novo e não tem legado. O endpoint de
  relatórios (`report-to`) entra junto com o Sentry.
- **Matcher do Proxy:** `/((?!_next/static/).*)`, ou seja, tudo, inclusive `/api`,
  `/_next/image` e os prefetches do `<Link>`, exceto os assets com hash **dentro** de
  `/_next/static/` (arquivo ausente ali devolve 404 `text/plain`, sem HTML). O matcher antigo
  (`_next/static|_next/image|favicon.ico`, prefixo sem âncora e `.` sem escape, mais um
  `missing` para os cabeçalhos de prefetch) deixava sem CSP a página 404 em caminhos como
  `/favicon.ico.bak`, `/_next/staticX` e `/favicon-ico-studio`, e todo HTML pedido com um
  cabeçalho de prefetch, que o cliente controla. Nesses casos o Next ainda aceitava o nonce
  enviado pelo cliente. O teste unitário compila o matcher com as regras do próprio Next
  (`unstable_doesMiddlewareMatch`) e o E2E "cobertura do Proxy" confere a CSP nesses caminhos.
- **Sem recursos de terceiros** (fontes, imagens, scripts). Assim nenhum IP de visitante vai
  para outro controlador (LGPD) e a CSP continua `'self'`. Quando o Turnstile entrar, ele exige
  `frame-src https://challenges.cloudflare.com` e o nonce no `<Script>`. Quando o Sentry
  entrar, usar túnel na mesma origem.

## 2. Cabeçalhos estáticos [fundação]

Definidos em `headers.ts` e aplicados pelo `next.config.ts` a toda resposta gerada pelo Next,
inclusive assets. Exceções, fora do alcance do app:

- erros do parser HTTP do Node (`TRACK`, requisição malformada) saem como 400 sem cabeçalhos;
- `TRACE` e `CONNECT` falham no adaptador do Proxy do Next 16.4 (o Fetch proíbe esses métodos
  num `Request`) e saem como 500 sem cabeçalhos, antes de `proxy()` rodar. O corpo é fixo,
  sem eco da requisição nem stack (E2E "método TRACE").

**Na hospedagem, bloqueie `TRACE`, `TRACK` e `CONNECT` com 405 na borda** (CDN, Vercel Firewall
ou reverse proxy) antes de expor o app [planejado; não verificado se a Vercel já os recusa].

| Cabeçalho | Valor | Motivo |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` (2 anos), **só no build de produção** | ASVS 3.4.1 L2. Em `next dev` com HTTPS local fixaria HTTPS em `localhost`. Sem `preload`: decidir quando o domínio definitivo existir, porque entrar na lista é difícil de reverter |
| `X-Content-Type-Options` | `nosniff` | ASVS 3.4.4 |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | ASVS 3.4.5 |
| `Permissions-Policy` | nega câmera, microfone, geolocalização, pagamento, USB, sensores e outros recursos | **Não** bloqueia `publickey-credentials-get/create` (passkeys) nem `otp-credentials` (WebOTP). Nome que o navegador não reconhece gera aviso no console ("Unrecognized feature"), e os E2E reprovam esse aviso. Exceção tolerada: `bluetooth`, que o Chromium do Linux não reconhece, mas o Chrome do Android, Windows e macOS sim |
| `Cross-Origin-Opener-Policy` | `same-origin` | ASVS 3.4.8 (nível 3, barato) |
| `Cross-Origin-Resource-Policy` | `same-site` | isolamento de recursos |
| `X-Frame-Options` | `DENY` | legado. O controle efetivo é `frame-ancestors 'none'` |
| (ausente) `X-Powered-By` | `poweredByHeader: false` | não anuncia o framework |

Outros pontos implementados: `/api/health` com `Cache-Control: no-store` e sem versão;
`noindex, nofollow` fora de `APP_ENV=production`; otimizador de imagens desligado
(`images.unoptimized: true`): `/_next/image` responde a página 404 do app, com CSP, e o
otimizador, alvo de vários advisories do Next, sai do caminho das requisições. O antigo
`images.remotePatterns: []` não fazia nada, porque já é o padrão do Next.

## 3. Planejado (entra com autenticação e páginas autenticadas)

| Item | Detalhe |
|---|---|
| `Cache-Control: no-store` | páginas autenticadas (`/app/**`, `/conta/**`) e APIs com dado de tenant |
| `Clear-Site-Data: "cache", "storage"` | no logout (ASVS 14.3.1). Não usar `"cookies"`, que apagaria cookies não relacionados; o Better Auth expira os dele |
| `Referrer-Policy: no-referrer` | na rota de gerenciar agendamento (link com token) |
| Rota `/embed/*` | só se o iframe no site do salão virar requisito: `frame-ancestors` com os domínios verificados do tenant (TXT de DNS) e sem depender de cookies. Hoje o agendamento abre em nova aba e `frame-ancestors 'none'` vale para tudo |
| Trusted Types | avaliar `require-trusted-types-for 'script'` quando a UI crescer |
| `report-to` | relatórios de violação de CSP via Sentry |

## 4. CSRF

| Superfície | Proteção nativa | O que fazemos |
|---|---|---|
| Server Actions | só POST; o Next compara `Origin` com `Host`/`X-Forwarded-Host`; IDs de action cifrados | **não** configurar `serverActions.allowedOrigins` (só para proxy reverso próprio). Tratar toda action como endpoint público: reautenticar e reautorizar dentro dela. Nunca mutar estado em GET ou render. Next ≥ 16.1.7 corrige o bypass com `Origin: null` (GHSA-mq59-m269-xvcx) |
| Route Handlers (`route.ts`) | nenhuma | `assertSameOrigin` em todo método que altera estado: `Sec-Fetch-Site` igual a `same-origin`, `Origin` igual à origem do app e `Content-Type: application/json`. Exceção: webhooks, que exigem assinatura [planejado] |
| Better Auth (`/api/auth/*`) | `Origin` × `trustedOrigins`, Fetch Metadata, `SameSite=Lax` | nunca `disableCSRFCheck` nem `disableOriginCheck` [planejado] |

## 5. Cookies [planejado]

Configuração prevista para o Better Auth ([ADR-0004](../adr/0004-autenticacao-better-auth.md)):

- Nome com prefixo **`__Host-`**, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` e **sem**
  `Domain`. No Better Auth: `useSecureCookies: false`, `cookiePrefix: "__Host-…"` e
  `defaultCookieAttributes.secure: true`. Só `cookiePrefix` geraria `__Secure-__Host-…`.
- `cookieCache` desligado, para que a revogação de sessão valha na hora.
- Nunca `crossSubDomainCookies`: subdomínios não compartilham sessão.
- Obrigatório: E2E que faz login e confere **todos** os `Set-Cookie`, inclusive os de plugins
  como o desafio do passkey.

## 6. Como testar

| Camada | Teste |
|---|---|
| Unit (Vitest) | `csp.test.ts` (diretivas por modo, nonce inválido recusado), `headers.test.ts`, `nonce.test.ts`, `proxy.test.ts` (nonce novo por requisição, `x-nonce` forjado descartado, matcher compilado com as regras do Next, com casos que devem e que não devem casar), `next-config.test.ts` (otimizador de imagens desligado) |
| E2E (Playwright) | `security-headers.spec.ts`: nonce diferente por requisição e presente em todos os `<script>`, nonce forjado ignorado, CSP nos caminhos que o matcher antigo deixava de fora e com cabeçalhos de prefetch, `/_next/image` desligado, `TRACE` sem eco nem stack, todos os cabeçalhos, health `no-store`, sem `X-Powered-By`. Uma fixture reprova qualquer erro de console e aviso de `Permissions-Policy`, o que pega violação de CSP (`console-guard.spec.ts` testa o classificador) |
| DAST | ZAP baseline ([`dast.yml`](../../.github/workflows/dast.yml)) contra o build de produção, com as regras de [`.zap/rules.tsv`](../../.zap/rules.tsv): CSP, anti-clickjacking, `nosniff`, `Permissions-Policy`, `X-Powered-By`, divulgação de erro e PII como `FAIL`. Ainda não é check obrigatório (em calibração) |
| Staging (planejado) | HSTS e cookies sob HTTPS real |

## 7. Ao mudar a CSP ou um cabeçalho

1. Altere a função pura e o teste unitário no mesmo PR.
2. Rode `pnpm e2e` e confira que não há erro de console.
3. Se afrouxar alguma diretiva, registre o desvio em [asvs-l2.md](asvs-l2.md#desvios-aceitos)
   com justificativa e mitigação.
4. Origem de terceiros nova (Turnstile, Sentry, bucket de fotos) precisa de avaliação de LGPD:
   ela passa a receber o IP do visitante.
