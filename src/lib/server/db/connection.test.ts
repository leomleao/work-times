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

    // Run forward migrations 005-008
    const applied = runMigrations(db, MIGRATIONS_DIR);
    expect(applied).toEqual([
      '005-sync-lifecycle.sql',
      '006-reconciliation-overlay.sql',
      '007-user-agent-registry.sql',
      '008-connection-lifecycle.sql'
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
