import type Database from 'better-sqlite3';

export interface WakaTimeOAuthConnectionRecord {
  accessTokenSealed: string;
  refreshTokenSealed: string;
  tokenType: 'Bearer';
  scopes: string[];
  expiresAt: string | null;
  connectedAt: string;
  updatedAt: string;
  generation: number;
  boundArchiveIdentity: string | null;
  reboundAt: string | null;
}

interface WakaTimeOAuthConnectionRow {
  access_token_sealed: string;
  refresh_token_sealed: string;
  token_type: string;
  scopes: string;
  expires_at: string | null;
  connected_at: string;
  updated_at: string;
  generation: number;
  bound_archive_identity: string | null;
  rebound_at: string | null;
}

export class SqliteWakaTimeOAuthConnectionRepository {
  private readonly getStatement: Database.Statement;
  private readonly upsertStatement: Database.Statement;
  private readonly updateTokensCasStatement: Database.Statement;
  private readonly deleteStatement: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getStatement = db.prepare(`
      SELECT access_token_sealed, refresh_token_sealed, token_type, scopes,
             expires_at, connected_at, updated_at, generation,
             bound_archive_identity, rebound_at
      FROM wakatime_oauth_connection
      WHERE id = 1
    `);

    this.upsertStatement = db.prepare(`
      INSERT INTO wakatime_oauth_connection (
        id, access_token_sealed, refresh_token_sealed, token_type, scopes,
        expires_at, connected_at, updated_at, generation, bound_archive_identity, rebound_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        access_token_sealed = excluded.access_token_sealed,
        refresh_token_sealed = excluded.refresh_token_sealed,
        token_type = excluded.token_type,
        scopes = excluded.scopes,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at,
        generation = CASE
          WHEN excluded.generation > wakatime_oauth_connection.generation THEN excluded.generation
          ELSE wakatime_oauth_connection.generation
        END,
        bound_archive_identity = COALESCE(excluded.bound_archive_identity, wakatime_oauth_connection.bound_archive_identity),
        rebound_at = COALESCE(excluded.rebound_at, wakatime_oauth_connection.rebound_at)
    `);

    this.updateTokensCasStatement = db.prepare(`
      UPDATE wakatime_oauth_connection
      SET access_token_sealed = ?,
          refresh_token_sealed = ?,
          expires_at = ?,
          updated_at = ?
      WHERE id = 1 AND generation = ?
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
      updatedAt: row.updated_at,
      generation: row.generation ?? 1,
      boundArchiveIdentity: row.bound_archive_identity ?? null,
      reboundAt: row.rebound_at ?? null
    };
  }

  upsert(record: {
    accessTokenSealed: string;
    refreshTokenSealed: string;
    tokenType: 'Bearer';
    scopes: string[];
    expiresAt: string | null;
    connectedAt: string;
    updatedAt: string;
    generation?: number;
    boundArchiveIdentity?: string | null;
    reboundAt?: string | null;
  }): void {
    const generation = record.generation ?? 1;
    this.upsertStatement.run(
      record.accessTokenSealed,
      record.refreshTokenSealed,
      record.tokenType,
      JSON.stringify(record.scopes),
      record.expiresAt,
      record.connectedAt,
      record.updatedAt,
      generation,
      record.boundArchiveIdentity ?? null,
      record.reboundAt ?? null
    );
  }

  /**
   * Compare-and-set update for refreshed tokens.
   * Atomically matches generation = expectedGeneration and consistently rejects
   * stale mismatches with STALE_CONNECTION_GENERATION without deliberate downgrade updates.
   */
  updateTokensCAS(
    tokens: {
      accessTokenSealed: string;
      refreshTokenSealed: string;
      expiresAt: string | null;
      updatedAt?: string;
    },
    expectedGeneration: number
  ): boolean {
    const updatedAt = tokens.updatedAt ?? new Date().toISOString();
    const result = this.updateTokensCasStatement.run(
      tokens.accessTokenSealed,
      tokens.refreshTokenSealed,
      tokens.expiresAt,
      updatedAt,
      expectedGeneration
    );

    if (result.changes > 0) {
      return true;
    }

    // Atomic update affected 0 rows. Check whether connection exists or generation was stale.
    const current = this.get();
    if (!current) {
      return false;
    }

    if (current.generation !== expectedGeneration) {
      throw new Error('STALE_CONNECTION_GENERATION');
    }

    return false;
  }

  /**
   * Rebinds the active connection to a new archive identity, monotonically
   * advancing the connection generation. Atomically enforces expectedGeneration
   * when provided, rejecting stale mismatches with STALE_CONNECTION_GENERATION.
   */
  rebind(archiveIdentity: string, expectedGeneration?: number, reboundAt?: string): number {
    const now = reboundAt ?? new Date().toISOString();

    if (expectedGeneration !== undefined) {
      const result = this.db
        .prepare(
          `UPDATE wakatime_oauth_connection
           SET generation = generation + 1,
               bound_archive_identity = ?,
               rebound_at = ?,
               updated_at = ?
           WHERE id = 1 AND generation = ?`
        )
        .run(archiveIdentity, now, now, expectedGeneration);

      if (result.changes === 0) {
        const current = this.get();
        if (!current) {
          throw new Error('Cannot rebind: no active WakaTime connection');
        }
        throw new Error('STALE_CONNECTION_GENERATION');
      }

      return expectedGeneration + 1;
    }

    // Unconditional monotonic rebind when expectedGeneration is omitted
    const result = this.db
      .prepare(
        `UPDATE wakatime_oauth_connection
         SET generation = generation + 1,
             bound_archive_identity = ?,
             rebound_at = ?,
             updated_at = ?
         WHERE id = 1`
      )
      .run(archiveIdentity, now, now);

    if (result.changes === 0) {
      throw new Error('Cannot rebind: no active WakaTime connection');
    }

    const current = this.get();
    return current ? current.generation : 1;
  }

  delete(): boolean {
    return this.deleteStatement.run().changes > 0;
  }
}
