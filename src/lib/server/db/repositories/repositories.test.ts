import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openTestDatabase } from '../connection.js';
import {
  SqliteAdminSessionRepository,
  SqliteApiKeyRepository,
  SqliteOAuthClientRepository,
  SqliteOAuthAuthorizationRepository,
  SqliteWakaTimeOAuthConnectionRepository
} from './index.js';
import type { AdminSessionRecord } from '$lib/server/auth/admin-auth';
import type { ApiKeyRecord } from '$lib/server/auth/api-keys';
import type { OAuthClientRecord } from '$lib/server/oauth/clients';
import type {
  AuthorizationCodeRecord,
  OAuthTokenRecord
} from '$lib/server/oauth/authorization';

describe('SQLite Repositories and Application State Schema', () => {
  let db: Database.Database;
  let adminSessions: SqliteAdminSessionRepository;
  let apiKeys: SqliteApiKeyRepository;
  let oauthClients: SqliteOAuthClientRepository;
  let oauthAuth: SqliteOAuthAuthorizationRepository;

  beforeEach(() => {
    db = openTestDatabase();
    adminSessions = new SqliteAdminSessionRepository(db);
    apiKeys = new SqliteApiKeyRepository(db);
    oauthClients = new SqliteOAuthClientRepository(db);
    oauthAuth = new SqliteOAuthAuthorizationRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('AdminSessionRepository', () => {
    it('inserts, finds, touches, revokes, and deletes expired sessions', () => {
      const session1: AdminSessionRecord = {
        tokenHash: 'hash_session_1',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
        revokedAt: null
      };
      const session2: AdminSessionRecord = {
        tokenHash: 'hash_session_2',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-10T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
        revokedAt: null
      };

      adminSessions.insert(session1);
      adminSessions.insert(session2);

      expect(adminSessions.findByTokenHash('hash_session_1')).toEqual(session1);
      expect(adminSessions.findByTokenHash('non_existent')).toBeNull();

      // Touch
      adminSessions.touch('hash_session_1', '2026-01-01T12:00:00.000Z');
      expect(adminSessions.findByTokenHash('hash_session_1')?.lastSeenAt).toBe(
        '2026-01-01T12:00:00.000Z'
      );

      // Revoke
      adminSessions.revoke('hash_session_1', '2026-01-01T13:00:00.000Z');
      expect(adminSessions.findByTokenHash('hash_session_1')?.revokedAt).toBe(
        '2026-01-01T13:00:00.000Z'
      );

      // Expiry cleanup
      const deletedCount = adminSessions.deleteExpired('2026-01-05T00:00:00.000Z');
      expect(deletedCount).toBe(1);
      expect(adminSessions.findByTokenHash('hash_session_1')).toBeNull();
      expect(adminSessions.findByTokenHash('hash_session_2')).not.toBeNull();
    });
  });

  describe('ApiKeyRepository', () => {
    it('inserts, lists metadata without hash, finds, touches, revokes, and deletes expired', () => {
      const keyRecord: ApiKeyRecord = {
        id: 'key_1',
        name: 'Agent Key',
        tokenPrefix: 'wtk_12345678',
        tokenHash: 'hash_secret_key_1',
        scopes: ['activity:read', 'operations:read'],
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-05T00:00:00.000Z',
        lastUsedAt: null,
        revokedAt: null
      };

      apiKeys.insert(keyRecord);

      // List returns metadata without tokenHash
      const list = apiKeys.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({
        id: 'key_1',
        name: 'Agent Key',
        tokenPrefix: 'wtk_12345678',
        scopes: ['activity:read', 'operations:read'],
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-05T00:00:00.000Z',
        lastUsedAt: null,
        revokedAt: null
      });
      expect((list[0] as unknown as Record<string, unknown>).tokenHash).toBeUndefined();

      // Find by hash
      expect(apiKeys.findByTokenHash('hash_secret_key_1')).toEqual(keyRecord);
      expect(apiKeys.findByTokenHash('unknown_hash')).toBeNull();

      // Touch
      apiKeys.touch('key_1', '2026-01-02T10:00:00.000Z');
      expect(apiKeys.findByTokenHash('hash_secret_key_1')?.lastUsedAt).toBe(
        '2026-01-02T10:00:00.000Z'
      );

      // Revoke
      expect(apiKeys.revoke('key_1', '2026-01-03T00:00:00.000Z')).toBe(true);
      expect(apiKeys.revoke('non_existent', '2026-01-03T00:00:00.000Z')).toBe(false);
      expect(apiKeys.findByTokenHash('hash_secret_key_1')?.revokedAt).toBe(
        '2026-01-03T00:00:00.000Z'
      );

      // Expiry cleanup
      expect(apiKeys.deleteExpired('2026-01-04T00:00:00.000Z')).toBe(0);
      expect(apiKeys.deleteExpired('2026-01-06T00:00:00.000Z')).toBe(1);
      expect(apiKeys.findByTokenHash('hash_secret_key_1')).toBeNull();
    });

    it('enforces forbidden scope constraints on api_keys', () => {
      const invalidRecord = {
        id: 'key_bad',
        name: 'Bad Scope Key',
        tokenPrefix: 'wtk_bad12345',
        tokenHash: 'hash_bad_scope',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scopes: ['activity:read', 'forbidden:scope'] as any,
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null
      };

      expect(() => apiKeys.insert(invalidRecord)).toThrow(/Unsupported scope/);

      // Also verify direct SQL trigger enforcement against forbidden scope
      expect(() =>
        db
          .prepare(
            `INSERT INTO api_keys (id, name, token_prefix, token_hash, scopes, created_at)
             VALUES ('k2', 'Raw Key', 'wtk_raw', 'hash_raw', ?, '2026-01-01T00:00:00.000Z')`
          )
          .run(JSON.stringify(['activity:read', 'admin:full_access']))
      ).toThrow(/forbidden scope/);
    });
  });

  describe('OAuthClientRepository', () => {
    it('supports public and confidential clients and lists metadata without secrets', () => {
      const publicClient: OAuthClientRecord = {
        clientId: 'client_pub',
        name: 'CLI Public Agent',
        publicClient: true,
        secretPrefix: null,
        secretHash: null,
        redirectUris: ['http://127.0.0.1:49152/callback'],
        scopes: ['activity:read'],
        createdAt: '2026-01-01T00:00:00.000Z',
        revokedAt: null
      };
      const confidentialClient: OAuthClientRecord = {
        clientId: 'client_conf',
        name: 'Backend Agent',
        publicClient: false,
        secretPrefix: 'wcs_prefix12',
        secretHash: 'hash_client_secret',
        redirectUris: ['https://backend.example/callback'],
        scopes: ['activity:read', 'operations:read'],
        createdAt: '2026-01-01T00:00:00.000Z',
        revokedAt: null
      };

      oauthClients.insert(publicClient);
      oauthClients.insert(confidentialClient);

      expect(oauthClients.find('client_pub')).toEqual(publicClient);
      expect(oauthClients.find('client_conf')).toEqual(confidentialClient);
      expect(oauthClients.find('unknown')).toBeNull();

      const list = oauthClients.list();
      expect(list).toHaveLength(2);
      for (const item of list) {
        expect((item as unknown as Record<string, unknown>).secretHash).toBeUndefined();
      }

      // Revoke
      expect(oauthClients.revoke('client_conf', '2026-01-02T00:00:00.000Z')).toBe(true);
      expect(oauthClients.revoke('non_existent', '2026-01-02T00:00:00.000Z')).toBe(false);
      expect(oauthClients.find('client_conf')?.revokedAt).toBe('2026-01-02T00:00:00.000Z');
    });

    it('enforces check constraints and scope validation for oauth_clients', () => {
      // Public client with secret_hash is forbidden
      expect(() =>
        db
          .prepare(
            `INSERT INTO oauth_clients (client_id, name, public_client, secret_hash, redirect_uris, scopes)
             VALUES ('bad_pub', 'Bad Public', 1, 'not_null_secret', '[]', '["activity:read"]')`
          )
          .run()
      ).toThrow(/CHECK constraint failed/);

      // Confidential client without secret_hash is forbidden
      expect(() =>
        db
          .prepare(
            `INSERT INTO oauth_clients (client_id, name, public_client, secret_hash, redirect_uris, scopes)
             VALUES ('bad_conf', 'Bad Conf', 0, NULL, '[]', '["activity:read"]')`
          )
          .run()
      ).toThrow(/CHECK constraint failed/);

      // Forbidden scope in oauth_clients
      expect(() =>
        db
          .prepare(
            `INSERT INTO oauth_clients (client_id, name, public_client, secret_hash, redirect_uris, scopes)
             VALUES ('bad_scope', 'Bad Scope', 1, NULL, '[]', '["forbidden:scope"]')`
          )
          .run()
      ).toThrow(/forbidden scope/);
    });
  });

  describe('OAuthAuthorizationRepository', () => {
    beforeEach(() => {
      oauthClients.insert({
        clientId: 'test_client_id',
        name: 'Test Client',
        publicClient: true,
        secretPrefix: null,
        secretHash: null,
        redirectUris: ['http://127.0.0.1:49152/callback'],
        scopes: ['activity:read', 'operations:read'],
        createdAt: '2026-01-01T00:00:00.000Z',
        revokedAt: null
      });
    });

    it('handles one-time authorization code insertion and atomic consumption', () => {
      const codeRecord: AuthorizationCodeRecord = {
        codeHash: 'code_hash_1',
        clientId: 'test_client_id',
        redirectUri: 'http://127.0.0.1:49152/callback',
        resource: 'https://work-times.home/mcp',
        scopes: ['activity:read'],
        codeChallenge: 'challenge_123',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:05:00.000Z',
        usedAt: null
      };

      oauthAuth.insertAuthorizationCode(codeRecord);

      expect(oauthAuth.findAuthorizationCode('code_hash_1')).toEqual(codeRecord);
      expect(oauthAuth.findAuthorizationCode('unknown_code')).toBeNull();

      // First consumption succeeds
      const firstConsume = oauthAuth.consumeAuthorizationCode(
        'code_hash_1',
        '2026-01-01T00:01:00.000Z'
      );
      expect(firstConsume).toBe(true);
      expect(oauthAuth.findAuthorizationCode('code_hash_1')?.usedAt).toBe(
        '2026-01-01T00:01:00.000Z'
      );

      // Second consumption fails (one-time use guarantee)
      const secondConsume = oauthAuth.consumeAuthorizationCode(
        'code_hash_1',
        '2026-01-01T00:02:00.000Z'
      );
      expect(secondConsume).toBe(false);

      // Clean expired codes
      expect(oauthAuth.deleteExpiredCodes('2026-01-01T00:00:00.000Z')).toBe(0);
      expect(oauthAuth.deleteExpiredCodes('2026-01-01T00:06:00.000Z')).toBe(1);
      expect(oauthAuth.findAuthorizationCode('code_hash_1')).toBeNull();
    });

    it('handles token issuance, transactional refresh rotation, and family revocation', () => {
      const token1: OAuthTokenRecord = {
        id: 'tok_1',
        familyId: 'fam_1',
        clientId: 'test_client_id',
        resource: 'https://work-times.home/mcp',
        accessTokenHash: 'acc_hash_1',
        refreshTokenHash: 'ref_hash_1',
        scopes: ['activity:read'],
        createdAt: '2026-01-01T00:00:00.000Z',
        accessExpiresAt: '2026-01-01T01:00:00.000Z',
        refreshExpiresAt: '2026-04-01T00:00:00.000Z',
        refreshUsedAt: null,
        revokedAt: null
      };

      oauthAuth.insertToken(token1);

      expect(oauthAuth.findByAccessTokenHash('acc_hash_1')).toEqual(token1);
      expect(oauthAuth.findByRefreshTokenHash('ref_hash_1')).toEqual(token1);
      expect(oauthAuth.findByAccessTokenHash('unknown')).toBeNull();

      // Rotate refresh token
      const token2: OAuthTokenRecord = {
        id: 'tok_2',
        familyId: 'fam_1',
        clientId: 'test_client_id',
        resource: 'https://work-times.home/mcp',
        accessTokenHash: 'acc_hash_2',
        refreshTokenHash: 'ref_hash_2',
        scopes: ['activity:read'],
        createdAt: '2026-01-01T00:30:00.000Z',
        accessExpiresAt: '2026-01-01T01:30:00.000Z',
        refreshExpiresAt: '2026-04-01T00:00:00.000Z',
        refreshUsedAt: null,
        revokedAt: null
      };

      const rotated = oauthAuth.rotateRefreshToken(
        'ref_hash_1',
        '2026-01-01T00:30:00.000Z',
        token2
      );
      expect(rotated).toBe(true);

      // Old token is now marked refreshUsedAt
      expect(oauthAuth.findByRefreshTokenHash('ref_hash_1')?.refreshUsedAt).toBe(
        '2026-01-01T00:30:00.000Z'
      );
      // New token exists
      expect(oauthAuth.findByRefreshTokenHash('ref_hash_2')).toEqual(token2);

      // Attempting to rotate old token again fails (reuse detection trigger point)
      const token3: OAuthTokenRecord = {
        ...token2,
        id: 'tok_3',
        accessTokenHash: 'acc_hash_3',
        refreshTokenHash: 'ref_hash_3'
      };
      const reuseAttempt = oauthAuth.rotateRefreshToken(
        'ref_hash_1',
        '2026-01-01T00:31:00.000Z',
        token3
      );
      expect(reuseAttempt).toBe(false);

      // Revoke entire family
      const revokedCount = oauthAuth.revokeFamily('fam_1', '2026-01-01T00:32:00.000Z');
      expect(revokedCount).toBe(2); // tok_1 and tok_2 both revoked
      expect(oauthAuth.findByRefreshTokenHash('ref_hash_2')?.revokedAt).toBe(
        '2026-01-01T00:32:00.000Z'
      );

      // Deleting expired tokens
      expect(oauthAuth.deleteExpiredTokens('2026-03-01T00:00:00.000Z')).toBe(0);
      expect(oauthAuth.deleteExpiredTokens('2026-05-01T00:00:00.000Z')).toBe(2);
      expect(oauthAuth.findByAccessTokenHash('acc_hash_1')).toBeNull();
      expect(oauthAuth.findByAccessTokenHash('acc_hash_2')).toBeNull();
    });

    it('enforces foreign key to oauth_clients', () => {
      expect(() =>
        oauthAuth.insertAuthorizationCode({
          codeHash: 'code_missing_client',
          clientId: 'non_existent_client',
          redirectUri: 'http://127.0.0.1:49152/callback',
          resource: 'https://work-times.home/mcp',
          scopes: ['activity:read'],
          codeChallenge: 'challenge',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-01T00:05:00.000Z',
          usedAt: null
        })
      ).toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  describe('Classification Rules & Daily Time Allocations Constraints', () => {
    it('accepts the 7 permitted identity selector types on classification_rules and rejects empty name/value', () => {
      const allowedSelectors = [
        'machine',
        'editor',
        'application',
        'domain',
        'project',
        'folder_prefix',
        'entity'
      ] as const;

      const stmt = db.prepare(`
        INSERT INTO classification_rules (id, name, classification, selector_type, selector_value, priority)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const [index, selector] of allowedSelectors.entries()) {
        expect(() =>
          stmt.run(`rule_${index}`, `Rule ${selector}`, 'work', selector, 'test-val', 10)
        ).not.toThrow();
      }

      // Verify 'personal' classification is accepted
      expect(() =>
        stmt.run('rule_pers', 'Personal Rule', 'personal', 'domain', 'youtube.com', 5)
      ).not.toThrow();

      // Empty name rejected
      expect(() =>
        stmt.run('rule_empty_name', '   ', 'work', 'project', 'proj-a', 0)
      ).toThrow(/CHECK constraint failed/);

      // Empty selector_value rejected
      expect(() =>
        stmt.run('rule_empty_val', 'Rule A', 'work', 'project', '   ', 0)
      ).toThrow(/CHECK constraint failed/);
    });

    it('rejects forbidden selectors and invalid classifications on classification_rules', () => {
      const stmt = db.prepare(`
        INSERT INTO classification_rules (id, name, classification, selector_type, selector_value)
        VALUES (?, ?, ?, ?, ?)
      `);

      // Forbidden selectors (language, category, branch, dependency)
      for (const forbidden of ['language', 'category', 'branch', 'dependency', 'framework']) {
        expect(() => stmt.run(`bad_${forbidden}`, 'Bad', 'work', forbidden, 'val')).toThrow(
          /CHECK constraint failed/
        );
      }

      // Forbidden classification ('unclassified' or arbitrary string)
      expect(() => stmt.run('bad_class', 'Bad', 'unclassified', 'machine', 'm1')).toThrow(
        /CHECK constraint failed/
      );
      expect(() => stmt.run('bad_class_2', 'Bad', 'other', 'machine', 'm1')).toThrow(
        /CHECK constraint failed/
      );
    });

    it('enforces whole-slice integrity: composite FK, duration match trigger, work|personal only, and uniqueness', () => {
      // Create source import and authoritative slice first
      db.prepare(`
        INSERT INTO source_imports (id, source_type, source_hash, byte_size)
        VALUES (1, 'daily_dump', 'hash_import_1', 100)
      `).run();

      const projectRow = db
        .prepare('SELECT id FROM projects WHERE is_unattributed = 1')
        .get() as { id: number };

      db.prepare(`
        INSERT INTO day_project_entity_slices (
          id, date, project_id, entity, entity_type, kind, is_unattributed, total_seconds, source_import_id
        ) VALUES (1, '2026-01-01', ?, '__unattributed__', 'unattributed', 'unattributed_residual', 1, 3600.0, 1)
      `).run(projectRow.id);

      db.prepare(`
        INSERT INTO day_project_entity_slices (
          id, date, project_id, entity, entity_type, total_seconds, source_import_id
        ) VALUES (2, '2026-01-02', ?, 'src/index.ts', 'file', 1234.5, 1)
      `).run(projectRow.id);

      const insertStmt = db.prepare(`
        INSERT INTO daily_time_allocations (
          id, date, project_id, entity, entity_type, kind, classification, allocated_seconds, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // 1. Valid allocation matching slice total_seconds
      insertStmt.run('alloc_1', '2026-01-01', projectRow.id, '__unattributed__', 'unattributed', 'unattributed_residual', 'work', 3600.0, 'Approved');

      // 2. Allocation with mismatched seconds fails
      expect(() =>
        insertStmt.run('alloc_bad_sec', '2026-01-02', projectRow.id, 'src/index.ts', 'file', 'entity', 'work', 1230.0, 'Wrong')
      ).toThrow(/allocated_seconds does not match authoritative slice total_seconds/);

      // 3. Allocation on non-existent slice fails (via trigger)
      expect(() =>
        insertStmt.run('alloc_missing_slice', '2026-01-03', projectRow.id, 'missing.ts', 'file', 'entity', 'work', 500.0, 'Missing')
      ).toThrow(/allocated_seconds does not match authoritative slice total_seconds/);

      // 4. Duplicate whole-slice allocation on (date, project_id, entity, entity_type, kind) fails UNIQUE constraint
      expect(() =>
        insertStmt.run('alloc_dup', '2026-01-01', projectRow.id, '__unattributed__', 'unattributed', 'unattributed_residual', 'personal', 3600.0, 'Dup')
      ).toThrow(/UNIQUE constraint failed/);

      // 5. Classification restricted to work | personal only ('unclassified' rejected)
      expect(() =>
        insertStmt.run('alloc_unclass', '2026-01-02', projectRow.id, 'src/index.ts', 'file', 'entity', 'unclassified', 1234.5, 'Unclass')
      ).toThrow(/CHECK constraint failed/);
    });
  });

  describe('Append-only classification_revisions and audit_events', () => {
    it('allows INSERT but forbids UPDATE and DELETE on classification_revisions', () => {
      db.prepare(`
        INSERT INTO classification_revisions (
          mutation_type, target_type, target_id, before_json, after_json, affected_json, actor
        ) VALUES ('rule_created', 'rule', 'rule_1', NULL, '{"classification":"work"}', '{"affected_dates":["2026-01-01"]}', 'admin')
      `).run();

      const row = db
        .prepare('SELECT id, mutation_type, before_json, after_json, affected_json FROM classification_revisions WHERE target_id = ?')
        .get('rule_1') as { id: number; mutation_type: string; before_json: string | null; after_json: string; affected_json: string };
      expect(row.id).toBe(1);
      expect(row.mutation_type).toBe('rule_created');

      // UPDATE rejected
      expect(() =>
        db
          .prepare('UPDATE classification_revisions SET actor = ? WHERE id = ?')
          .run('hacker', row.id)
      ).toThrow(/classification_revisions is append-only/);

      // DELETE rejected
      expect(() =>
        db
          .prepare('DELETE FROM classification_revisions WHERE id = ?')
          .run(row.id)
      ).toThrow(/classification_revisions is append-only/);
    });

    it('allows INSERT but forbids UPDATE and DELETE on audit_events and uses remote_fingerprint', () => {
      db.prepare(`
        INSERT INTO audit_events (event_type, actor, target_type, target_id, remote_fingerprint)
        VALUES ('admin.login', 'admin', 'admin_session', 'hash_123', 'fp_98765')
      `).run();

      const row = db
        .prepare('SELECT id, remote_fingerprint FROM audit_events WHERE event_type = ?')
        .get('admin.login') as { id: number; remote_fingerprint: string };
      expect(row.id).toBe(1);
      expect(row.remote_fingerprint).toBe('fp_98765');

      // UPDATE rejected
      expect(() =>
        db.prepare('UPDATE audit_events SET actor = ? WHERE id = ?').run('bad', row.id)
      ).toThrow(/audit_events is append-only/);

      // DELETE rejected
      expect(() =>
        db.prepare('DELETE FROM audit_events WHERE id = ?').run(row.id)
      ).toThrow(/audit_events is append-only/);
    });
  });

  describe('app_settings and sync state tables', () => {
    it('supports app_settings key-value storage', () => {
      db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('theme', 'dark');
      const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('theme') as {
        value: string;
      };
      expect(row.value).toBe('dark');

      db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('light', 'theme');
      const updated = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('theme') as {
        value: string;
      };
      expect(updated.value).toBe('light');
    });

    it('creates sync_runs and sync_days with proper relationships', () => {
      const runInfo = db
        .prepare(
          `INSERT INTO sync_runs (trigger, status, range_start_date, range_end_date, day_count)
           VALUES ('scheduled', 'running', '2026-01-01', '2026-01-07', 7)`
        )
        .run();
      const runId = runInfo.lastInsertRowid;

      db.prepare(
        `INSERT INTO sync_days (sync_run_id, date, status, summaries_status, total_seconds)
         VALUES (?, '2026-01-01', 'succeeded', 'succeeded', 3600)`
      ).run(runId);

      const day = db
        .prepare('SELECT date, status, total_seconds FROM sync_days WHERE sync_run_id = ?')
        .get(runId) as { date: string; status: string; total_seconds: number };
      expect(day.date).toBe('2026-01-01');
      expect(day.status).toBe('succeeded');
      expect(day.total_seconds).toBe(3600);

      // Cascade delete on sync_run_id
      db.prepare('DELETE FROM sync_runs WHERE id = ?').run(runId);
      expect(
        db.prepare('SELECT COUNT(*) AS c FROM sync_days WHERE sync_run_id = ?').get(runId)
      ).toEqual({ c: 0 });
    });
  });

  describe('Domain Services Integration with SQLite Repositories', () => {
    it('integrates AdminAuthenticator with SqliteAdminSessionRepository', async () => {
      const { AdminAuthenticator } = await import('$lib/server/auth/admin-auth');
      const { hashPassword } = await import('$lib/server/security/password');

      const auth = new AdminAuthenticator({
        username: 'admin',
        passwordHash: hashPassword('secure-test-pass'),
        sessions: adminSessions
      });

      const now = new Date('2026-01-01T10:00:00.000Z');
      const login = await auth.login('admin', 'secure-test-pass', now);
      expect(login).not.toBeNull();
      expect(login?.token).toMatch(/^wts_/);

      const authenticated = await auth.authenticate(login?.token, now);
      expect(authenticated).toMatchObject({ username: 'admin' });

      await auth.logout(login?.token, now);
      expect(await auth.authenticate(login?.token, now)).toBeNull();
    });

    it('integrates ApiKeyService with SqliteApiKeyRepository', async () => {
      const { ApiKeyService } = await import('$lib/server/auth/api-keys');
      const service = new ApiKeyService(apiKeys);

      const now = new Date('2026-01-01T00:00:00.000Z');
      const created = await service.create({
        name: 'Integration Test Key',
        scopes: ['activity:read'],
        expiresAt: new Date('2026-01-05T00:00:00.000Z'),
        now
      });

      expect(created.token).toMatch(/^wtk_/);
      const authSuccess = await service.authenticate(created.token, ['activity:read'], now);
      expect(authSuccess).toMatchObject({
        clientId: created.metadata.id,
        scopes: ['activity:read']
      });

      // Scope mismatch
      expect(
        await service.authenticate(created.token, ['activity:detail'], now)
      ).toBeNull();

      // Revocation
      expect(await service.revoke(created.metadata.id, now)).toBe(true);
      expect(await service.authenticate(created.token, ['activity:read'], now)).toBeNull();
    });

    it('integrates OAuthClientService and OAuthAuthorizationService with SQLite repositories', async () => {
      const { OAuthClientService } = await import('$lib/server/oauth/clients');
      const { OAuthAuthorizationService, OAuthTokenReuseError } = await import(
        '$lib/server/oauth/authorization'
      );
      const { createS256Challenge } = await import('$lib/server/oauth/pkce');

      const clientService = new OAuthClientService(oauthClients);
      const authService = new OAuthAuthorizationService(clientService, oauthAuth);

      const client = await clientService.register({
        name: 'MCP Integration Client',
        publicClient: true,
        redirectUris: ['http://127.0.0.1:49152/callback'],
        scopes: ['activity:read', 'operations:read']
      });

      const verifier = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
      const now = new Date('2026-01-01T00:00:00.000Z');

      // 1. Issue authorization code
      const issued = await authService.issueAuthorizationCode({
        clientId: client.metadata.clientId,
        redirectUri: 'http://127.0.0.1:49152/callback',
        resource: 'https://work-times.home/mcp',
        scopes: ['activity:read'],
        codeChallenge: createS256Challenge(verifier),
        codeChallengeMethod: 'S256',
        state: 'test_state',
        now
      });
      expect(issued.code).toMatch(/^wac_/);

      // 2. Exchange authorization code
      const tokens = await authService.exchangeAuthorizationCode({
        code: issued.code,
        clientId: client.metadata.clientId,
        redirectUri: 'http://127.0.0.1:49152/callback',
        resource: 'https://work-times.home/mcp',
        codeVerifier: verifier,
        now
      });
      expect(tokens).not.toBeNull();
      expect(tokens?.accessToken).toMatch(/^wat_/);
      expect(tokens?.refreshToken).toMatch(/^wrt_/);

      // 3. Code cannot be exchanged twice
      const secondExchange = await authService.exchangeAuthorizationCode({
        code: issued.code,
        clientId: client.metadata.clientId,
        redirectUri: 'http://127.0.0.1:49152/callback',
        resource: 'https://work-times.home/mcp',
        codeVerifier: verifier,
        now
      });
      expect(secondExchange).toBeNull();

      // 4. Verify access token
      const verify = await authService.verifyAccessToken(
        tokens?.accessToken ?? '',
        ['activity:read'],
        now,
        'https://work-times.home/mcp'
      );
      expect(verify).toMatchObject({
        clientId: client.metadata.clientId,
        scopes: ['activity:read']
      });

      // 5. Refresh token rotation
      const refreshed = await authService.refresh({
        refreshToken: tokens?.refreshToken ?? '',
        clientId: client.metadata.clientId,
        resource: 'https://work-times.home/mcp',
        now: new Date('2026-01-01T00:01:00.000Z')
      });
      expect(refreshed).not.toBeNull();
      expect(refreshed?.refreshToken).not.toBe(tokens?.refreshToken);

      // 6. Refresh token reuse triggers family revocation and error
      await expect(
        authService.refresh({
          refreshToken: tokens?.refreshToken ?? '',
          clientId: client.metadata.clientId,
          resource: 'https://work-times.home/mcp',
          now: new Date('2026-01-01T00:02:00.000Z')
        })
      ).rejects.toBeInstanceOf(OAuthTokenReuseError);

      // Refreshed token is now also invalidated due to family revocation
      await expect(
        authService.verifyAccessToken(
          refreshed?.accessToken ?? '',
          ['activity:read'],
          new Date('2026-01-01T00:03:00.000Z'),
          'https://work-times.home/mcp'
        )
      ).resolves.toBeNull();
    });
  });

  describe('WakaTimeOAuthConnectionRepository and Connection Lifecycle', () => {
    it('initializes connection with generation 1 and supports archive binding', () => {
      const repo = new SqliteWakaTimeOAuthConnectionRepository(db);
      expect(repo.get()).toBeNull();

      repo.upsert({
        accessTokenSealed: 'sealed_tok_1',
        refreshTokenSealed: 'sealed_ref_1',
        tokenType: 'Bearer',
        scopes: ['read_summaries'],
        expiresAt: '2026-01-01T01:00:00.000Z',
        connectedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      });

      const conn = repo.get();
      expect(conn).not.toBeNull();
      expect(conn?.generation).toBe(1);
      expect(conn?.boundArchiveIdentity).toBeNull();
      expect(conn?.reboundAt).toBeNull();

      // Rebind to archive identity
      const nextGen = repo.rebind('user_waka_123', 1, '2026-01-01T00:10:00.000Z');
      expect(nextGen).toBe(2);

      const rebound = repo.get();
      expect(rebound?.generation).toBe(2);
      expect(rebound?.boundArchiveIdentity).toBe('user_waka_123');
      expect(rebound?.reboundAt).toBe('2026-01-01T00:10:00.000Z');
    });

    it('clears archive binding when a new OAuth connection generation replaces the old one', () => {
      const repo = new SqliteWakaTimeOAuthConnectionRepository(db);
      repo.upsert({
        accessTokenSealed: 'sealed_tok_1',
        refreshTokenSealed: 'sealed_ref_1',
        tokenType: 'Bearer',
        scopes: ['read_summaries'],
        expiresAt: null,
        connectedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      });
      repo.rebind('user_waka_123', 1, '2026-01-01T00:10:00.000Z');

      repo.upsert({
        accessTokenSealed: 'sealed_tok_replacement',
        refreshTokenSealed: 'sealed_ref_replacement',
        tokenType: 'Bearer',
        scopes: ['read_summaries'],
        expiresAt: null,
        connectedAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        generation: 3
      });

      expect(repo.get()).toMatchObject({
        accessTokenSealed: 'sealed_tok_replacement',
        generation: 3,
        boundArchiveIdentity: null,
        reboundAt: null
      });
    });

    it('enforces compare-and-set guards on token refresh and rejects stale generation CAS', () => {
      const repo = new SqliteWakaTimeOAuthConnectionRepository(db);

      repo.upsert({
        accessTokenSealed: 'sealed_tok_1',
        refreshTokenSealed: 'sealed_ref_1',
        tokenType: 'Bearer',
        scopes: ['read_summaries'],
        expiresAt: '2026-01-01T01:00:00.000Z',
        connectedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      });

      // CAS update with matching generation succeeds
      const updated = repo.updateTokensCAS(
        {
          accessTokenSealed: 'sealed_tok_2',
          refreshTokenSealed: 'sealed_ref_2',
          expiresAt: '2026-01-01T02:00:00.000Z'
        },
        1
      );
      expect(updated).toBe(true);
      expect(repo.get()?.accessTokenSealed).toBe('sealed_tok_2');

      // Rebind advances generation to 2
      repo.rebind('user_waka_123', 1);
      expect(repo.get()?.generation).toBe(2);

      // CAS update from worker running under stale generation 1 throws or aborts via trigger
      expect(() =>
        repo.updateTokensCAS(
          {
            accessTokenSealed: 'sealed_tok_stale',
            refreshTokenSealed: 'sealed_ref_stale',
            expiresAt: '2026-01-01T03:00:00.000Z'
          },
          1
        )
      ).toThrow(/STALE_CONNECTION_GENERATION/);

      // Direct SQL update attempting to write generation < active generation aborts via trigger
      expect(() =>
        db
          .prepare('UPDATE wakatime_oauth_connection SET generation = 1 WHERE id = 1')
          .run()
      ).toThrow(/STALE_CONNECTION_GENERATION/);

      // Rebind with wrong expectedGeneration throws STALE_CONNECTION_GENERATION
      expect(() => repo.rebind('user_waka_456', 1)).toThrow(/STALE_CONNECTION_GENERATION/);

      // Monotonic rebind without expectedGeneration succeeds and advances generation
      const gen3 = repo.rebind('user_waka_789');
      expect(gen3).toBe(3);
      expect(repo.get()?.generation).toBe(3);
      expect(repo.get()?.boundArchiveIdentity).toBe('user_waka_789');

      // Monotonic rebind with matching expectedGeneration succeeds and advances generation
      const gen4 = repo.rebind('user_waka_101112', 3);
      expect(gen4).toBe(4);
      expect(repo.get()?.generation).toBe(4);

      // CAS refresh with stale generation throws STALE_CONNECTION_GENERATION without downgrade
      expect(() =>
        repo.updateTokensCAS(
          {
            accessTokenSealed: 'sealed_tok_stale_3',
            refreshTokenSealed: 'sealed_ref_stale_3',
            expiresAt: '2026-01-01T04:00:00.000Z'
          },
          3
        )
      ).toThrow(/STALE_CONNECTION_GENERATION/);
      expect(repo.get()?.generation).toBe(4); // Database generation unmodified

      // Deleting connection makes CAS return false and rebind throw
      repo.delete();
      expect(repo.get()).toBeNull();
      expect(
        repo.updateTokensCAS(
          {
            accessTokenSealed: 'sealed_tok_none',
            refreshTokenSealed: 'sealed_ref_none',
            expiresAt: null
          },
          4
        )
      ).toBe(false);
      expect(() => repo.rebind('user_none', 4)).toThrow(/Cannot rebind: no active WakaTime connection/);
    });
  });
});
