# Regras de segurança do Agenda Salão

SaaS multi-tenant (salões e barbearias, Brasil) em Next.js 16 + Drizzle + PostgreSQL com RLS.
Estas regras SOMAM às verificações padrão; nenhuma delas dispensa um achado.

## Isolamento entre tenants (severidade ALTA quando violado)
- `tenantId` vem só da sessão autenticada no servidor. Vindo de body, query, params, header,
  cookie não assinado ou subdomínio sem checagem de vínculo = IDOR/BOLA.
- Dado de tenant só via `withTenant(db, tenantId, fn, options)` de `@salon/db`. Achado:
  `db.select/insert/update/delete` fora de `withTenant` em código de requisição; `set_config`
  ou `SET app.tenant_id` montado à mão; `sql.raw`/`sql.identifier` com entrada externa.
- Conexão de requisição usa `app_user` (jobs: `app_worker`). URL de `app_migrator`,
  `postgres` ou de qualquer papel com BYPASSRLS fora do runner de migração = ALTA.
- Migração: tabela com `tenant_id` sem ENABLE + FORCE RLS, sem a política RESTRICTIVE
  `tenant_isolation`, `DISABLE ROW LEVEL SECURITY`, `NO FORCE`, `DROP POLICY` sem substituta,
  GRANT a PUBLIC, função SECURITY DEFINER sem `SET search_path` ou executável pela aplicação,
  view sem `security_invoker` = ALTA.
- Edição de migração já commitada (`packages/db/drizzle/*.sql`, `drizzle/meta/*_snapshot.json`):
  o histórico é imutável; correção é migração nova.
- Recurso de outro tenant deve responder 404, sem revelar existência.

## Autorização e entrada
- O Proxy (`apps/web/src/proxy.ts`) só aplica nonce/CSP. Autorização ali, ou checagem de papel
  ausente dentro de Server Action/Route Handler, é achado.
- Toda entrada (Action, Route Handler, webhook, job) passa por zod estrito. Aceitar `role`,
  `tenantId`, `price`, `status`, `staffId` ou duração do cliente sem checagem = mass assignment.
- Regras de agenda (antecedência, horizonte, jornada, transição de status) decididas no cliente
  ou só na UI = Insecure Design; a fonte de verdade é o servidor, o core e o banco (EXCLUDE,
  trigger de status).

## Página pública e integrações
- Página de reserva não expõe nome, telefone ou e-mail de outros clientes; não permite enumerar
  clientes por telefone/e-mail; tem rate limit e hold de horário com expiração.
- Links de cancelamento/confirmação e OTP: token aleatório >= 128 bits, uso único, expiração,
  comparação em tempo constante. UUIDv7 (ids do banco) é previsível: nunca é segredo.
- Webhooks (PSP Pix, WhatsApp, e-mail): assinatura verificada antes de qualquer efeito,
  idempotência, proteção contra replay; pagamento confirmado pela API do PSP, não pelo payload.
- URL configurável pelo usuário (webhook do salão, calendário ICS, imagem) passa por
  allowlist/bloqueio de IP privado (SSRF).

## Dados pessoais (LGPD)
- Nunca logar ou enviar a Sentry/analytics/prompt de IA: nome, telefone, e-mail, CPF, observações
  de atendimento, anamnese (dado de saúde), tokens, cookies, cabeçalho Authorization.
- Mensagem de erro para o usuário sem stack, SQL, `DETAIL` do PostgreSQL ou dado pessoal.
- Anamnese/observação de saúde exige consentimento específico, acesso por papel e criptografia
  de campo; campo livre novo com esse conteúdo é achado.

## Front-end e configuração
- CSP com nonce em produção: `dangerouslySetInnerHTML`, `eval`, `new Function`, atributo
  `style` inline ou relaxar `script-src`/`style-src` é achado.
- Variável `NEXT_PUBLIC_*` vai para o bundle: segredo ali = ALTA. Variável nova precisa de
  schema em `src/env.ts`.
- Cookies de sessão: `HttpOnly`, `Secure`, `SameSite=Lax` ou mais restrito, prefixo `__Host-`.

## Tempo e dinheiro
- Instantes em `timestamptz`/`Temporal.Instant` (UTC); fuso IANA da unidade, nunca o da máquina;
  `Date.now()`/`new Date()` no `@salon/scheduling-core` é proibido (use `Clock`).
- Dinheiro em centavos inteiros; `float` para valor monetário é achado.

## Cadeia de suprimentos e CI
- Dependência nova sem versão exata, com script de instalação liberado em `allowBuilds` sem
  justificativa, `dangerouslyAllowAllBuilds`, ou exceção de `minimumReleaseAge` sem motivo.
- GitHub Action sem SHA fixo, `pull_request_target` com checkout do código do PR, expressão
  `${{ github.event.* }}` interpolada direto em `run:`.
- Desligar hooks (`--no-verify`, `LEFTHOOK=0`), enfraquecer teste ou regra de lint para passar.
