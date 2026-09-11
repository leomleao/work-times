-- 009-slice-semantic-identity.sql
--
-- Corrects slice semantic identity as specified for milestone P1:
--   * day_project_entity_slices: uniqueness changed to (date, project_id, entity, entity_type, kind),
--     preserving row IDs, source lineage, slice_identities, indexes, and foreign-key integrity.
--   * daily_time_allocations: rebuilt with required entity_type and kind columns and the same
--     semantic unique key (date, project_id, entity, entity_type, kind); preserves IDs,
--     classification, allocated_seconds, note, timesheet_code, state, timestamps, and revision history.
--   * Legacy daily_time_allocations rows are populated only from exactly one matching current slice,
--     failing and rolling back on missing or ambiguous slice identity.
--   * State-aware duration check triggers updated to require the exact full 5-part key for active
--     allocations while keeping detached allocations valid.

-- ---------------------------------------------------------------------------
-- 1. Validate legacy allocation identities before schema alteration
-- ---------------------------------------------------------------------------

CREATE TABLE _legacy_allocation_validator (
  id INTEGER PRIMARY KEY
);

CREATE TRIGGER trg_validate_legacy_allocations
BEFORE INSERT ON _legacy_allocation_validator
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM daily_time_allocations a
  WHERE (
    SELECT COUNT(*) FROM day_project_entity_slices s
    WHERE s.date = a.date
      AND s.project_id = a.project_id
      AND s.entity = a.entity
  ) != 1
)
BEGIN
  SELECT RAISE(ABORT, 'UNRESOLVABLE_LEGACY_ALLOCATION_IDENTITY');
END;

INSERT INTO _legacy_allocation_validator (id) VALUES (1);

DROP TRIGGER trg_validate_legacy_allocations;
DROP TABLE _legacy_allocation_validator;

-- Drop legacy triggers on daily_time_allocations that reference day_project_entity_slices
DROP TRIGGER IF EXISTS trg_daily_allocations_match_insert;
DROP TRIGGER IF EXISTS trg_daily_allocations_match_update;

-- ---------------------------------------------------------------------------
-- 2. Rebuild day_project_entity_slices under active foreign key enforcement
-- ---------------------------------------------------------------------------

-- Stage child slice_identities so parent table can be rebuilt safely
CREATE TABLE slice_identities_stage (
  id                  INTEGER PRIMARY KEY,
  slice_id            INTEGER NOT NULL,
  selector_type       TEXT    NOT NULL,
  value               TEXT    NOT NULL,
  source              TEXT    NOT NULL,
  observed_heartbeats INTEGER NOT NULL
);

INSERT INTO slice_identities_stage (
  id, slice_id, selector_type, value, source, observed_heartbeats
)
SELECT
  id, slice_id, selector_type, value, source, observed_heartbeats
FROM slice_identities;

DROP TABLE slice_identities;

-- Rebuild day_project_entity_slices with expanded 5-column unique constraint
CREATE TABLE day_project_entity_slices_new (
  id                  INTEGER PRIMARY KEY,
  date                TEXT    NOT NULL,
  project_id          INTEGER NOT NULL REFERENCES projects(id),
  entity              TEXT    NOT NULL,
  entity_type         TEXT    NOT NULL
                              CHECK (entity_type IN ('file','app','domain','unattributed')),
  total_seconds       REAL    NOT NULL DEFAULT 0.0 CHECK (total_seconds >= 0.0),
  percent             REAL,
  project_root_count  INTEGER,
  human_additions     INTEGER NOT NULL DEFAULT 0,
  human_deletions     INTEGER NOT NULL DEFAULT 0,
  ai_additions        INTEGER NOT NULL DEFAULT 0,
  ai_deletions        INTEGER NOT NULL DEFAULT 0,
  ai_sessions         INTEGER NOT NULL DEFAULT 0,
  is_unattributed     INTEGER NOT NULL DEFAULT 0 CHECK (is_unattributed IN (0,1)),
  source_import_id    INTEGER NOT NULL REFERENCES source_imports(id),
  kind                TEXT    NOT NULL DEFAULT 'entity'
                              CHECK (kind IN ('entity', 'project_summary', 'unattributed_residual')),
  snapshot_version    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (date, project_id, entity, entity_type, kind)
);

INSERT INTO day_project_entity_slices_new (
  id, date, project_id, entity, entity_type, total_seconds, percent,
  project_root_count, human_additions, human_deletions, ai_additions,
  ai_deletions, ai_sessions, is_unattributed, source_import_id,
  kind, snapshot_version
)
SELECT
  id, date, project_id, entity, entity_type, total_seconds, percent,
  project_root_count, human_additions, human_deletions, ai_additions,
  ai_deletions, ai_sessions, is_unattributed, source_import_id,
  kind, snapshot_version
FROM day_project_entity_slices;

DROP TABLE day_project_entity_slices;
ALTER TABLE day_project_entity_slices_new RENAME TO day_project_entity_slices;

CREATE INDEX idx_slices_date    ON day_project_entity_slices(date);
CREATE INDEX idx_slices_project ON day_project_entity_slices(project_id, date);
CREATE INDEX idx_slices_entity  ON day_project_entity_slices(entity);
CREATE INDEX idx_slices_kind    ON day_project_entity_slices(kind);
CREATE INDEX idx_slices_semantic ON day_project_entity_slices(date, project_id, entity, entity_type, kind);

