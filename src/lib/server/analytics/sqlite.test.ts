import type Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase } from '../db/connection.js';
import { importDumps } from '../import/importer.js';
import { SqliteClassificationService } from '../classification/sqlite.js';
import { SqliteWorkOnlyAnalytics } from './sqlite.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../tests/fixtures');
const DAILY = join(FIXTURES, 'synthetic-daily.json');
const HEARTBEATS = join(FIXTURES, 'synthetic-heartbeats.json');

describe('SqliteWorkOnlyAnalytics - Invariants and Totals', () => {
  let db: Database.Database;
  let classification: SqliteClassificationService;
  let analytics: SqliteWorkOnlyAnalytics;

  beforeEach(async () => {
    db = openTestDatabase();
    classification = new SqliteClassificationService(db);
    analytics = new SqliteWorkOnlyAnalytics(db, classification);

    await importDumps(db, {
      dailyDumpPath: DAILY,
      heartbeatDumpPath: HEARTBEATS
    });
  });

  it('proves work + personal + unclassified equals daily_totals across all days', () => {
    classification.unsafeSeedRule({
      name: 'Alpha is Work',
      classification: 'work',
      selectorType: 'project',
      selectorValue: 'alpha'
    });

    classification.unsafeSeedRule({
      name: 'Bravo is Personal',
      classification: 'personal',
      selectorType: 'project',
      selectorValue: 'bravo'
    });

    const days = db
      .prepare('SELECT date, total_seconds FROM daily_totals ORDER BY date ASC')
      .all() as Array<{ date: string; total_seconds: number }>;

    expect(days.length).toBeGreaterThan(0);

    for (const day of days) {
      const inv = analytics.getDailyClassificationTotal(day.date);
      expect(inv.isEqual).toBe(true);
      expect(inv.diff).toBeLessThan(0.001);

      const sum = inv.workSeconds + inv.personalSeconds + inv.unclassifiedSeconds;
      expect(Math.abs(sum - day.total_seconds)).toBeLessThan(0.001);
    }
  });

  it('computes range summary with mutually exclusive slices and aggregate unclassified warnings', async () => {
    classification.unsafeSeedRule({
      name: 'Alpha Work',
      classification: 'work',
      selectorType: 'project',
      selectorValue: 'alpha'
    });

    classification.unsafeSeedRule({
      name: 'Bravo Personal',
      classification: 'personal',
      selectorType: 'project',
      selectorValue: 'bravo'
    });

    const summary = await analytics.getRangeSummary({
      start: '2026-01-01',
      end: '2026-01-07'
    });

    expect(summary.start).toBe('2026-01-01');
    expect(summary.end).toBe('2026-01-07');
    expect(summary.workSeconds).toBeGreaterThan(0);
    expect(summary.unclassifiedSeconds).toBeGreaterThan(0);
    expect(summary.hasUnclassified).toBe(true);
    expect(summary.days).toHaveLength(7);

    // Only work project 'alpha' should appear; 'bravo' must NOT appear
    for (const d of summary.days) {
      for (const p of d.projects) {
        expect(p.project).toBe('alpha');
        expect(p.project).not.toBe('bravo');
      }
    }
  });

  it('bounds range queries to a sane maximum and rejects ranges > 366 days', async () => {
    await expect(
      analytics.getRangeSummary({
        start: '2025-01-01',
        end: '2026-01-10' // 375 days
      })
    ).rejects.toThrow(/exceeds maximum allowed range/);
  });

  it('rejects invalid dates in analytics queries', async () => {
    // Non-existent leap day in non-leap year
    await expect(
      analytics.getRangeSummary({
        start: '2025-02-29',
        end: '2025-03-01'
      })
    ).rejects.toThrow(/Invalid date/);

    // Out of range month
    await expect(
      analytics.getDayEvidence({
        date: '2026-13-01'
      })
    ).rejects.toThrow(/Invalid date/);

    // Malformed string
    expect(() => {
      analytics.getDailyClassificationTotal('not-a-date');
    }).toThrow(/Invalid date/);
  });
});

