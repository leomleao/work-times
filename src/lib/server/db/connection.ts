import Database from 'better-sqlite3';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OpenDatabaseOptions {
  /** Path to the SQLite file, or ':memory:'. */
  path: string;
  /** Busy timeout in milliseconds. Default 5000. */
  busyTimeoutMs?: number;
  /** Enable WAL. Default true; forced off for in-memory databases. */
  wal?: boolean;
  /** Run pending migrations on open. Default true. */
  migrate?: boolean;
  /** Override the migrations directory (tests). */
  migrationsDir?: string;
  /** Open read-only. Implies `migrate: false`. */
  readonly?: boolean;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Repository/runtime `migrations/` directory.
 *
 * Production bundles relocate this module under `build/server/chunks`, so a
 * source-relative path alone would resolve outside `/app` in the container.
 * Prefer the directory shipped beside the application working directory and
 * retain the source-relative path for callers that execute the module from a
 * different working directory.
 */
const WORKING_DIRECTORY_MIGRATIONS = resolve(process.cwd(), 'migrations');
const SOURCE_DIRECTORY_MIGRATIONS = resolve(MODULE_DIR, '../../../../migrations');
export const MIGRATIONS_DIR = existsSync(WORKING_DIRECTORY_MIGRATIONS)
  ? WORKING_DIRECTORY_MIGRATIONS
  : SOURCE_DIRECTORY_MIGRATIONS;

/**
 * Migration filenames must be `NNN-name.sql` so lexicographic order is also
 * numeric order. Enforced rather than assumed: a `10-x.sql` sorting before
 * `9-x.sql` would silently apply migrations out of order.
 */
const MIGRATION_FILENAME = /^(\d{3,})-[a-z0-9][a-z0-9-]*\.sql$/;

/**
 * Open (or create) the database with the pragmas this application depends on,
 * then bring the schema up to date.
 *
 * Startup-safe: concurrent processes racing to migrate are serialized by the
 * busy timeout plus the per-migration transaction, and an already-applied
 * migration is skipped rather than re-run.
 */
export function openDatabase(options: OpenDatabaseOptions): Database.Database {
  const fileBacked = options.path !== ':memory:' && options.path !== '';
  if (fileBacked && !options.readonly) {
    const parent = dirname(options.path);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    closeSync(openSync(options.path, 'a', 0o600));
    chmodSync(options.path, 0o600);
  }

  const db = new Database(options.path, { readonly: options.readonly ?? false });

  configurePragmas(db, options);

  if (options.migrate !== false && !options.readonly) {
    runMigrations(db, options.migrationsDir);
  }

  if (fileBacked && !options.readonly) {
    for (const suffix of ['', '-wal', '-shm']) {
      const artifact = `${options.path}${suffix}`;
      if (existsSync(artifact)) chmodSync(artifact, 0o600);
    }
  }

  return db;
}

/**
 * Apply the connection-level pragmas.
 *
 * `busy_timeout` is set first so that every later statement — including the
 * `journal_mode` switch, which needs a brief exclusive lock — waits for a
 * competing writer instead of failing immediately with SQLITE_BUSY.
 */
export function configurePragmas(db: Database.Database, options: Partial<OpenDatabaseOptions> = {}): void {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new Error('busyTimeoutMs must be a non-negative integer');
  }

  db.pragma(`busy_timeout = ${busyTimeoutMs}`);

  const wantsWal = options.wal !== false && db.name !== ':memory:' && db.name !== '';
  if (wantsWal) {
    const [row] = db.pragma('journal_mode = WAL') as Array<{ journal_mode: string }>;
    if (row?.journal_mode?.toLowerCase() !== 'wal') {
      throw new Error(`Failed to enable WAL journal mode (got '${row?.journal_mode ?? 'unknown'}')`);
    }
    // WAL + NORMAL is the documented durable-enough pairing: a crash can lose
    // the last transactions but never corrupts the database.
    db.pragma('synchronous = NORMAL');
  }

  if (!options.readonly) {
    db.pragma('foreign_keys = ON');
    const [fk] = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    if (fk?.foreign_keys !== 1) {
      throw new Error('Failed to enable foreign key enforcement');
    }
  }
}

/** A migration file discovered on disk, in application order. */
export interface PendingMigration {
  filename: string;
  sequence: number;
}

/** List migration files in validated, ascending numeric order. */
export function listMigrations(migrationsDir: string = MIGRATIONS_DIR): PendingMigration[] {
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));

  const parsed = files.map((filename) => {
    const match = MIGRATION_FILENAME.exec(filename);
    if (!match) {
      throw new Error(
        `Invalid migration filename '${filename}': expected NNN-kebab-name.sql with a zero-padded numeric prefix`
      );
    }
    return { filename, sequence: Number.parseInt(match[1], 10) };
  });

  parsed.sort((left, right) =>
    left.sequence === right.sequence
      ? left.filename.localeCompare(right.filename)
      : left.sequence - right.sequence
  );

  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].sequence === parsed[i - 1].sequence) {
      throw new Error(
        `Duplicate migration sequence ${parsed[i].sequence}: '${parsed[i - 1].filename}' and '${parsed[i].filename}'`
      );
    }
  }

  return parsed;
}

/**
 * Apply every migration that has not been recorded yet, in order, each inside
 * its own transaction. Idempotent and safe to call on every startup.
 *
 * Returns the filenames actually applied by this call.
 */
export function runMigrations(db: Database.Database, migrationsDir: string = MIGRATIONS_DIR): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT filename FROM schema_migrations').all() as Array<{ filename: string }>).map(
      (row) => row.filename
    )
  );

  const performed: string[] = [];

  for (const { filename } of listMigrations(migrationsDir)) {
    if (applied.has(filename)) continue;

    const sql = readFileSync(join(migrationsDir, filename), 'utf8');
    const insert = db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)');

    // A migration may contain DDL that SQLite cannot run inside an implicit
    // transaction started by better-sqlite3's `.transaction()` helper only if
    // it commits itself; none of ours do, so a plain transaction is correct.
    const apply = db.transaction(() => {
      db.exec(sql);
      insert.run(filename);
    });

    try {
      apply();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration '${filename}' failed: ${reason}`, { cause: error });
    }

    performed.push(filename);
  }

  return performed;
}

/** Open a migrated in-memory database. Test helper. */
export function openTestDatabase(migrationsDir: string = MIGRATIONS_DIR): Database.Database {
  return openDatabase({ path: ':memory:', wal: false, migrationsDir });
}
