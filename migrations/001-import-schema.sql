-- 001-import-schema.sql
--
-- Import-side schema for the WakaTime archive.
--
-- Invariants this schema exists to enforce (see docs/IMPLEMENTATION-PLAN.md
-- §6 and docs/DUMP-DATA-CONTRACT.md §7):
--
--   * Elapsed time is ONLY ever the official WakaTime value carried by the
--     daily summary export. Nothing in here stores a duration derived from
--     heartbeat gaps or heartbeat counts.
--   * `daily_dimension_totals` holds two disjoint views of the same time
--     (account scope and project scope). They must never be summed together,
--     so `scope` is NOT NULL and every query must predicate on it.
--   * The additive unit of classification is the day/project/entity slice in
--     `day_project_entity_slices`, whose seconds come from the daily export's
--     `projects[].entities[]` rows plus one synthetic `__unattributed__`
--     residual slice per day.
--   * Heartbeats are evidence, not duration. They contribute identity
--     associations to slices via `slice_identities`.
--
-- Classification tables (rules, allocations, revisions) are deliberately NOT
-- created here; they are a local overlay owned by a later migration.

-- ---------------------------------------------------------------------------
-- Migration bookkeeping
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    TEXT    PRIMARY KEY,
  applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- 1. Source lineage
-- ---------------------------------------------------------------------------

-- One row per import attempt. Deliberately stores NO filename: supplied dump
-- names embed the account email address.
CREATE TABLE IF NOT EXISTS source_imports (
  id                INTEGER PRIMARY KEY,
  source_type       TEXT    NOT NULL
                            CHECK (source_type IN ('daily_dump','heartbeat_dump','api_summaries','api_heartbeats')),
  source_hash       TEXT    NOT NULL,          -- SHA-256 hex of the exact bytes consumed
  byte_size         INTEGER NOT NULL,
  range_start_date  TEXT,                      -- YYYY-MM-DD, inclusive
  range_end_date    TEXT,                      -- YYYY-MM-DD, inclusive
  started_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at       TEXT,
  status            TEXT    NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running','completed','failed')),
  dry_run           INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0,1)),
  day_count         INTEGER NOT NULL DEFAULT 0,
  record_count      INTEGER NOT NULL DEFAULT 0,
  duplicate_count   INTEGER NOT NULL DEFAULT 0,
  conflict_count    INTEGER NOT NULL DEFAULT 0,
  warnings_json     TEXT,                      -- JSON array of redacted warning strings
  error_summary     TEXT                       -- redacted; never contains a path or entity
);

CREATE INDEX IF NOT EXISTS idx_source_imports_hash   ON source_imports(source_hash, status);
CREATE INDEX IF NOT EXISTS idx_source_imports_status ON source_imports(status, started_at);

-- Lossless retention of the per-day source JSON so fields without a normalized
-- column are never lost. Heartbeat payloads are retained on
-- `heartbeat_variants` instead, one row per distinct canonical payload.
CREATE TABLE IF NOT EXISTS source_payloads (
  id                INTEGER PRIMARY KEY,
  source_import_id  INTEGER NOT NULL REFERENCES source_imports(id) ON DELETE CASCADE,
  endpoint          TEXT    NOT NULL,          -- e.g. 'dump:daily.days[]'
  covered_date      TEXT    NOT NULL,          -- YYYY-MM-DD
  payload_hash      TEXT    NOT NULL,          -- SHA-256 hex of the canonical payload
  payload_json      TEXT    NOT NULL,
  first_seen_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source_import_id, endpoint, covered_date)
);

CREATE INDEX IF NOT EXISTS idx_source_payloads_date ON source_payloads(covered_date, endpoint);
CREATE INDEX IF NOT EXISTS idx_source_payloads_hash ON source_payloads(payload_hash);

-- ---------------------------------------------------------------------------
-- 2. Account and projects
-- ---------------------------------------------------------------------------

