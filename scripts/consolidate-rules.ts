#!/usr/bin/env tsx
/**
 * Consolidate classification rules via manifest.
 *
 * Usage:
 *   # Default: Dry-run preview against specified DB path (performs no writes)
 *   pnpm rules:consolidate --db <path> --manifest <manifest-path>
 *
 *   # Explicit Apply: Requires separate --apply flag, explicit DB path, manifest, and non-existing backup path
 *   pnpm rules:consolidate --db <path> --manifest <manifest-path> --apply --backup <backup-path>
 *
 * Safety Constraints:
 *   - The CLI requires --db <path> explicitly. It never defaults to the live database.
 *   - --apply asserts that --backup <path> does not exist, refusing overwrite.
 *   - Pre-apply protocol:
 *     1. Executes await db.backup(backupPath).
 *     2. Runs PRAGMA integrity_check; on the backup file.
 *     3. Runs consolidation in an atomic transaction returning created/deleted rule IDs and revision IDs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../src/lib/server/db/connection.js';
import { createClassificationService } from '../src/lib/server/classification/sqlite.js';
import type { CreateRuleInput } from '../src/lib/server/classification/sqlite.js';

interface ConsolidationManifest {
  createRules?: CreateRuleInput[];
  deleteRuleIds?: string[];
}

interface CliArgs {
  dbPath: string | null;
  manifestPath: string | null;
  apply: boolean;
  backupPath: string | null;
}

function parseArguments(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    dbPath: null,
    manifestPath: null,
    apply: false,
    backupPath: null
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--database':
      case '--db': {
        const next = argv[++i];
        if (!next) throw new Error(`${flag} requires a database path`);
        args.dbPath = next;
        break;
      }
      case '--manifest': {
        const next = argv[++i];
        if (!next) throw new Error(`${flag} requires a manifest path`);
        args.manifestPath = next;
        break;
      }
      case '--apply': {
        args.apply = true;
        break;
      }
      case '--backup': {
        const next = argv[++i];
        if (!next) throw new Error(`${flag} requires a backup path`);
        args.backupPath = next;
        break;
      }
      case '--help':
      case '-h': {
        process.stdout.write(
          'Usage:\n' +
            '  # Dry-run preview:\n' +
            '  pnpm rules:consolidate --db <path> --manifest <manifest-path>\n\n' +
            '  # Apply changes:\n' +
            '  pnpm rules:consolidate --db <path> --manifest <manifest-path> --apply --backup <backup-path>\n'
        );
        process.exit(0);
        break;
      }
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));

  if (!args.dbPath) {
    process.stderr.write(
      'Error: --db <path> is required. The consolidation CLI never defaults to the live database.\n'
    );
    process.exit(1);
  }

  if (!args.manifestPath) {
    process.stderr.write('Error: --manifest <manifest-path> is required.\n');
    process.exit(1);
  }

  const resolvedDbPath = resolve(args.dbPath);
  if (!existsSync(resolvedDbPath)) {
    process.stderr.write(`Error: Target database not found at ${resolvedDbPath}\n`);
    process.exit(1);
  }

  const resolvedManifestPath = resolve(args.manifestPath);
  if (!existsSync(resolvedManifestPath)) {
    process.stderr.write(`Error: Manifest file not found at ${resolvedManifestPath}\n`);
    process.exit(1);
  }

  let manifest: ConsolidationManifest;
  try {
    const content = readFileSync(resolvedManifestPath, 'utf8');
    manifest = JSON.parse(content) as ConsolidationManifest;
  } catch (err) {
    process.stderr.write(
      `Error: Failed to parse manifest JSON at ${resolvedManifestPath}: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }

  const createCount = manifest.createRules?.length ?? 0;
  const deleteCount = manifest.deleteRuleIds?.length ?? 0;

  process.stdout.write(`Database: ${resolvedDbPath}\n`);
  process.stdout.write(`Manifest: ${resolvedManifestPath}\n`);
  process.stdout.write(
    `Operations: ${createCount} rule(s) to create, ${deleteCount} rule(s) to retire\n`
  );

  if (!args.apply) {
    process.stdout.write(
      '\n[DRY-RUN] Preview mode. No changes written. To apply changes, rerun with --apply --backup <backup-path>.\n'
    );
    if (createCount > 0) {
      process.stdout.write('\nRules to create:\n');
      for (const [idx, rule] of (manifest.createRules ?? []).entries()) {
        process.stdout.write(
          `  ${idx + 1}. [${(rule.matchMode ?? 'exact').toUpperCase()}] ${rule.selectorType}:${rule.selectorValue} -> ${rule.classification} ("${rule.name}")\n`
        );
      }
    }
    if (deleteCount > 0) {
      process.stdout.write('\nRules to delete:\n');
      for (const id of manifest.deleteRuleIds ?? []) {
        process.stdout.write(`  - ${id}\n`);
      }
    }
    return;
  }

  // Explicit Apply Mode
  if (!args.backupPath) {
    process.stderr.write('Error: --apply requires --backup <path> to be specified.\n');
    process.exit(1);
  }

  const resolvedBackupPath = resolve(args.backupPath);
  if (existsSync(resolvedBackupPath)) {
    process.stderr.write(
      `Error: Backup file already exists at ${resolvedBackupPath}. Refusing to overwrite.\n`
    );
    process.exit(1);
  }

  process.stdout.write(`Creating pre-apply backup at ${resolvedBackupPath}...\n`);
  const targetDb = openDatabase({ path: resolvedDbPath, migrate: true });

  try {
    await targetDb.backup(resolvedBackupPath);
    process.stdout.write('Pre-apply backup created successfully.\n');

    // Run PRAGMA integrity_check on backup
    process.stdout.write('Verifying backup database integrity...\n');
    const backupDb = openDatabase({ path: resolvedBackupPath, readonly: true, migrate: false });
    try {
      const integrityRows = backupDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (!integrityRows.length || integrityRows[0].integrity_check !== 'ok') {
        throw new Error(`Backup integrity check failed: ${JSON.stringify(integrityRows)}`);
      }
      process.stdout.write('Backup database integrity verified: OK\n');
    } finally {
      backupDb.close();
    }

    process.stdout.write('Executing atomic rule consolidation...\n');
    const service = createClassificationService(targetDb);
    const result = service.consolidateRules(manifest, { actor: 'cli-consolidate' });

    process.stdout.write(
      `Successfully applied consolidation:\n` +
        `  - Created ${result.createdRuleIds.length} rule(s): ${result.createdRuleIds.join(', ')}\n` +
        `  - Deleted ${result.deletedRuleIds.length} rule(s): ${result.deletedRuleIds.join(', ')}\n` +
        `  - Created ${result.revisionIds.length} audit revision(s): ${result.revisionIds.join(', ')}\n`
    );
  } finally {
    targetDb.close();
  }
}

main().catch((err) => {
  process.stderr.write(`Consolidation failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
