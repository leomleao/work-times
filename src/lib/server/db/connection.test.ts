import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configurePragmas,
  listMigrations,
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
});
