-- 007-user-agent-registry.sql
--
-- Implements the user-agent registry and staging tables specified in
-- docs/NEXT-MILESTONE.md §2.6 and NEXT-MILESTONE-P0-CONTRACTS.md §5.3:
--   * user_agent_registry: canonical UUID mappings, editor, OS, version, AI model metadata,
--     historical marker, and refresh timestamps
--   * user_agent_registry_staging: identical schema for atomic staging of complete bounded refreshes
--   * Historical retention: UUID mappings absent from newer responses remain available with is_historical = 1

CREATE TABLE IF NOT EXISTS user_agent_registry (
  id                    TEXT    PRIMARY KEY,       -- canonical UUID
  editor                TEXT    NOT NULL,
  user_agent_value      TEXT    NOT NULL,
  os                    TEXT    NOT NULL,
  version               TEXT,
  ai_model              TEXT,
  ai_model_version      TEXT,
  ai_model_complexity   TEXT,
  is_browser_extension  INTEGER NOT NULL DEFAULT 0 CHECK (is_browser_extension IN (0, 1)),
  is_desktop_app        INTEGER NOT NULL DEFAULT 0 CHECK (is_desktop_app IN (0, 1)),
  first_seen_at         TEXT,
  last_seen_at          TEXT,
  is_historical         INTEGER NOT NULL DEFAULT 0 CHECK (is_historical IN (0, 1)),
  refreshed_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_user_agent_registry_editor ON user_agent_registry(editor);
CREATE INDEX IF NOT EXISTS idx_user_agent_registry_historical ON user_agent_registry(is_historical);

-- Staging table for atomic refresh verification prior to publication
CREATE TABLE IF NOT EXISTS user_agent_registry_staging (
  id                    TEXT    PRIMARY KEY,       -- canonical UUID
  editor                TEXT    NOT NULL,
  user_agent_value      TEXT    NOT NULL,
  os                    TEXT    NOT NULL,
  version               TEXT,
  ai_model              TEXT,
  ai_model_version      TEXT,
  ai_model_complexity   TEXT,
  is_browser_extension  INTEGER NOT NULL DEFAULT 0 CHECK (is_browser_extension IN (0, 1)),
  is_desktop_app        INTEGER NOT NULL DEFAULT 0 CHECK (is_desktop_app IN (0, 1)),
  first_seen_at         TEXT,
  last_seen_at          TEXT,
  is_historical         INTEGER NOT NULL DEFAULT 0 CHECK (is_historical IN (0, 1)),
  refreshed_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_user_agent_registry_staging_editor ON user_agent_registry_staging(editor);
