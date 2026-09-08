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
 *   - Manifest schema is strictly validated against MAX_PATTERN_LENGTH, allowed selector types, and duplicate delete IDs.
 *   - Dry-run opens database read-only with migrate: false, validates that all deleteRuleIds exist, and performs zero mutations.
 *   - In --apply mode:
 *     1. Checks that --backup <path> does not exist, refusing overwrite.
 *     2. Opens source database read-only with migrate: false to take the pre-migration pre-apply backup via await sourceDb.backup(backupPath).
 *     3. Runs PRAGMA integrity_check; on the backup file.
 *     4. Only then opens target database with migrate: true and runs consolidation in an atomic transaction returning created/deleted rule IDs and revision IDs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../src/lib/server/db/connection.js';
import { createClassificationService } from '../src/lib/server/classification/sqlite.js';
import type { CreateRuleInput } from '../src/lib/server/classification/sqlite.js';
import {
  MAX_PATTERN_LENGTH,
  SELECTOR_TYPES,
  type SelectorType,
  type MatchMode
} from '../src/lib/server/classification/model.js';

export interface ConsolidationManifest {
  createRules?: CreateRuleInput[];
  deleteRuleIds?: string[];
}

export interface CliArgs {
  dbPath: string | null;
  manifestPath: string | null;
  apply: boolean;
  backupPath: string | null;
}

export function parseArguments(argv: readonly string[]): CliArgs {
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

const ALLOWED_TOP_LEVEL_KEYS = new Set(['createRules', 'deleteRuleIds']);
const ALLOWED_CREATE_RULE_KEYS = new Set([
  'id',
  'name',
  'classification',
  'selectorType',
  'selectorValue',
  'matchMode',
  'priority',
  'enabled',
  'timesheetCode'
]);

export function validateManifest(raw: unknown): ConsolidationManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Manifest must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new Error(`Manifest contains unknown top-level key: '${key}'`);
    }
  }

  const hasCreate = Array.isArray(obj.createRules) && obj.createRules.length > 0;
  const hasDelete = Array.isArray(obj.deleteRuleIds) && obj.deleteRuleIds.length > 0;

  if (!hasCreate && !hasDelete) {
    throw new Error('Manifest must contain non-empty createRules or deleteRuleIds');
  }

  const result: ConsolidationManifest = {};

  if (obj.createRules !== undefined) {
    if (!Array.isArray(obj.createRules)) {
      throw new Error('Manifest createRules must be an array');
    }
    result.createRules = [];
    const seenCreateIds = new Set<string>();

    for (const [idx, item] of obj.createRules.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`createRules[${idx}] must be an object`);
      }
      const r = item as Record<string, unknown>;

      for (const key of Object.keys(r)) {
        if (!ALLOWED_CREATE_RULE_KEYS.has(key)) {
          throw new Error(`createRules[${idx}] contains unknown key: '${key}'`);
        }
      }

      let id: string | undefined = undefined;
      if ('id' in r && r.id !== undefined) {
        if (typeof r.id !== 'string' || r.id.trim().length === 0) {
          throw new Error(`createRules[${idx}].id must be a non-empty string if supplied`);
        }
        id = r.id.trim();
        if (seenCreateIds.has(id)) {
          throw new Error(`Duplicate rule ID in createRules: '${id}'`);
        }
        seenCreateIds.add(id);
      }

      const name = typeof r.name === 'string' ? r.name.trim() : '';
      if (!name) {
        throw new Error(`createRules[${idx}].name cannot be empty`);
      }
      const classification = String(r.classification ?? '').trim();
      if (classification !== 'work' && classification !== 'personal') {
        throw new Error(
          `createRules[${idx}].classification must be 'work' or 'personal', got '${classification}'`
        );
      }
      const selectorType = String(r.selectorType ?? '').trim();
      if (!SELECTOR_TYPES.includes(selectorType as SelectorType)) {
        throw new Error(`createRules[${idx}].selectorType '${selectorType}' is invalid`);
      }
      const selectorValue = typeof r.selectorValue === 'string' ? r.selectorValue.trim() : '';
      if (!selectorValue) {
        throw new Error(`createRules[${idx}].selectorValue cannot be empty`);
      }
      if (selectorValue.length > MAX_PATTERN_LENGTH) {
        throw new Error(
          `createRules[${idx}].selectorValue length ${selectorValue.length} exceeds limit of ${MAX_PATTERN_LENGTH}`
        );
      }

      let matchMode: MatchMode = 'exact';
      if (r.matchMode !== undefined && r.matchMode !== null && r.matchMode !== '') {
        const mm = String(r.matchMode).trim();
        if (mm !== 'exact' && mm !== 'glob') {
          throw new Error(`createRules[${idx}].matchMode must be 'exact' or 'glob', got '${mm}'`);
        }
        matchMode = mm;
      }

      let priority = 0;
      if (r.priority !== undefined && r.priority !== null && r.priority !== '') {
        if (typeof r.priority !== 'number' || !Number.isSafeInteger(r.priority)) {
          throw new Error(`createRules[${idx}].priority must be an integer`);
        }
        priority = r.priority;
      }

      let enabled = true;
      if (r.enabled !== undefined && r.enabled !== null) {
        if (typeof r.enabled !== 'boolean') {
          throw new Error(`createRules[${idx}].enabled must be a boolean`);
        }
        enabled = r.enabled;
      }

      let timesheetCode: string | null = null;
      if ('timesheetCode' in r && r.timesheetCode !== undefined && r.timesheetCode !== null) {
        if (typeof r.timesheetCode !== 'string') {
          throw new Error(`createRules[${idx}].timesheetCode must be a string or null`);
        }
        timesheetCode = r.timesheetCode.trim().length > 0 ? r.timesheetCode.trim() : null;
      }

      result.createRules.push({
        id,
        name,
        classification: classification as 'work' | 'personal',
        selectorType: selectorType as SelectorType,
        selectorValue,
        matchMode,
        priority,
        enabled,
        timesheetCode
      });
    }
  }

  if (obj.deleteRuleIds !== undefined) {
    if (!Array.isArray(obj.deleteRuleIds)) {
      throw new Error('Manifest deleteRuleIds must be an array');
    }
    const seen = new Set<string>();
    result.deleteRuleIds = [];
    for (const [idx, id] of obj.deleteRuleIds.entries()) {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new Error(`deleteRuleIds[${idx}] must be a non-empty string`);
      }
      const trimmedId = id.trim();
      if (seen.has(trimmedId)) {
        throw new Error(`Duplicate rule ID in deleteRuleIds: '${trimmedId}'`);
      }
      seen.add(trimmedId);
      result.deleteRuleIds.push(trimmedId);
    }
  }

  // Reject any explicit create ID also present in deleteRuleIds
  if (result.createRules && result.deleteRuleIds) {
    const deleteSet = new Set(result.deleteRuleIds);
    for (const cr of result.createRules) {
      if (cr.id && deleteSet.has(cr.id)) {
        throw new Error(`Rule ID '${cr.id}' cannot be present in both createRules and deleteRuleIds`);
      }
    }
  }

  return result;
}

