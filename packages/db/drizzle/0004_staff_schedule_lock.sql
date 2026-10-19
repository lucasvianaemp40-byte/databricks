-- =============================================================================
-- 0004 · Fila por profissional para gravar ocupação ativa (sem deadlock no EXCLUDE).
-- Roda como app_migrator.
--
-- O EXCLUDE occupancies_no_staff_overlap grava a entrada no índice ANTES de procurar
-- conflito. Duas reservas simultâneas que se sobrepõem acham a entrada uma da outra, ainda
-- sem commit, e cada uma espera a outra terminar. O PostgreSQL resolve com deadlock (40P01)
-- em vez de 23P01, depois do deadlock_timeout (comentário "Exclusion Constraints" em
-- src/backend/executor/execIndexing.c). Visto no CI com 6 reservas simultâneas do mesmo
-- horário e reproduzido com duas reservas cruzadas (uma pega 13h e quer 15h, a outra pega
-- 15h e quer 13h).
--
-- Com a fila, a escrita que deixa uma ocupação ATIVA espera a transação que já gravou
-- ocupação ativa do mesmo profissional terminar. Quando chega a vez, o conflito já tem commit
-- e sai 23P01 na hora. Quem garante que não há sobreposição continua sendo o EXCLUDE; a fila
-- só tira o deadlock.
--
-- - pg_advisory_xact_lock: vale até o fim da transação e não exige privilégio em tabela (o
--   app_worker não tem UPDATE em app.staff, então FOR UPDATE na linha do profissional não
--   serviria para a reativação feita por job).
-- - Chave: hash de 64 bits do staff_id com prefixo (UUID global, sem dado pessoal), no mesmo
--   espaço de chaves bigint do lock do runner de migrações (MIGRATION_LOCK_KEY). Uma colisão,
--   entre agendas ou com o runner (~2^-64), só faz um esperar o outro; nunca libera
--   sobreposição.
-- - A espera não tem teto próprio: a transação que gravou ocupação ativa segura a fila daquele
--   profissional até terminar. Grave as ocupações no fim da transação de reserva e mantenha-a
--   curta.
-- - Roda depois de occupancies_derive_active (os BEFORE disparam em ordem alfabética), então
--   NEW.active já é o valor derivado do status. Cobre INSERT e a reativação (UPDATE de active).
-- - Reserva com itens de profissionais diferentes pega um lock por profissional, na ordem dos
--   INSERTs: duas reservas em ordem inversa ainda podem dar deadlock. Grave as ocupações em
--   ordem de staff_id; o que sobrar, withTenant repete (TransactionConflictError se persistir).
-- =============================================================================

CREATE FUNCTION app_private.occupancies_lock_staff_schedule()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- staff_id nulo: o NOT NULL da tabela recusa a linha logo depois.
  IF NEW.active AND NEW.staff_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('app.occupancies.staff:' || NEW.staff_id::text, 0)
    );
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER occupancies_lock_staff_schedule
  BEFORE INSERT OR UPDATE ON app.occupancies
  FOR EACH ROW EXECUTE FUNCTION app_private.occupancies_lock_staff_schedule();
