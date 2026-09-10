-- 005-sync-lifecycle.sql
--
-- Extends sync_runs, sync_days, and sync_layer_state to enforce the durable sync
-- lifecycle specified in docs/NEXT-MILESTONE.md §3.1 and NEXT-MILESTONE-P0-CONTRACTS.md §5.1:
--   * sync_runs: expanded to 7 statuses ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted')
--   * sync_runs: mode column ('recent', 'backfill', 'compare', 'retry', 'registry')
--   * sync_runs: idempotency_key, payload_hash, resumed_from_run_id, cancel_requested_at
--   * sync_runs: single running claim enforced via unique partial index
--   * sync_runs: bounded queue limit (max 10 nonterminal runs) enforced via trigger ('SYNC_QUEUE_FULL')
--   * sync_days: expanded to 8 statuses and adds disposition ('updated', 'unchanged', 'preserved', 'rejected') and advisory_codes_json
--   * sync_layer_state: per-date, per-layer accepted vs observed state tracking
--
-- Rebuilds are executed transactionally with foreign keys enabled, preserving
-- all populated 001-004 IDs, rows, and relationships.

-- 1. Stage child sync_days so parent sync_runs can be rebuilt under active foreign keys
CREATE TABLE sync_days_stage (
  id                INTEGER PRIMARY KEY,
  sync_run_id       INTEGER,
  date              TEXT NOT NULL,
  status            TEXT NOT NULL,
  disposition       TEXT,
  summaries_status  TEXT,
  durations_status  TEXT,
  heartbeats_status TEXT,
  source_import_id  INTEGER,
  total_seconds     REAL NOT NULL DEFAULT 0.0,
  heartbeat_count   INTEGER NOT NULL DEFAULT 0,
  advisory_codes_json TEXT,
  error_message     TEXT,
  synced_at         TEXT NOT NULL
);

INSERT INTO sync_days_stage (
  id, sync_run_id, date, status, disposition, summaries_status, durations_status, heartbeats_status, source_import_id, total_seconds, heartbeat_count, advisory_codes_json, error_message, synced_at
)
SELECT
  id, sync_run_id, date, status, NULL, summaries_status, durations_status, heartbeats_status, source_import_id, total_seconds, heartbeat_count, NULL, error_message, synced_at
FROM sync_days;

DROP TABLE sync_days;

-- 2. Rebuild sync_runs with extended statuses, mode, idempotency, and recovery fields
CREATE TABLE sync_runs_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at           TEXT,
  trigger               TEXT    NOT NULL DEFAULT 'manual'
                                CHECK (trigger IN ('manual', 'scheduled', 'startup', 'catchup')),
  mode                  TEXT    NOT NULL DEFAULT 'recent'
                                CHECK (mode IN ('recent', 'backfill', 'compare', 'retry', 'registry')),
  status                TEXT    NOT NULL DEFAULT 'running'
                                CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted')),
  range_start_date      TEXT,
  range_end_date        TEXT,
  day_count             INTEGER NOT NULL DEFAULT 0,
  days_synced           INTEGER NOT NULL DEFAULT 0,
  days_failed           INTEGER NOT NULL DEFAULT 0,
  degraded_capabilities TEXT,
  advisory_codes        TEXT,
  summary               TEXT,
  error_message         TEXT,
  policy_state_json     TEXT,
  idempotency_key       TEXT,
  payload_hash          TEXT,
  resumed_from_run_id   INTEGER REFERENCES sync_runs_new(id),
  cancel_requested_at   TEXT
);

INSERT INTO sync_runs_new (
  id, started_at, finished_at, trigger, mode, status, range_start_date, range_end_date, day_count, days_synced, days_failed, degraded_capabilities, advisory_codes, summary, error_message, policy_state_json, idempotency_key, payload_hash, resumed_from_run_id, cancel_requested_at
)
SELECT
  id, started_at, finished_at, trigger, 'recent', status, range_start_date, range_end_date, day_count, days_synced, days_failed, degraded_capabilities, advisory_codes, summary, error_message, policy_state_json, NULL, NULL, NULL, NULL
FROM sync_runs;

DROP TABLE sync_runs;
ALTER TABLE sync_runs_new RENAME TO sync_runs;

-- Indexes and constraints on sync_runs
CREATE UNIQUE INDEX idx_sync_runs_single_running ON sync_runs(status) WHERE status = 'running';
CREATE INDEX idx_sync_runs_status ON sync_runs(status, started_at);
CREATE INDEX idx_sync_runs_started ON sync_runs(started_at);
CREATE INDEX idx_sync_runs_idempotency ON sync_runs(idempotency_key);
CREATE INDEX idx_sync_runs_resumed ON sync_runs(resumed_from_run_id) WHERE resumed_from_run_id IS NOT NULL;