-- Restore slice_identities with FK targeting rebuilt day_project_entity_slices
CREATE TABLE slice_identities (
  id                  INTEGER PRIMARY KEY,
  slice_id            INTEGER NOT NULL REFERENCES day_project_entity_slices(id) ON DELETE CASCADE,
  selector_type       TEXT    NOT NULL
                              CHECK (selector_type IN ('machine','editor','application',
                                                       'domain','project','folder_prefix',
                                                       'entity')),
  value               TEXT    NOT NULL,
  source              TEXT    NOT NULL DEFAULT 'slice'
                              CHECK (source IN ('slice','heartbeat')),
  observed_heartbeats INTEGER NOT NULL DEFAULT 0,
  UNIQUE (slice_id, selector_type, value)
);

INSERT INTO slice_identities (
  id, slice_id, selector_type, value, source, observed_heartbeats
)
SELECT
  id, slice_id, selector_type, value, source, observed_heartbeats
FROM slice_identities_stage;

DROP TABLE slice_identities_stage;

CREATE INDEX idx_slice_ident_lookup ON slice_identities(selector_type, value);
CREATE INDEX idx_slice_ident_slice  ON slice_identities(slice_id);

-- ---------------------------------------------------------------------------
-- 3. Rebuild daily_time_allocations with entity_type, kind, and 5-tuple key
-- ---------------------------------------------------------------------------

CREATE TABLE daily_time_allocations_new (
  id                TEXT    PRIMARY KEY,
  date              TEXT    NOT NULL,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  entity            TEXT    NOT NULL,
  entity_type       TEXT    NOT NULL CHECK (entity_type IN ('file', 'app', 'domain', 'unattributed')),
  kind              TEXT    NOT NULL CHECK (kind IN ('entity', 'project_summary', 'unattributed_residual')),
  classification    TEXT    NOT NULL CHECK (classification IN ('work', 'personal')),
  allocated_seconds REAL    NOT NULL CHECK (allocated_seconds >= 0.0),
  timesheet_code    TEXT,
  note              TEXT,
  state             TEXT    NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'detached')),
  detached_at       TEXT,
  reattached_at     TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (date, project_id, entity, entity_type, kind)
);

-- Populate legacy allocations from exactly one matching current slice
INSERT INTO daily_time_allocations_new (
  id,
  date,
  project_id,
  entity,
  entity_type,
  kind,
  classification,
  allocated_seconds,
  timesheet_code,
  note,
  state,
  detached_at,
  reattached_at,
  created_at,
  updated_at
)
SELECT
  a.id,
  a.date,
  a.project_id,
  a.entity,
  s.entity_type,
  s.kind,
  a.classification,
  a.allocated_seconds,
  a.timesheet_code,
  a.note,
  a.state,
  a.detached_at,
  a.reattached_at,
  a.created_at,
  a.updated_at
FROM daily_time_allocations a
JOIN day_project_entity_slices s
  ON s.date = a.date
 AND s.project_id = a.project_id
 AND s.entity = a.entity;

-- Ensure every legacy allocation was successfully transferred
CREATE TABLE _legacy_allocation_count_validator (
  id INTEGER PRIMARY KEY
);

CREATE TRIGGER trg_validate_legacy_allocation_counts
BEFORE INSERT ON _legacy_allocation_count_validator
FOR EACH ROW
WHEN (SELECT COUNT(*) FROM daily_time_allocations) != (SELECT COUNT(*) FROM daily_time_allocations_new)
BEGIN
  SELECT RAISE(ABORT, 'UNRESOLVABLE_LEGACY_ALLOCATION_IDENTITY');
END;

INSERT INTO _legacy_allocation_count_validator (id) VALUES (1);

DROP TRIGGER trg_validate_legacy_allocation_counts;
DROP TABLE _legacy_allocation_count_validator;

DROP TABLE daily_time_allocations;
ALTER TABLE daily_time_allocations_new RENAME TO daily_time_allocations;

CREATE INDEX idx_allocations_slice ON daily_time_allocations(date, project_id, entity, entity_type, kind);
CREATE INDEX idx_allocations_date ON daily_time_allocations(date);
CREATE INDEX idx_allocations_project ON daily_time_allocations(project_id);
CREATE INDEX idx_allocations_state ON daily_time_allocations(state);

-- ---------------------------------------------------------------------------
-- 4. State-aware triggers requiring exact 5-tuple key for active allocations
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_daily_allocations_match_insert
BEFORE INSERT ON daily_time_allocations
FOR EACH ROW
WHEN NEW.state = 'active' AND NOT EXISTS (
  SELECT 1 FROM day_project_entity_slices
  WHERE date = NEW.date
    AND project_id = NEW.project_id
    AND entity = NEW.entity
    AND entity_type = NEW.entity_type
    AND kind = NEW.kind
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
    AND entity_type = NEW.entity_type
    AND kind = NEW.kind
    AND ABS(total_seconds - NEW.allocated_seconds) <= 0.001
)
BEGIN
  SELECT RAISE(ABORT, 'daily_time_allocations: allocated_seconds does not match authoritative slice total_seconds');
END;
