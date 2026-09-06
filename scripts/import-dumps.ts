#!/usr/bin/env tsx
/**
 * Import a pair of WakaTime dump files into the local database.
 *
 * Usage:
 *   pnpm import:dumps --daily <path> --heartbeats <path> [options]
 *
 * Options:
 *   --database <path>   Target SQLite file. Defaults to DATABASE_PATH.
 *   --dry-run           Validate and report without writing anything.
 *   --allow-conflicts   Quarantine conflicting duplicate heartbeat payloads
 *                       instead of failing the import closed.
 *   --force             Re-import dumps whose exact bytes were already imported.
 *   --max-bytes <n>     Direct-parse ceiling. Defaults to MAX_DIRECT_IMPORT_BYTES.
 *   --json              Emit the report as JSON on stdout.
 *
 * The dump files are single-user PII archives. This script never prints a dump
 * path, an entity, a machine id or an account id: paths and identities are
 * reduced to short SHA-256 fingerprints before they reach a log line.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getRuntimeConfig } from '../src/lib/server/config.js';
import { openDatabase } from '../src/lib/server/db/connection.js';
import { importDumps, type ImportLogger, type ImportReport } from '../src/lib/server/import/importer.js';
import { redactPath } from '../src/lib/server/import/canonical.js';

process.umask(0o077);

interface CliArguments {
  daily: string;
  heartbeats: string;
  database: string | null;
  dryRun: boolean;
  allowConflicts: boolean;
  force: boolean;
  maxBytes: number | null;
  json: boolean;
}

function parseArguments(argv: readonly string[]): CliArguments {
  const args: CliArguments = {
    daily: '',
    heartbeats: '',
    database: null,
    dryRun: false,
    allowConflicts: false,
    force: false,
    maxBytes: null,
    json: false
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };

    switch (flag) {
      case '--daily':
        args.daily = value();
        break;
      case '--heartbeats':
      case '--heartbeat':
        args.heartbeats = value();
        break;
      case '--database':
      case '--db':
        args.database = value();
        break;
      case '--max-bytes': {
        const parsed = Number.parseInt(value(), 10);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          throw new Error('--max-bytes must be a positive integer');
        }
        args.maxBytes = parsed;
        break;
      }
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--allow-conflicts':
        args.allowConflicts = true;
        break;
      case '--force':
        args.force = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  if (!args.daily || !args.heartbeats) {
    throw new Error('Both --daily and --heartbeats are required');
  }

  return args;
}

function printUsage(): void {
  process.stdout.write(
    'Usage: pnpm import:dumps --daily <path> --heartbeats <path>\n' +
      '                        [--database <path>] [--dry-run] [--allow-conflicts] [--force]\n' +
      '                        [--max-bytes <n>] [--json]\n'
  );
}

function reportLines(report: ImportReport): string[] {
  return [
    report.alreadyImported
      ? 'Already imported (no-op); re-run with --force to import again'
      : report.dryRun
        ? 'Dry run (nothing written)'
        : 'Import committed',
    `  range                    ${report.rangeStartDate} to ${report.rangeEndDate}`,
    `  calendar days            ${report.dayCount}`,
    `  days with positive time  ${report.activeDayCount}`,
    `  distinct projects        ${report.projectCount}`,
    `  account dimension rows   ${report.accountDimensionRows}`,
    `  project dimension rows   ${report.projectDimensionRows}`,
    `  official slices          ${report.sliceCount} (${report.unattributedSliceCount} unattributed, ` +
      `${report.unattributedSeconds.toFixed(1)}s)`,
    `  slice identities         ${report.sliceIdentityRows}`,
    `  heartbeats               ${report.heartbeatCount}`,
    `  duplicate occurrences    ${report.duplicateOccurrences} (${report.duplicateHeartbeatIds} idempotent)`,
    `  payload conflicts        ${report.conflictingHeartbeatIds}`,
    `  dependency relationships ${report.dependencyRelationships} source, ` +
      `${report.canonicalDependencyRows} canonical`,
    `  divergent days           ${report.divergentDays}`,
    `  warnings                 ${report.warnings.length}`
  ];
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const config = getRuntimeConfig();

  const databasePath = resolve(args.database ?? config.databasePath);
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });

  const logger: ImportLogger = {
    info: (message) => process.stderr.write(`[import] ${message}\n`),
    warn: (message) => process.stderr.write(`[import] warning: ${message}\n`)
  };

  logger.info(`Database ${redactPath(databasePath)}`);

  const db = openDatabase({ path: databasePath });
  try {
    const report = await importDumps(db, {
      dailyDumpPath: resolve(args.daily),
      heartbeatDumpPath: resolve(args.heartbeats),
      dryRun: args.dryRun,
      allowConflicts: args.allowConflicts,
      force: args.force,
      maxBytes: args.maxBytes ?? config.maxDirectImportBytes,
      logger
    });

    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${reportLines(report).join('\n')}\n`);
      for (const warning of report.warnings.slice(0, 20)) {
        process.stdout.write(`  ! ${warning}\n`);
      }
      if (report.warnings.length > 20) {
        process.stdout.write(`  ! ...and ${report.warnings.length - 20} more\n`);
      }
    }
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[import] failed: ${message}\n`);
  process.exitCode = 1;
});
