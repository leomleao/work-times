import type Database from 'better-sqlite3';
import type { AdminSessionRecord, AdminSessionRepository } from '$lib/server/auth/admin-auth';

interface AdminSessionRow {
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

export class SqliteAdminSessionRepository implements AdminSessionRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findStmt: Database.Statement;
  private readonly touchStmt: Database.Statement;
  private readonly revokeStmt: Database.Statement;
  private readonly deleteExpiredStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = this.db.prepare(`
      INSERT INTO admin_sessions (token_hash, created_at, expires_at, last_seen_at, revoked_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.findStmt = this.db.prepare(`
      SELECT token_hash, created_at, expires_at, last_seen_at, revoked_at
      FROM admin_sessions
      WHERE token_hash = ?
    `);
    this.touchStmt = this.db.prepare(`
      UPDATE admin_sessions
      SET last_seen_at = ?
      WHERE token_hash = ?
    `);
    this.revokeStmt = this.db.prepare(`
      UPDATE admin_sessions
      SET revoked_at = ?
      WHERE token_hash = ?
    `);
    this.deleteExpiredStmt = this.db.prepare(`
      DELETE FROM admin_sessions
      WHERE expires_at <= ?
    `);
  }

  insert(session: AdminSessionRecord): void {
    this.insertStmt.run(
      session.tokenHash,
      session.createdAt,
      session.expiresAt,
      session.lastSeenAt,
      session.revokedAt
    );
  }

  findByTokenHash(tokenHash: string): AdminSessionRecord | null {
    const row = this.findStmt.get(tokenHash) as AdminSessionRow | undefined;
    if (!row) return null;
    return {
      tokenHash: row.token_hash,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at
    };
  }

  touch(tokenHash: string, lastSeenAt: string): void {
    this.touchStmt.run(lastSeenAt, tokenHash);
  }

  revoke(tokenHash: string, revokedAt: string): void {
    this.revokeStmt.run(revokedAt, tokenHash);
  }

  deleteExpired(now: string): number {
    const info = this.deleteExpiredStmt.run(now);
    return info.changes;
  }
}
