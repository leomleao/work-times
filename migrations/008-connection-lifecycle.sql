-- 008-connection-lifecycle.sql
--
-- Adds connection generation, archive binding, and compare-and-set guards
-- to wakatime_oauth_connection as specified in docs/NEXT-MILESTONE.md §3.2–3.3
-- and NEXT-MILESTONE-P0-CONTRACTS.md §5.4:
--   * generation: monotonic integer generation tracking connection identity
--   * bound_archive_identity: pinned operator archive identity binding
--   * rebound_at: timestamp of last archive rebound / reconnection
--   * trigger: enforces CAS guard preventing stale generation rollback

ALTER TABLE wakatime_oauth_connection ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE wakatime_oauth_connection ADD COLUMN bound_archive_identity TEXT;
ALTER TABLE wakatime_oauth_connection ADD COLUMN rebound_at TEXT;

CREATE TRIGGER IF NOT EXISTS trg_wakatime_oauth_connection_cas
BEFORE UPDATE ON wakatime_oauth_connection
FOR EACH ROW
WHEN NEW.generation < OLD.generation
BEGIN
  SELECT RAISE(ABORT, 'STALE_CONNECTION_GENERATION');
END;
