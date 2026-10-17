-- =============================================================================
-- 0001 · Schema app_private: tipos e funções de validação usados por CHECKs do schema.
-- Roda como app_migrator. Precisa vir ANTES das tabelas (migração 0002, gerada pelo
-- drizzle-kit), cujos CHECKs chamam estas funções.
--
-- app_private não recebe USAGE dos papéis de runtime: nada aqui é API. As funções usadas
-- em CHECK/EXCLUDE recebem EXECUTE explícito na migração 0003.
-- =============================================================================

CREATE SCHEMA app_private;
--> statement-breakpoint
-- Toda função criada daqui em diante pelo app_migrator nasce SEM EXECUTE para PUBLIC.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
-- Aceita apenas nomes IANA "Area/Local" que o tzdata do servidor reconhece
-- (America/Sao_Paulo, America/Manaus, Etc/UTC). Recusa abreviações ("BRT"), offsets fixos
-- ("UTC-3", "-03:00") e nomes inexistentes. STABLE: depende do tzdata instalado.
CREATE FUNCTION app_private.is_valid_iana_timezone(tz text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF tz IS NULL OR char_length(tz) > 64 OR tz !~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$' THEN
    RETURN false;
  END IF;
  PERFORM now() AT TIME ZONE tz;
  RETURN true;
EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN false;
END
$$;
--> statement-breakpoint
-- Fases de um serviço multi-etapa, no formato ServicePhase de @salon/scheduling-core: array
-- de 1 a 8 objetos exatamente {"kind": "work" | "pause", "minutes": <inteiro 1..720>}, com ao
-- menos uma fase "work" (profissional ocupado) e soma dos minutos = duração do serviço.
-- IFs aninhados: a ordem de avaliação de OR em SQL não é garantida, e jsonb_object_keys()
-- lança erro em escalar.
CREATE FUNCTION app_private.service_phases_are_valid(phases jsonb, total_minutes integer)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  phase jsonb;
  minutes numeric;
  total integer := 0;
  has_work_phase boolean := false;
BEGIN
  IF phases IS NULL OR total_minutes IS NULL OR jsonb_typeof(phases) <> 'array' THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(phases) NOT BETWEEN 1 AND 8 THEN
    RETURN false;
  END IF;

  FOR phase IN SELECT value FROM jsonb_array_elements(phases) LOOP
    IF jsonb_typeof(phase) <> 'object' THEN
      RETURN false;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(phase)) <> 2
       OR jsonb_typeof(phase -> 'minutes') IS DISTINCT FROM 'number'
       OR ((phase ->> 'kind') IS DISTINCT FROM 'work' AND (phase ->> 'kind') IS DISTINCT FROM 'pause') THEN
      RETURN false;
    END IF;
    minutes := (phase ->> 'minutes')::numeric;
    IF minutes <> trunc(minutes) OR minutes < 1 OR minutes > 720 THEN
      RETURN false;
    END IF;
    total := total + minutes::integer;
    has_work_phase := has_work_phase OR (phase ->> 'kind') = 'work';
  END LOOP;

  RETURN has_work_phase AND total = total_minutes;
END
$$;
--> statement-breakpoint
-- Diferença em segundos entre horas de parede: deixa o GiST do tipo time_range eficiente.
CREATE FUNCTION app_private.time_subtype_diff(a time, b time)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT EXTRACT(EPOCH FROM (a - b))::double precision $$;
--> statement-breakpoint
-- Faixa de hora de parede ('[09:00,12:00)'), usada no EXCLUDE da jornada semanal.
CREATE TYPE app_private.time_range AS RANGE (
  subtype = time,
  subtype_diff = app_private.time_subtype_diff
);