describe('SqliteWorkOnlyAnalytics - Leakage Prevention for Category/Language Breakdowns', () => {
  let db: Database.Database;
  let classification: SqliteClassificationService;
  let analytics: SqliteWorkOnlyAnalytics;

  beforeEach(() => {
    db = openTestDatabase();
    classification = new SqliteClassificationService(db);
    analytics = new SqliteWorkOnlyAnalytics(db, classification);

    db.prepare(`INSERT INTO projects (id, name) VALUES (301, 'mixed-proj'), (302, 'pure-work-proj')`).run();
    db.prepare(
      `INSERT INTO source_imports (id, source_type, source_hash, byte_size)
       VALUES (1, 'daily_dump', 'h', 1)`
    ).run();

    // 1. Pure work project has 1 slice on 2026-02-01 (100% work)
    db.prepare(
      `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, source_import_id)
       VALUES (1, '2026-02-01', 302, 'src/pure.ts', 'file', 3600, 1)`
    ).run();

    // 2. Mixed project has 2 slices on 2026-02-01: one work, one personal
    db.prepare(
      `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, source_import_id)
       VALUES (2, '2026-02-01', 301, 'src/work.ts', 'file', 2000, 1),
              (3, '2026-02-01', 301, 'src/personal.ts', 'file', 1000, 1)`
    ).run();

    // Add dimension totals for both projects
    db.prepare(
      `INSERT INTO daily_dimension_totals (date, scope, project_id, dimension, name, total_seconds, source_import_id)
       VALUES ('2026-02-01', 'project', 302, 'category', 'Coding', 3600, 1),
              ('2026-02-01', 'project', 302, 'language', 'TypeScript', 3600, 1),
              ('2026-02-01', 'project', 301, 'category', 'Coding', 3000, 1),
              ('2026-02-01', 'project', 301, 'language', 'TypeScript', 3000, 1)`
    ).run();

    // Classify slices
    classification.unsafeSeedRule({
      name: 'Pure Work Rule',
      classification: 'work',
      selectorType: 'project',
      selectorValue: 'pure-work-proj'
    });

    classification.unsafeSeedRule({
      name: 'Mixed Work Slice',
      classification: 'work',
      selectorType: 'entity',
      selectorValue: 'src/work.ts'
    });

    classification.unsafeSeedRule({
      name: 'Mixed Personal Slice',
      classification: 'personal',
      selectorType: 'entity',
      selectorValue: 'src/personal.ts'
    });
  });

  it('returns category/language breakdowns for fully-work project-days', async () => {
    const evidence = await analytics.getDayEvidence({
      date: '2026-02-01',
      project: 'pure-work-proj'
    });

    expect(evidence.projects).toHaveLength(1);
    const p = evidence.projects[0];
    expect(p.project).toBe('pure-work-proj');
    expect(p.seconds).toBe(3600);
    expect(p.categories).toEqual([{ name: 'Coding', seconds: 3600 }]);
    expect(p.languages).toEqual([{ name: 'TypeScript', seconds: 3600 }]);
  });

  it('omits category/language breakdowns for partially-work project-days to prevent leakage', async () => {
    const evidence = await analytics.getDayEvidence({
      date: '2026-02-01',
      project: 'mixed-proj'
    });

    expect(evidence.projects).toHaveLength(1);
    const p = evidence.projects[0];
    expect(p.project).toBe('mixed-proj');
    expect(p.seconds).toBe(2000);
    expect(p.categories).toEqual([]);
    expect(p.languages).toEqual([]);
  });
});

