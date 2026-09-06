import type Database from 'better-sqlite3';
import { parseScopes } from '$lib/server/auth/scopes';
import type {
  OAuthClientMetadata,
  OAuthClientRecord,
  OAuthClientRepository
} from '$lib/server/oauth/clients';

interface OAuthClientRow {
  client_id: string;
  name: string;
  public_client: number;
  secret_prefix: string | null;
  secret_hash: string | null;
  redirect_uris: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
}

export class SqliteOAuthClientRepository implements OAuthClientRepository {
  private readonly insertStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly findStmt: Database.Statement;
  private readonly revokeStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = this.db.prepare(`
      INSERT INTO oauth_clients (
        client_id, name, public_client, secret_prefix, secret_hash,
        redirect_uris, scopes, created_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.listStmt = this.db.prepare(`
      SELECT client_id, name, public_client, secret_prefix, redirect_uris, scopes, created_at, revoked_at
      FROM oauth_clients
      ORDER BY created_at DESC
    `);
    this.findStmt = this.db.prepare(`
      SELECT client_id, name, public_client, secret_prefix, secret_hash, redirect_uris, scopes, created_at, revoked_at
      FROM oauth_clients
      WHERE client_id = ?
    `);
    this.revokeStmt = this.db.prepare(`
      UPDATE oauth_clients
      SET revoked_at = ?
      WHERE client_id = ?
    `);
  }

  insert(record: OAuthClientRecord): void {
    const validatedScopes = parseScopes(record.scopes);
    this.insertStmt.run(
      record.clientId,
      record.name,
      record.publicClient ? 1 : 0,
      record.secretPrefix,
      record.secretHash,
      JSON.stringify(record.redirectUris),
      JSON.stringify(validatedScopes),
      record.createdAt,
      record.revokedAt
    );
  }

  list(): OAuthClientMetadata[] {
    const rows = this.listStmt.all() as Omit<OAuthClientRow, 'secret_hash'>[];
    return rows.map((row) => ({
      clientId: row.client_id,
      name: row.name,
      publicClient: Boolean(row.public_client),
      secretPrefix: row.secret_prefix,
      redirectUris: JSON.parse(row.redirect_uris),
      scopes: JSON.parse(row.scopes),
      createdAt: row.created_at,
      revokedAt: row.revoked_at
    }));
  }

  find(clientId: string): OAuthClientRecord | null {
    const row = this.findStmt.get(clientId) as OAuthClientRow | undefined;
    if (!row) return null;
    return {
      clientId: row.client_id,
      name: row.name,
      publicClient: Boolean(row.public_client),
      secretPrefix: row.secret_prefix,
      secretHash: row.secret_hash,
      redirectUris: JSON.parse(row.redirect_uris),
      scopes: JSON.parse(row.scopes),
      createdAt: row.created_at,
      revokedAt: row.revoked_at
    };
  }

  revoke(clientId: string, revokedAt: string): boolean {
    const info = this.revokeStmt.run(revokedAt, clientId);
    return info.changes > 0;
  }
}