export function preflightTargetConflicts(
  targetDbPath: string,
  manifest: ConsolidationManifest
): void {
  const targetDb = openDatabase({
    path: targetDbPath,
    readonly: true,
    migrate: false,
    wal: false
  });
  try {
    if (manifest.deleteRuleIds && manifest.deleteRuleIds.length > 0) {
      const findRule = targetDb.prepare(
        'SELECT id FROM classification_rules WHERE id = ?'
      );
      for (const id of manifest.deleteRuleIds) {
        const row = findRule.get(id);
        if (!row) {
          throw new Error(
            `Rule '${id}' specified in deleteRuleIds does not exist in target database`
          );
        }
      }
    }

    if (manifest.createRules && manifest.createRules.length > 0) {
      const findRule = targetDb.prepare(
        'SELECT id FROM classification_rules WHERE id = ?'
      );
      for (const rule of manifest.createRules) {
        if (rule.id) {
          const row = findRule.get(rule.id);
          if (row) {
            throw new Error(
              `Rule ID '${rule.id}' specified in createRules already exists in target database`
            );
          }
        }
      }
    }
  } finally {
    targetDb.close();
  }
}

export async function executeConsolidationCli(args: CliArgs): Promise<void> {
  if (!args.dbPath) {
    throw new Error('--db <path> is required. The consolidation CLI never defaults to the live database.');
  }

  if (!args.manifestPath) {
    throw new Error('--manifest <manifest-path> is required.');
  }

  const resolvedDbPath = resolve(args.dbPath);
  if (!existsSync(resolvedDbPath)) {
    throw new Error(`Target database not found at ${resolvedDbPath}`);
  }

  const resolvedManifestPath = resolve(args.manifestPath);
  if (!existsSync(resolvedManifestPath)) {
    throw new Error(`Manifest file not found at ${resolvedManifestPath}`);
  }

  let rawManifest: unknown;
  try {
    const content = readFileSync(resolvedManifestPath, 'utf8');
    rawManifest = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Failed to parse manifest JSON at ${resolvedManifestPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const manifest = validateManifest(rawManifest);
  const createCount = manifest.createRules?.length ?? 0;
  const deleteCount = manifest.deleteRuleIds?.length ?? 0;

  process.stdout.write(`Database: ${resolvedDbPath}\n`);
  process.stdout.write(`Manifest: ${resolvedManifestPath}\n`);
  process.stdout.write(
    `Operations: ${createCount} rule(s) to create, ${deleteCount} rule(s) to retire\n`
  );

  // Preflight target-dependent conflicts read-only BEFORE any backup or migration in BOTH dry-run and apply
  preflightTargetConflicts(resolvedDbPath, manifest);

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
    throw new Error('--apply requires --backup <path> to be specified.');
  }

  const resolvedBackupPath = resolve(args.backupPath);
  if (existsSync(resolvedBackupPath)) {
    throw new Error(`Backup file already exists at ${resolvedBackupPath}. Refusing to overwrite.`);
  }

  process.stdout.write(`Creating pre-apply backup at ${resolvedBackupPath}...\n`);
  // Open source read-only WITHOUT migrating so the backup captures genuine pre-apply state
  const sourceDb = openDatabase({ path: resolvedDbPath, readonly: true, migrate: false, wal: false });
  try {
    await sourceDb.backup(resolvedBackupPath);
    process.stdout.write('Pre-apply backup created successfully.\n');
  } finally {
    sourceDb.close();
  }

  // Verify backup integrity
  process.stdout.write('Verifying backup database integrity...\n');
  const backupDb = openDatabase({ path: resolvedBackupPath, readonly: true, migrate: false, wal: false });
  try {
    const integrityRows = backupDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (!integrityRows.length || integrityRows[0].integrity_check !== 'ok') {
      throw new Error(`Backup integrity check failed: ${JSON.stringify(integrityRows)}`);
    }
    process.stdout.write('Backup database integrity verified: OK\n');
  } finally {
    backupDb.close();
  }

  process.stdout.write('Opening target database and running pending migrations...\n');
  const targetDb = openDatabase({ path: resolvedDbPath, migrate: true });
  try {
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

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  await executeConsolidationCli(args);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    process.stderr.write(`Consolidation failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
