-- 006-reconciliation-overlay.sql
--
-- Implements the reconciliation overlay and decision preservation requirements
-- specified in docs/NEXT-MILESTONE.md §2.3–2.5 and NEXT-MILESTONE-P0-CONTRACTS.md §5.2:
--   * day_project_entity_slices: adds kind ('entity', 'project_summary', 'unattributed_residual')
--     and snapshot_version INTEGER NOT NULL DEFAULT 1
--   * daily_time_allocations: decouples from ON DELETE CASCADE slice FK, binding to semantic
--     identity (date, project_id, entity); adds state ('active', 'detached'), detached_at, and reattached_at
--   * daily_time_allocations: updates allocation duration check triggers so detached allocations
--     retain their last-known duration without requiring a matching slice
--   * classification_revisions: extends mutation_type to include 'reconciliation_adjusted',
--     'allocation_detached', and 'allocation_reattached'
--   * heartbeat_memberships: introduces active heartbeat membership relation, seeded from all
--     existing heartbeats as active = 1
--
-- All operations run transactionally under the real migration runner with foreign keys enabled.

-- 1. Extend day_project_entity_slices with slice kind and snapshot_version
ALTER TABLE day_project_entity_slices ADD COLUMN kind TEXT NOT NULL DEFAULT 'entity'
  CHECK (kind IN ('entity', 'project_summary', 'unattributed_residual'));

ALTER TABLE day_project_entity_slices ADD COLUMN snapshot_version INTEGER NOT NULL DEFAULT 1;

UPDATE day_project_entity_slices
SET kind = 'unattributed_residual'
WHERE is_unattributed = 1 OR entity = '__unattributed__';

CREATE INDEX IF NOT EXISTS idx_slices_kind ON day_project_entity_slices(kind);

-- 2. Rebuild daily_time_allocations without ON DELETE CASCADE slice FK, adding state and detachment timestamps
CREATE TABLE daily_time_allocations_new (
  id                TEXT    PRIMARY KEY,
  date              TEXT    NOT NULL,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  entity            TEXT    NOT NULL,
  classification    TEXT    NOT NULL CHECK (classification IN ('work', 'personal')),
  allocated_seconds REAL    NOT NULL CHECK (allocated_seconds >= 0.0),
  timesheet_code    TEXT,
  note              TEXT,
  state             TEXT    NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'detached')),
  detached_at       TEXT,
  reattached_at     TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (date, project_id, entity)
);

INSERT INTO daily_time_allocations_new (
  id, date, project_id, entity, classification, allocated_seconds, timesheet_code, note, state, detached_at, reattached_at, created_at, updated_at
)
SELECT
  id, date, project_id, entity, classification, allocated_seconds, timesheet_code, note, 'active', NULL, NULL, created_at, updated_at
FROM daily_time_allocations;

DROP TABLE daily_time_allocations;
ALTER TABLE daily_time_allocations_new RENAME TO daily_time_allocations;

CREATE INDEX idx_allocations_slice ON daily_time_allocations(date, project_id, entity);
CREATE INDEX idx_allocations_date ON daily_time_allocations(date);
CREATE INDEX idx_allocations_project ON daily_time_allocations(project_id);
CREATE INDEX idx_allocations_state ON daily_time_allocations(state);

-- Recreate state-aware allocation triggers
CREATE TRIGGER trg_daily_allocations_match_insert
BEFORE INSERT ON daily_time_allocations
FOR EACH ROW
WHEN NEW.state = 'active' AND NOT EXISTS (
  SELECT 1 FROM day_project_entity_slices
  WHERE date = NEW.date
    AND project_id = NEW.project_id
    AND entity = NEW.entity
    AND ABS(total_seconds - NEW.allocated_seconds) <= 0.001
)
BEGIN
  SELECT RAISE(ABORT, 'daily_time_allocations: allocated_seconds does not match authoritative slice total_seconds');
END;

CREATE TRIGGER trg_daily_allocations_match_update
BEFORE UPDATE ON daily_time_allocations
FOR EACH ROW
WHEN NEW.state = 'active' AND NOT EXISTS (
  SELECT 1 FROM day_project_entity_slices
  WHERE date = NEW.date
    AND project_id = NEW.project_id
    AND entity = NEW.entity
    AND ABS(total_seconds - NEW.allocated_seconds) <= 0.001
)
BEGIN
  SELECT RAISE(ABORT, 'daily_time_allocations: allocated_seconds does not match authoritative slice total_seconds');
END;

-- 3. Rebuild classification_revisions to allow reconciliation mutation types
CREATE TABLE classification_revisions_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_type TEXT    NOT NULL CHECK (mutation_type IN (
    'rule_created', 'rule_updated', 'rule_deleted',
    'allocation_created', 'allocation_deleted',
    'reconciliation_adjusted', 'allocation_detached', 'allocation_reattached'
  )),
  target_type   TEXT    NOT NULL CHECK (target_type IN ('rule', 'allocation')),
  target_id     TEXT    NOT NULL,
  before_json   TEXT,
  after_json    TEXT,
  affected_json TEXT,
  actor         TEXT    NOT NULL DEFAULT 'admin',
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO classification_revisions_new (
  id, mutation_type, target_type, target_id, before_json, after_json, affected_json, actor, created_at
)
SELECT
  id, mutation_type, target_type, target_id, before_json, after_json, affected_json, actor, created_at
FROM classification_revisions;

DROP TABLE classification_revisions;
ALTER TABLE classification_revisions_new RENAME TO classification_revisions;

CREATE TRIGGER trg_classification_revisions_no_update
BEFORE UPDATE ON classification_revisions
BEGIN
  SELECT RAISE(ABORT, 'classification_revisions is append-only');
END;

CREATE TRIGGER trg_classification_revisions_no_delete
BEFORE DELETE ON classification_revisions
BEGIN
  SELECT RAISE(ABORT, 'classification_revisions is append-only');
END;

-- 4. Heartbeat active evidence memberships, seeded from existing heartbeats
CREATE TABLE IF NOT EXISTS heartbeat_memberships (
  date          TEXT    NOT NULL,
  heartbeat_id  INTEGER NOT NULL REFERENCES heartbeats(id) ON DELETE CASCADE,
  active        INTEGER NOT NULL CHECK (active IN (0, 1)),
  PRIMARY KEY (date, heartbeat_id)
);

CREATE INDEX IF NOT EXISTS idx_hb_mem_date_active ON heartbeat_memberships(date, active);
CREATE INDEX IF NOT EXISTS idx_hb_mem_hb ON heartbeat_memberships(heartbeat_id);

INSERT OR IGNORE INTO heartbeat_memberships (date, heartbeat_id, active)
SELECT local_date, id, 1
FROM heartbeats;
