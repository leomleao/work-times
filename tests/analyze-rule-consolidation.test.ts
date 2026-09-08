import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  parseAnalysisArguments,
  runRuleConsolidationAnalysis,
  executeAnalysisCli
} from '../scripts/analyze-rule-consolidation.js';
import { openDatabase, openTestDatabase } from '../src/lib/server/db/connection.js';
import { importDumps } from '../src/lib/server/import/importer.js';
import { SqliteClassificationService } from '../src/lib/server/classification/sqlite.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const DAILY = join(FIXTURES, 'synthetic-daily.json');
const HEARTBEATS = join(FIXTURES, 'synthetic-heartbeats.json');

function computeFileSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('Analyze Rule Consolidation CLI (scripts/analyze-rule-consolidation.ts)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'work-times-analyze-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('parseAnalysisArguments', () => {
    it('parses valid command-line flags correctly', () => {
      const args = parseAnalysisArguments([
        '--db', 'test.sqlite',
        '--manifest', 'manifest.json',
        '--out', 'out.json',
        '--json'
      ]);
      expect(args.dbPath).toBe('test.sqlite');
      expect(args.manifestPath).toBe('manifest.json');
      expect(args.outPath).toBe('out.json');
      expect(args.json).toBe(true);
    });

    it('rejects missing flag values and unknown arguments', () => {
      expect(() => parseAnalysisArguments(['--db'])).toThrow('--db requires a database path');
      expect(() => parseAnalysisArguments(['--manifest'])).toThrow('--manifest requires a manifest path');
      expect(() => parseAnalysisArguments(['--out'])).toThrow('--out requires an output path');
      expect(() => parseAnalysisArguments(['--unknown'])).toThrow('Unknown argument: --unknown');
    });
  });

  describe('runRuleConsolidationAnalysis', () => {
    it('analyzes impact accurately, populates minDate/maxDate, and preserves database read-only hash stability', async () => {
      const dbPath = join(tempDir, 'target.sqlite');
      const db = openDatabase({ path: dbPath, migrate: true, wal: false });
      await importDumps(db, { dailyDumpPath: DAILY, heartbeatDumpPath: HEARTBEATS });
      const service = new SqliteClassificationService(db);

      const r1 = service.unsafeSeedRule({
        name: 'Work Alpha Project',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'alpha',
        matchMode: 'exact'
      });

      const r2 = service.unsafeSeedRule({
        name: 'Personal Beta Project',
        classification: 'personal',
        selectorType: 'project',
        selectorValue: 'beta',
        matchMode: 'exact'
      });
      db.close();

      const shaBefore = computeFileSha256(dbPath);

      const manifest = {
        deleteRuleIds: [r1.rule.id],
        createRules: [
          {
            name: 'Consolidated Work Glob Rule',
            classification: 'work' as const,
            selectorType: 'project' as const,
            selectorValue: 'alp*',
            matchMode: 'glob' as const,
            priority: 0
          }
        ]
      };

      const result = runRuleConsolidationAnalysis(dbPath, manifest);

      expect(result.totalSlices).toBeGreaterThan(0);
      expect(result.safetyGatePassed).toBe(true);
      expect(result.hardGatePassed).toBe(true);
      expect(result.polarityFlipsCount).toBe(0);
      expect(result.unclassifiedRegressionsCount).toBe(0);
      expect(result.ambiguityTransitionsCount).toBe(0);
      expect(result.baseline.ruleCount).toBe(2);
      expect(result.proposed.ruleCount).toBe(2);
      expect(result.proposed.retiredCount).toBe(1);
      expect(result.proposed.createdCount).toBe(1);

      // Verify minDate and maxDate on every transition aggregate
      for (const trans of Object.values(result.transitions)) {
        expect(trans.minDate).toBeDefined();
        expect(trans.maxDate).toBeDefined();
        expect(trans.minDate.length).toBe(10);
        expect(trans.maxDate.length).toBe(10);
        expect(trans.minDate <= trans.maxDate).toBe(true);
      }

      // Verify zero file mutations
      const shaAfter = computeFileSha256(dbPath);
      expect(shaAfter).toBe(shaBefore);
    });

    it('detects work-to-personal polarity flips and fails the safety gate', async () => {
      const dbPath = join(tempDir, 'flip-test.sqlite');
      const db = openDatabase({ path: dbPath, migrate: true, wal: false });
      await importDumps(db, { dailyDumpPath: DAILY, heartbeatDumpPath: HEARTBEATS });
      const service = new SqliteClassificationService(db);

      const workRule = service.unsafeSeedRule({
        name: 'Work Alpha Project',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'alpha',
        matchMode: 'exact'
      });
      db.close();

      // Manifest that retires work rule and creates an overlapping personal glob rule
      const flipManifest = {
        deleteRuleIds: [workRule.rule.id],
        createRules: [
          {
            name: 'Personal Glob Overlap',
            classification: 'personal' as const,
            selectorType: 'project' as const,
            selectorValue: 'al*',
            matchMode: 'glob' as const,
            priority: 0
          }
        ]
      };

      const result = runRuleConsolidationAnalysis(dbPath, flipManifest);

      expect(result.safetyGatePassed).toBe(false);
      expect(result.hardGatePassed).toBe(false);
      expect(result.polarityFlipsCount).toBeGreaterThan(0);
      expect(result.polarityFlips[0].from).toBe('work');
      expect(result.polarityFlips[0].to).toBe('personal');
    });

    it('detects classified-to-unclassified regressions and fails the safety gate', async () => {
      const dbPath = join(tempDir, 'regression-test.sqlite');
      const db = openDatabase({ path: dbPath, migrate: true, wal: false });
      await importDumps(db, { dailyDumpPath: DAILY, heartbeatDumpPath: HEARTBEATS });
      const service = new SqliteClassificationService(db);

      const workRule = service.unsafeSeedRule({
        name: 'Work Alpha Project',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'alpha',
        matchMode: 'exact'
      });
      db.close();

      // Manifest that retires work rule without replacement, causing work slices to become unclassified
      const regressionManifest = {
        deleteRuleIds: [workRule.rule.id]
      };

      const result = runRuleConsolidationAnalysis(dbPath, regressionManifest);

      expect(result.safetyGatePassed).toBe(false);
      expect(result.unclassifiedRegressionsCount).toBeGreaterThan(0);
      expect(result.unclassifiedRegressions[0].from).toBe('work');
      expect(result.unclassifiedRegressions[0].to).toBe('unclassified');
    });

    it('detects transitions into ambiguity and fails the safety gate', async () => {
      const dbPath = join(tempDir, 'ambiguity-test.sqlite');
      const db = openDatabase({ path: dbPath, migrate: true, wal: false });
      await importDumps(db, { dailyDumpPath: DAILY, heartbeatDumpPath: HEARTBEATS });
      const service = new SqliteClassificationService(db);

      service.unsafeSeedRule({
        name: 'Work Alpha Project',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'alpha',
        matchMode: 'exact',
        priority: 0
      });
      db.close();

      // Manifest that adds a conflicting personal rule on same project with same priority
      const ambiguityManifest = {
        createRules: [
          {
            name: 'Conflicting Personal Alpha Rule',
            classification: 'personal' as const,
            selectorType: 'project' as const,
            selectorValue: 'alpha',
            matchMode: 'exact' as const,
            priority: 0
          }
        ]
      };

      const result = runRuleConsolidationAnalysis(dbPath, ambiguityManifest);

      expect(result.safetyGatePassed).toBe(false);
      expect(result.ambiguityTransitionsCount).toBeGreaterThan(0);
      expect(result.ambiguityTransitions[0].toSource).toBe('ambiguous');
    });

    it('proves an enabled: false created rule does not affect classifications', async () => {
      const dbPath = join(tempDir, 'disabled-rule-test.sqlite');
      const db = openDatabase({ path: dbPath, migrate: true, wal: false });
      await importDumps(db, { dailyDumpPath: DAILY, heartbeatDumpPath: HEARTBEATS });
      const service = new SqliteClassificationService(db);

      const workRule = service.unsafeSeedRule({
        name: 'Work Alpha Project',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'alpha',
        matchMode: 'exact'
      });
      db.close();

      // Create a proposed personal rule targeting 'alpha' with higher priority, but enabled: false
      const disabledRuleManifest = {
        createRules: [
          {
            name: 'Disabled Personal Override Rule',
            classification: 'personal' as const,
            selectorType: 'project' as const,
            selectorValue: 'alpha',
            matchMode: 'exact' as const,
            priority: 100,
            enabled: false
          }
        ]
      };

      const result = runRuleConsolidationAnalysis(dbPath, disabledRuleManifest);

      // Since the rule is enabled: false, it must NOT match or flip work slices to personal
      expect(result.safetyGatePassed).toBe(true);
      expect(result.polarityFlipsCount).toBe(0);
      expect(result.proposed.workSlices).toBe(result.baseline.workSlices);
      expect(result.proposed.personalSlices).toBe(result.baseline.personalSlices);
    });

    it('rejects explicit create rule IDs that already exist in the target database', async () => {
      const dbPath = join(tempDir, 'dup-create-id.sqlite');
      const db = openDatabase({ path: dbPath, migrate: true, wal: false });
      const service = new SqliteClassificationService(db);

      const existing = service.unsafeSeedRule({
        name: 'Existing Rule',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'existing-proj',
        matchMode: 'exact'
      });
      db.close();

      const manifest = {
        createRules: [
          {
            id: existing.rule.id,
            name: 'Duplicate ID Create Rule',
            classification: 'work' as const,
            selectorType: 'project' as const,
            selectorValue: 'some-other-proj',
            matchMode: 'exact' as const
          }
        ]
      };

      expect(() => runRuleConsolidationAnalysis(dbPath, manifest)).toThrow(
        `Rule ID '${existing.rule.id}' specified in createRules already exists in target database`
      );
    });

    it('rejects manifests specifying non-existent deleteRuleIds', async () => {
      const dbPath = join(tempDir, 'missing-id.sqlite');
      const db = openDatabase({ path: dbPath, migrate: true, wal: false });
      db.close();

      const manifest = {
        deleteRuleIds: ['non-existent-rule-id']
      };

      expect(() => runRuleConsolidationAnalysis(dbPath, manifest)).toThrow(
        "Rule 'non-existent-rule-id' specified in deleteRuleIds does not exist in target database"
      );
    });
  });

  describe('executeAnalysisCli', () => {
    it('runs end-to-end and writes JSON output to --out', async () => {
      const dbPath = join(tempDir, 'cli-exec.sqlite');
      const db = openDatabase({ path: dbPath, migrate: true, wal: false });
      await importDumps(db, { dailyDumpPath: DAILY, heartbeatDumpPath: HEARTBEATS });
      const service = new SqliteClassificationService(db);

      const r = service.unsafeSeedRule({
        name: 'Work Rule',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'proj-1',
        matchMode: 'exact'
      });
      db.close();

      const manifestPath = join(tempDir, 'manifest.json');
      const outPath = join(tempDir, 'analysis-out.json');

      writeFileSync(
        manifestPath,
        JSON.stringify({
          deleteRuleIds: [r.rule.id],
          createRules: [
            {
              name: 'New Work Rule',
              classification: 'work',
              selectorType: 'project',
              selectorValue: 'proj-*',
              matchMode: 'glob',
              priority: 0
            }
          ]
        }),
        'utf8'
      );

      const exitCode = await executeAnalysisCli([
        '--db', dbPath,
        '--manifest', manifestPath,
        '--out', outPath,
        '--json'
      ]);

      expect(exitCode).toBe(0);
      expect(existsSync(outPath)).toBe(true);

      const parsedOut = JSON.parse(readFileSync(outPath, 'utf8'));
      expect(parsedOut.safetyGatePassed).toBe(true);
      expect(parsedOut.hardGatePassed).toBe(true);
      expect(parsedOut.totalSlices).toBeGreaterThan(0);
    });

    it('returns exit code 1 when safety gate fails due to regression', async () => {
      const dbPath = join(tempDir, 'cli-fail.sqlite');
      const db = openDatabase({ path: dbPath, migrate: true, wal: false });
      await importDumps(db, { dailyDumpPath: DAILY, heartbeatDumpPath: HEARTBEATS });
      const service = new SqliteClassificationService(db);

      const r = service.unsafeSeedRule({
        name: 'Work Rule',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'alpha',
        matchMode: 'exact'
      });
      db.close();

      const manifestPath = join(tempDir, 'manifest-flip.json');

      writeFileSync(
        manifestPath,
        JSON.stringify({
          deleteRuleIds: [r.rule.id],
          createRules: [
            {
              name: 'Conflicting Personal Rule',
              classification: 'personal',
              selectorType: 'project',
              selectorValue: 'alpha',
              matchMode: 'exact',
              priority: 0
            }
          ]
        }),
        'utf8'
      );

      const exitCode = await executeAnalysisCli([
        '--db', dbPath,
        '--manifest', manifestPath,
        '--json'
      ]);

      expect(exitCode).toBe(1);
    });
  });
});
