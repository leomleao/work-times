import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import {
  validateManifest,
  executeConsolidationCli,
  parseArguments
} from '../scripts/consolidate-rules.js';
import { openDatabase } from '../src/lib/server/db/connection.js';

function computeFileSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('Consolidate Rules CLI (scripts/consolidate-rules.ts)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'work-times-cli-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('parseArguments', () => {
    it('parses valid command-line flags correctly', () => {
      const args = parseArguments([
        '--db', 'test.sqlite',
        '--manifest', 'manifest.json',
        '--apply',
        '--backup', 'backup.sqlite'
      ]);
      expect(args.dbPath).toBe('test.sqlite');
      expect(args.manifestPath).toBe('manifest.json');
      expect(args.apply).toBe(true);
      expect(args.backupPath).toBe('backup.sqlite');
    });

    it('rejects missing flag values and unknown arguments', () => {
      expect(() => parseArguments(['--db'])).toThrow('--db requires a database path');
      expect(() => parseArguments(['--manifest'])).toThrow('--manifest requires a manifest path');
      expect(() => parseArguments(['--backup'])).toThrow('--backup requires a backup path');
      expect(() => parseArguments(['--unknown'])).toThrow('Unknown argument: --unknown');
    });
  });

  describe('validateManifest', () => {
    it('rejects invalid JSON shapes (non-object, array, null)', () => {
      expect(() => validateManifest(null)).toThrow('Manifest must be a JSON object');
      expect(() => validateManifest('string')).toThrow('Manifest must be a JSON object');
      expect(() => validateManifest([1, 2, 3])).toThrow('Manifest must be a JSON object');
    });

    it('rejects manifests without createRules or deleteRuleIds, or with empty arrays', () => {
      expect(() => validateManifest({})).toThrow(
        'Manifest must contain non-empty createRules or deleteRuleIds'
      );
      expect(() => validateManifest({ createRules: [], deleteRuleIds: [] })).toThrow(
        'Manifest must contain non-empty createRules or deleteRuleIds'
      );
    });

    it('rejects duplicate rule IDs in deleteRuleIds', () => {
      expect(() =>
        validateManifest({
          deleteRuleIds: ['rule-1', 'rule-2', 'rule-1']
        })
      ).toThrow("Duplicate rule ID in deleteRuleIds: 'rule-1'");
    });

    it('rejects empty strings in deleteRuleIds', () => {
      expect(() =>
        validateManifest({
          deleteRuleIds: ['rule-1', '   ']
        })
      ).toThrow('deleteRuleIds[1] must be a non-empty string');
    });

    it('rejects pattern length exceeding MAX_PATTERN_LENGTH (500)', () => {
      const longPattern = 'a'.repeat(501);
      expect(() =>
        validateManifest({
          createRules: [
            {
              name: 'Long Pattern Rule',
              classification: 'work',
              selectorType: 'folder_prefix',
              selectorValue: longPattern
            }
          ]
        })
      ).toThrow('exceeds limit of 500');
    });

    it('rejects invalid classification, selectorType, or matchMode', () => {
      expect(() =>
        validateManifest({
          createRules: [
            {
              name: 'Invalid Classification',
              classification: 'unknown' as any,
              selectorType: 'project',
              selectorValue: 'proj'
            }
          ]
        })
      ).toThrow("classification must be 'work' or 'personal'");

      expect(() =>
        validateManifest({
          createRules: [
            {
              name: 'Invalid Selector',
              classification: 'work',
              selectorType: 'invalid_selector' as any,
              selectorValue: 'val'
            }
          ]
        })
      ).toThrow("selectorType 'invalid_selector' is invalid");

      expect(() =>
        validateManifest({
          createRules: [
            {
              name: 'Invalid Match Mode',
              classification: 'work',
              selectorType: 'project',
              selectorValue: 'val',
              matchMode: 'regex' as any
            }
          ]
        })
      ).toThrow("matchMode must be 'exact' or 'glob'");
    });

    it('accepts and normalizes valid manifests with createRules and deleteRuleIds', () => {
      const parsed = validateManifest({
        createRules: [
          {
            name: '  Valid Glob Rule  ',
            classification: 'work',
            selectorType: 'folder_prefix',
            selectorValue: '/code/*/src',
            matchMode: 'glob',
            priority: 50
          }
        ],
        deleteRuleIds: [' rule-delete-1 ', 'rule-delete-2']
      });

      expect(parsed.createRules).toHaveLength(1);
      expect(parsed.createRules![0].name).toBe('Valid Glob Rule');
      expect(parsed.createRules![0].matchMode).toBe('glob');
      expect(parsed.createRules![0].priority).toBe(50);
      expect(parsed.deleteRuleIds).toEqual(['rule-delete-1', 'rule-delete-2']);
    });
  });

  describe('Dry-Run Execution', () => {
    it('runs preview without writing, keeping target DB SHA-256 unchanged', async () => {
      const dbPath = join(tempDir, 'dryrun.sqlite');
      const manifestPath = join(tempDir, 'manifest.json');

      // Setup a test database with an existing rule
      const db = openDatabase({ path: dbPath, migrate: true });
      db.prepare(
        `INSERT INTO classification_rules (id, name, classification, selector_type, selector_value, match_mode, priority, enabled)
         VALUES ('existing-rule-1', 'Old Rule', 'work', 'project', 'old-proj', 'exact', 0, 1)`
      ).run();
      db.close();

      const initialHash = computeFileSha256(dbPath);

      const manifestContent = JSON.stringify({
        createRules: [
          {
            name: 'New Glob Rule',
            classification: 'personal',
            selectorType: 'folder_prefix',
            selectorValue: '*/personal/*',
            matchMode: 'glob'
          }
        ],
        deleteRuleIds: ['existing-rule-1']
      });
      writeFileSync(manifestPath, manifestContent, 'utf8');

      await executeConsolidationCli({
        dbPath,
        manifestPath,
        apply: false,
        backupPath: null
      });

      // Target database must not have been modified
      const postHash = computeFileSha256(dbPath);
      expect(postHash).toBe(initialHash);

      // Verify records are unchanged
      const verifyDb = openDatabase({ path: dbPath, readonly: true, migrate: false });
      const rule = verifyDb.prepare('SELECT id FROM classification_rules WHERE id = ?').get('existing-rule-1');
      expect(rule).toBeDefined();
      const newRule = verifyDb.prepare("SELECT id FROM classification_rules WHERE selector_value = '*/personal/*'").get();
      expect(newRule).toBeUndefined();
      verifyDb.close();
    });

    it('fails dry-run when a deleteRuleIds rule does not exist in target database', async () => {
      const dbPath = join(tempDir, 'dryrun-missing.sqlite');
      const manifestPath = join(tempDir, 'manifest.json');

      const db = openDatabase({ path: dbPath, migrate: true });
      db.close();

      const manifestContent = JSON.stringify({
        deleteRuleIds: ['non-existent-rule-id']
      });
      writeFileSync(manifestPath, manifestContent, 'utf8');

      await expect(
        executeConsolidationCli({
          dbPath,
          manifestPath,
          apply: false,
          backupPath: null
        })
      ).rejects.toThrow("Rule 'non-existent-rule-id' specified in deleteRuleIds does not exist in target database");
    });
  });

  describe('Apply Execution & Pre-Migration-004 Backup Isolation', () => {
    it('creates pre-apply backup at migration 003, advances target to 004, and applies consolidation', async () => {
      const dbPath = join(tempDir, 'apply-target.sqlite');
      const backupPath = join(tempDir, 'pre-apply-backup.sqlite');
      const manifestPath = join(tempDir, 'manifest.json');

      // 1. Scaffold a migration folder with ONLY migrations 001, 002, 003 (pre-004)
      const pre004MigrationsDir = join(tempDir, 'pre004-migrations');
      mkdirSync(pre004MigrationsDir, { recursive: true });
      const repoMigrationsDir = join(process.cwd(), 'migrations');

      copyFileSync(
        join(repoMigrationsDir, '001-import-schema.sql'),
        join(pre004MigrationsDir, '001-import-schema.sql')
      );
      copyFileSync(
        join(repoMigrationsDir, '002-application-state.sql'),
        join(pre004MigrationsDir, '002-application-state.sql')
      );
      copyFileSync(
        join(repoMigrationsDir, '003-wakatime-oauth.sql'),
        join(pre004MigrationsDir, '003-wakatime-oauth.sql')
      );

      // 2. Open database with migrationsDir = pre004MigrationsDir
      const preDb = openDatabase({
        path: dbPath,
        migrate: true,
        migrationsDir: pre004MigrationsDir
      });

      // Verify migration 003 is the latest applied migration
      const initialMigrations = preDb
        .prepare('SELECT filename FROM schema_migrations ORDER BY filename ASC')
        .all() as Array<{ filename: string }>;
      expect(initialMigrations.map((m) => m.filename)).toEqual([
        '001-import-schema.sql',
        '002-application-state.sql',
        '003-wakatime-oauth.sql'
      ]);

      // Seed a rule to delete (in schema 002/003, classification_rules did not have match_mode yet)
      preDb.prepare(
        `INSERT INTO classification_rules (id, name, classification, selector_type, selector_value, priority, enabled)
         VALUES ('rule-to-retire', 'Retiring Rule', 'work', 'project', 'old-project', 0, 1)`
      ).run();
      preDb.close();

      // 3. Prepare consolidation manifest with create and delete
      const manifestContent = JSON.stringify({
        createRules: [
          {
            id: 'rule-new-glob',
            name: 'Consolidated Wildcard Rule',
            classification: 'personal',
            selectorType: 'folder_prefix',
            selectorValue: '*/u081715/*',
            matchMode: 'glob',
            priority: 10
          }
        ],
        deleteRuleIds: ['rule-to-retire']
      });
      writeFileSync(manifestPath, manifestContent, 'utf8');

      // 4. Run CLI with --apply --backup
      await executeConsolidationCli({
        dbPath,
        manifestPath,
        apply: true,
        backupPath
      });

      // 5. Verify BACKUP database:
      // - Backup file exists
      expect(existsSync(backupPath)).toBe(true);

      // - Backup database integrity check passes
      const backupDb = openDatabase({ path: backupPath, readonly: true, migrate: false });
      const backupIntegrity = backupDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
      expect(backupIntegrity[0].integrity_check).toBe('ok');

      // - Backup remains strictly at migration 003 (pre-004)
      const backupMigrations = backupDb
        .prepare('SELECT filename FROM schema_migrations ORDER BY filename ASC')
        .all() as Array<{ filename: string }>;
      expect(backupMigrations.map((m) => m.filename)).toEqual([
        '001-import-schema.sql',
        '002-application-state.sql',
        '003-wakatime-oauth.sql'
      ]);

      // - Retiring rule still exists in backup
      const retiringRuleInBackup = backupDb
        .prepare('SELECT id, name FROM classification_rules WHERE id = ?')
        .get('rule-to-retire');
      expect(retiringRuleInBackup).toBeDefined();

      // - Table schema in backup does not have match_mode column
      const backupCols = backupDb
        .prepare("PRAGMA table_info('classification_rules')")
        .all() as Array<{ name: string }>;
      expect(backupCols.some((c) => c.name === 'match_mode')).toBe(false);
      backupDb.close();

      // 6. Verify TARGET database:
      // - Target database advanced to migration 004
      const targetDb = openDatabase({ path: dbPath, readonly: true, migrate: false });
      const targetMigrations = targetDb
        .prepare('SELECT filename FROM schema_migrations ORDER BY filename ASC')
        .all() as Array<{ filename: string }>;
      expect(targetMigrations.map((m) => m.filename)).toEqual([
        '001-import-schema.sql',
        '002-application-state.sql',
        '003-wakatime-oauth.sql',
        '004-classification-rules-match-mode.sql'
      ]);

      // - Target has match_mode column
      const targetCols = targetDb
        .prepare("PRAGMA table_info('classification_rules')")
        .all() as Array<{ name: string }>;
      expect(targetCols.some((c) => c.name === 'match_mode')).toBe(true);

      // - Old rule was deleted
      const retiredRule = targetDb
        .prepare('SELECT id FROM classification_rules WHERE id = ?')
        .get('rule-to-retire');
      expect(retiredRule).toBeUndefined();

      // - New wildcard rule was created
      const newRule = targetDb
        .prepare('SELECT id, name, classification, selector_type, selector_value, match_mode, priority FROM classification_rules WHERE id = ?')
        .get('rule-new-glob') as any;
      expect(newRule).toBeDefined();
      expect(newRule.name).toBe('Consolidated Wildcard Rule');
      expect(newRule.classification).toBe('personal');
      expect(newRule.match_mode).toBe('glob');
      expect(newRule.selector_value).toBe('*/u081715/*');
      expect(newRule.priority).toBe(10);

      // - Audit revisions were recorded
      const revisions = targetDb
        .prepare('SELECT id, target_id, mutation_type FROM classification_revisions WHERE target_id IN (?, ?)')
        .all('rule-to-retire', 'rule-new-glob') as Array<{ id: number; target_id: string; mutation_type: string }>;
      expect(revisions.some((r) => r.target_id === 'rule-to-retire' && r.mutation_type === 'rule_deleted')).toBe(true);
      expect(revisions.some((r) => r.target_id === 'rule-new-glob' && r.mutation_type === 'rule_created')).toBe(true);

      targetDb.close();
    });

    it('refuses to overwrite an existing backup file', async () => {
      const dbPath = join(tempDir, 'overwrite-target.sqlite');
      const backupPath = join(tempDir, 'existing-backup.sqlite');
      const manifestPath = join(tempDir, 'manifest.json');

      const db = openDatabase({ path: dbPath, migrate: true });
      db.close();

      writeFileSync(backupPath, 'pre-existing content', 'utf8');
      writeFileSync(
        manifestPath,
        JSON.stringify({ createRules: [{ name: 'A', classification: 'work', selectorType: 'project', selectorValue: 'a' }] }),
        'utf8'
      );

      await expect(
        executeConsolidationCli({
          dbPath,
          manifestPath,
          apply: true,
          backupPath
        })
      ).rejects.toThrow(`Backup file already exists at ${backupPath}. Refusing to overwrite.`);
    });
  });
});
