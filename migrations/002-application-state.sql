-- 002-application-state.sql
--
-- Durable application state, security, and classification overlay schema.
--
-- Enforces:
--   * No plaintext credentials (hashes and prefixes only).
--   * Admin sessions matching AdminSessionRecord.
--   * API keys matching ApiKeyRecord with validated ApplicationScope sets.
--   * OAuth clients matching OAuthClientRecord with validated redirect URIs and scopes.
--   * OAuth authorization codes and tokens with one-use code consumption, token rotation,
--     and RFC 8707 resource binding.
--   * Classification rules with exactly 'work' | 'personal' and valid identity selector types.
--   * Whole-slice one-off daily time allocations keyed on (date, project_id, entity) with
--     authoritative duration enforcement against day_project_entity_slices.
--   * Append-only classification revisions and audit events (no raw IP/user-agents).
--   * Sync run and day tracking sufficient for scheduler state.
--

-- ---------------------------------------------------------------------------
-- 1. Application settings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- 2. Admin sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash    TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at    TEXT,
  CHECK (length(token_hash) > 0)
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_revoked ON admin_sessions(revoked_at) WHERE revoked_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. API keys
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL CHECK (length(trim(name)) >= 2 AND length(trim(name)) <= 80),
  token_prefix  TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  scopes        TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT,
  last_used_at  TEXT,
  revoked_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_token_hash ON api_keys(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_revoked ON api_keys(revoked_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_expires ON api_keys(expires_at);

CREATE TRIGGER IF NOT EXISTS trg_api_keys_scopes_insert
BEFORE INSERT ON api_keys
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.scopes)
  WHERE value NOT IN ('activity:read', 'activity:detail', 'operations:read')
)
BEGIN
  SELECT RAISE(ABORT, 'api_keys: contains forbidden scope');
END;

CREATE TRIGGER IF NOT EXISTS trg_api_keys_scopes_update
BEFORE UPDATE ON api_keys
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.scopes)
  WHERE value NOT IN ('activity:read', 'activity:detail', 'operations:read')
)
BEGIN
  SELECT RAISE(ABORT, 'api_keys: contains forbidden scope');
END;

-- ---------------------------------------------------------------------------
-- 4. OAuth clients, authorization codes, and tokens
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  name          TEXT NOT NULL CHECK (length(trim(name)) >= 2 AND length(trim(name)) <= 80),
  public_client INTEGER NOT NULL CHECK (public_client IN (0, 1)),
  secret_prefix TEXT,
  secret_hash   TEXT,
  redirect_uris TEXT NOT NULL CHECK (json_valid(redirect_uris) AND json_type(redirect_uris) = 'array'),
  scopes        TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at    TEXT,
  CHECK ((public_client = 1 AND secret_hash IS NULL) OR (public_client = 0 AND secret_hash IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_revoked ON oauth_clients(revoked_at);

CREATE TRIGGER IF NOT EXISTS trg_oauth_clients_scopes_insert
BEFORE INSERT ON oauth_clients
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.scopes)
  WHERE value NOT IN ('activity:read', 'activity:detail', 'operations:read')
)
BEGIN
  SELECT RAISE(ABORT, 'oauth_clients: contains forbidden scope');
END;

CREATE TRIGGER IF NOT EXISTS trg_oauth_clients_scopes_update
BEFORE UPDATE ON oauth_clients
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.scopes)
  WHERE value NOT IN ('activity:read', 'activity:detail', 'operations:read')
)
BEGIN
  SELECT RAISE(ABORT, 'oauth_clients: contains forbidden scope');
END;

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri    TEXT NOT NULL,
  resource        TEXT NOT NULL,
  scopes          TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  code_challenge  TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at      TEXT NOT NULL,
  used_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_client ON oauth_authorization_codes(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_expires ON oauth_authorization_codes(expires_at);

CREATE TRIGGER IF NOT EXISTS trg_oauth_codes_scopes_insert
BEFORE INSERT ON oauth_authorization_codes
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.scopes)
  WHERE value NOT IN ('activity:read', 'activity:detail', 'operations:read')
)
BEGIN
  SELECT RAISE(ABORT, 'oauth_authorization_codes: contains forbidden scope');
END;

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                  TEXT PRIMARY KEY,
  family_id           TEXT NOT NULL,
  client_id           TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  resource            TEXT NOT NULL,
  access_token_hash   TEXT NOT NULL UNIQUE,
  refresh_token_hash  TEXT NOT NULL UNIQUE,
  scopes              TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  access_expires_at   TEXT NOT NULL,
  refresh_expires_at  TEXT NOT NULL,
  refresh_used_at     TEXT,
  revoked_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_access ON oauth_tokens(access_token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);

CREATE TRIGGER IF NOT EXISTS trg_oauth_tokens_scopes_insert
BEFORE INSERT ON oauth_tokens
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.scopes)
  WHERE value NOT IN ('activity:read', 'activity:detail', 'operations:read')
)
BEGIN
  SELECT RAISE(ABORT, 'oauth_tokens: contains forbidden scope');
END;

