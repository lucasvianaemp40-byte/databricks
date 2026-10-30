# ADR-0012: Papel `app_auth`, schema `auth` e provisionamento do salão

- **Status:** Aceito (proposta apresentada ao dono do produto em 2026-10-20 e aprovada para
  esta iteração). Substitui só o item "O `app_user` recebe só `SELECT` em membros e
  organizações" do [ADR-0004](0004-autenticacao-better-auth.md); o restante do ADR-0004 segue
  valendo.
- **Data:** 2026-10-30
- **Decisores:** dono do produto e mantenedor
- **Relacionados:** [ADR-0002](0002-isolamento-multi-tenant-rls.md),
  [ADR-0004](0004-autenticacao-better-auth.md),
  [threat model de login e cadastro](../seguranca/threat-models/2026-10-20-login-cadastro-onboarding.md)

## Contexto

O ADR-0004 decidiu o Better Auth com dados no schema `auth` e um papel próprio, `app_auth`, e
previa `SELECT` do `app_user` em membros e organizações para resolver o tenant da sessão.

Ao implementar a primeira entrega (cadastro do dono, salão e primeira unidade), três fatos
pesaram:

- A criação do salão precisa gravar, juntas, linhas em `app.tenants` e `app.locations` (com
  RLS) e em `auth.organizations` e `auth.members`. Em duas conexões separadas, uma falha no
  meio deixaria organização sem tenant (ou o contrário), com o slug público preso.
- O `withTenant` pode repetir o callback em deadlock (40P01): nada fora do banco pode rodar
  dentro dele, então "grava o tenant e chama a API do Better Auth" não é seguro.
- Com o Better Auth 1.7.10 e `generateId: 'uuid'` no PostgreSQL, a biblioteca não envia o `id`
  ao inserir: o banco gera (conferido no E2E; o INSERT falhou com 23502 sem `DEFAULT`).

## Decisão

1. **`app_auth`** (LOGIN, NOSUPERUSER, NOBYPASSRLS, NOINHERIT, sem CREATE) é criado por
   migração privilegiada (0006), como os demais papéis. É a conexão do Better Auth
   (`DATABASE_URL_AUTH`) e do provisionamento.
2. **Schema `auth`** com as tabelas do Better Auth em plural e snake_case (0005). Sem RLS: são
   globais, porque o login acontece antes de existir tenant. `auth.organizations.id` tem FK
   para `app.tenants.id`: não existe organização sem tenant, e o id da organização É o id do
   tenant.
3. **`app_user` e `app_worker` sem nenhum acesso ao schema `auth`** (mais restrito que o
   ADR-0004). O DAL resolve sessão -> vínculo -> tenant no servidor pela conexão do
   `app_auth` (`listMemberships`) e só então abre `withTenant(app_user, tenantId)`.
4. **Provisionamento numa transação só**: `provisionTenant` roda
   `withTenant(app_auth, newId())` e grava tenant, unidade, organização e vínculo `owner`. Para
   isso o `app_auth` recebe USAGE em `app`, **só INSERT** em `app.tenants` e `app.locations`
   (sem SELECT, UPDATE nem DELETE) e políticas PERMISSIVE `FOR INSERT` (em `tenants`, com
   `status = 'trial'`). A política RESTRICTIVE de tenant continua valendo.
5. **Um salão por conta** nesta iteração, serializado por `SELECT ... FOR UPDATE` na linha do
   usuário antes de conferir os vínculos.
6. **Plugin `organization` desligado**: as tabelas seguem o formato dele para os convites
   (E1.4), mas nenhum endpoint dele fica exposto (a rota `/api/auth/*` tem lista fechada).
7. **Função de invariantes** estendida (0007): `app_auth` entre os papéis de runtime; em `app`
   só os dois INSERTs; políticas do `app_auth` só as de provisionamento; `app_auth` só
   SELECT/INSERT em organizações e vínculos; ninguém de runtime com `WITH GRANT OPTION`; schema
   `auth` do `app_migrator` e fechado a PUBLIC, `app_user` e `app_worker`.

## Consequências

- **Positivas:**
  - criação do salão atômica e repetível (sem órfão em falha, slug em uso ou corrida);
  - a conexão das requisições de tenant (`app_user`) não lê hash de senha nem sessões, nem
    por SQL injection;
  - a conexão de login (`app_auth`) não lê dado de salão nenhum.
- **Negativas e riscos:**
  - o web mantém dois pools (`app_user` e `app_auth`);
  - **LC-22:** com o contexto de um tenant **existente**, o `app_auth` conseguiria inserir uma
    unidade nele. `provisionTenant` sempre abre o contexto com um id novo; quem consegue
    executar SQL como `app_auth` já domina o schema `auth` inteiro. Fica registrado como
    pendência: trocar os GRANTs de INSERT por uma função `SECURITY DEFINER` dedicada (entrando
    em `executable_definers`);
  - quem conseguir executar SQL arbitrário como `app_auth` (bug ou injeção no caminho de login)
    também consegue gravar um vínculo `owner` num salão existente, ou uma organização para um
    tenant que ainda não tem (pentest de 2026-10-30, PoC fora do repositório). Com a mesma
    pré-condição ele já troca o hash de senha do dono em `auth.accounts`, então um trigger extra
    quase não reduz o risco; a correção é a mesma da LC-22 (função de provisionamento
    `SECURITY DEFINER` e REVOKE dos INSERTs diretos);
  - o `app_user` ainda tem INSERT e UPDATE em `app.tenants` (da 0003): um UPDATE de `slug`
    pelo app desalinharia `auth.organizations.slug`. Nenhum código faz isso hoje; a revisão do
    GRANT entra com a tela de configurações do salão.
- **Ações decorrentes:** testes de catálogo e de integração (papéis, privilégios, sabotagens,
  negativos cross-tenant, corrida), E2E com banco real e README do `@salon/db` atualizado.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| `app_user` com SELECT em `auth.members`/`auth.organizations` (ADR-0004) | Daria à conexão das requisições de tenant a lista de vínculos de todos os salões; o `app_auth` já precisa ler esses dados |
| API `createOrganization` do Better Auth + INSERT do tenant em outra conexão | Duas transações: falha no meio deixa órfão; dentro do `withTenant`, a chamada externa repetiria em deadlock |
| `app_user` com INSERT em `auth.members` | Uma SQL injection no caminho de tenant viraria "me torne dono de qualquer salão" |
| Função `SECURITY DEFINER` de provisionamento já agora | Fecha a LC-22, mas exige política permissiva para o dono em `app.tenants` e mexe no portão de invariantes; fica para a próxima iteração, com threat model próprio |
