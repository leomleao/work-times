import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configurePragmas,
  MIGRATIONS_DIR,
  openDatabase,
  runMigrations
} from '../../src/lib/server/db/connection.js';

describe('Integration: Populated 001-004 Migrations, SQLite Backup & Verified Restore', () => {
  let tempDir: string;
  let sourceDbPath: string;
  let backupDbPath: string;
  let restoredDbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'work-times-p10-migration-'));
    sourceDbPath = join(tempDir, 'source.sqlite');
    backupDbPath = join(tempDir, 'source-backup.sqlite');
    restoredDbPath = join(tempDir, 'restored.sqlite');
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Constructs an isolated SQLite database strictly running migrations 001 through 004
   * and populates it with synthetic, realistic data across all defined tables.
   */
  function createPopulated001To004Database(dbPath: string): Database.Database {
    const db = new Database(dbPath);
    configurePragmas(db, { wal: true });

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);

    const p0MigrationFiles = [
      '001-import-schema.sql',
      '002-application-state.sql',
      '003-wakatime-oauth.sql',
      '004-classification-rules-match-mode.sql'
    ];

    for (const filename of p0MigrationFiles) {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(filename);
      })();
    }

    // Populate data across all 001-004 tables
    db.exec(`
      -- 1. Source Lineage
      INSERT INTO source_imports (id, source_type, source_hash, byte_size, range_start_date, range_end_date, status, dry_run, day_count, record_count)
      VALUES
        (1, 'daily_dump', 'hash_daily_001', 2048, '2026-09-08', '2026-09-09', 'completed', 0, 2, 5),
        (2, 'heartbeat_dump', 'hash_hb_002', 4096, '2026-09-08', '2026-09-09', 'completed', 0, 2, 2);

      INSERT INTO source_payloads (id, source_import_id, endpoint, covered_date, payload_hash, payload_json)
      VALUES
        (1, 1, 'dump:daily.days[]', '2026-09-08', 'phash_08', '{"date":"2026-09-08"}'),
        (2, 1, 'dump:daily.days[]', '2026-09-09', 'phash_09', '{"date":"2026-09-09"}');

      -- 2. Account Settings and Projects
      INSERT INTO account_settings (wakatime_user_id, timezone, weekday_start, keystroke_timeout_seconds, writes_only, plan, has_premium_features, source_import_id)
      VALUES ('usr_synthetic_01', 'Europe/London', 1, 15, 0, 'pro', 1, 1);

      INSERT INTO projects (id, name, is_unattributed, first_activity_date, last_activity_date)
      VALUES
        (10, 'project-core', 0, '2026-09-08', '2026-09-09'),
        (20, 'personal-blog', 0, '2026-09-08', '2026-09-08'),
        (30, 'mixed-infra', 0, '2026-09-09', '2026-09-09');

      -- 3. Official Totals and Scoped Dimensions
      INSERT INTO daily_totals (date, timezone, total_seconds, grand_total_json, project_sum_seconds, project_sum_delta, source_import_id, source_hash)
      VALUES
        ('2026-09-08', 'Europe/London', 7200.0, '{"total_seconds":7200.0}', 7200.0, 0.0, 1, 'hash_daily_001'),
        ('2026-09-09', 'Europe/London', 3600.0, '{"total_seconds":3600.0}', 3600.0, 0.0, 1, 'hash_daily_001');

      INSERT INTO daily_dimension_totals (id, date, scope, project_id, dimension, name, total_seconds, source_import_id)
      VALUES
        (1, '2026-09-08', 'account', NULL, 'category', 'Coding', 7200.0, 1),
        (2, '2026-09-08', 'project', 10, 'category', 'Coding', 6000.0, 1),
        (3, '2026-09-08', 'project', 20, 'category', 'Coding', 1200.0, 1),
        (4, '2026-09-09', 'account', NULL, 'category', 'Coding', 3600.0, 1);

      -- 4. Official Additive Slices (5 slices across files, apps, domains)
      INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id)
      VALUES
        (101, '2026-09-08', 10, 'src/server.ts', 'file', 4000.0, 0, 1),
        (102, '2026-09-08', 10, 'src/client.ts', 'file', 2000.0, 0, 1),
        (103, '2026-09-08', 20, 'posts/hello.md', 'file', 1200.0, 0, 1),
        (104, '2026-09-09', 10, 'Terminal', 'app', 2000.0, 0, 1),
        (105, '2026-09-09', 30, 'github.com', 'domain', 1600.0, 0, 1);

      INSERT INTO slice_identities (id, slice_id, selector_type, value, source, observed_heartbeats)
      VALUES
        (1, 101, 'folder_prefix', 'src/', 'slice', 1),
        (2, 101, 'entity', 'src/server.ts', 'slice', 1),
        (3, 104, 'application', 'Terminal', 'slice', 1),
        (4, 105, 'domain', 'github.com', 'slice', 1);

      -- 5. Raw Heartbeats
      INSERT INTO heartbeats (id, external_id, occurred_at_us, occurred_at, local_date, entity, entity_type, category, project_id, project_name, machine_name_id, user_agent_id, canonical_hash, source_import_id)
      VALUES
        (201, 'hb-uuid-001', 1789038000000000, '2026-09-08T10:00:00Z', '2026-09-08', 'src/server.ts', 'file', 'coding', 10, 'project-core', 'mbp-work', 'vscode-ua', 'hash_hb_01', 2),
        (202, 'hb-uuid-002', 1789124400000000, '2026-09-09T10:00:00Z', '2026-09-09', 'Terminal', 'app', 'coding', 10, 'project-core', 'mbp-work', 'iterm-ua', 'hash_hb_02', 2);

      INSERT INTO heartbeat_dependencies (id, heartbeat_id, name, position)
      VALUES (1, 201, 'better-sqlite3', 0);

      INSERT INTO heartbeat_variants (id, external_id, canonical_hash, raw_json, occurrence_count, conflict_state, source_import_id)
      VALUES
        (1, 'hb-uuid-001', 'hash_hb_01', '{"id":"hb-uuid-001"}', 1, 'canonical', 2),
        (2, 'hb-uuid-002', 'hash_hb_02', '{"id":"hb-uuid-002"}', 1, 'canonical', 2);

      -- 6. Application Settings, Admin Sessions, and API Keys
      INSERT INTO app_settings (key, value) VALUES ('sync_interval_minutes', '60');

      INSERT INTO admin_sessions (token_hash, expires_at)
      VALUES ('admin_token_hash_001', '2027-01-01T00:00:00Z');

      INSERT INTO api_keys (id, name, token_prefix, token_hash, scopes, expires_at)
      VALUES ('key_synthetic_1', 'Integration Key', 'wtk_', 'api_key_hash_001', '["activity:read"]', '2027-01-01T00:00:00Z');

      -- 7. OAuth Clients, Codes, and Tokens
      INSERT INTO oauth_clients (client_id, name, public_client, secret_prefix, secret_hash, redirect_uris, scopes)
      VALUES ('client_claude_desktop', 'Claude Desktop', 1, NULL, NULL, '["http://localhost:8080/callback"]', '["activity:read"]');

      INSERT INTO oauth_authorization_codes (code_hash, client_id, redirect_uri, resource, scopes, code_challenge, expires_at)
      VALUES ('auth_code_hash_001', 'client_claude_desktop', 'http://localhost:8080/callback', 'http://localhost:3002/mcp', '["activity:read"]', 'chall_001', '2027-01-01T00:00:00Z');

      INSERT INTO oauth_tokens (id, family_id, client_id, resource, access_token_hash, refresh_token_hash, scopes, access_expires_at, refresh_expires_at)
      VALUES ('tok_001', 'fam_001', 'client_claude_desktop', 'http://localhost:3002/mcp', 'at_hash_001', 'rt_hash_001', '["activity:read"]', '2027-01-01T00:00:00Z', '2028-01-01T00:00:00Z');

      -- 8. Classification Rules (004 match_mode column present)
      INSERT INTO classification_rules (id, name, classification, selector_type, selector_value, match_mode, priority, enabled)
      VALUES
        ('rule_work_core', 'Core Work', 'work', 'project', 'project-core', 'exact', 10, 1),
        ('rule_personal_blog', 'Blog Personal', 'personal', 'project', 'personal-blog', 'exact', 10, 1);

      -- 9. Daily Time Allocations & Append-Only Audit History
      INSERT INTO daily_time_allocations (id, date, project_id, entity, classification, allocated_seconds, note)
      VALUES
        ('alloc_001', '2026-09-08', 10, 'src/server.ts', 'work', 4000.0, 'Initial manual work allocation'),
        ('alloc_002', '2026-09-09', 10, 'Terminal', 'work', 2000.0, 'Terminal session');

      INSERT INTO classification_revisions (id, mutation_type, target_type, target_id, after_json, actor)
      VALUES
        (1, 'rule_created', 'rule', 'rule_work_core', '{"classification":"work"}', 'admin'),
        (2, 'allocation_created', 'allocation', 'alloc_001', '{"classification":"work"}', 'admin');

      INSERT INTO audit_events (id, event_type, actor, target_type, target_id, details_json)
      VALUES (1, 'database_seeded', 'test', 'schema', '001-004', '{"records":20}');

      -- 10. Sync Runs and Sync Days (Pre-005 schema)
      INSERT INTO sync_runs (id, started_at, finished_at, trigger, status, range_start_date, range_end_date, day_count, days_synced, days_failed)
      VALUES (1, '2026-09-08T12:00:00Z', '2026-09-08T12:05:00Z', 'manual', 'succeeded', '2026-09-08', '2026-09-08', 1, 1, 0);

      INSERT INTO sync_days (id, sync_run_id, date, status, summaries_status, total_seconds, heartbeat_count)
      VALUES (1, 1, '2026-09-08', 'succeeded', 'succeeded', 7200.0, 1);

      -- 11. WakaTime Outbound OAuth Connection (Pre-008 schema)
      INSERT INTO wakatime_oauth_connection (id, access_token_sealed, refresh_token_sealed, token_type, scopes, connected_at, updated_at)
      VALUES (1, 'sealed_access_token_001', 'sealed_refresh_token_001', 'Bearer', '["email","read_logged_time"]', '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z');
    `);

    return db;
  }

  it('performs online SQLite backup and verified restore of populated 001-004 database before migration', async () => {
    const sourceDb = createPopulated001To004Database(sourceDbPath);

    // Initial sanity check on source
    expect(sourceDb.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(sourceDb.pragma('foreign_key_check')).toEqual([]);

    // 1. Perform online backup via Better-SQLite3 backup API
    await sourceDb.backup(backupDbPath);
    expect(existsSync(backupDbPath)).toBe(true);

    // 2. Open backup database in read-only mode and verify integrity
    const backupDb = openDatabase({
      path: backupDbPath,
      readonly: true,
      migrate: false,
      wal: false
    });

    try {
      const integrity = backupDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
      expect(integrity).toEqual([{ integrity_check: 'ok' }]);
      expect(backupDb.pragma('foreign_key_check')).toEqual([]);

      // Verify schema_migrations contains ONLY 001 through 004
      const backupMigrations = backupDb
        .prepare('SELECT filename FROM schema_migrations ORDER BY filename ASC')
        .all() as Array<{ filename: string }>;
      expect(backupMigrations.map((m) => m.filename)).toEqual([
        '001-import-schema.sql',
        '002-application-state.sql',
        '003-wakatime-oauth.sql',
        '004-classification-rules-match-mode.sql'
      ]);

      // Verify tables introduced in 005-009 DO NOT exist in backup
      const tableNames = (
        backupDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tableNames).not.toContain('user_agent_registry');
      expect(tableNames).not.toContain('user_agent_registry_staging');
      expect(tableNames).not.toContain('heartbeat_memberships');
      expect(tableNames).not.toContain('sync_layer_state');

      // Verify columns introduced in 005-009 DO NOT exist in backup
      const sliceCols = (
        backupDb.prepare("PRAGMA table_info('day_project_entity_slices')").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(sliceCols).not.toContain('kind');
      expect(sliceCols).not.toContain('snapshot_version');

      const allocCols = (
        backupDb.prepare("PRAGMA table_info('daily_time_allocations')").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(allocCols).not.toContain('entity_type');
      expect(allocCols).not.toContain('kind');
      expect(allocCols).not.toContain('state');

      const connCols = (
        backupDb.prepare("PRAGMA table_info('wakatime_oauth_connection')").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(connCols).not.toContain('generation');

      // Verify exact row counts in backup match source
      expect(backupDb.prepare('SELECT COUNT(*) AS c FROM day_project_entity_slices').get()).toEqual({ c: 5 });
      expect(backupDb.prepare('SELECT COUNT(*) AS c FROM daily_time_allocations').get()).toEqual({ c: 2 });
      expect(backupDb.prepare('SELECT COUNT(*) AS c FROM heartbeats').get()).toEqual({ c: 2 });
      expect(backupDb.prepare('SELECT COUNT(*) AS c FROM classification_rules').get()).toEqual({ c: 2 });
      expect(backupDb.prepare('SELECT COUNT(*) AS c FROM classification_revisions').get()).toEqual({ c: 2 });
      expect(backupDb.prepare('SELECT COUNT(*) AS c FROM audit_events').get()).toEqual({ c: 1 });
      expect(backupDb.prepare('SELECT COUNT(*) AS c FROM sync_runs').get()).toEqual({ c: 1 });
    } finally {
      backupDb.close();
    }

    // 3. Restore backup to a new database file (restoredDbPath) and verify restoration
    const restoreSource = openDatabase({
      path: backupDbPath,
      readonly: true,
      migrate: false,
      wal: false
    });
    try {
      await restoreSource.backup(restoredDbPath);
    } finally {
      restoreSource.close();
    }

    expect(existsSync(restoredDbPath)).toBe(true);

    const restoredDb = openDatabase({
      path: restoredDbPath,
      readonly: true,
      migrate: false,
      wal: false
    });

    try {
      expect(restoredDb.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(restoredDb.pragma('foreign_key_check')).toEqual([]);
      expect(restoredDb.prepare('SELECT COUNT(*) AS c FROM day_project_entity_slices').get()).toEqual({ c: 5 });
      expect(restoredDb.prepare('SELECT COUNT(*) AS c FROM daily_time_allocations').get()).toEqual({ c: 2 });
    } finally {
      restoredDb.close();
    }

    sourceDb.close();
  });

  it('upgrades populated 001-004 database through all migrations 005-009, preserving IDs, counts, and FKs', () => {
    const db = createPopulated001To004Database(sourceDbPath);

    // Apply pending migrations (005 through 009)
    const applied = runMigrations(db, MIGRATIONS_DIR);
    expect(applied).toEqual([
      '005-sync-lifecycle.sql',
      '006-reconciliation-overlay.sql',
      '007-user-agent-registry.sql',
      '008-connection-lifecycle.sql',
      '009-slice-semantic-identity.sql'
    ]);

    // 1. Verify schema migrations table has all 9 migrations
    const recorded = db
      .prepare('SELECT filename FROM schema_migrations ORDER BY filename ASC')
      .all() as Array<{ filename: string }>;
    expect(recorded.map((r) => r.filename)).toEqual([
      '001-import-schema.sql',
      '002-application-state.sql',
      '003-wakatime-oauth.sql',
      '004-classification-rules-match-mode.sql',
      '005-sync-lifecycle.sql',
      '006-reconciliation-overlay.sql',
      '007-user-agent-registry.sql',
      '008-connection-lifecycle.sql',
      '009-slice-semantic-identity.sql'
    ]);

    // 2. Strict SQLite foreign key and integrity verification
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // 3. Verify row counts and IDs preserved across fact tables
    expect(db.prepare('SELECT COUNT(*) AS c FROM source_imports').get()).toEqual({ c: 2 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM projects').get()).toEqual({ c: 4 }); // 3 + 1 unattributed
    expect(db.prepare('SELECT COUNT(*) AS c FROM daily_totals').get()).toEqual({ c: 2 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM day_project_entity_slices').get()).toEqual({ c: 5 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM slice_identities').get()).toEqual({ c: 4 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM heartbeats').get()).toEqual({ c: 2 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM heartbeat_dependencies').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM heartbeat_variants').get()).toEqual({ c: 2 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM daily_time_allocations').get()).toEqual({ c: 2 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM classification_rules').get()).toEqual({ c: 2 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM classification_revisions').get()).toEqual({ c: 2 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM audit_events').get()).toEqual({ c: 1 });

    // 4. Verify slice semantic identity (migration 009)
    const slice101 = db.prepare('SELECT * FROM day_project_entity_slices WHERE id = 101').get() as Record<string, unknown>;
    expect(slice101.date).toBe('2026-09-08');
    expect(slice101.project_id).toBe(10);
    expect(slice101.entity).toBe('src/server.ts');
    expect(slice101.entity_type).toBe('file');
    expect(slice101.kind).toBe('entity');
    expect(slice101.snapshot_version).toBe(1);

    const slice104 = db.prepare('SELECT * FROM day_project_entity_slices WHERE id = 104').get() as Record<string, unknown>;
    expect(slice104.entity).toBe('Terminal');
    expect(slice104.entity_type).toBe('app');
    expect(slice104.kind).toBe('entity');

    // 5. Verify daily_time_allocations backfilled 5-tuple columns and state
    const alloc1 = db.prepare('SELECT * FROM daily_time_allocations WHERE id = ?').get('alloc_001') as Record<string, unknown>;
    expect(alloc1.id).toBe('alloc_001');
    expect(alloc1.date).toBe('2026-09-08');
    expect(alloc1.project_id).toBe(10);
    expect(alloc1.entity).toBe('src/server.ts');
    expect(alloc1.entity_type).toBe('file'); // populated from slice 101
    expect(alloc1.kind).toBe('entity');       // populated from slice 101
    expect(alloc1.classification).toBe('work');
    expect(alloc1.allocated_seconds).toBe(4000.0);
    expect(alloc1.state).toBe('active');
    expect(alloc1.note).toBe('Initial manual work allocation');

    const alloc2 = db.prepare('SELECT * FROM daily_time_allocations WHERE id = ?').get('alloc_002') as Record<string, unknown>;
    expect(alloc2.entity).toBe('Terminal');
    expect(alloc2.entity_type).toBe('app');
    expect(alloc2.kind).toBe('entity');
    expect(alloc2.state).toBe('active');

    // 6. Verify heartbeat memberships seeded with active = 1
    const memberships = db.prepare('SELECT * FROM heartbeat_memberships ORDER BY heartbeat_id ASC').all() as Array<Record<string, unknown>>;
    expect(memberships).toHaveLength(2);
    expect(memberships[0]).toEqual({ date: '2026-09-08', heartbeat_id: 201, active: 1 });
    expect(memberships[1]).toEqual({ date: '2026-09-09', heartbeat_id: 202, active: 1 });

    // 7. Verify sync_runs rebuilt with mode='recent' and single running index
    const run1 = db.prepare('SELECT * FROM sync_runs WHERE id = 1').get() as Record<string, unknown>;
    expect(run1.status).toBe('succeeded');
    expect(run1.mode).toBe('recent');

    // 8. Verify wakatime_oauth_connection backfilled with generation = 1
    const conn = db.prepare('SELECT * FROM wakatime_oauth_connection WHERE id = 1').get() as Record<string, unknown>;
    expect(conn.generation).toBe(1);

    // 9. Verify user_agent_registry tables exist and are empty
    expect(db.prepare('SELECT COUNT(*) AS c FROM user_agent_registry').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM user_agent_registry_staging').get()).toEqual({ c: 0 });

    // 10. Verify sync_layer_state exists
    expect(db.prepare('SELECT COUNT(*) AS c FROM sync_layer_state').get()).toEqual({ c: 0 });

    db.close();
  });

  it('guarantees stable idempotent replay across multiple invocations', () => {
    const db = createPopulated001To004Database(sourceDbPath);
    runMigrations(db, MIGRATIONS_DIR);

    // Replay 1
    const replay1 = runMigrations(db, MIGRATIONS_DIR);
    expect(replay1).toEqual([]);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // Replay 2
    const replay2 = runMigrations(db, MIGRATIONS_DIR);
    expect(replay2).toEqual([]);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // Replay 3
    const replay3 = runMigrations(db, MIGRATIONS_DIR);
    expect(replay3).toEqual([]);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    expect(db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get()).toEqual({ c: 9 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM day_project_entity_slices').get()).toEqual({ c: 5 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM daily_time_allocations').get()).toEqual({ c: 2 });

    db.close();
  });

  it('enforces runtime constraints: sync queue bounded limit and OAuth CAS generation guard', () => {
    const db = createPopulated001To004Database(sourceDbPath);
    runMigrations(db, MIGRATIONS_DIR);

    // 1. Queue limit trigger (trg_sync_runs_queue_limit_insert): max 10 queued/running
    // Currently 0 queued/running (run 1 is 'succeeded')
    const insertRun = db.prepare(`
      INSERT INTO sync_runs (trigger, mode, status, range_start_date, range_end_date, day_count)
      VALUES ('manual', 'recent', 'queued', '2026-09-08', '2026-09-08', 1)
    `);

    for (let i = 0; i < 10; i++) {
      insertRun.run();
    }

    expect(
      db.prepare("SELECT COUNT(*) AS c FROM sync_runs WHERE status IN ('queued', 'running')").get()
    ).toEqual({ c: 10 });

    // 11th queued run must abort with SYNC_QUEUE_FULL
    expect(() => insertRun.run()).toThrow(/SYNC_QUEUE_FULL/);

    // 2. OAuth CAS generation guard (trg_wakatime_oauth_connection_cas)
    // Updating with lower generation must abort with STALE_CONNECTION_GENERATION
    expect(() =>
      db.prepare('UPDATE wakatime_oauth_connection SET generation = 0 WHERE id = 1').run()
    ).toThrow(/STALE_CONNECTION_GENERATION/);

    // Advancing generation to 2 succeeds
    db.prepare('UPDATE wakatime_oauth_connection SET generation = 2 WHERE id = 1').run();
    const conn = db.prepare('SELECT generation FROM wakatime_oauth_connection WHERE id = 1').get() as { generation: number };
    expect(conn.generation).toBe(2);

    // Downgrading from 2 to 1 aborts
    expect(() =>
      db.prepare('UPDATE wakatime_oauth_connection SET generation = 1 WHERE id = 1').run()
    ).toThrow(/STALE_CONNECTION_GENERATION/);

    // 3. Append-only triggers on classification_revisions and audit_events
    expect(() =>
      db.prepare("UPDATE classification_revisions SET actor = 'hacker' WHERE id = 1").run()
    ).toThrow(/classification_revisions is append-only/);

    expect(() =>
      db.prepare('DELETE FROM classification_revisions WHERE id = 1').run()
    ).toThrow(/classification_revisions is append-only/);

    expect(() =>
      db.prepare("UPDATE audit_events SET actor = 'hacker' WHERE id = 1").run()
    ).toThrow(/audit_events is append-only/);

    expect(() =>
      db.prepare('DELETE FROM audit_events WHERE id = 1').run()
    ).toThrow(/audit_events is append-only/);

    db.close();
  });
});