describe('SqliteWorkOnlyAnalytics - Sentinel Privacy Tests', () => {
  let db: Database.Database;
  let classification: SqliteClassificationService;
  let analytics: SqliteWorkOnlyAnalytics;

  const SENTINELS = {
    personalProject: 'sentinel-personal-secret-project',
    personalEntity: '/vault/personal/confidential-tax-return.pdf',
    personalApp: 'SentinelPersonalBankingApp',
    unclassifiedProject: 'sentinel-unclassified-hidden-venture',
    unclassifiedEntity: '/tmp/sentinel-unclassified-scratch.md',
    workProject: 'public-work-verified-project',
    workEntity: '/src/public/index.ts'
  };

  beforeEach(() => {
    db = openTestDatabase();
    classification = new SqliteClassificationService(db);
    analytics = new SqliteWorkOnlyAnalytics(db, classification);

    db.prepare(
      `INSERT INTO projects (id, name) VALUES
        (401, ?),
        (402, ?),
        (403, ?)`
    ).run(SENTINELS.workProject, SENTINELS.personalProject, SENTINELS.unclassifiedProject);

    db.prepare(
      `INSERT INTO source_imports (id, source_type, source_hash, byte_size)
       VALUES (1, 'daily_dump', 'h', 1)`
    ).run();

    // 1. Work slice
    db.prepare(
      `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, source_import_id)
       VALUES (1, '2026-03-01', 401, ?, 'file', 3600, 1)`
    ).run(SENTINELS.workEntity);

    // 2. Personal slice
    db.prepare(
      `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, source_import_id)
       VALUES (2, '2026-03-01', 402, ?, 'file', 1800, 1)`
    ).run(SENTINELS.personalEntity);

    // 3. Unclassified slice
    db.prepare(
      `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, source_import_id)
       VALUES (3, '2026-03-01', 403, ?, 'file', 900, 1)`
    ).run(SENTINELS.unclassifiedEntity);

    // Rules via unsafe seed
    classification.unsafeSeedRule({
      name: 'Classify Work Sentinel',
      classification: 'work',
      selectorType: 'project',
      selectorValue: SENTINELS.workProject
    });

    classification.unsafeSeedRule({
      name: 'Classify Personal Sentinel',
      classification: 'personal',
      selectorType: 'project',
      selectorValue: SENTINELS.personalProject
    });
  });

  it('ensures no personal or unclassified identities appear in serialized range summary', async () => {
    const summary = await analytics.getRangeSummary({
      start: '2026-03-01',
      end: '2026-03-01'
    });

    const serialized = JSON.stringify(summary);

    expect(serialized).toContain(SENTINELS.workProject);

    expect(serialized).not.toContain(SENTINELS.personalProject);
    expect(serialized).not.toContain(SENTINELS.personalEntity);
    expect(serialized).not.toContain(SENTINELS.personalApp);
    expect(serialized).not.toContain(SENTINELS.unclassifiedProject);
    expect(serialized).not.toContain(SENTINELS.unclassifiedEntity);
    expect(serialized).not.toContain('sentinel-personal');
    expect(serialized).not.toContain('sentinel-unclassified');
    expect(serialized).not.toContain('confidential');
    expect(serialized).not.toContain('tax-return');

    expect(summary.workSeconds).toBe(3600);
    expect(summary.unclassifiedSeconds).toBe(900);
    expect(summary.hasUnclassified).toBe(true);
  });

  it('ensures no personal or unclassified identities appear in day evidence', async () => {
    const evidence = await analytics.getDayEvidence({ date: '2026-03-01' });

    const serialized = JSON.stringify(evidence);

    expect(serialized).toContain(SENTINELS.workProject);

    expect(serialized).not.toContain(SENTINELS.personalProject);
    expect(serialized).not.toContain(SENTINELS.personalEntity);
    expect(serialized).not.toContain(SENTINELS.unclassifiedProject);
    expect(serialized).not.toContain(SENTINELS.unclassifiedEntity);
    expect(serialized).not.toContain('confidential');
    expect(serialized).not.toContain('tax-return');
  });

  it('refuses to leak personal or unclassified project existence when queried directly by name', async () => {
    const personalQuery = await analytics.getDayEvidence({
      date: '2026-03-01',
      project: SENTINELS.personalProject
    });

    expect(personalQuery.workSeconds).toBe(0);
    expect(personalQuery.unclassifiedSeconds).toBe(0);
    expect(personalQuery.hasUnclassified).toBe(false);
    expect(personalQuery.projects).toHaveLength(0);
    expect(JSON.stringify(personalQuery)).not.toContain(SENTINELS.personalProject);

    const unclassQuery = await analytics.getDayEvidence({
      date: '2026-03-01',
      project: SENTINELS.unclassifiedProject
    });

    expect(unclassQuery.workSeconds).toBe(0);
    expect(unclassQuery.unclassifiedSeconds).toBe(0);
    expect(unclassQuery.hasUnclassified).toBe(false);
    expect(unclassQuery.projects).toHaveLength(0);
    expect(JSON.stringify(unclassQuery)).not.toContain(SENTINELS.unclassifiedProject);
  });
});
