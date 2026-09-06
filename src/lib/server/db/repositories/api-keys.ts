import type Database from 'better-sqlite3';
import { parseScopes } from '$lib/server/auth/scopes';
import type { ApiKeyMetadata, ApiKeyRecord, ApiKeyRepository } from '$lib/server/auth/api-keys';

interface ApiKeyRow {
  id: string;
  name: string;
  token_prefix: string;
  token_hash: string;
  scopes: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export class SqliteApiKeyRepository implements ApiKeyRepository {
  private readonly insertStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly findByTokenHashStmt: Database.Statement;
  private readonly touchStmt: Database.Statement;
  private readonly revokeStmt: Database.Statement;
  private readonly deleteExpiredStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = this.db.prepare(`
      INSERT INTO api_keys (
        id, name, token_prefix, token_hash, scopes,
        created_at, expires_at, last_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.listStmt = this.db.prepare(`
      SELECT id, name, token_prefix, scopes, created_at, expires_at, last_used_at, revoked_at
      FROM api_keys
      ORDER BY created_at DESC
    `);
    this.findByTokenHashStmt = this.db.prepare(`
      SELECT id, name, token_prefix, token_hash, scopes, created_at, expires_at, last_used_at, revoked_at
      FROM api_keys
      WHERE token_hash = ?
    `);
    this.touchStmt = this.db.prepare(`
      UPDATE api_keys
      SET last_used_at = ?
      WHERE id = ?
    `);
    this.revokeStmt = this.db.prepare(`
      UPDATE api_keys
      SET revoked_at = ?
      WHERE id = ?
    `);
    this.deleteExpiredStmt = this.db.prepare(`
      DELETE FROM api_keys
      WHERE expires_at IS NOT NULL AND expires_at <= ?
    `);
  }

  insert(record: ApiKeyRecord): void {
    const validatedScopes = parseScopes(record.scopes);
    this.insertStmt.run(
      record.id,
      record.name,
      record.tokenPrefix,
      record.tokenHash,
      JSON.stringify(validatedScopes),
      record.createdAt,
      record.expiresAt,
      record.lastUsedAt,
      record.revokedAt
    );
  }

  list(): ApiKeyMetadata[] {
    const rows = this.listStmt.all() as Omit<ApiKeyRow, 'token_hash'>[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      tokenPrefix: row.token_prefix,
      scopes: JSON.parse(row.scopes),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at
    }));
  }

  findByTokenHash(tokenHash: string): ApiKeyRecord | null {
    const row = this.findByTokenHashStmt.get(tokenHash) as ApiKeyRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      tokenPrefix: row.token_prefix,
      tokenHash: row.token_hash,
      scopes: JSON.parse(row.scopes),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at
    };
  }

  touch(id: string, lastUsedAt: string): void {
    this.touchStmt.run(lastUsedAt, id);
  }

  revoke(id: string, revokedAt: string): boolean {
    const info = this.revokeStmt.run(revokedAt, id);
    return info.changes > 0;
  }

  deleteExpired(now: string): number {
    const info = this.deleteExpiredStmt.run(now);
    return info.changes;
  }
}