-- ---------------------------------------------------------------------------
-- 5. Classification overlay (rules, allocations, append-only revisions)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS classification_rules (
  id              TEXT    PRIMARY KEY,
  name            TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  classification  TEXT    NOT NULL CHECK (classification IN ('work', 'personal')),
  selector_type   TEXT    NOT NULL CHECK (selector_type IN ('machine', 'editor', 'application', 'domain', 'project', 'folder_prefix', 'entity')),
  selector_value  TEXT    NOT NULL CHECK (length(trim(selector_value)) > 0),
  priority        INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  timesheet_code  TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_classification_rules_lookup ON classification_rules(selector_type, selector_value);
CREATE INDEX IF NOT EXISTS idx_classification_rules_priority ON classification_rules(priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_classification_rules_enabled ON classification_rules(enabled);

CREATE TABLE IF NOT EXISTS daily_time_allocations (
  id                TEXT    PRIMARY KEY,
  date              TEXT    NOT NULL,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  entity            TEXT    NOT NULL,
  classification    TEXT    NOT NULL CHECK (classification IN ('work', 'personal')),
  allocated_seconds REAL    NOT NULL CHECK (allocated_seconds >= 0.0),
  timesheet_code    TEXT,
  note              TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (date, project_id, entity),
  FOREIGN KEY (date, project_id, entity) REFERENCES day_project_entity_slices(date, project_id, entity) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_allocations_slice ON daily_time_allocations(date, project_id, entity);
CREATE INDEX IF NOT EXISTS idx_allocations_date ON daily_time_allocations(date);
CREATE INDEX IF NOT EXISTS idx_allocations_project ON daily_time_allocations(project_id);

CREATE TRIGGER IF NOT EXISTS trg_daily_allocations_match_insert
BEFORE INSERT ON daily_time_allocations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM day_project_entity_slices
  WHERE date = NEW.date
    AND project_id = NEW.project_id
    AND entity = NEW.entity
    AND ABS(total_seconds - NEW.allocated_seconds) <= 0.001
)
BEGIN
  SELECT RAISE(ABORT, 'daily_time_allocations: allocated_seconds does not match authoritative slice total_seconds');
END;

CREATE TRIGGER IF NOT EXISTS trg_daily_allocations_match_update
BEFORE UPDATE ON daily_time_allocations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM day_project_entity_slices
  WHERE date = NEW.date
    AND project_id = NEW.project_id
    AND entity = NEW.entity
    AND ABS(total_seconds - NEW.allocated_seconds) <= 0.001
)
BEGIN
  SELECT RAISE(ABORT, 'daily_time_allocations: allocated_seconds does not match authoritative slice total_seconds');
END;

CREATE TABLE IF NOT EXISTS classification_revisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_type TEXT    NOT NULL CHECK (mutation_type IN ('rule_created', 'rule_updated', 'rule_deleted', 'allocation_created', 'allocation_deleted')),
  target_type   TEXT    NOT NULL CHECK (target_type IN ('rule', 'allocation')),
  target_id     TEXT    NOT NULL,
  before_json   TEXT,
  after_json    TEXT,
  affected_json TEXT,
  actor         TEXT    NOT NULL DEFAULT 'admin',
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER IF NOT EXISTS trg_classification_revisions_no_update
BEFORE UPDATE ON classification_revisions
BEGIN
  SELECT RAISE(ABORT, 'classification_revisions is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_classification_revisions_no_delete
BEFORE DELETE ON classification_revisions
BEGIN
  SELECT RAISE(ABORT, 'classification_revisions is append-only');
END;

-- ---------------------------------------------------------------------------
-- 6. Audit events (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type          TEXT    NOT NULL,
  actor               TEXT    NOT NULL DEFAULT 'system',
  target_type         TEXT,
  target_id           TEXT,
  details_json        TEXT,
  remote_fingerprint  TEXT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_type ON audit_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor, created_at);

CREATE TRIGGER IF NOT EXISTS trg_audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

-- ---------------------------------------------------------------------------
-- 7. Sync runs and sync days (scheduler state)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sync_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at           TEXT,
  trigger               TEXT    NOT NULL DEFAULT 'manual'
                                CHECK (trigger IN ('manual', 'scheduled', 'startup', 'catchup')),
  status                TEXT    NOT NULL DEFAULT 'running'
                                CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  range_start_date      TEXT,
  range_end_date        TEXT,
  day_count             INTEGER NOT NULL DEFAULT 0,
  days_synced           INTEGER NOT NULL DEFAULT 0,
  days_failed           INTEGER NOT NULL DEFAULT 0,
  degraded_capabilities TEXT,
  advisory_codes        TEXT,
  summary               TEXT,
  error_message         TEXT,
  policy_state_json     TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_status ON sync_runs(status, started_at);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at);

CREATE TABLE IF NOT EXISTS sync_days (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_run_id       INTEGER REFERENCES sync_runs(id) ON DELETE CASCADE,
  date              TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'succeeded', 'partial', 'failed', 'skipped')),
  summaries_status  TEXT    CHECK (summaries_status IS NULL OR summaries_status IN ('succeeded', 'failed', 'restricted', 'skipped')),
  durations_status  TEXT    CHECK (durations_status IS NULL OR durations_status IN ('succeeded', 'failed', 'restricted', 'skipped')),
  heartbeats_status TEXT    CHECK (heartbeats_status IS NULL OR heartbeats_status IN ('succeeded', 'failed', 'restricted', 'skipped')),
  source_import_id  INTEGER REFERENCES source_imports(id) ON DELETE SET NULL,
  total_seconds     REAL    NOT NULL DEFAULT 0.0 CHECK (total_seconds >= 0.0),
  heartbeat_count   INTEGER NOT NULL DEFAULT 0,
  error_message     TEXT,
  synced_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (date, sync_run_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_days_date ON sync_days(date);
CREATE INDEX IF NOT EXISTS idx_sync_days_run ON sync_days(sync_run_id, status);
