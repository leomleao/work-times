-- Preserve WakaTime URL summary entities as URL dimensions, slices, and
-- allocations. Existing row IDs and identity associations remain unchanged.
-- The migration runner wraps this file in one transaction with foreign keys ON.

CREATE TABLE daily_dimension_totals_new (
  id                  INTEGER PRIMARY KEY,
  date                TEXT    NOT NULL,
  scope               TEXT    NOT NULL CHECK (scope IN ('account','project')),
  project_id          INTEGER REFERENCES projects(id),
  project_key         INTEGER NOT NULL GENERATED ALWAYS AS (COALESCE(project_id, 0)) STORED,
  dimension           TEXT    NOT NULL CHECK (dimension IN ('project','category','dependency','editor',
                                                            'entity','language','machine','operating_system','branch')),
  name                TEXT    NOT NULL,
  entity_type         TEXT    CHECK (entity_type IS NULL OR entity_type IN ('file','app','domain','url')),
  machine_name_id     TEXT,
  project_root_count  INTEGER,
  total_seconds       REAL    NOT NULL DEFAULT 0.0 CHECK (total_seconds >= 0.0),
  percent             REAL,
  human_additions     INTEGER NOT NULL DEFAULT 0,
  human_deletions     INTEGER NOT NULL DEFAULT 0,
  ai_additions        INTEGER NOT NULL DEFAULT 0,
  ai_deletions        INTEGER NOT NULL DEFAULT 0,
  ai_sessions         INTEGER NOT NULL DEFAULT 0,
  raw_json            TEXT,
  source_import_id    INTEGER NOT NULL REFERENCES source_imports(id),
  CHECK ((scope = 'account' AND project_id IS NULL)
      OR (scope = 'project' AND project_id IS NOT NULL)),
  UNIQUE (date, scope, project_key, dimension, name)
);
INSERT INTO daily_dimension_totals_new (
  id, date, scope, project_id, dimension, name, entity_type, machine_name_id,
  project_root_count, total_seconds, percent, human_additions, human_deletions,
  ai_additions, ai_deletions, ai_sessions, raw_json, source_import_id
)
SELECT id, date, scope, project_id, dimension, name, entity_type, machine_name_id,
       project_root_count, total_seconds, percent, human_additions, human_deletions,
       ai_additions, ai_deletions, ai_sessions, raw_json, source_import_id
FROM daily_dimension_totals;
DROP TABLE daily_dimension_totals;
ALTER TABLE daily_dimension_totals_new RENAME TO daily_dimension_totals;
CREATE INDEX idx_ddt_scope_dim ON daily_dimension_totals(scope, dimension, name, date);
CREATE INDEX idx_ddt_date_scope ON daily_dimension_totals(date, scope, dimension);
CREATE INDEX idx_ddt_project ON daily_dimension_totals(project_id, dimension, date)
  WHERE project_id IS NOT NULL;

CREATE TABLE slice_identities_stage (
  id INTEGER PRIMARY KEY,
  slice_id INTEGER NOT NULL,
  selector_type TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_heartbeats INTEGER NOT NULL
);
INSERT INTO slice_identities_stage
SELECT id, slice_id, selector_type, value, source, observed_heartbeats
FROM slice_identities;
DROP TABLE slice_identities;

DROP TRIGGER IF EXISTS trg_daily_allocations_match_insert;
DROP TRIGGER IF EXISTS trg_daily_allocations_match_update;

CREATE TABLE day_project_entity_slices_new (
  id                  INTEGER PRIMARY KEY,
  date                TEXT    NOT NULL,
  project_id          INTEGER NOT NULL REFERENCES projects(id),
  entity              TEXT    NOT NULL,
  entity_type         TEXT    NOT NULL CHECK (entity_type IN ('file','app','domain','url','unattributed')),
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
                              CHECK (kind IN ('entity','project_summary','unattributed_residual')),
  snapshot_version    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (date, project_id, entity, entity_type, kind)
);
INSERT INTO day_project_entity_slices_new (
  id, date, project_id, entity, entity_type, total_seconds, percent,
  project_root_count, human_additions, human_deletions, ai_additions,
  ai_deletions, ai_sessions, is_unattributed, source_import_id, kind, snapshot_version
)
SELECT id, date, project_id, entity, entity_type, total_seconds, percent,
       project_root_count, human_additions, human_deletions, ai_additions,
       ai_deletions, ai_sessions, is_unattributed, source_import_id, kind, snapshot_version
