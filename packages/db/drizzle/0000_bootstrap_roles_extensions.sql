-- @salon/db run-as: session-user
-- =============================================================================
-- 0000 · Bootstrap privilegiado: extensão e papéis do banco.
--
-- Única migração que roda com o usuário da conexão (superusuário local/CI, ou o admin do
-- provedor com CREATEROLE em produção). Todas as outras rodam como `app_migrator` (o runner
-- faz SET LOCAL ROLE), que fica dono de todos os objetos da aplicação.
--
-- Papéis (atributos de cluster: valem para todos os bancos do servidor):
--   app_migrator  NOLOGIN. Dono do schema; o deploy assume o papel via SET ROLE.
--   app_user      LOGIN. Requisições web. Não é dono, sem BYPASSRLS, sem TRUNCATE/REFERENCES.
--   app_worker    LOGIN. Jobs (lembretes, expiração de holds). Mesmas restrições, menos GRANTs.
-- Nenhum papel recebe senha aqui: a credencial é definida fora do repositório
-- (ALTER ROLE app_user PASSWORD ... pelo provedor/IaC) e nunca é versionada.
--
-- Idempotente: papéis já existentes (outro banco do mesmo cluster, criados pelo provedor)
-- são reaproveitados, mas seus atributos são verificados e corrigidos (falha se não puder):
--   - nenhum dos três fica SUPERUSER, BYPASSRLS, CREATEDB, CREATEROLE ou REPLICATION;
--   - app_migrator volta a NOLOGIN, NOINHERIT e sem senha (dono de tudo não pode logar:
--     logado, desligaria a RLS e trocaria a função de invariantes);
--   - app_migrator membro de algum papel aborta a migração (herdaria privilégios alheios).
-- =============================================================================

-- Operador = para uuid/smallint em índices GiST (EXCLUDE anti-sobreposição). É "trusted"
-- desde o PG13 e existe nos provedores gerenciados (Neon, RDS, Cloud SQL).
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
DO $$
DECLARE
  role_name text;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION;
  END IF;

  FOREACH role_name IN ARRAY ARRAY['app_user', 'app_worker'] LOOP
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
        role_name);
    END IF;
  END LOOP;

  -- Papel reaproveitado com atributo perigoso: corrige. Sem privilégio para corrigir, o
  -- ALTER falha e a migração inteira é desfeita (falha fechada). Só altera quando precisa:
  -- um admin não superusuário não pode nem citar SUPERUSER/BYPASSRLS num ALTER ROLE.
  FOREACH role_name IN ARRAY ARRAY['app_migrator', 'app_user', 'app_worker'] LOOP
    IF EXISTS (
      SELECT FROM pg_catalog.pg_roles
       WHERE rolname = role_name
         AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)
    ) THEN
      EXECUTE format(
        'ALTER ROLE %I NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',
        role_name);
    END IF;
  END LOOP;

  -- O dono só é assumido por SET ROLE no deploy. Reaproveitado com LOGIN ou INHERIT (ex.:
  -- criado pelo console do provedor), volta a NOLOGIN/NOINHERIT e perde a senha. Com
  -- NOLOGIN, uma senha antiga não serve para nada; ela é apagada junto na correção.
  IF EXISTS (
    SELECT FROM pg_catalog.pg_roles
     WHERE rolname = 'app_migrator' AND (rolcanlogin OR rolinherit)
  ) THEN
    ALTER ROLE app_migrator NOLOGIN NOINHERIT PASSWORD NULL;
  END IF;

  IF EXISTS (
    SELECT FROM pg_catalog.pg_auth_members m
     WHERE m.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'app_migrator')
  ) THEN
    RAISE EXCEPTION 'app_migrator é membro de outro papel: revogue antes de migrar (o dono não herda nada)';
  END IF;
END
$$;
--> statement-breakpoint
-- O dono precisa criar os schemas `app` e `app_private` neste banco; os papéis de runtime
-- só precisam conectar (USAGE nos schemas é concedido pela migração 0003).
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO app_migrator',
                 current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_user, app_worker', current_database());
END
$$;
--> statement-breakpoint
-- Ninguém cria objetos no schema public (padrão desde o PG15; bancos antigos ou criados por
-- provedor podem ter o CREATE de PUBLIC). Sem ser dono do schema, o REVOKE só avisa, e a
-- função de invariantes recusa o deploy se um papel de runtime ainda puder criar ali.
DO $$
BEGIN
  IF to_regnamespace('public') IS NOT NULL THEN
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  END IF;
END
$$;
--> statement-breakpoint
-- O runner precisa assumir app_migrator (SET ROLE). Superusuário já pode. Um admin com
-- CREATEROLE (PG16+: recebe só ADMIN OPTION ao criar o papel) concede a si mesmo o SET,
-- sem herança de privilégios.
DO $$
BEGIN
  IF NOT pg_catalog.pg_has_role(current_user, 'app_migrator', 'SET') THEN
    EXECUTE format('GRANT app_migrator TO %I WITH INHERIT FALSE, SET TRUE', current_user);
  END IF;
END
$$;
