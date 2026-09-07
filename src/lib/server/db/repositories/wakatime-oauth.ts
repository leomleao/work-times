import type Database from 'better-sqlite3';

export interface WakaTimeOAuthConnectionRecord {
  accessTokenSealed: string;
  refreshTokenSealed: string;
  tokenType: 'Bearer';
  scopes: string[];
  expiresAt: string | null;
  connectedAt: string;
  updatedAt: string;
}

interface WakaTimeOAuthConnectionRow {
  access_token_sealed: string;
  refresh_token_sealed: string;
  token_type: string;
  scopes: string;
  expires_at: string | null;
  connected_at: string;
  updated_at: string;
}

export class SqliteWakaTimeOAuthConnectionRepository {
  private readonly getStatement: Database.Statement;
  private readonly upsertStatement: Database.Statement;
  private readonly deleteStatement: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getStatement = db.prepare(`
      SELECT access_token_sealed, refresh_token_sealed, token_type, scopes,
             expires_at, connected_at, updated_at
      FROM wakatime_oauth_connection
      WHERE id = 1
    `);
    this.upsertStatement = db.prepare(`
      INSERT INTO wakatime_oauth_connection (
        id, access_token_sealed, refresh_token_sealed, token_type, scopes,
        expires_at, connected_at, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        access_token_sealed = excluded.access_token_sealed,
        refresh_token_sealed = excluded.refresh_token_sealed,
        token_type = excluded.token_type,
        scopes = excluded.scopes,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `);
    this.deleteStatement = db.prepare('DELETE FROM wakatime_oauth_connection WHERE id = 1');
  }

  get(): WakaTimeOAuthConnectionRecord | null {
    const row = this.getStatement.get() as WakaTimeOAuthConnectionRow | undefined;
    if (!row) return null;

    const parsedScopes: unknown = JSON.parse(row.scopes);
    if (!Array.isArray(parsedScopes) || !parsedScopes.every((scope) => typeof scope === 'string')) {
      throw new Error('Stored WakaTime OAuth scopes are invalid');
    }

    return {
      accessTokenSealed: row.access_token_sealed,
      refreshTokenSealed: row.refresh_token_sealed,
      tokenType: 'Bearer',
      scopes: parsedScopes,
      expiresAt: row.expires_at,
      connectedAt: row.connected_at,
      updatedAt: row.updated_at
    };
  }

  upsert(record: WakaTimeOAuthConnectionRecord): void {
    this.upsertStatement.run(
      record.accessTokenSealed,
      record.refreshTokenSealed,
      record.tokenType,
      JSON.stringify(record.scopes),
      record.expiresAt,
      record.connectedAt,
      record.updatedAt
    );
  }

  delete(): boolean {
    return this.deleteStatement.run().changes > 0;
  }
}

