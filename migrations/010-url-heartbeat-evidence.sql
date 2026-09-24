-- WakaTime emits URL heartbeats. Keep their original entity and type as raw
-- evidence; this does not extend summary slices, classification or allocations.
-- The migration runner wraps this file in a transaction with foreign keys ON.

CREATE TABLE heartbeat_dependencies_stage (
  id INTEGER PRIMARY KEY,
  heartbeat_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL
);
INSERT INTO heartbeat_dependencies_stage
SELECT id, heartbeat_id, name, position FROM heartbeat_dependencies;

CREATE TABLE heartbeat_memberships_stage (
  date TEXT NOT NULL,
  heartbeat_id INTEGER NOT NULL,
  active INTEGER NOT NULL
);
INSERT INTO heartbeat_memberships_stage
SELECT date, heartbeat_id, active FROM heartbeat_memberships;

DROP TABLE heartbeat_dependencies;
DROP TABLE heartbeat_memberships;

CREATE TABLE heartbeats_new (
  id                      INTEGER PRIMARY KEY,
  external_id             TEXT    NOT NULL UNIQUE,
  occurred_at_us          INTEGER NOT NULL,
  occurred_at             TEXT    NOT NULL,
  local_date              TEXT    NOT NULL,
  entity                  TEXT    NOT NULL,
  entity_type             TEXT    NOT NULL CHECK (entity_type IN ('file','app','domain','url')),
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
  canonical_hash          TEXT    NOT NULL,
  occurrence_count        INTEGER NOT NULL DEFAULT 1,
  source_import_id        INTEGER NOT NULL REFERENCES source_imports(id),
  first_seen_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO heartbeats_new (
  id, external_id, occurred_at_us, occurred_at, local_date, entity, entity_type,
  category, project_id, project_name, branch, language, project_root_count,
  machine_name_id, user_agent_id, lines, lineno, cursorpos, is_write, ai_session,
  ai_subscription_plan, ai_line_changes, human_line_changes, ai_input_tokens,
  ai_cached_input_tokens, ai_output_tokens, ai_prompt_length, canonical_hash,
  occurrence_count, source_import_id, first_seen_at, last_seen_at
)
SELECT
  id, external_id, occurred_at_us, occurred_at, local_date, entity, entity_type,
  category, project_id, project_name, branch, language, project_root_count,
  machine_name_id, user_agent_id, lines, lineno, cursorpos, is_write, ai_session,
  ai_subscription_plan, ai_line_changes, human_line_changes, ai_input_tokens,
  ai_cached_input_tokens, ai_output_tokens, ai_prompt_length, canonical_hash,
  occurrence_count, source_import_id, first_seen_at, last_seen_at
FROM heartbeats;

DROP TABLE heartbeats;
ALTER TABLE heartbeats_new RENAME TO heartbeats;

CREATE INDEX idx_hb_date     ON heartbeats(local_date, occurred_at_us);
CREATE INDEX idx_hb_time     ON heartbeats(occurred_at_us);
CREATE INDEX idx_hb_project  ON heartbeats(project_id, local_date);
CREATE INDEX idx_hb_entity   ON heartbeats(entity);
CREATE INDEX idx_hb_slice    ON heartbeats(local_date, project_name, entity);
CREATE INDEX idx_hb_machine  ON heartbeats(machine_name_id) WHERE machine_name_id IS NOT NULL;

CREATE TABLE heartbeat_dependencies (
  id            INTEGER PRIMARY KEY,
  heartbeat_id  INTEGER NOT NULL REFERENCES heartbeats(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  position      INTEGER NOT NULL,
  UNIQUE (heartbeat_id, name)
);
INSERT INTO heartbeat_dependencies
SELECT id, heartbeat_id, name, position FROM heartbeat_dependencies_stage;
DROP TABLE heartbeat_dependencies_stage;
CREATE INDEX idx_hb_dep_name ON heartbeat_dependencies(name);

CREATE TABLE heartbeat_memberships (
  date          TEXT    NOT NULL,
  heartbeat_id  INTEGER NOT NULL REFERENCES heartbeats(id) ON DELETE CASCADE,
  active        INTEGER NOT NULL CHECK (active IN (0, 1)),
  PRIMARY KEY (date, heartbeat_id)
);
INSERT INTO heartbeat_memberships
SELECT date, heartbeat_id, active FROM heartbeat_memberships_stage;
DROP TABLE heartbeat_memberships_stage;
CREATE INDEX idx_hb_mem_date_active ON heartbeat_memberships(date, active);
CREATE INDEX idx_hb_mem_hb ON heartbeat_memberships(heartbeat_id);