-- Non-PII account settings only. Email, display/full name, photo, profile URLs
-- and social handles are contractually forbidden here (DUMP-DATA-CONTRACT §3).
CREATE TABLE IF NOT EXISTS account_settings (
  wakatime_user_id          TEXT    PRIMARY KEY,
  timezone                  TEXT    NOT NULL DEFAULT 'UTC',
  weekday_start             INTEGER NOT NULL DEFAULT 0,
  keystroke_timeout_seconds INTEGER NOT NULL DEFAULT 15,
  writes_only               INTEGER NOT NULL DEFAULT 0 CHECK (writes_only IN (0,1)),
  plan                      TEXT    NOT NULL DEFAULT '',
  has_premium_features      INTEGER NOT NULL DEFAULT 0 CHECK (has_premium_features IN (0,1)),
  source_import_id          INTEGER REFERENCES source_imports(id),
  updated_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id                  INTEGER PRIMARY KEY,
  name                TEXT    NOT NULL UNIQUE,
  is_unattributed     INTEGER NOT NULL DEFAULT 0 CHECK (is_unattributed IN (0,1)),
  first_activity_date TEXT,
  last_activity_date  TEXT,
  first_seen_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Pseudo-project owning the per-day residual between the authoritative daily
-- total and the sum of that day's official entity slices.
INSERT OR IGNORE INTO projects (name, is_unattributed) VALUES ('__unattributed__', 1);

-- ---------------------------------------------------------------------------
-- 3. Official WakaTime-derived totals
-- ---------------------------------------------------------------------------

-- The single authoritative source of elapsed time. One row per calendar day in
-- the export range, including zero-activity days.
CREATE TABLE IF NOT EXISTS daily_totals (
  date                    TEXT    PRIMARY KEY,      -- YYYY-MM-DD
  timezone                TEXT    NOT NULL DEFAULT 'UTC',
  total_seconds           REAL    NOT NULL DEFAULT 0.0 CHECK (total_seconds >= 0.0),
  human_additions         INTEGER NOT NULL DEFAULT 0,
  human_deletions         INTEGER NOT NULL DEFAULT 0,
  ai_additions            INTEGER NOT NULL DEFAULT 0,
  ai_deletions            INTEGER NOT NULL DEFAULT 0,
  ai_sessions             INTEGER NOT NULL DEFAULT 0,
  ai_input_tokens         INTEGER NOT NULL DEFAULT 0,
  ai_cached_input_tokens  INTEGER NOT NULL DEFAULT 0,
  ai_output_tokens        INTEGER NOT NULL DEFAULT 0,
  ai_prompt_length_sum    INTEGER NOT NULL DEFAULT 0,
  ai_model_total_cost     REAL    NOT NULL DEFAULT 0.0,
  ai_model_data_json      TEXT,                     -- {breakdown, costs, line_changes}
  grand_total_json        TEXT    NOT NULL,         -- lossless grand_total
  project_sum_seconds     REAL    NOT NULL DEFAULT 0.0,
  project_sum_delta       REAL    NOT NULL DEFAULT 0.0, -- total_seconds - project_sum_seconds
  source_import_id        INTEGER NOT NULL REFERENCES source_imports(id),
  source_hash             TEXT    NOT NULL,
  reconciled_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_daily_totals_active ON daily_totals(date) WHERE total_seconds > 0.0;

-- Generic scoped breakdown rows. `scope` partitions two non-additive views:
--   scope='account'  -> day-level rollups, project_id IS NULL
--   scope='project'  -> rows nested inside one project, project_id NOT NULL
-- Never sum across scopes; every query must supply an explicit scope predicate.
CREATE TABLE IF NOT EXISTS daily_dimension_totals (
  id                  INTEGER PRIMARY KEY,
  date                TEXT    NOT NULL,
  scope               TEXT    NOT NULL CHECK (scope IN ('account','project')),
  project_id          INTEGER REFERENCES projects(id),
  -- COALESCE shim so the UNIQUE constraint dedupes account rows, where SQLite
  -- would otherwise treat every NULL project_id as distinct.
  project_key         INTEGER NOT NULL GENERATED ALWAYS AS (COALESCE(project_id, 0)) STORED,
  dimension           TEXT    NOT NULL
                              CHECK (dimension IN ('project','category','dependency','editor',
                                                   'entity','language','machine',
                                                   'operating_system','branch')),
  name                TEXT    NOT NULL,
  entity_type         TEXT    CHECK (entity_type IS NULL OR entity_type IN ('file','app','domain')),
  machine_name_id     TEXT,
  project_root_count  INTEGER,
  total_seconds       REAL    NOT NULL DEFAULT 0.0 CHECK (total_seconds >= 0.0),
  percent             REAL,                      -- display-only; never recomputed
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

CREATE INDEX IF NOT EXISTS idx_ddt_scope_dim   ON daily_dimension_totals(scope, dimension, name, date);
CREATE INDEX IF NOT EXISTS idx_ddt_date_scope  ON daily_dimension_totals(date, scope, dimension);
CREATE INDEX IF NOT EXISTS idx_ddt_project     ON daily_dimension_totals(project_id, dimension, date)
  WHERE project_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Official additive slices (the classification unit)
-- ---------------------------------------------------------------------------

-- One row per daily projects[].entities[] row, plus one synthetic
-- `__unattributed__` slice per day carrying any positive residual between the
-- authoritative daily total and the sum of that day's entity slices.
-- Seconds here always come from the daily export; never from heartbeats.
CREATE TABLE IF NOT EXISTS day_project_entity_slices (
  id                  INTEGER PRIMARY KEY,
  date                TEXT    NOT NULL,
  project_id          INTEGER NOT NULL REFERENCES projects(id),
  entity              TEXT    NOT NULL,        -- normalized path/app/domain, or '__unattributed__'
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
  UNIQUE (date, project_id, entity)
);

CREATE INDEX IF NOT EXISTS idx_slices_date    ON day_project_entity_slices(date);
CREATE INDEX IF NOT EXISTS idx_slices_project ON day_project_entity_slices(project_id, date);
CREATE INDEX IF NOT EXISTS idx_slices_entity  ON day_project_entity_slices(entity);

-- Identity associations observed for a slice. Machine and editor identities are
-- contributed by matching raw heartbeats; project, folder_prefix, entity,
-- application and domain identities are intrinsic to the slice itself.
--
-- Selector types are restricted to real identity boundaries. Language,
-- category, branch and dependency are descriptive attributes and are
-- deliberately excluded (IMPLEMENTATION-PLAN §6.5 "Disallowed selectors").
CREATE TABLE IF NOT EXISTS slice_identities (
  id                  INTEGER PRIMARY KEY,
  slice_id            INTEGER NOT NULL REFERENCES day_project_entity_slices(id) ON DELETE CASCADE,
  selector_type       TEXT    NOT NULL
                              CHECK (selector_type IN ('machine','editor','application',
                                                       'domain','project','folder_prefix',
                                                       'entity')),
  value               TEXT    NOT NULL,        -- normalized per normalizeSelectorValue()
  source              TEXT    NOT NULL DEFAULT 'slice'
                              CHECK (source IN ('slice','heartbeat')),
  observed_heartbeats INTEGER NOT NULL DEFAULT 0,
  UNIQUE (slice_id, selector_type, value)
);

CREATE INDEX IF NOT EXISTS idx_slice_ident_lookup ON slice_identities(selector_type, value);
CREATE INDEX IF NOT EXISTS idx_slice_ident_slice  ON slice_identities(slice_id);

-- ---------------------------------------------------------------------------
-- 5. Raw heartbeats (evidence, never duration)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS heartbeats (
  id                      INTEGER PRIMARY KEY,
  external_id             TEXT    NOT NULL UNIQUE,   -- WakaTime heartbeat UUID
  occurred_at_us          INTEGER NOT NULL,          -- epoch microseconds, exact ordering
  occurred_at             TEXT    NOT NULL,          -- ISO 8601 UTC
  local_date              TEXT    NOT NULL,          -- enclosing WakaTime day
  entity                  TEXT    NOT NULL,
  entity_type             TEXT    NOT NULL CHECK (entity_type IN ('file','app','domain')),
  category                TEXT    NOT NULL,
  project_id              INTEGER REFERENCES projects(id),
  project_name            TEXT,
  branch                  TEXT,
  language                TEXT,
  project_root_count      INTEGER,
  machine_name_id         TEXT,
  user_agent_id           TEXT    NOT NULL,
  lines                   INTEGER,
  lineno                  INTEGER,
  cursorpos               INTEGER,
  is_write                INTEGER NOT NULL DEFAULT 0 CHECK (is_write IN (0,1)),
  ai_session              TEXT,
  ai_subscription_plan    TEXT,
  ai_line_changes         INTEGER,
  human_line_changes      INTEGER,
  ai_input_tokens         INTEGER NOT NULL DEFAULT 0,
  ai_cached_input_tokens  INTEGER NOT NULL DEFAULT 0,
  ai_output_tokens        INTEGER NOT NULL DEFAULT 0,
  ai_prompt_length        INTEGER NOT NULL DEFAULT 0,
  canonical_hash          TEXT    NOT NULL,          -- SHA-256 of the canonical payload
  occurrence_count        INTEGER NOT NULL DEFAULT 1,
  source_import_id        INTEGER NOT NULL REFERENCES source_imports(id),
  first_seen_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_hb_date     ON heartbeats(local_date, occurred_at_us);
CREATE INDEX IF NOT EXISTS idx_hb_time     ON heartbeats(occurred_at_us);
CREATE INDEX IF NOT EXISTS idx_hb_project  ON heartbeats(project_id, local_date);
CREATE INDEX IF NOT EXISTS idx_hb_entity   ON heartbeats(entity);
CREATE INDEX IF NOT EXISTS idx_hb_slice    ON heartbeats(local_date, project_name, entity);
CREATE INDEX IF NOT EXISTS idx_hb_machine  ON heartbeats(machine_name_id) WHERE machine_name_id IS NOT NULL;

-- Canonical (sorted, deduplicated) dependency relationships. The indexed query
-- path for dependency search; the lossless array also lives in the variant JSON.
CREATE TABLE IF NOT EXISTS heartbeat_dependencies (
  id            INTEGER PRIMARY KEY,
  heartbeat_id  INTEGER NOT NULL REFERENCES heartbeats(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  position      INTEGER NOT NULL,              -- index within the canonical array
  UNIQUE (heartbeat_id, name)
);

CREATE INDEX IF NOT EXISTS idx_hb_dep_name ON heartbeat_dependencies(name);

-- One row per DISTINCT canonical payload seen for an external heartbeat ID.
-- Canonically identical repeats increment occurrence_count. A payload that
-- differs after canonicalization is a conflict: the importer fails closed by
-- default and only records it as 'conflict' when explicitly allowed to.
CREATE TABLE IF NOT EXISTS heartbeat_variants (
  id                INTEGER PRIMARY KEY,
  external_id       TEXT    NOT NULL,
  canonical_hash    TEXT    NOT NULL,
  raw_json          TEXT    NOT NULL,          -- lossless canonical payload
  occurrence_count  INTEGER NOT NULL DEFAULT 1,
  conflict_state    TEXT    NOT NULL DEFAULT 'canonical'
                            CHECK (conflict_state IN ('canonical','conflict')),
  source_import_id  INTEGER NOT NULL REFERENCES source_imports(id),
  first_seen_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (external_id, canonical_hash)
);

CREATE INDEX IF NOT EXISTS idx_hb_variant_external ON heartbeat_variants(external_id);
CREATE INDEX IF NOT EXISTS idx_hb_variant_conflict ON heartbeat_variants(conflict_state)
  WHERE conflict_state = 'conflict';
