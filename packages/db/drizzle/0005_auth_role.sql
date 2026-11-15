-- @salon/db run-as: session-user
-- =============================================================================
-- 0005 · Papel app_auth (Better Auth, ADR-0004).
--
-- Privilegiada como a 0000: criar papel exige CREATEROLE, que o app_migrator não tem. Roda
-- com o usuário da conexão (superusuário local/CI, admin do provedor em produção).
--
--   app_auth  LOGIN. Conexão do Better Auth: lê e grava SÓ o schema auth (usuários, contas
--             com hash de senha, sessões, organizações e membros), criado pela 0006. Não tem
--             privilégio nenhum em app/app_private: credencial e dado de tenant ficam em
--             papéis separados. Sem senha aqui (definida fora do repositório).
--
-- Idempotente e com correção de atributos, como a 0000: um app_auth reaproveitado volta a
-- NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE/NOREPLICATION e NOINHERIT (sem privilégio
-- para corrigir, a migração inteira é desfeita). As invariantes de deploy (0006) passam a
-- conferir o app_auth junto com os outros papéis de runtime.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_auth') THEN
    CREATE ROLE app_auth LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION;
  END IF;

  IF EXISTS (
    SELECT FROM pg_catalog.pg_roles
     WHERE rolname = 'app_auth'
       AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)
  ) THEN
    ALTER ROLE app_auth NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;

  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_auth' AND rolinherit) THEN
    ALTER ROLE app_auth NOINHERIT;
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_auth', current_database());
  -- As tabelas do Better Auth são procuradas sem schema: o search_path vem do papel, neste
  -- banco, e não só da conexão (um pooler pode não repassar `options`).
  EXECUTE format('ALTER ROLE app_auth IN DATABASE %I SET search_path = auth', current_database());
END
$$;
