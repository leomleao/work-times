import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configurePragmas,
  listMigrations,
  MIGRATIONS_DIR,
  openDatabase,
  openTestDatabase,
  runMigrations
} from './connection.js';
import { SqliteSyncRepository } from './repositories/sync.js';

const temporaryDirectories: string[] = [];

function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'work-times-db-'));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe('listMigrations', () => {
  it('orders by numeric prefix rather than string order', () => {
    const dir = temporaryDir();
    for (const name of ['010-ten.sql', '002-two.sql', '009-nine.sql']) {
      writeFileSync(join(dir, name), '');
    }
    expect(listMigrations(dir).map((m) => m.filename)).toEqual([
      '002-two.sql',
      '009-nine.sql',
      '010-ten.sql'
    ]);
  });

  it('rejects a filename without a zero-padded numeric prefix', () => {
    const dir = temporaryDir();
    writeFileSync(join(dir, 'add-thing.sql'), '');
    expect(() => listMigrations(dir)).toThrow(/Invalid migration filename/);
  });

  it('rejects two migrations claiming the same sequence', () => {
    const dir = temporaryDir();
    writeFileSync(join(dir, '001-a.sql'), '');
    writeFileSync(join(dir, '001-b.sql'), '');
    expect(() => listMigrations(dir)).toThrow(/Duplicate migration sequence/);
  });

  it('ignores non-SQL files', () => {
    const dir = temporaryDir();
    writeFileSync(join(dir, '001-a.sql'), '');
    writeFileSync(join(dir, 'README.md'), '');
    expect(listMigrations(dir)).toHaveLength(1);
  });
});

describe('runMigrations', () => {
  function migrationDir(): string {
    const dir = temporaryDir();
    writeFileSync(join(dir, '001-first.sql'), 'CREATE TABLE first (id INTEGER PRIMARY KEY);');
    writeFileSync(join(dir, '002-second.sql'), 'CREATE TABLE second (id INTEGER PRIMARY KEY);');
    return dir;
  }

  it('applies pending migrations in order and records them', () => {
    const dir = migrationDir();
    const db = new Database(':memory:');

    expect(runMigrations(db, dir)).toEqual(['001-first.sql', '002-second.sql']);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    ).toEqual([{ name: 'first' }, { name: 'schema_migrations' }, { name: 'second' }]);
  });

  it('is idempotent, so calling it on every startup is safe', () => {
    const dir = migrationDir();
    const db = new Database(':memory:');

    runMigrations(db, dir);
    expect(runMigrations(db, dir)).toEqual([]);
  });

  it('applies only what is new when a migration is added later', () => {
    const dir = migrationDir();
    const db = new Database(':memory:');
    runMigrations(db, dir);

    writeFileSync(join(dir, '003-third.sql'), 'CREATE TABLE third (id INTEGER PRIMARY KEY);');
    expect(runMigrations(db, dir)).toEqual(['003-third.sql']);
  });

  it('rolls back a failing migration and leaves it unrecorded', () => {
    const dir = temporaryDir();
    writeFileSync(
      join(dir, '001-broken.sql'),
      'CREATE TABLE ok (id INTEGER PRIMARY KEY); THIS IS NOT SQL;'
    );
    const db = new Database(':memory:');

    expect(() => runMigrations(db, dir)).toThrow(/Migration '001-broken.sql' failed/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").get()).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 0 });
  });
});

