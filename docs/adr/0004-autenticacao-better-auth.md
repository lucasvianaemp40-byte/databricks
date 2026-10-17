# ADR-0004: Autenticação com Better Auth (organizações, 2FA, passkeys)

- **Status:** Proposto. Implementação na próxima iteração; nada disto está no código ainda.
- **Data:** 2026-10-17
- **Relacionados:** [ADR-0002](0002-isolamento-multi-tenant-rls.md), [ASVS L2](../seguranca/asvs-l2.md),
  [backlog E1](../produto/backlog-inicial.md#e1-autenticação-e-organizações)

## Contexto

Há dois públicos com riscos diferentes:

- **Equipe do salão** (dono, gerente, recepção, profissional): acesso à base de clientes,
  financeiro e configurações. O ASVS 5.0 nível 2 exige **MFA** (6.3.3) e cookies `__Host-`
  (3.3.3).
- **Cliente final**: agenda pelo celular, sem app. Fricção alta derruba a conversão.

Requisitos: dados de autenticação no nosso PostgreSQL em São Paulo (LGPD), organização =
tenant, convites, papéis, passkeys, TOTP, rate limit, proteção contra enumeração.

Fatos verificados em 16 e 17/10/2026, no registry npm, no código do pacote 1.7.10 e na
documentação do repositório `better-auth/better-auth`:

- Better Auth 1.7.x (MIT) tem plugins `organization`, `twoFactor`, `passkey`
  (`@better-auth/passkey`), `phoneNumber`, `haveIBeenPwned`, `captcha` (Turnstile) e rate limit
  em banco. A telemetria vem desligada por padrão.
- Histórico relevante de advisories:
  - bypass de 2FA por cache de sessão (GHSA-xg6x-h9c9-2m83, < 1.4.9);
  - aceite de convite de organização com e-mail não verificado
    ([GHSA-fmh4-wcc4-5jm3](https://github.com/advisories/GHSA-fmh4-wcc4-5jm3), < 1.6.11);
  - ATO por *pre-account hijacking* em magic link e e-mail OTP (GHSA-qq9h-g4jm-xgf3, < 1.6.22).

  **Mínimo seguro: 1.6.22, ou qualquer 1.7.x estável.**
- O 2FA só intercepta `/sign-in/email`, `/sign-in/username` e `/sign-in/phone-number`. Magic
  link, e-mail OTP e login social **não** passam pelo segundo fator.
- `cookieCache` mantém uma sessão revogada válida até expirar.
- Lacunas da 1.7.10 frente ao ASVS:
  - o TOTP não registra o passo já usado e aceita replay dentro da janela (6.5.1);
  - o OTP de telefone fica em claro na tabela `verification` (6.5.2).
- Para o prefixo `__Host-` é preciso `useSecureCookies: false` + `cookiePrefix: "__Host-…"` +
  `defaultCookieAttributes.secure: true` (conferido em `dist/cookies/index.mjs`). Só
  `cookiePrefix` geraria `__Secure-__Host-…`.

## Decisão (proposta)

Usar o **Better Auth**, na versão estável mais nova fora da quarentena (`better-auth` e
`@better-auth/*` sempre na mesma versão).

- **Tenant = `organization`** do Better Auth. O ID da organização vira `tenant_id`, com
  `advanced.database.generateId: "uuid"`. Papéis: `owner`, `admin` (gerente/recepção) e
  `member` (profissional), refinados com `createAccessControl`.
- **Dados de auth no schema `auth`**, com papel próprio `app_auth`. Essas tabelas são globais,
  porque o login acontece antes do contexto de tenant. O `app_user` recebe só `SELECT` em
  membros e organizações, para resolver o tenant da sessão.
- **Equipe:**
  - e-mail e senha com mínimo de 12 e máximo de 128 caracteres, HIBP (k-anonymity) e
    bloqueio de palavras do contexto (nome do salão, slug);
  - **TOTP obrigatório ou passkey com `userVerification: "required"`**, aplicado no DAL:
    sem fator verificado, só a tela de configurar MFA;
  - backup codes cifrados;
  - `trustDevice` desligado ou ≤ 7 dias;
  - sem magic link, e-mail OTP ou login social para a equipe.
- **Cliente final:** OTP pelo WhatsApp (template de autenticação), com SMS de reserva, só
  `+55`, Turnstile antes do envio e limites por número, IP, tenant e dia, com falha fechada se
  o Redis cair. Passkey opcional. Sessão de baixo privilégio. **Desvio documentado do ASVS
  6.3.3** ([asvs-l2.md](../seguranca/asvs-l2.md#desvios-aceitos)).
- **Sessão:**
  - cookie `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, sem `Domain`;
  - `cookieCache` desligado;
  - `freshAge` de 10 min para step-up (exportar clientes, alterar Pix ou dados bancários,
    trocar e-mail, telefone ou MFA, convidar admin, excluir tenant);
  - inatividade e tempo absoluto por papel, checados no DAL: equipe 12 h / 7 dias,
    profissional 12 h / 30 dias, cliente 30 / 90 dias;
  - `revokeSessionsOnPasswordReset`;
  - revogar as sessões ao remover um membro.
- **Verificação:** `requireEmailVerification: true` (também protege contra enumeração no
  cadastro), `organization({ requireEmailVerificationOnInvitation: true })` e
  `verification.storeIdentifier: "hashed"`.
- **CSRF e origem:** nunca `disableCSRFCheck` nem `disableOriginCheck`. `trustedOrigins` sem
  `localhost` em produção.
- **IP do cliente:** um único cabeçalho sobrescrito pela plataforma (`x-real-ip` na Vercel,
  **não verificado**).
- **Proxy:** no máximo um redirect de conveniência para quem não tem cookie. A autorização é
  sempre no DAL.
- **Replay de TOTP:** guarda própria em Redis (`SET NX`, TTL de 90 s) até haver correção
  upstream.

## Consequências

- **Positivas:**
  - dados de autenticação no Brasil;
  - sem custo por usuário ativo (MAU);
  - organizações, passkeys e 2FA prontos;
  - baixo lock-in.
- **Negativas e riscos:**
  - nós operamos o serviço de autenticação, e o histórico de advisories exige patch rápido;
  - duas lacunas de ASVS (6.5.1 e 6.5.2) precisam de mitigação ou desvio registrado;
  - o OTP por WhatsApp e SMS custa dinheiro e é alvo de *SMS pumping*.
- **Ações decorrentes:**
  - threat model antes da implementação (skill `threat-model`);
  - E2E que verifica **todos** os `Set-Cookie` (prefixo `__Host-`, `Secure`, `HttpOnly`,
    `Path=/`, sem `Domain`, `SameSite=Lax`);
  - testes de MFA obrigatório, de fail-closed sem Redis e da matriz de autorização.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| Auth.js (next-auth 4.24 / 5 beta) | Sem organizações e sem 2FA nativo. A v5 nunca saiu de beta. O projeto está em modo de patch, mantido pela equipe do Better Auth desde set/2025 |
| Clerk | Sem residência de dados no Brasil (transferência internacional), cobrança por MAU (clientes dos salões virariam MAUs) e lock-in alto |
| Supabase Auth | Atrela à plataforma Supabase, e o RLS idiomático é por usuário, não por organização |
| Autenticação própria | Reinventar a parte mais sensível do produto |

## Referências

- Documentação do Better Auth (repositório): https://github.com/better-auth/better-auth/tree/main/docs/content/docs
- Advisories do Better Auth: https://github.com/better-auth/better-auth/security/advisories
- OWASP ASVS 5.0.0, capítulos V6 e V7: https://github.com/OWASP/ASVS/tree/v5.0.0_release/5.0
- OWASP Multifactor Authentication Cheat Sheet:
  https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Multifactor_Authentication_Cheat_Sheet.md