-- Trigger enforcing maximum 10 queued or running (nonterminal) runs
CREATE TRIGGER trg_sync_runs_queue_limit_insert
BEFORE INSERT ON sync_runs
FOR EACH ROW
WHEN NEW.status IN ('queued', 'running') AND (
  SELECT COUNT(*) FROM sync_runs WHERE status IN ('queued', 'running')
) >= 10
BEGIN
  SELECT RAISE(ABORT, 'SYNC_QUEUE_FULL');
END;

CREATE TRIGGER trg_sync_runs_queue_limit_update
BEFORE UPDATE OF status ON sync_runs
FOR EACH ROW
WHEN NEW.status IN ('queued', 'running') AND OLD.status NOT IN ('queued', 'running') AND (
  SELECT COUNT(*) FROM sync_runs WHERE status IN ('queued', 'running')
) >= 10
BEGIN
  SELECT RAISE(ABORT, 'SYNC_QUEUE_FULL');
END;

-- 3. Rebuild sync_days with expanded status constraint and disposition
CREATE TABLE sync_days (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_run_id       INTEGER REFERENCES sync_runs(id) ON DELETE CASCADE,
  date              TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'running', 'succeeded', 'partial', 'failed', 'skipped', 'cancelled', 'interrupted')),
  disposition       TEXT    CHECK (disposition IS NULL OR disposition IN ('updated', 'unchanged', 'preserved', 'rejected')),
  summaries_status  TEXT    CHECK (summaries_status IS NULL OR summaries_status IN ('succeeded', 'failed', 'restricted', 'skipped')),
  durations_status  TEXT    CHECK (durations_status IS NULL OR durations_status IN ('succeeded', 'failed', 'restricted', 'skipped')),
  heartbeats_status TEXT    CHECK (heartbeats_status IS NULL OR heartbeats_status IN ('succeeded', 'failed', 'restricted', 'skipped')),
  source_import_id  INTEGER REFERENCES source_imports(id) ON DELETE SET NULL,
  total_seconds     REAL    NOT NULL DEFAULT 0.0 CHECK (total_seconds >= 0.0),
  heartbeat_count   INTEGER NOT NULL DEFAULT 0,
  advisory_codes_json TEXT,
  error_message     TEXT,
  synced_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (date, sync_run_id)
);

INSERT INTO sync_days (
  id, sync_run_id, date, status, disposition, summaries_status, durations_status, heartbeats_status, source_import_id, total_seconds, heartbeat_count, advisory_codes_json, error_message, synced_at
)
SELECT
  id, sync_run_id, date, status, disposition, summaries_status, durations_status, heartbeats_status, source_import_id, total_seconds, heartbeat_count, advisory_codes_json, error_message, synced_at
FROM sync_days_stage;

DROP TABLE sync_days_stage;

CREATE INDEX idx_sync_days_date ON sync_days(date);
CREATE INDEX idx_sync_days_run ON sync_days(sync_run_id, status);

-- 4. Create sync_layer_state for per-date, per-layer accepted vs observed state tracking
CREATE TABLE IF NOT EXISTS sync_layer_state (
  date                      TEXT    NOT NULL,
  layer                     TEXT    NOT NULL CHECK (layer IN ('summaries', 'durations', 'heartbeats')),
  last_attempt_at           TEXT,
  last_success_at           TEXT,
  last_accepted_change_at   TEXT,
  accepted_source_reference TEXT,
  accepted_snapshot_version INTEGER NOT NULL DEFAULT 0,
  accepted_fidelity         TEXT    CHECK (accepted_fidelity IS NULL OR accepted_fidelity IN ('entity_detail', 'coarse_project', 'verified_zero')),
  accepted_content_hash     TEXT,
  verified_timezone         TEXT,
  evidence_matches_summary  INTEGER CHECK (evidence_matches_summary IS NULL OR evidence_matches_summary IN (0, 1)),
  status_code               TEXT,
  next_retry_at             TEXT,
  is_stale                  INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1)),
  unresolved_mismatch       INTEGER NOT NULL DEFAULT 0 CHECK (unresolved_mismatch IN (0, 1)),
  has_detail_downgrade      INTEGER NOT NULL DEFAULT 0 CHECK (has_detail_downgrade IN (0, 1)),
  has_restriction           INTEGER NOT NULL DEFAULT 0 CHECK (has_restriction IN (0, 1)),
  has_failure               INTEGER NOT NULL DEFAULT 0 CHECK (has_failure IN (0, 1)),
  updated_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (date, layer)
);

CREATE INDEX IF NOT EXISTS idx_sync_layer_state_date ON sync_layer_state(date);
CREATE INDEX IF NOT EXISTS idx_sync_layer_state_retry ON sync_layer_state(next_retry_at) WHERE next_retry_at IS NOT NULL;