describe('URL heartbeat evidence migration', () => {
  it('preserves populated heartbeat evidence and child relationships under foreign keys', () => {
    const db = new Database(':memory:');
    configurePragmas(db, { wal: false });
    for (const migration of listMigrations(MIGRATIONS_DIR).filter((m) => m.sequence < 10)) {
      db.transaction(() => {
        db.exec(readFileSync(join(MIGRATIONS_DIR, migration.filename), 'utf8'));
        db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(migration.filename);
      })();
    }

    db.exec(`
      INSERT INTO source_imports (id, source_type, source_hash, byte_size)
      VALUES (1, 'heartbeat_dump', 'hash', 1);
      INSERT INTO heartbeats
        (id, external_id, occurred_at_us, occurred_at, local_date, entity, entity_type,
         category, user_agent_id, canonical_hash, source_import_id)
      VALUES (42, 'hb-file', 1, '2026-01-01T00:00:00Z', '2026-01-01', '/a.ts', 'file',
              'coding', 'editor/1', 'digest', 1);
      INSERT INTO heartbeat_dependencies (id, heartbeat_id, name, position)
      VALUES (55, 42, 'sqlite', 0);
      INSERT INTO heartbeat_memberships (date, heartbeat_id, active)
      VALUES ('2026-01-01', 42, 1);
    `);

    expect(runMigrations(db, MIGRATIONS_DIR)).toEqual([
      '010-url-heartbeat-evidence.sql',
      '011-url-summary-entities.sql',
      '012-seed-dump-heartbeat-memberships.sql'
    ]);
    expect(db.prepare('SELECT id, external_id, entity_type, canonical_hash FROM heartbeats WHERE id = 42').get())
      .toEqual({ id: 42, external_id: 'hb-file', entity_type: 'file', canonical_hash: 'digest' });
    expect(db.prepare('SELECT id, heartbeat_id, name, position FROM heartbeat_dependencies').all())
      .toEqual([{ id: 55, heartbeat_id: 42, name: 'sqlite', position: 0 }]);
    expect(db.prepare('SELECT date, heartbeat_id, active FROM heartbeat_memberships').all())
      .toEqual([{ date: '2026-01-01', heartbeat_id: 42, active: 1 }]);
    db.exec(`
      INSERT INTO projects (id, name) VALUES (2, 'browser-project');
      INSERT INTO daily_dimension_totals
        (date, scope, project_id, dimension, name, entity_type, total_seconds, source_import_id)
      VALUES ('2026-01-01', 'project', 2, 'entity', 'https://example.com/path', 'url', 30, 1);
      INSERT INTO day_project_entity_slices
        (date, project_id, entity, entity_type, total_seconds, source_import_id)
      VALUES ('2026-01-01', 2, 'https://example.com/path', 'url', 30, 1);
      INSERT INTO daily_time_allocations
        (id, date, project_id, entity, entity_type, kind, classification, allocated_seconds)
      VALUES ('url-allocation', '2026-01-01', 2, 'https://example.com/path', 'url', 'entity', 'work', 30);
    `);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.prepare(`
      INSERT INTO heartbeats
        (id, external_id, occurred_at_us, occurred_at, local_date, entity, entity_type,
         category, user_agent_id, canonical_hash, source_import_id)
      VALUES (43, 'hb-url', 2, '2026-01-01T00:00:01Z', '2026-01-01',
              'https://Example.com/Path', 'url', 'browsing', 'browser/1', 'url-digest', 1)
    `).run();
    expect(() => db.prepare(`
      INSERT INTO heartbeats
        (external_id, occurred_at_us, occurred_at, local_date, entity, entity_type,
         category, user_agent_id, canonical_hash, source_import_id)
      VALUES ('hb-bad', 3, '2026-01-01T00:00:02Z', '2026-01-01',
              'bad', 'widget', 'coding', 'editor/1', 'bad-digest', 1)
    `).run()).toThrow(/CHECK constraint failed/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    db.close();
  });
});

describe('dump heartbeat membership backfill', () => {
  it('activates missing dump days without reviving superseded evidence', () => {
    const db = new Database(':memory:');
    configurePragmas(db, { wal: false });
    for (const migration of listMigrations(MIGRATIONS_DIR).filter((m) => m.sequence < 12)) {
      db.transaction(() => {
        db.exec(readFileSync(join(MIGRATIONS_DIR, migration.filename), 'utf8'));
        db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(migration.filename);
      })();
    }

    db.exec(`
      INSERT INTO source_imports (id, source_type, source_hash, byte_size)
      VALUES (1, 'heartbeat_dump', 'dump', 1), (2, 'api_heartbeats', 'api', 1);
      INSERT INTO heartbeats
        (id, external_id, occurred_at_us, occurred_at, local_date, entity, entity_type,
         category, user_agent_id, canonical_hash, source_import_id)
      VALUES
        (1, 'missing', 1, '2026-01-01T00:00:00Z', '2026-01-01', '/a', 'file', 'coding', 'editor', 'a', 1),
        (2, 'inactive', 2, '2026-01-02T00:00:00Z', '2026-01-02', '/b', 'file', 'coding', 'editor', 'b', 1),
        (3, 'synced', 3, '2026-01-03T00:00:00Z', '2026-01-03', '/c', 'file', 'coding', 'editor', 'c', 1),
        (4, 'api', 4, '2026-01-01T00:00:00Z', '2026-01-01', '/d', 'file', 'coding', 'editor', 'd', 2);
      INSERT INTO heartbeat_memberships (date, heartbeat_id, active)
      VALUES ('2026-01-02', 2, 0);
      INSERT INTO sync_layer_state (date, layer, accepted_snapshot_version)
      VALUES ('2026-01-03', 'heartbeats', 1);
    `);

    expect(runMigrations(db, MIGRATIONS_DIR)).toEqual(['012-seed-dump-heartbeat-memberships.sql']);
    expect(db.prepare('SELECT date, heartbeat_id, active FROM heartbeat_memberships ORDER BY date').all()).toEqual([
      { date: '2026-01-01', heartbeat_id: 1, active: 1 },
      { date: '2026-01-02', heartbeat_id: 2, active: 0 }
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});

describe('configurePragmas', () => {
  it('enables foreign key enforcement', () => {
    const db = new Database(':memory:');
    configurePragmas(db, { wal: false });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('applies the requested busy timeout', () => {
    const db = new Database(':memory:');
    configurePragmas(db, { wal: false, busyTimeoutMs: 12_345 });
    expect(db.pragma('busy_timeout', { simple: true })).toBe(12_345);
  });

  it('rejects a nonsensical busy timeout instead of silently defaulting', () => {
    const db = new Database(':memory:');
    expect(() => configurePragmas(db, { wal: false, busyTimeoutMs: -1 })).toThrow(/non-negative/);
  });

  it('enables WAL on a file-backed database', () => {
    const path = join(temporaryDir(), 'wal.sqlite');
    const db = new Database(path);
    configurePragmas(db, {});
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    db.close();
  });
});

describe('openDatabase', () => {
  it('opens, migrates and enforces foreign keys in one call', () => {
    const path = join(temporaryDir(), 'app.sqlite');
    const db = openDatabase({ path });

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({
      n: listMigrations().length
    });
    db.close();
  });

  it('reopening an existing database re-applies nothing', () => {
    const path = join(temporaryDir(), 'app.sqlite');
    openDatabase({ path }).close();

    const db = openDatabase({ path });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM day_project_entity_slices').get()
    ).toEqual({ n: 0 });
    db.close();
  });

  it('restricts a file-backed archive to the owning OS user', () => {
    const path = join(temporaryDir(), 'private.sqlite');
    openDatabase({ path }).close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('the shipped schema', () => {
  it('creates the unattributed pseudo-project exactly once', () => {
    const db = openTestDatabase();
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE is_unattributed = 1').get()).toEqual({
      n: 1
    });
  });

  it('refuses a dimension row whose scope and project_id disagree', () => {
    const db = openTestDatabase();
    const insert = db.prepare(
      `INSERT INTO daily_dimension_totals (date, scope, project_id, dimension, name, total_seconds, source_import_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    db.prepare(
      `INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (1, 'daily_dump', 'h', 1)`
    ).run();

    expect(() => insert.run('2026-01-01', 'account', 1, 'category', 'Coding', 10, 1)).toThrow(
      /CHECK constraint failed/
    );
    expect(() => insert.run('2026-01-01', 'project', null, 'category', 'Coding', 10, 1)).toThrow(
      /CHECK constraint failed/
    );
  });

  it('dedupes account-scope dimension rows despite the NULL project_id', () => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (1, 'daily_dump', 'h', 1)`
    ).run();
    const insert = db.prepare(
      `INSERT INTO daily_dimension_totals (date, scope, project_id, dimension, name, total_seconds, source_import_id)
       VALUES (?, 'account', NULL, ?, ?, ?, 1)`
    );

    insert.run('2026-01-01', 'category', 'Coding', 10);
    expect(() => insert.run('2026-01-01', 'category', 'Coding', 20)).toThrow(/UNIQUE constraint failed/);
  });

  it('rejects a classification selector that is not an identity boundary', () => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (1, 'daily_dump', 'h', 1)`
    ).run();
    db.prepare(
      `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, source_import_id)
       VALUES (1, '2026-01-01', 1, '/a.ts', 'file', 1)`
    ).run();

    expect(() =>
      db
        .prepare('INSERT INTO slice_identities (slice_id, selector_type, value) VALUES (1, ?, ?)')
        .run('language', 'TypeScript')
    ).toThrow(/CHECK constraint failed/);
  });

  it('refuses a negative duration anywhere it stores one', () => {
    const db = openTestDatabase();
    db.prepare(
      `INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (1, 'daily_dump', 'h', 1)`
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO daily_totals (date, total_seconds, grand_total_json, source_import_id, source_hash)
           VALUES ('2026-01-01', -1, '{}', 1, 'h')`
        )
        .run()
    ).toThrow(/CHECK constraint failed/);
  });

  it('performs forward migration from populated 001-004 database, preserving all data and constraints', () => {
    const db = new Database(':memory:');
    configurePragmas(db, {});

    // Apply 001-004 sequentially
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);

    const p0Files = [
      '001-import-schema.sql',
      '002-application-state.sql',
      '003-wakatime-oauth.sql',
      '004-classification-rules-match-mode.sql'
    ];

    for (const f of p0Files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(f);
      })();
    }

    // Populate data across 001-004 tables
    db.exec(`
      INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (1, 'daily_dump', 'hash1', 100);
      INSERT INTO projects (id, name) VALUES (2, 'alpha-project');
      INSERT INTO daily_totals (date, total_seconds, grand_total_json, source_import_id, source_hash)
        VALUES ('2026-01-01', 3600.0, '{}', 1, 'hash1');
      INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id)
        VALUES (1, '2026-01-01', 2, 'src/app.ts', 'file', 3600.0, 0, 1);
      INSERT INTO daily_time_allocations (id, date, project_id, entity, classification, allocated_seconds, note)
        VALUES ('alloc_1', '2026-01-01', 2, 'src/app.ts', 'work', 3600.0, 'Initial allocation');
      INSERT INTO classification_revisions (id, mutation_type, target_type, target_id)
        VALUES (1, 'allocation_created', 'allocation', 'alloc_1');
      INSERT INTO heartbeats (id, external_id, occurred_at_us, occurred_at, local_date, entity, entity_type, category, user_agent_id, canonical_hash, source_import_id)
        VALUES (1, 'hb-uuid-001', 1000000, '2026-01-01T00:00:00Z', '2026-01-01', 'src/app.ts', 'file', 'coding', 'ua-1', 'hbhash', 1);
      INSERT INTO sync_runs (id, trigger, status, range_start_date, range_end_date, day_count)
        VALUES (1, 'manual', 'succeeded', '2026-01-01', '2026-01-01', 1);
      INSERT INTO sync_days (id, sync_run_id, date, status, total_seconds)
        VALUES (1, 1, '2026-01-01', 'succeeded', 3600.0);
      INSERT INTO wakatime_oauth_connection (id, access_token_sealed, refresh_token_sealed, scopes, connected_at, updated_at)
        VALUES (1, 'sealed_access', 'sealed_refresh', '["read_summaries"]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `);

    // Run all remaining forward migrations.
    const applied = runMigrations(db, MIGRATIONS_DIR);
    expect(applied).toEqual([
      '005-sync-lifecycle.sql',
      '006-reconciliation-overlay.sql',
      '007-user-agent-registry.sql',
      '008-connection-lifecycle.sql',
      '009-slice-semantic-identity.sql',
      '010-url-heartbeat-evidence.sql',
      '011-url-summary-entities.sql',
      '012-seed-dump-heartbeat-memberships.sql'
    ]);

    // Verify foreign key integrity with 0 violations
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // Verify data was preserved
    const run = db.prepare('SELECT * FROM sync_runs WHERE id = 1').get() as Record<string, unknown>;
    expect(run.id).toBe(1);
    expect(run.status).toBe('succeeded');
    expect(run.mode).toBe('recent');

    const day = db.prepare('SELECT * FROM sync_days WHERE id = 1').get() as Record<string, unknown>;
    expect(day.id).toBe(1);
    expect(day.sync_run_id).toBe(1);
    expect(day.total_seconds).toBe(3600.0);

    const slice = db.prepare('SELECT * FROM day_project_entity_slices WHERE id = 1').get() as Record<string, unknown>;
    expect(slice.kind).toBe('entity');
    expect(slice.snapshot_version).toBe(1);

    const alloc = db.prepare('SELECT * FROM daily_time_allocations WHERE id = ?').get('alloc_1') as Record<string, unknown>;
    expect(alloc.state).toBe('active');
    expect(alloc.entity_type).toBe('file');
    expect(alloc.kind).toBe('entity');
    expect(alloc.note).toBe('Initial allocation');

    // Heartbeat membership seeded
    const membership = db.prepare('SELECT * FROM heartbeat_memberships WHERE heartbeat_id = 1').get() as Record<string, unknown>;
    expect(membership.active).toBe(1);
    expect(membership.date).toBe('2026-01-01');

    // Connection generation initialized
    const conn = db.prepare('SELECT * FROM wakatime_oauth_connection WHERE id = 1').get() as Record<string, unknown>;
    expect(conn.generation).toBe(1);

    // Verify migration replay is idempotent
    expect(runMigrations(db, MIGRATIONS_DIR)).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rolls back completely on constraint or syntax violation without recording the migration', () => {
    const dir = temporaryDir();
    writeFileSync(join(dir, '001-good.sql'), 'CREATE TABLE ok_tab (id INTEGER PRIMARY KEY);');

    const db = new Database(':memory:');
    configurePragmas(db, {});

    expect(runMigrations(db, dir)).toEqual(['001-good.sql']);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok_tab'").get()).toBeDefined();

    writeFileSync(join(dir, '002-fail.sql'), 'CREATE TABLE will_fail (id INTEGER PRIMARY KEY); INVALID SQL SYNTAX;');

    expect(() => runMigrations(db, dir)).toThrow(/Migration '002-fail.sql' failed/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'will_fail'").get()).toBeUndefined();
    expect(
      db.prepare("SELECT filename FROM schema_migrations WHERE filename = '002-fail.sql'").get()
    ).toBeUndefined();
  });
});

describe('Milestone P1: Slice semantic identity (migration 009)', () => {
  function createPopulated008Database(): Database.Database {
    const db = new Database(':memory:');
    configurePragmas(db, {});

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);

    const pre009Files = [
      '001-import-schema.sql',
      '002-application-state.sql',
      '003-wakatime-oauth.sql',
      '004-classification-rules-match-mode.sql',
      '005-sync-lifecycle.sql',
      '006-reconciliation-overlay.sql',
      '007-user-agent-registry.sql',
      '008-connection-lifecycle.sql'
    ];

    for (const f of pre009Files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(f);
      })();
    }

    db.exec(`
      INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (1, 'daily_dump', 'hash1', 100);
      INSERT INTO projects (id, name) VALUES (10, 'project-p1');
      INSERT INTO daily_totals (date, total_seconds, grand_total_json, source_import_id, source_hash)
        VALUES ('2026-01-01', 3600.0, '{}', 1, 'hash1');
      INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, kind, total_seconds, is_unattributed, source_import_id)
        VALUES (100, '2026-01-01', 10, 'src/index.ts', 'file', 'entity', 1800.0, 0, 1);
      INSERT INTO slice_identities (id, slice_id, selector_type, value, source, observed_heartbeats)
        VALUES (200, 100, 'entity', 'src/index.ts', 'slice', 5);
      INSERT INTO daily_time_allocations (id, date, project_id, entity, classification, allocated_seconds, state, note)
        VALUES ('alloc_legacy', '2026-01-01', 10, 'src/index.ts', 'work', 1800.0, 'active', 'Legacy alloc');
      INSERT INTO classification_revisions (id, mutation_type, target_type, target_id, before_json, after_json, actor)
        VALUES (1, 'allocation_created', 'allocation', 'alloc_legacy', NULL, '{"classification":"work"}', 'admin');
    `);

    return db;
  }

  it('proves populated upgrade and idempotent migration replay', () => {
    const db = createPopulated008Database();

    const applied = runMigrations(db, MIGRATIONS_DIR);
    expect(applied).toEqual([
      '009-slice-semantic-identity.sql',
      '010-url-heartbeat-evidence.sql',
      '011-url-summary-entities.sql',
      '012-seed-dump-heartbeat-memberships.sql'
    ]);

    // Foreign key check passes with 0 errors
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // Slices preserved
    const slice = db.prepare('SELECT * FROM day_project_entity_slices WHERE id = 100').get() as Record<string, unknown>;
    expect(slice.id).toBe(100);
    expect(slice.date).toBe('2026-01-01');
    expect(slice.project_id).toBe(10);
    expect(slice.entity).toBe('src/index.ts');
    expect(slice.entity_type).toBe('file');
    expect(slice.kind).toBe('entity');
    expect(slice.total_seconds).toBe(1800.0);

    // Slice identities preserved with FK
    const ident = db.prepare('SELECT * FROM slice_identities WHERE id = 200').get() as Record<string, unknown>;
    expect(ident.id).toBe(200);
    expect(ident.slice_id).toBe(100);
    expect(ident.selector_type).toBe('entity');
    expect(ident.value).toBe('src/index.ts');

    // Allocations rebuilt with entity_type and kind
    const alloc = db.prepare('SELECT * FROM daily_time_allocations WHERE id = ?').get('alloc_legacy') as Record<string, unknown>;
    expect(alloc.id).toBe('alloc_legacy');
    expect(alloc.date).toBe('2026-01-01');
    expect(alloc.project_id).toBe(10);
    expect(alloc.entity).toBe('src/index.ts');
    expect(alloc.entity_type).toBe('file');
    expect(alloc.kind).toBe('entity');
    expect(alloc.classification).toBe('work');
    expect(alloc.allocated_seconds).toBe(1800.0);
    expect(alloc.state).toBe('active');
    expect(alloc.note).toBe('Legacy alloc');

    // Classification revision history preserved
    const rev = db.prepare('SELECT * FROM classification_revisions WHERE id = 1').get() as Record<string, unknown>;
    expect(rev.id).toBe(1);
    expect(rev.target_id).toBe('alloc_legacy');

    // Replay migration is idempotent
    expect(runMigrations(db, MIGRATIONS_DIR)).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('proves both file and app entities with the same text can coexist without collision', () => {
    const db = openTestDatabase();
    db.prepare(`INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (1, 'daily_dump', 'h', 1)`).run();
    db.prepare(`INSERT INTO projects (id, name) VALUES (10, 'project-multi')`).run();

    const insertSlice = db.prepare(`
      INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, kind, total_seconds, source_import_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);

    // Slices for file and app with identical entity text 'Terminal'
    insertSlice.run(1, '2026-01-01', 10, 'Terminal', 'app', 'entity', 500.0);
    insertSlice.run(2, '2026-01-01', 10, 'Terminal', 'file', 'entity', 700.0);

    const slices = db.prepare('SELECT id, entity, entity_type, total_seconds FROM day_project_entity_slices WHERE entity = ? ORDER BY id').all('Terminal');
    expect(slices).toHaveLength(2);

    const insertAlloc = db.prepare(`
      INSERT INTO daily_time_allocations (id, date, project_id, entity, entity_type, kind, classification, allocated_seconds, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Both allocations coexist simultaneously
    insertAlloc.run('alloc_app', '2026-01-01', 10, 'Terminal', 'app', 'entity', 'work', 500.0, 'active');
    insertAlloc.run('alloc_file', '2026-01-01', 10, 'Terminal', 'file', 'entity', 'personal', 700.0, 'active');

    const allocs = db.prepare('SELECT id, entity_type, classification, allocated_seconds FROM daily_time_allocations WHERE entity = ? ORDER BY id').all('Terminal') as Array<Record<string, unknown>>;
    expect(allocs).toHaveLength(2);
    expect(allocs[0]).toEqual({ id: 'alloc_app', entity_type: 'app', classification: 'work', allocated_seconds: 500.0 });
    expect(allocs[1]).toEqual({ id: 'alloc_file', entity_type: 'file', classification: 'personal', allocated_seconds: 700.0 });

    // Duplicate on exact 5-tuple is rejected by UNIQUE constraint
    expect(() =>
      insertAlloc.run('alloc_dup', '2026-01-01', 10, 'Terminal', 'app', 'entity', 'personal', 500.0, 'active')
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('proves coarse and entity kinds cannot steal each others allocation', () => {
    const db = openTestDatabase();
    db.prepare(`INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (1, 'daily_dump', 'h', 1)`).run();
    db.prepare(`INSERT INTO projects (id, name) VALUES (10, 'project-kinds')`).run();

    const insertSlice = db.prepare(`
      INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, kind, total_seconds, source_import_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);

    // Slice 1: entity kind (500s)
    insertSlice.run(1, '2026-01-01', 10, 'src/shared.ts', 'file', 'entity', 500.0);
    // Slice 2: project_summary coarse kind (500s)
    insertSlice.run(2, '2026-01-01', 10, 'src/shared.ts', 'file', 'project_summary', 500.0);

    const insertAlloc = db.prepare(`
      INSERT INTO daily_time_allocations (id, date, project_id, entity, entity_type, kind, classification, allocated_seconds, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Create allocation specifically targeting 'entity' kind
    insertAlloc.run('alloc_fine', '2026-01-01', 10, 'src/shared.ts', 'file', 'entity', 'work', 500.0, 'active');

    // Create allocation specifically targeting 'project_summary' kind
    insertAlloc.run('alloc_coarse', '2026-01-01', 10, 'src/shared.ts', 'file', 'project_summary', 'personal', 500.0, 'active');

    // Delete coarse slice
    db.prepare('DELETE FROM day_project_entity_slices WHERE id = 2').run();

    // Re-inserting or updating active allocation for 'project_summary' fails duration trigger,
    // proving the 'entity' slice (with identical date, project, entity, entity_type, duration) cannot be stolen!
    expect(() =>
      insertAlloc.run('alloc_coarse_steal', '2026-01-01', 10, 'src/shared.ts', 'file', 'project_summary', 'work', 500.0, 'active')
    ).toThrow(/allocated_seconds does not match authoritative slice total_seconds/);
  });

  it('proves exact detach and reattach identity behavior', () => {
    const db = openTestDatabase();
    const repo = new SqliteSyncRepository(db);

    db.prepare(`INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (1, 'daily_dump', 'h', 1)`).run();
    db.prepare(`INSERT INTO projects (id, name) VALUES (10, 'project-lifecycle')`).run();

    db.prepare(`
      INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, kind, total_seconds, source_import_id)
      VALUES (1, '2026-01-01', 10, 'Slack', 'app', 'entity', 800.0, 1)
    `).run();

    db.prepare(`
      INSERT INTO daily_time_allocations (id, date, project_id, entity, entity_type, kind, classification, allocated_seconds, state)
      VALUES ('alloc_slack', '2026-01-01', 10, 'Slack', 'app', 'entity', 'work', 800.0, 'active')
    `).run();

    // Detach allocation
    repo.detachAllocation('alloc_slack', '2026-01-01T10:00:00.000Z');
    let alloc = repo.getAllocationsForDate('2026-01-01')[0];
    expect(alloc.state).toBe('detached');
    expect(alloc.entityType).toBe('app');
    expect(alloc.kind).toBe('entity');

    // Delete the original slice ('Slack', 'app', 'entity')
    db.prepare('DELETE FROM day_project_entity_slices WHERE id = 1').run();

    // Insert a DIFFERENT slice with same entity text 'Slack' but entity_type = 'domain'
    db.prepare(`
      INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, kind, total_seconds, source_import_id)
      VALUES (2, '2026-01-01', 10, 'Slack', 'domain', 'entity', 800.0, 1)
    `).run();

    // Reattach MUST FAIL because identity (date, project_id, entity, entity_type, kind) does NOT match the domain slice
    expect(() => repo.reattachAllocation('alloc_slack', 800.0, '2026-01-01T11:00:00.000Z')).toThrow(
      /allocated_seconds does not match authoritative slice total_seconds/
    );

    // Recreate the matching slice ('Slack', 'app', 'entity')
    db.prepare(`
      INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, kind, total_seconds, source_import_id)
      VALUES (3, '2026-01-01', 10, 'Slack', 'app', 'entity', 800.0, 1)
    `).run();

    // Now reattach succeeds with exact identity
    repo.reattachAllocation('alloc_slack', 800.0, '2026-01-01T11:30:00.000Z');
    alloc = repo.getAllocationsForDate('2026-01-01').find((a) => a.id === 'alloc_slack')!;
    expect(alloc.state).toBe('active');
    expect(alloc.reattachedAt).toBe('2026-01-01T11:30:00.000Z');
  });

  it('proves duration trigger behavior for active vs detached allocations', () => {
    const db = openTestDatabase();
    db.prepare(`INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (1, 'daily_dump', 'h', 1)`).run();
    db.prepare(`INSERT INTO projects (id, name) VALUES (10, 'project-trigger')`).run();

    db.prepare(`
      INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, kind, total_seconds, source_import_id)
      VALUES (1, '2026-01-01', 10, 'src/calc.ts', 'file', 'entity', 1234.0, 1)
    `).run();

    const insertAlloc = db.prepare(`
      INSERT INTO daily_time_allocations (id, date, project_id, entity, entity_type, kind, classification, allocated_seconds, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Active with mismatched seconds rejected
    expect(() =>
      insertAlloc.run('alloc_bad_time', '2026-01-01', 10, 'src/calc.ts', 'file', 'entity', 'work', 1230.0, 'active')
    ).toThrow(/allocated_seconds does not match authoritative slice total_seconds/);

    // Active with nonexistent slice rejected
    expect(() =>
      insertAlloc.run('alloc_bad_key', '2026-01-01', 10, 'missing.ts', 'file', 'entity', 'work', 500.0, 'active')
    ).toThrow(/allocated_seconds does not match authoritative slice total_seconds/);

    // Detached allocation without matching slice or duration is accepted
    expect(() =>
      insertAlloc.run('alloc_detached', '2026-01-01', 10, 'detached.ts', 'file', 'entity', 'work', 999.0, 'detached')
    ).not.toThrow();

    // Updating detached allocation while remaining detached is allowed
    expect(() =>
      db.prepare('UPDATE daily_time_allocations SET allocated_seconds = 888.0 WHERE id = ?').run('alloc_detached')
    ).not.toThrow();

    // Transitioning detached allocation to active without matching slice fails
    expect(() =>
      db.prepare("UPDATE daily_time_allocations SET state = 'active' WHERE id = ?").run('alloc_detached')
    ).toThrow(/allocated_seconds does not match authoritative slice total_seconds/);
  });

  it('proves preserved FKs, cascade deletes, and revision history', () => {
    const db = openTestDatabase();
    db.prepare(`INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (1, 'daily_dump', 'h', 1)`).run();
    db.prepare(`INSERT INTO projects (id, name) VALUES (10, 'project-fks')`).run();

    db.prepare(`
      INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, kind, total_seconds, source_import_id)
      VALUES (55, '2026-01-01', 10, 'src/mod.ts', 'file', 'entity', 200.0, 1)
    `).run();

    db.prepare(`
      INSERT INTO slice_identities (id, slice_id, selector_type, value)
      VALUES (101, 55, 'folder_prefix', 'src/')
    `).run();

    db.prepare(`
      INSERT INTO daily_time_allocations (id, date, project_id, entity, entity_type, kind, classification, allocated_seconds, state)
      VALUES ('alloc_55', '2026-01-01', 10, 'src/mod.ts', 'file', 'entity', 'work', 200.0, 'active')
    `).run();

    db.prepare(`
      INSERT INTO classification_revisions (id, mutation_type, target_type, target_id, actor)
      VALUES (1, 'allocation_created', 'allocation', 'alloc_55', 'admin')
    `).run();

    expect(db.pragma('foreign_key_check')).toEqual([]);

    // Cascade delete on slice_identities when slice is deleted
    db.prepare('DELETE FROM day_project_entity_slices WHERE id = 55').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM slice_identities WHERE slice_id = 55').get()).toEqual({ n: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // Allocation and revision history preserved
    expect(db.prepare('SELECT id FROM daily_time_allocations WHERE id = ?').get('alloc_55')).toBeDefined();
    expect(db.prepare('SELECT id FROM classification_revisions WHERE id = 1').get()).toBeDefined();

    // Invalid project FK rejected on slice insert
    expect(() =>
      db.prepare(`
        INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, kind, total_seconds, source_import_id)
        VALUES (99, '2026-01-01', 9999, 'bad.ts', 'file', 'entity', 10.0, 1)
      `).run()
    ).toThrow(/FOREIGN KEY constraint failed/);

    // Invalid project FK rejected on allocation insert
    expect(() =>
      db.prepare(`
        INSERT INTO daily_time_allocations (id, date, project_id, entity, entity_type, kind, classification, allocated_seconds, state)
        VALUES ('bad_fk', '2026-01-01', 9999, 'bad.ts', 'file', 'entity', 'work', 10.0, 'detached')
      `).run()
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('proves rollback on unresolvable legacy allocation identity without guessing', () => {
    const db = new Database(':memory:');
    configurePragmas(db, {});

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);

    const pre009Files = [
      '001-import-schema.sql',
      '002-application-state.sql',
      '003-wakatime-oauth.sql',
      '004-classification-rules-match-mode.sql',
      '005-sync-lifecycle.sql',
      '006-reconciliation-overlay.sql',
      '007-user-agent-registry.sql',
      '008-connection-lifecycle.sql'
    ];

    for (const f of pre009Files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(f);
      })();
    }

    db.exec(`
      INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (1, 'daily_dump', 'hash1', 100);
      INSERT INTO projects (id, name) VALUES (10, 'project-orphan');
      INSERT INTO daily_totals (date, total_seconds, grand_total_json, source_import_id, source_hash)
        VALUES ('2026-01-01', 3600.0, '{}', 1, 'hash1');
      -- An orphan legacy allocation with NO matching slice in day_project_entity_slices
      INSERT INTO daily_time_allocations (id, date, project_id, entity, classification, allocated_seconds, state, note)
        VALUES ('orphan_alloc', '2026-01-01', 10, 'orphan.ts', 'work', 500.0, 'detached', 'Orphan legacy');
    `);

    // Migration 009 must fail and rollback rather than guess missing identity
    expect(() => runMigrations(db, MIGRATIONS_DIR)).toThrow(
      /Migration '009-slice-semantic-identity.sql' failed: UNRESOLVABLE_LEGACY_ALLOCATION_IDENTITY/
    );

    // Migration 009 unrecorded
    expect(
      db.prepare("SELECT filename FROM schema_migrations WHERE filename = '009-slice-semantic-identity.sql'").get()
    ).toBeUndefined();

    // Table daily_time_allocations retains legacy 008 structure (no entity_type column)
    const columns = (db.prepare("PRAGMA table_info('daily_time_allocations')").all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    expect(columns).not.toContain('entity_type');
    expect(columns).not.toContain('kind');

    // Data remains intact
    const orphan = db.prepare('SELECT * FROM daily_time_allocations WHERE id = ?').get('orphan_alloc') as Record<string, unknown>;
    expect(orphan.id).toBe('orphan_alloc');
    expect(orphan.note).toBe('Orphan legacy');
  });
});
