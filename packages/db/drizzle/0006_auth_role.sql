-- @salon/db run-as: session-user
-- =============================================================================
-- 0006 · Bootstrap privilegiado: papel `app_auth` (Better Auth, ADR-0004).
--
-- Roda com o usuário da conexão (como a 0000): só ele pode criar papéis. As permissões do
-- papel ficam na 0007, que roda como `app_migrator`.
--
--   app_auth  LOGIN. Conexão do Better Auth (schema `auth`: usuários, sessões, contas) e do
--             provisionamento do salão. Não é dono de nada, sem BYPASSRLS, sem herança.
--
-- Mesmas regras dos papéis da 0000: nenhuma senha aqui (definida fora do repositório) e,
-- se o papel já existir (outro banco do cluster, criado pelo provedor), os atributos
-- perigosos são corrigidos; sem privilégio para corrigir, a migração inteira falha.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_auth') THEN
    CREATE ROLE app_auth LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION;
  END IF;

  -- Papel reaproveitado com atributo perigoso: corrige (só quando precisa: um admin não
  -- superusuário não pode nem citar SUPERUSER/BYPASSRLS num ALTER ROLE).
  IF EXISTS (
    SELECT FROM pg_catalog.pg_roles
     WHERE rolname = 'app_auth'
       AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)
  ) THEN
    ALTER ROLE app_auth NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;

  -- Herança desligada: o papel não ganha privilégio de nenhum grupo em que for colocado.
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_auth' AND rolinherit) THEN
    ALTER ROLE app_auth NOINHERIT;
  END IF;

  IF EXISTS (
    SELECT FROM pg_catalog.pg_auth_members m
     WHERE m.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'app_auth')
  ) THEN
    RAISE EXCEPTION 'app_auth é membro de outro papel: revogue antes de migrar (papel de runtime não herda nada)';
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_auth', current_database());
END
$$;
