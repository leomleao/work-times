import type Database from 'better-sqlite3';
import { parseScopes } from '$lib/server/auth/scopes';
import type {
  AuthorizationCodeRecord,
  OAuthAuthorizationRepository,
  OAuthTokenRecord
} from '$lib/server/oauth/authorization';

interface AuthorizationCodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  scopes: string;
  code_challenge: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

interface OAuthTokenRow {
  id: string;
  family_id: string;
  client_id: string;
  resource: string;
  access_token_hash: string;
  refresh_token_hash: string;
  scopes: string;
  created_at: string;
  access_expires_at: string;
  refresh_expires_at: string;
  refresh_used_at: string | null;
  revoked_at: string | null;
}

export class SqliteOAuthAuthorizationRepository implements OAuthAuthorizationRepository {
  private readonly insertCodeStmt: Database.Statement;
  private readonly findCodeStmt: Database.Statement;
  private readonly consumeCodeStmt: Database.Statement;
  private readonly insertTokenStmt: Database.Statement;
  private readonly findByAccessTokenHashStmt: Database.Statement;
  private readonly findByRefreshTokenHashStmt: Database.Statement;
  private readonly markRefreshUsedStmt: Database.Statement;
  private readonly revokeFamilyStmt: Database.Statement;
  private readonly revokeByTokenHashStmt: Database.Statement;
  private readonly deleteExpiredCodesStmt: Database.Statement;
  private readonly deleteExpiredTokensStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertCodeStmt = this.db.prepare(`
      INSERT INTO oauth_authorization_codes (
        code_hash, client_id, redirect_uri, resource, scopes,
        code_challenge, created_at, expires_at, used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.findCodeStmt = this.db.prepare(`
      SELECT code_hash, client_id, redirect_uri, resource, scopes, code_challenge, created_at, expires_at, used_at
      FROM oauth_authorization_codes
      WHERE code_hash = ?
    `);
    this.consumeCodeStmt = this.db.prepare(`
      UPDATE oauth_authorization_codes
      SET used_at = ?
      WHERE code_hash = ? AND used_at IS NULL
    `);
    this.insertTokenStmt = this.db.prepare(`
      INSERT INTO oauth_tokens (
        id, family_id, client_id, resource, access_token_hash, refresh_token_hash,
        scopes, created_at, access_expires_at, refresh_expires_at,
        refresh_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.findByAccessTokenHashStmt = this.db.prepare(`
      SELECT id, family_id, client_id, resource, access_token_hash, refresh_token_hash,
             scopes, created_at, access_expires_at, refresh_expires_at,
             refresh_used_at, revoked_at
      FROM oauth_tokens
      WHERE access_token_hash = ?
    `);
    this.findByRefreshTokenHashStmt = this.db.prepare(`
      SELECT id, family_id, client_id, resource, access_token_hash, refresh_token_hash,
             scopes, created_at, access_expires_at, refresh_expires_at,
             refresh_used_at, revoked_at
      FROM oauth_tokens
      WHERE refresh_token_hash = ?
    `);
    this.markRefreshUsedStmt = this.db.prepare(`
      UPDATE oauth_tokens
      SET refresh_used_at = ?
      WHERE refresh_token_hash = ? AND refresh_used_at IS NULL AND revoked_at IS NULL
    `);
    this.revokeFamilyStmt = this.db.prepare(`
      UPDATE oauth_tokens
      SET revoked_at = ?
      WHERE family_id = ? AND revoked_at IS NULL
    `);
    this.revokeByTokenHashStmt = this.db.prepare(`
      UPDATE oauth_tokens
      SET revoked_at = ?
      WHERE family_id IN (
        SELECT family_id FROM oauth_tokens
        WHERE (access_token_hash = ? OR refresh_token_hash = ?)
          AND client_id = ?
      ) AND revoked_at IS NULL
    `);
    this.deleteExpiredCodesStmt = this.db.prepare(`
      DELETE FROM oauth_authorization_codes
      WHERE expires_at <= ?
    `);
    this.deleteExpiredTokensStmt = this.db.prepare(`
      DELETE FROM oauth_tokens
      WHERE refresh_expires_at <= ?
    `);
  }

  insertAuthorizationCode(record: AuthorizationCodeRecord): void {
    const validatedScopes = parseScopes(record.scopes);
    this.insertCodeStmt.run(
      record.codeHash,
      record.clientId,
      record.redirectUri,
      record.resource,
      JSON.stringify(validatedScopes),
      record.codeChallenge,
      record.createdAt,
      record.expiresAt,
      record.usedAt
    );
  }

  findAuthorizationCode(codeHash: string): AuthorizationCodeRecord | null {
    const row = this.findCodeStmt.get(codeHash) as AuthorizationCodeRow | undefined;
    if (!row) return null;
    return {
      codeHash: row.code_hash,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      resource: row.resource,
      scopes: JSON.parse(row.scopes),
      codeChallenge: row.code_challenge,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at
    };
  }

  consumeAuthorizationCode(codeHash: string, usedAt: string): boolean {
    const consume = this.db.transaction(() => {
      const info = this.consumeCodeStmt.run(usedAt, codeHash);
      return info.changes > 0;
    });
    return consume();
  }

  insertToken(record: OAuthTokenRecord): void {
    const validatedScopes = parseScopes(record.scopes);
    this.insertTokenStmt.run(
      record.id,
      record.familyId,
      record.clientId,
      record.resource,
      record.accessTokenHash,
      record.refreshTokenHash,
      JSON.stringify(validatedScopes),
      record.createdAt,
      record.accessExpiresAt,
      record.refreshExpiresAt,
      record.refreshUsedAt,
      record.revokedAt
    );
  }

  findByAccessTokenHash(tokenHash: string): OAuthTokenRecord | null {
    const row = this.findByAccessTokenHashStmt.get(tokenHash) as OAuthTokenRow | undefined;
    if (!row) return null;
    return this.mapTokenRow(row);
  }

  findByRefreshTokenHash(tokenHash: string): OAuthTokenRecord | null {
    const row = this.findByRefreshTokenHashStmt.get(tokenHash) as OAuthTokenRow | undefined;
    if (!row) return null;
    return this.mapTokenRow(row);
  }

  rotateRefreshToken(
    oldTokenHash: string,
    usedAt: string,
    replacement: OAuthTokenRecord
  ): boolean {
    const rotate = this.db.transaction(() => {
      const info = this.markRefreshUsedStmt.run(usedAt, oldTokenHash);
      if (info.changes === 0) {
        return false;
      }
      this.insertToken(replacement);
      return true;
    });
    return rotate();
  }

  revokeFamily(familyId: string, revokedAt: string): number {
    const info = this.revokeFamilyStmt.run(revokedAt, familyId);
    return info.changes;
  }

  revokeByTokenHash(tokenHash: string, clientId: string, revokedAt: string): number {
    const info = this.revokeByTokenHashStmt.run(revokedAt, tokenHash, tokenHash, clientId);
    return info.changes;
  }

  deleteExpiredCodes(now: string): number {
    const info = this.deleteExpiredCodesStmt.run(now);
    return info.changes;
  }

  deleteExpiredTokens(now: string): number {
    const info = this.deleteExpiredTokensStmt.run(now);
    return info.changes;
  }

  private mapTokenRow(row: OAuthTokenRow): OAuthTokenRecord {
    return {
      id: row.id,
      familyId: row.family_id,
      clientId: row.client_id,
      resource: row.resource,
      accessTokenHash: row.access_token_hash,
      refreshTokenHash: row.refresh_token_hash,
      scopes: JSON.parse(row.scopes),
      createdAt: row.created_at,
      accessExpiresAt: row.access_expires_at,
      refreshExpiresAt: row.refresh_expires_at,
      refreshUsedAt: row.refresh_used_at,
      revokedAt: row.revoked_at
    };
  }
}
