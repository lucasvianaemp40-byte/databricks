# OWASP ASVS 5.0 nível 2: checklist

Padrão: **OWASP ASVS 5.0.0** (maio de 2025, tag
[`v5.0.0_release`](https://github.com/OWASP/ASVS/tree/v5.0.0_release/5.0)), nível 2, como
Definition of Done de segurança. Os textos abaixo são **resumos**. O texto normativo está no
padrão. Os IDs seguem o formato `capítulo.seção.item` do ASVS 5.0.

O ASVS 5.0 trouxe duas mudanças que afetam este produto: **MFA obrigatório no nível 2**
(6.3.3) e **cookies `__Host-`** (3.3.3).

**Status:**

- **Atendido**: implementado e testado na fundação.
- **Parcial**: parte implementada e parte planejada, com a parte que falta descrita.
- **Planejado**: decidido, sem código ainda. A iteração está no [backlog](../produto/backlog-inicial.md).
- **Desvio aceito**: não atendido por decisão registrada (ver [Desvios aceitos](#desvios-aceitos)).
- **N/A**: não se aplica hoje, com o motivo.

Revise este arquivo no PR que mudar o status de qualquer item.

## V1 Codificação e sanitização

| ID | Nível | Requisito (resumo) | Como atendemos | Status |
|---|---|---|---|---|
| 1.2.4 | L1 | Consultas parametrizadas | Drizzle (tagged template vira parâmetro); `sql.raw` só com constantes; regra Semgrep `sql-raw-interpolation` | Atendido |
| — | L1 | Codificação de saída em HTML | Escaping do React; sem `dangerouslySetInnerHTML` (Biome `noDangerouslySetInnerHtml`); CSP com nonce | Atendido |
| 1.3.6 | L2 | Proteção contra SSRF por allowlist | `safeFetch`: só https, sem redirect, IP público validado na resolução DNS, timeout | Planejado |
| 1.3.11 | L2 | Sanitizar entrada usada em e-mail (injeção SMTP) | E-mail validado com Zod; cabeçalhos nunca interpolados | Planejado |

## V2 Validação e lógica de negócio

| ID | Nível | Requisito (resumo) | Como atendemos | Status |
|---|---|---|---|---|
| 2.2.1 / 2.2.2 | L1 | Validação positiva no servidor | Env validada com Zod no boot; CHECKs no banco (E.164, fuso IANA, durações, preços, status). Zod estrito em toda Server Action e Route Handler quando existirem | Parcial |
| 2.3.3 | L2 | Transações de negócio atômicas | `withTenant` abre transação; agendamento, itens e ocupações na mesma transação; job do pg-boss enfileirado na mesma transação | Parcial (fila planejada) |
| 2.3.4 | L2 | Recurso limitado não pode ser reservado em dobro | `EXCLUDE USING gist (tenant_id =, staff_id =, during &&) WHERE (active)`; corrida real testada (exatamente uma vence) | Atendido |
| 2.4.1 | L2 | Anti-automação contra abuso de fluxo, custo e cota | Rate limit por IP, número, tenant e dia; Turnstile; hold com TTL; limite de reservas pendentes | Planejado |

## V3 Segurança do frontend web

Detalhes em [headers-e-csp.md](headers-e-csp.md).

| ID | Nível | Requisito (resumo) | Como atendemos | Status |
|---|---|---|---|---|
| 3.3.1 / 3.3.2 / 3.3.4 | L1 | Cookies `Secure`, `SameSite` adequado e `HttpOnly` | Sem cookies na fundação. Better Auth com `Secure`, `HttpOnly` e `SameSite=Lax` | Planejado |
| 3.3.3 | L2 | Prefixo `__Host-` | Configuração do Better Auth com `cookiePrefix: "__Host-…"` + E2E que confere todo `Set-Cookie` | Planejado |
| 3.4.1 | L1/L2 | HSTS ≥ 1 ano; L2 exige `includeSubDomains` | `max-age=63072000; includeSubDomains` no build de produção. Sem `preload` até existir o domínio definitivo | Atendido |
| 3.4.3 | L2 | CSP com `object-src 'none'`, `base-uri 'none'` e nonce, hash ou allowlist | Nonce de 128 bits por requisição, `strict-dynamic`, `object-src 'none'`, `base-uri 'none'` (o exemplo do Next usa `'self'`). O matcher do Proxy cobre todo documento HTML, inclusive 404, `/_next/*` e prefetch (E2E "cobertura do Proxy") | Atendido |
| 3.4.4 | L2 | `X-Content-Type-Options: nosniff` | Cabeçalho estático | Atendido |
| 3.4.5 | L2 | `Referrer-Policy` adequada | `strict-origin-when-cross-origin`; `no-referrer` na rota de gerenciar agendamento quando existir | Atendido |
| 3.4.6 | L2 | `frame-ancestors` contra clickjacking | `frame-ancestors 'none'` + `X-Frame-Options: DENY` | Atendido |
| 3.4.8 | L3 | `Cross-Origin-Opener-Policy` | `same-origin` (adotado por ser barato); `Cross-Origin-Resource-Policy: same-site` | Atendido |
| 3.5.1–3.5.3 | L1 | Proteção contra CSRF e métodos seguros | Server Actions: checagem nativa de `Origin`. `/api/health` só aceita GET (POST devolve 405; `TRACE` devolve 500 sem eco por limitação do Next 16.4, e o bloqueio com 405 fica na borda). `assertSameOrigin` em Route Handlers mutáveis | Parcial |
| 3.7.2 | L2 | Redirecionamento externo só por allowlist | `trustedOrigins` do Better Auth; redirects próprios por allowlist | Planejado |

## V4 API e web services

| ID | Nível | Requisito (resumo) | Como atendemos | Status |
|---|---|---|---|---|
| 4.1.3 | L2 | Cabeçalhos de intermediário não podem ser sobrescritos pelo cliente | Confiar só no cabeçalho de IP que a plataforma sobrescreve (`x-real-ip` na Vercel, não verificado); o Proxy sobrescreve `x-nonce` vindo do cliente (testado) | Parcial |

## V5 Arquivos

**N/A na fundação**: não há upload. Quando entrarem fotos de antes/depois (fase 2), mapear o
capítulo inteiro: bucket privado, URL assinada curta, tipo e tamanho validados e remoção de
EXIF (14.2.8, nível 3, barato).

## V6 Autenticação

Tudo planejado para a próxima iteração ([ADR-0004](../adr/0004-autenticacao-better-auth.md)).

| ID | Nível | Requisito (resumo) | Como vamos atender | Status |
|---|---|---|---|---|
| 6.1.1 | L1 | Documentar rate limit e anti-automação contra credential stuffing sem lockout malicioso | Throttling progressivo por conta e IP; lockout só no segundo fator | Planejado |
| 6.1.3 / 6.3.4 | L2 | Todos os caminhos de autenticação documentados e com força consistente | Equipe: só e-mail + senha + TOTP ou passkey. Sem magic link, e-mail OTP ou social para a equipe | Planejado |
| 6.2.1 / 6.2.9 | L1 | Senha ≥ 8 (15 recomendado); aceitar ≥ 64 | Mínimo 12, máximo 128 | Planejado |
| 6.2.4 / 6.2.12 | L1/L2 | Bloquear senhas comuns e vazadas | Plugin `haveIBeenPwned` (k-anonymity) | Planejado |
| 6.2.5 / 6.2.7 | L1 | Sem regras de composição; permitir colar e gerenciador | UI sem regras de composição; `autocomplete` correto | Planejado |
| 6.2.11 | L2 | Bloquear palavras do contexto | Nome do salão, slug, "salao", "barbearia" e nome do produto | Planejado |
| 6.3.3 | L2 | MFA obrigatório | Equipe: TOTP ou passkey com verificação do usuário, aplicado no DAL. **Cliente final: desvio** | Planejado / Desvio aceito |
| 6.4.3 | L2 | Reset de senha não contorna MFA | O reset não cria sessão; o login seguinte passa pelo segundo fator; `revokeSessionsOnPasswordReset` | Planejado |
| 6.4.4 | L2 | Perda de fator exige prova de identidade equivalente ao cadastro | Processo assistido (CNPJ, e-mail verificado, outro owner, espera de 24–72 h com notificação, auditoria) | Planejado |
| 6.5.1 | L2 | TOTP e OOB de uso único | Lacuna do Better Auth 1.7.10: guarda de replay própria em Redis | Desvio aceito até a guarda existir |
| 6.5.2 | L2 | Segredos de consulta com hash | Backup codes cifrados (padrão no código 1.7.10). OTP de telefone em claro | Desvio aceito (OTP) |
| 6.5.4 / 6.5.5 | L2 | OOB ≥ 20 bits; expiração curta; TOTP de 30 s | OTP de 6 dígitos com 300 s; TOTP com período de 30 s | Planejado |
| 6.6.1 | L2 | OTP por telefone só com número validado, alternativa mais forte e aviso de risco | Equipe não usa SMS como fator. Cliente: OTP é a validação; passkey oferecida; texto de risco | Planejado |
| 6.6.2 / 6.6.3 | L2 | OOB vinculado à requisição; brute force limitado | 3 tentativas por código; limites por número | Planejado |

## V7 Sessão

| ID | Nível | Requisito (resumo) | Como vamos atender | Status |
|---|---|---|---|---|
| 7.1.1 / 7.3.1 / 7.3.2 | L2 | Inatividade e tempo de vida absoluto definidos e aplicados | Por papel, checado no DAL: equipe 12 h / 7 dias; profissional 12 h / 30 dias; cliente 30 / 90 dias | Planejado |
| 7.1.2 | L2 | Política de sessões concorrentes | Até 5 sessões por membro da equipe; tela "Dispositivos" | Planejado |
| 7.2.1–7.2.4 | L1 | Verificação no backend; token CSPRNG ≥ 128 bits; token novo no login | Sessão opaca no banco; `cookieCache` desligado | Planejado |
| 7.4.1 / 7.4.2 | L1 | Logout invalida no servidor; desativar conta encerra sessões | Revogar sessões ao remover membro (hook da organização) | Planejado |
| 7.4.3 / 7.5.2 | L2 | Encerrar outras sessões depois de trocar fator; usuário vê suas sessões | Tela "Dispositivos" | Planejado |
| 7.4.5 | L2 | Admin encerra sessões de um usuário | Dono revoga sessões de membros do tenant | Planejado |
| 7.5.1 | L2 | Reautenticação antes de mudar e-mail, telefone ou MFA | `freshAge` de 10 min (step-up) | Planejado |

## V8 Autorização

| ID | Nível | Requisito (resumo) | Como atendemos | Status |
|---|---|---|---|---|
| 8.1.1 / 8.1.2 | L1/L2 | Regras de autorização documentadas por função, dado e campo | Matriz papel × rota/action × tenant, que gera testes (meta-teste "toda rota tem entrada") | Planejado |
| 8.2.1 | L1 | Autorização por função | Clientes `tenantAction` e `ownerAction` do `next-safe-action` | Planejado |
| 8.2.2 | L1 | Autorização por dado (IDOR/BOLA) | **Banco:** RLS `FORCE` + FKs compostas, testadas. **App:** 404 para recurso de outro tenant | Parcial (camada de banco atendida) |
| 8.2.3 | L2 | Autorização por campo (BOPLA) | DTOs por papel; anamnese só para papéis autorizados | Planejado |
| 8.3.1 | L1 | Autorização em camada confiável | Decisão registrada: o Proxy não autoriza; cada action e handler reautoriza. Ainda não há rota autenticada | Planejado |
| 8.4.1 | L2 | Controles cross-tenant em aplicação multi-tenant | RLS `ENABLE` + `FORCE`, política RESTRICTIVE, papéis sem BYPASSRLS, invariantes no deploy, `*.rls.test.ts` e meta-testes. DAL e matriz HTTP pendentes | Parcial (banco atendido) |
| 8.4.2 | L3 | Controles de acesso administrativo (suporte) | Acesso do suporte só com janela concedida pelo dono e auditoria visível a ele | Planejado |

## V9 Tokens autocontidos e V10 OAuth/OIDC

- **V9: N/A.** As sessões são opacas no banco; não usamos JWT para sessão.
- **V10: N/A hoje.** Passa a valer quando formos **cliente OAuth** do Mercado Pago (cada salão
  conecta a própria conta) e do Google Calendar (fase 2). Mapeie os requisitos de cliente OAuth
  no threat model da integração.

## V11 Criptografia

| ID | Nível | Requisito (resumo) | Como atendemos | Status |
|---|---|---|---|---|
| 11.1.1 / 11.1.2 | L2 | Política de chaves e inventário criptográfico | Inventário: segredos do Better Auth (rotacionáveis), DEK por tenant + KEK, segredos de webhook, tokens de WhatsApp e PSP | Planejado |
| 11.3.2 / 11.3.3 | L1/L2 | Cifra autenticada (AEAD) | AES-256-GCM com nonce de 96 bits e AAD `tenant_id\|customer_id\|coluna` para dados sensíveis | Planejado |
| 11.4.2 | L2 | Hash de senha caro | scrypt (padrão do Better Auth) | Planejado |
| 11.5.1 | L2 | Valores aleatórios com ≥ 128 bits; UUID não serve como segredo | Nonce de CSP com 128 bits (`crypto.getRandomValues`). `newId()` (UUIDv7) documentado como não secreto. Tokens de link com 32 bytes | Parcial |

## V12 Comunicação segura

| ID | Nível | Requisito (resumo) | Como atendemos | Status |
|---|---|---|---|---|
| 12.1.1 / 12.3.1 | L1/L2 | TLS em tudo, inclusive ao banco | HSTS no app. PostgreSQL com `sslmode=verify-full` em produção | Parcial |

## V13 Configuração

| ID | Nível | Requisito (resumo) | Como atendemos | Status |
|---|---|---|---|---|
| 13.2.2 | L2 | Componentes com menor privilégio | `app_user` e `app_worker` sem ownership, sem BYPASSRLS e com GRANTs mínimos; workflows com `permissions: {}` e o mínimo por job | Atendido |
| 13.3.1 | L2 | Gestão de segredos | Nenhuma credencial no repositório; gitleaks no CI; env validada. Segredos de produção no provedor e com rotação | Parcial |
| — | — | Não expor tecnologia e depuração | `poweredByHeader: false`; source maps de navegador desligados (padrão); `/api/health` mínimo | Atendido |

## V14 Proteção de dados

| ID | Nível | Requisito (resumo) | Como atendemos | Status |
|---|---|---|---|---|
| 14.1.1 / 14.1.2 | L2 | Classificar dados sensíveis e definir requisitos por nível | [Inventário de dados](../lgpd/inventario-de-dados.md). Classificação no schema (`COMMENT ON COLUMN` + checagem no CI) | Parcial |
| 14.2.1 | L1 | Nada sensível em URL | Tokens de link trocados por cookie no primeiro acesso, com redirect para URL limpa; IDs opacos nas rotas | Planejado |
| 14.2.3 | L2 | Não enviar dado sensível a terceiros (trackers) | Sem scripts, fontes ou imagens de terceiros; CSP `'self'`; sem `next/image` e otimizador de imagens desligado (`images.unoptimized: true`) | Atendido |
| 14.2.8 | L3 | Remover metadados de arquivos | EXIF removido das fotos (fase 2) | Planejado |
| 14.3.1–14.3.3 | L1/L2 | Limpar armazenamento do cliente no logout; `no-store`; nada sensível em localStorage | `Clear-Site-Data: "cache", "storage"` no logout; `Cache-Control: no-store` em páginas autenticadas | Planejado |

## V15 Codificação segura e arquitetura

| ID | Nível | Requisito (resumo) | Como atendemos | Status |
|---|---|---|---|---|
| 15.1.1 | L1 | Política de atualização de componentes | [ADR-0007](../adr/0007-politica-de-supply-chain.md): Renovate, quarentena, PR de vulnerabilidade imediato; patch crítico em até 7 dias (Next.js em até 48 h) | Atendido |
| 15.1.3 / 15.2.2 | L2 | Funcionalidades caras com proteção de disponibilidade | Motor com teto de trabalho (`MAX_CANDIDATE_STARTS` = 20.160 inícios candidatos por consulta, até 366 datas, antecedência e horizonte até 2 anos), ~200 ms no pior caso medido. Planejado: janela de 31 dias e rate limit na página pública, exportações e relatórios assíncronos | Parcial |
| 15.3.1 / 15.3.3 | L1/L2 | Devolver só o necessário; proteção contra mass assignment | DTOs; Zod `.strict()`; `tenant_id`, `role` e `status` nunca vêm do cliente | Planejado |
| 15.3.2 | L2 | Requisições de saída sem seguir redirect | `safeFetch` com `redirect: "manual"` | Planejado |
| 15.3.4 | L2 | IP real do cliente por cabeçalho confiável | Um único cabeçalho sobrescrito pela plataforma | Planejado |
| 15.3.6 | L2 | Prototype pollution | Zod com strip; `Map` ou `Object.create(null)` em merges | Planejado |
| — | — | Concorrência segura | `EXCLUDE` no banco; lock otimista (`version`); `pg_advisory_xact_lock` no runner; `FOR SHARE` na derivação de ocupação, que depende do READ COMMITTED fixado pelo `withTenant`; `tx` recusado depois do callback (`TransactionClosedError`) | Atendido |

## V16 Logs e tratamento de erros

| ID | Nível | Requisito (resumo) | Como atendemos | Status |
|---|---|---|---|---|
| 16.2.1 / 16.2.2 | L2 | Logs com quem, quando, onde e o quê, em UTC | `appointment_events` com ator, transição e instante. Logs da aplicação em pino JSON com `requestId`, `tenantId` e `userId` | Parcial |
| 16.2.5 | L2 | Tratar dado sensível em log conforme a classificação | Regra Semgrep `pii-in-logs` (inclusive `console.*`, Sentry e analytics). Redaction no pino e no Sentry ([ADR-0010](../adr/0010-observabilidade.md), proposto) | Parcial |
| 16.3.1–16.3.3 | L2 | Logar autenticação, falhas de autorização e tentativas de bypass | Eventos `auth.*`, `authz.denied`, `ratelimit.hit`, `rls.violation` | Planejado |
| 16.4.2 / 16.4.3 | L2 | Logs protegidos contra alteração e enviados a sistema separado | `appointment_events` append-only (bloqueado até para o dono). Dreno externo de logs | Parcial |
| 16.5.1 | L2 | Mensagem de erro genérica | Páginas de erro só com `digest`; `@salon/db` traduz erros sem `DETAIL` (que pode conter dado pessoal) | Atendido |
| 16.5.3 | L2 | Falhar fechado | Sem contexto de tenant: 0 linhas e INSERT negado. Invariantes desfazem a migração. Regras de fail-closed para Redis, Turnstile, membership e PSP | Parcial |

## V17 WebRTC

**N/A.** O produto não usa WebRTC.

## Desvios aceitos

| # | Requisito | Desvio | Mitigação | Revisão |
|---|---|---|---|---|
| D1 | 6.3.3 (MFA) | O **cliente final** autentica com um fator de posse (OTP por WhatsApp ou SMS) | Escopo mínimo (só os próprios agendamentos); nada sensível visível sem novo OTP; limites anti-abuso; passkey opcional; aviso de risco (6.6.1) | ao implementar a autenticação do cliente |
| D2 | 6.5.1 (TOTP de uso único) | O Better Auth 1.7.10 aceita replay do mesmo código dentro da janela | Guarda própria em Redis (`SET NX` com TTL de 90 s) ou correção upstream. O desvio vale até a guarda existir | na implementação do 2FA |
| D3 | 6.5.2 (OTP com hash) | O OTP de telefone fica em claro na tabela `verification` | TTL de 300 s, 3 tentativas, tabela acessível só ao papel de autenticação | na implementação do OTP |
| D4 | 3.3.3 (`__Host-`) | **Contingente:** se a configuração falhar no E2E de cookies (por exemplo, cookie de desafio do passkey), usar `__Secure-` e registrar aqui | E2E que confere todos os `Set-Cookie` | na implementação da autenticação |
| D5 | 3.4.3 (`style-src`) | **Contingente, hoje não necessário:** se um componente exigir atributo `style`, usar `'unsafe-inline'` só em `style-src` | Os E2E falham hoje se aparecer atributo `style`; nunca em `script-src` | ao adotar biblioteca de UI |

Decisões que não são desvio, mas ficam registradas: HSTS sem `preload` até existir o domínio
definitivo (o L2 exige só `includeSubDomains`); CSP aplicada desde o início, sem fase
Report-Only, porque o app é novo e não tem legado.