FROM day_project_entity_slices;
DROP TABLE day_project_entity_slices;
ALTER TABLE day_project_entity_slices_new RENAME TO day_project_entity_slices;
CREATE INDEX idx_slices_date ON day_project_entity_slices(date);
CREATE INDEX idx_slices_project ON day_project_entity_slices(project_id, date);
CREATE INDEX idx_slices_entity ON day_project_entity_slices(entity);
CREATE INDEX idx_slices_kind ON day_project_entity_slices(kind);
CREATE INDEX idx_slices_semantic ON day_project_entity_slices(date, project_id, entity, entity_type, kind);

CREATE TABLE slice_identities (
  id                  INTEGER PRIMARY KEY,
  slice_id            INTEGER NOT NULL REFERENCES day_project_entity_slices(id) ON DELETE CASCADE,
  selector_type       TEXT    NOT NULL CHECK (selector_type IN ('machine','editor','application',
                                                               'domain','project','folder_prefix','entity')),
  value               TEXT    NOT NULL,
  source              TEXT    NOT NULL DEFAULT 'slice' CHECK (source IN ('slice','heartbeat')),
  observed_heartbeats INTEGER NOT NULL DEFAULT 0,
  UNIQUE (slice_id, selector_type, value)
);
INSERT INTO slice_identities
SELECT id, slice_id, selector_type, value, source, observed_heartbeats
FROM slice_identities_stage;
DROP TABLE slice_identities_stage;
CREATE INDEX idx_slice_ident_lookup ON slice_identities(selector_type, value);
CREATE INDEX idx_slice_ident_slice ON slice_identities(slice_id);

CREATE TABLE daily_time_allocations_new (
  id                TEXT    PRIMARY KEY,
  date              TEXT    NOT NULL,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  entity            TEXT    NOT NULL,
  entity_type       TEXT    NOT NULL CHECK (entity_type IN ('file','app','domain','url','unattributed')),
  kind              TEXT    NOT NULL CHECK (kind IN ('entity','project_summary','unattributed_residual')),
  classification    TEXT    NOT NULL CHECK (classification IN ('work','personal')),
  allocated_seconds REAL    NOT NULL CHECK (allocated_seconds >= 0.0),
  timesheet_code    TEXT,
  note              TEXT,
  state             TEXT    NOT NULL DEFAULT 'active' CHECK (state IN ('active','detached')),
  detached_at       TEXT,
  reattached_at     TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (date, project_id, entity, entity_type, kind)
);
INSERT INTO daily_time_allocations_new (
  id, date, project_id, entity, entity_type, kind, classification,
  allocated_seconds, timesheet_code, note, state, detached_at,
  reattached_at, created_at, updated_at
)
SELECT id, date, project_id, entity, entity_type, kind, classification,
       allocated_seconds, timesheet_code, note, state, detached_at,
       reattached_at, created_at, updated_at
FROM daily_time_allocations;
DROP TABLE daily_time_allocations;
ALTER TABLE daily_time_allocations_new RENAME TO daily_time_allocations;
CREATE INDEX idx_allocations_slice ON daily_time_allocations(date, project_id, entity, entity_type, kind);
CREATE INDEX idx_allocations_date ON daily_time_allocations(date);
CREATE INDEX idx_allocations_project ON daily_time_allocations(project_id);
CREATE INDEX idx_allocations_state ON daily_time_allocations(state);

CREATE TRIGGER trg_daily_allocations_match_insert
BEFORE INSERT ON daily_time_allocations
FOR EACH ROW
WHEN NEW.state = 'active' AND NOT EXISTS (
  SELECT 1 FROM day_project_entity_slices
  WHERE date = NEW.date AND project_id = NEW.project_id
    AND entity = NEW.entity AND entity_type = NEW.entity_type AND kind = NEW.kind
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
  WHERE date = NEW.date AND project_id = NEW.project_id
    AND entity = NEW.entity AND entity_type = NEW.entity_type AND kind = NEW.kind
    AND ABS(total_seconds - NEW.allocated_seconds) <= 0.001
)
BEGIN
  SELECT RAISE(ABORT, 'daily_time_allocations: allocated_seconds does not match authoritative slice total_seconds');
END;
