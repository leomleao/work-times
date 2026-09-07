-- 003-wakatime-oauth.sql
--
-- The WakaTime integration is an outbound OAuth client. This table is
-- deliberately separate from oauth_clients/oauth_tokens, which implement the
-- authorization server used by inbound MCP clients.

CREATE TABLE IF NOT EXISTS wakatime_oauth_connection (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  access_token_sealed   TEXT NOT NULL CHECK (length(access_token_sealed) > 0),
  refresh_token_sealed  TEXT NOT NULL CHECK (length(refresh_token_sealed) > 0),
  token_type            TEXT NOT NULL DEFAULT 'Bearer' CHECK (lower(token_type) = 'bearer'),
  scopes                TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  expires_at            TEXT,
  connected_at          TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

