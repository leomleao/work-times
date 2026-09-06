#!/usr/bin/env tsx
/**
 * Run pending database migrations.
 *
 * Usage:
 *   pnpm db:migrate [options]
 *
 * Options:
 *   --database <path>   Target SQLite file. Defaults to DATABASE_PATH in runtime config.
 *   --status            Check migration status without applying pending migrations.
 *   --help, -h          Show this help message.
 *
 * Security:
 *   Does not print environment secrets, tokens, or plaintext credentials.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getRuntimeConfig } from '../src/lib/server/config.js';
import {
  listMigrations,
  openDatabase,
  runMigrations
} from '../src/lib/server/db/connection.js';
import { redactPath } from '../src/lib/server/import/canonical.js';

process.umask(0o077);

interface CliArgs {
  database: string | null;
  statusOnly: boolean;
}

function parseArguments(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    database: null,
    statusOnly: false
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--database':
      case '--db': {
        const next = argv[++i];
        if (!next) throw new Error(`${flag} requires a path value`);
        args.database = next;
        break;
      }
      case '--status':
        args.statusOnly = true;
        break;
      case '--help':
      case '-h':
        process.stdout.write(
          'Usage: pnpm db:migrate [--database <path>] [--status]\n'
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const config = getRuntimeConfig();
  const databasePath = resolve(args.database ?? config.databasePath);

  process.stderr.write(`[migrate] Database ${redactPath(databasePath)}\n`);

  if (args.statusOnly) {
    if (!existsSync(databasePath)) {
      process.stdout.write(`Database does not exist yet at ${redactPath(databasePath)}\n`);
      const all = listMigrations();
      process.stdout.write(`Pending (${all.length}): ${all.map((m) => m.filename).join(', ')}\n`);
      return;
    }

    const db = openDatabase({ path: databasePath, migrate: false, readonly: true });
    try {
      const all = listMigrations();
      const appliedRows = db.prepare('SELECT filename, applied_at FROM schema_migrations ORDER BY filename').all() as Array<{ filename: string; applied_at: string }>;
      const appliedSet = new Set(appliedRows.map((r) => r.filename));
      const pending = all.filter((m) => !appliedSet.has(m.filename));

      process.stdout.write(`Applied migrations (${appliedRows.length}):\n`);
      for (const row of appliedRows) {
        process.stdout.write(`  ✓ ${row.filename} (applied ${row.applied_at})\n`);
      }
      if (pending.length > 0) {
        process.stdout.write(`Pending migrations (${pending.length}):\n`);
        for (const m of pending) {
          process.stdout.write(`  • ${m.filename}\n`);
        }
      } else {
        process.stdout.write(`All migrations up to date.\n`);
      }
    } finally {
      db.close();
    }
    return;
  }

  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });

  // Open without running migrations first so we can track newly applied migrations
  const db = openDatabase({ path: databasePath, migrate: false });
  try {
    const applied = runMigrations(db);
    if (applied.length === 0) {
      process.stdout.write('[migrate] Schema is up to date (no migrations pending)\n');
    } else {
      process.stdout.write(`[migrate] Applied ${applied.length} migration(s):\n`);
      for (const filename of applied) {
        process.stdout.write(`  ✓ ${filename}\n`);
      }
    }
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[migrate] failed: ${message}\n`);
  process.exitCode = 1;
});
