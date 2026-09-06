import type Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase } from '../db/connection.js';
import { importDumps } from '../import/importer.js';
import {
  AllocationConflictError,
  MissingPreviewError,
  SqliteClassificationService,
  StalePreviewError
} from './sqlite.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../tests/fixtures');
const DAILY = join(FIXTURES, 'synthetic-daily.json');
const HEARTBEATS = join(FIXTURES, 'synthetic-heartbeats.json');

describe('SqliteClassificationService - Contract & Finalized Schema 002', () => {
  let db: Database.Database;
  let service: SqliteClassificationService;

  beforeEach(() => {
    db = openTestDatabase();
    service = new SqliteClassificationService(db);
  });

  it('uses the exact finalized migration-002 tables and constraints', () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
          'classification_rules', 'daily_time_allocations', 'classification_revisions'
        ) ORDER BY name`
      )
      .all() as Array<{ name: string }>;

    expect(tables.map((t) => t.name)).toEqual([
      'classification_revisions',
      'classification_rules',
      'daily_time_allocations'
    ]);

    // Check exact columns in daily_time_allocations
    const allocCols = (
      db.prepare("PRAGMA table_info('daily_time_allocations')").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(allocCols).toContain('note');
    expect(allocCols).not.toContain('operator_note');

    // Check exact columns in classification_revisions
    const revCols = (
      db.prepare("PRAGMA table_info('classification_revisions')").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(revCols).toEqual([
      'id',
      'mutation_type',
      'target_type',
      'target_id',
      'before_json',
      'after_json',
      'affected_json',
      'actor',
      'created_at'
    ]);

    // Test classification_rules check constraint on classification
    expect(() => {
      db.prepare(
        `INSERT INTO classification_rules (id, name, classification, selector_type, selector_value)
         VALUES ('r1', 'invalid', 'unclassified', 'project', 'proj1')`
      ).run();
    }).toThrow(/CHECK constraint failed/);

    // Test classification_rules check constraint on selector_type
    expect(() => {
      db.prepare(
        `INSERT INTO classification_rules (id, name, classification, selector_type, selector_value)
         VALUES ('r2', 'invalid', 'work', 'language', 'typescript')`
      ).run();
    }).toThrow(/CHECK constraint failed/);

    // Test classification_rules check constraint on non-empty name and selector_value
    expect(() => {
      db.prepare(
        `INSERT INTO classification_rules (id, name, classification, selector_type, selector_value)
         VALUES ('r3', '   ', 'work', 'project', 'proj1')`
      ).run();
    }).toThrow(/CHECK constraint failed/);

    expect(() => {
      db.prepare(
        `INSERT INTO classification_rules (id, name, classification, selector_type, selector_value)
         VALUES ('r4', 'valid-name', 'work', 'project', '   ')`
      ).run();
    }).toThrow(/CHECK constraint failed/);
  });
});

describe('SqliteClassificationService - Rule Confirmation, Preview Binding & Normalization', () => {
  let db: Database.Database;
  let service: SqliteClassificationService;

  beforeEach(() => {
    db = openTestDatabase();
    service = new SqliteClassificationService(db);

    db.prepare(`INSERT INTO projects (id, name) VALUES (101, 'proj-one'), (102, 'proj-two')`).run();
    db.prepare(
      `INSERT INTO source_imports (id, source_type, source_hash, byte_size)
       VALUES (1, 'daily_dump', 'h1', 100)`
    ).run();

    db.prepare(
      `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, source_import_id)
       VALUES (1, '2026-01-01', 101, 'src/main.ts', 'file', 3600, 1),
              (2, '2026-01-01', 101, 'src/util.ts', 'file', 1800, 1),
              (3, '2026-01-02', 102, 'docs/readme.md', 'file', 900, 1)`
    ).run();
  });

  it('fails public mutations when preview digest is absent', () => {
    expect(() => {
      service.createRule({
        name: 'Work Alpha',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'proj-one'
      }, undefined as any);
    }).toThrow(MissingPreviewError);

    expect(() => {
      service.updateRule('nonexistent', { priority: 10 }, {} as any);
    }).toThrow(MissingPreviewError);

    expect(() => {
      service.deleteRule('nonexistent', {} as any);
    }).toThrow(MissingPreviewError);
  });

  it('rejects confirmation when payload has been altered since preview', () => {
    const preview = service.previewRuleChange({
      type: 'create',
      rule: {
        name: 'Work proj-one',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'proj-one',
        priority: 10
      }
    });

    // Altering name
    expect(() => {
      service.createRule(
        {
          name: 'Altered Name',
          classification: 'work',
          selectorType: 'project',
          selectorValue: 'proj-one',
          priority: 10
        },
        { expectedDigest: preview.previewDigest }
      );
    }).toThrow(StalePreviewError);

    // Altering priority
    expect(() => {
      service.createRule(
        {
          name: 'Work proj-one',
          classification: 'work',
          selectorType: 'project',
          selectorValue: 'proj-one',
          priority: 20
        },
        { expectedDigest: preview.previewDigest }
      );
    }).toThrow(StalePreviewError);

    // Altering classification
    expect(() => {
      service.createRule(
        {
          name: 'Work proj-one',
          classification: 'personal',
          selectorType: 'project',
          selectorValue: 'proj-one',
          priority: 10
        },
        { expectedDigest: preview.previewDigest }
      );
    }).toThrow(StalePreviewError);
  });

  it('prevents preview for one rule from authorizing another rule', () => {
    const previewAlpha = service.previewRuleChange({
      type: 'create',
      rule: {
        name: 'Alpha Rule',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'proj-one'
      }
    });

    expect(() => {
      service.createRule(
        {
          name: 'Beta Rule',
          classification: 'work',
          selectorType: 'project',
          selectorValue: 'proj-two'
        },
        { expectedDigest: previewAlpha.previewDigest }
      );
    }).toThrow(StalePreviewError);
  });

  it('fails confirmation when database revision state becomes stale', () => {
    const preview = service.previewRuleChange({
      type: 'create',
      rule: {
        name: 'Work proj-one',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'proj-one'
      }
    });

    // Intervening mutation via unsafe seed helper
    service.unsafeSeedRule({
      name: 'Intervening Seed',
      classification: 'personal',
      selectorType: 'project',
      selectorValue: 'proj-two'
    });

    // Old preview must fail
    expect(() => {
      service.createRule(
        {
          name: 'Work proj-one',
          classification: 'work',
          selectorType: 'project',
          selectorValue: 'proj-one'
        },
        { expectedDigest: preview.previewDigest }
      );
    }).toThrow(StalePreviewError);
  });

  it('preview digests distinguish delimiter-like payloads without collision', () => {
    // Two distinct payloads that would collide under naive delimiter joining
    const preview1 = service.previewRuleChange({
      type: 'create',
      rule: {
        name: 'alpha::beta',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'gamma'
      }
    });

    const preview2 = service.previewRuleChange({
      type: 'create',
      rule: {
        name: 'alpha',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'beta::gamma'
      }
    });

    expect(preview1.previewDigest).not.toBe(preview2.previewDigest);

    expect(() => {
      service.createRule(
        {
          name: 'alpha',
          classification: 'work',
          selectorType: 'project',
          selectorValue: 'beta::gamma'
        },
        { expectedDigest: preview1.previewDigest }
      );
    }).toThrow(StalePreviewError);
  });

  it('normalizes and validates rule fields before storage', () => {
    // Empty name rejected
    expect(() => {
      service.previewRuleChange({
        type: 'create',
        rule: {
          name: '   ',
          classification: 'work',
          selectorType: 'project',
          selectorValue: 'proj-one'
        }
      });
    }).toThrow(/Rule name cannot be empty/);

    // Empty selector value rejected
    expect(() => {
      service.previewRuleChange({
        type: 'create',
        rule: {
          name: 'Valid Name',
          classification: 'work',
          selectorType: 'project',
          selectorValue: '   '
        }
      });
    }).toThrow(/Rule selector_value cannot be empty/);

    // Normalization on create
    const preview = service.previewRuleChange({
      type: 'create',
      rule: {
        name: '  Trimmed Name  ',
        classification: 'work',
        selectorType: 'machine',
        selectorValue: '  Dev-Laptop-01  '
      }
    });

    const { rule } = service.createRule(
      {
        name: '  Trimmed Name  ',
        classification: 'work',
        selectorType: 'machine',
        selectorValue: '  Dev-Laptop-01  '
      },
      { expectedDigest: preview.previewDigest }
    );

    expect(rule.name).toBe('Trimmed Name');
    expect(rule.selector_value).toBe('dev-laptop-01');

    // Also verify persisted row
    const row = db.prepare('SELECT name, selector_value FROM classification_rules WHERE id = ?').get(rule.id) as {
      name: string;
      selector_value: string;
    };
    expect(row.name).toBe('Trimmed Name');
    expect(row.selector_value).toBe('dev-laptop-01');
  });

  it('supports full lifecycle (create, update, delete) with revisions and preview digests', () => {
    // 1. Create
    const createPrev = service.previewRuleChange({
      type: 'create',
      rule: {
        name: 'Proj One Rule',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'proj-one',
        priority: 10
      }
    });

    const { rule, revision: rev1 } = service.createRule(
      {
        name: 'Proj One Rule',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'proj-one',
        priority: 10
      },
      { expectedDigest: createPrev.previewDigest, actor: 'operator-1' }
    );

    expect(rev1.mutation_type).toBe('rule_created');
    expect(rev1.target_id).toBe(rule.id);
    expect(rev1.actor).toBe('operator-1');
    expect(rev1.before_json).toBeNull();
    expect(JSON.parse(rev1.after_json!).priority).toBe(10);

    // 2. Update
    const updatePrev = service.previewRuleChange({
      type: 'update',
      id: rule.id,
      rule: { priority: 25 }
    });

    const { rule: updated, revision: rev2 } = service.updateRule(
      rule.id,
      { priority: 25 },
      { expectedDigest: updatePrev.previewDigest, actor: 'operator-2' }
    );

    expect(updated.priority).toBe(25);
    expect(rev2.mutation_type).toBe('rule_updated');
    expect(rev2.actor).toBe('operator-2');
    expect(JSON.parse(rev2.before_json!).priority).toBe(10);
    expect(JSON.parse(rev2.after_json!).priority).toBe(25);

    // 3. Delete
    const deletePrev = service.previewRuleChange({
      type: 'delete',
      id: rule.id
    });

    const { revision: rev3 } = service.deleteRule(rule.id, {
      expectedDigest: deletePrev.previewDigest,
      actor: 'operator-3'
    });

    expect(rev3.mutation_type).toBe('rule_deleted');
    expect(rev3.actor).toBe('operator-3');
    expect(service.getRule(rule.id)).toBeNull();

    const revs = service.getRevisions();
    expect(revs).toHaveLength(3);
    expect(revs[0].id).toBe(rev3.id);
  });
});

describe('SqliteClassificationService - Allocations & Confirmed Replacement', () => {
  let db: Database.Database;
  let service: SqliteClassificationService;

  beforeEach(() => {
    db = openTestDatabase();
    service = new SqliteClassificationService(db);

    db.prepare(`INSERT INTO projects (id, name) VALUES (10, 'my-proj')`).run();
    db.prepare(
      `INSERT INTO source_imports (id, source_type, source_hash, byte_size)
       VALUES (1, 'daily_dump', 'hash1', 100)`
    ).run();
    db.prepare(
      `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, source_import_id)
       VALUES (1, '2026-01-05', 10, 'secret.ts', 'file', 1800, 1)`
    ).run();
  });

  it('rejects allocation when classification is not work or personal', () => {
    expect(() => {
      service.createAllocation({
        date: '2026-01-05',
        projectId: 10,
        entity: 'secret.ts',
        classification: 'unclassified' as any
      });
    }).toThrow(/Invalid allocation classification/);
  });

  it('rejects allocation for nonexistent day_project_entity_slice', () => {
    expect(() => {
      service.createAllocation({
        date: '2026-01-05',
        projectId: 10,
        entity: 'nonexistent.ts',
        classification: 'work'
      });
    }).toThrow(/Cannot allocate: slice does not exist/);
  });

  it('always uses slice total_seconds and prevents caller-supplied duration mismatch', () => {
    // Calling createAllocation without allocatedSeconds uses slice total_seconds (1800)
    const { allocation } = service.createAllocation({
      date: '2026-01-05',
      projectId: 10,
      entity: 'secret.ts',
      classification: 'work'
    });
    expect(allocation.allocated_seconds).toBe(1800);

    // If caller attempts to supply a fractional or mismatched duration, it is rejected
    expect(() => {
      service.createAllocation({
        date: '2026-01-05',
        projectId: 10,
        entity: 'secret.ts',
        classification: 'work',
        ...({ allocatedSeconds: 900 } as any)
      });
    }).toThrow();

    // Trigger test on raw DB insert: trigger aborts when allocated_seconds does not match slice total_seconds
    expect(() => {
      db.prepare(
        `INSERT INTO daily_time_allocations (id, date, project_id, entity, classification, allocated_seconds)
         VALUES ('bad-alloc', '2026-01-05', 10, 'secret.ts', 'personal', 500)`
      ).run();
    }).toThrow(/allocated_seconds does not match authoritative slice total_seconds/);
  });

  it('surfaces existing allocation conflict by default, and supports confirmed replacement via delete then create', () => {
    // 1. Initial allocation
    const { allocation: firstAlloc, revision: rev1 } = service.createAllocation({
      date: '2026-01-05',
      projectId: 10,
      entity: 'secret.ts',
      classification: 'personal',
      note: 'Initial personal'
    });
    expect(firstAlloc.classification).toBe('personal');
    expect(rev1.mutation_type).toBe('allocation_created');

    // 2. Attempting to allocate again on the same slice without confirmation throws AllocationConflictError
    expect(() => {
      service.createAllocation({
        date: '2026-01-05',
        projectId: 10,
        entity: 'secret.ts',
        classification: 'work',
        note: 'Switch to work'
      });
    }).toThrow(AllocationConflictError);

    try {
      service.createAllocation({
        date: '2026-01-05',
        projectId: 10,
        entity: 'secret.ts',
        classification: 'work'
      });
    } catch (err: any) {
      expect(err).toBeInstanceOf(AllocationConflictError);
      expect(err.existingClassification).toBe('personal');
      expect(err.proposedClassification).toBe('work');
    }

    // 3. Confirmed replacement path: executes delete then create (recording allocation_deleted and allocation_created)
    const { allocation: replaced, revision: revCreated } = service.replaceAllocation(
      {
        date: '2026-01-05',
        projectId: 10,
        entity: 'secret.ts',
        classification: 'work',
        note: 'Confirmed work'
      },
      { actor: 'admin-op' }
    );

    expect(replaced.classification).toBe('work');
    expect(replaced.note).toBe('Confirmed work');
    expect(revCreated.mutation_type).toBe('allocation_created');

    // Verify revisions: newest first should be allocation_created, followed by allocation_deleted, then initial allocation_created
    // Migration 002 only allows allocation_created and allocation_deleted
    const revs = service.getRevisions();
    expect(revs).toHaveLength(3);
    expect(revs[0].mutation_type).toBe('allocation_created');
    expect(revs[1].mutation_type).toBe('allocation_deleted');
    expect(revs[2].mutation_type).toBe('allocation_created');
    expect(revs.every((r) => (r.mutation_type as string) !== 'allocation_updated')).toBe(true);
  });
});

describe('SqliteClassificationService - Evaluated Unattributed Slices', () => {
  let db: Database.Database;
  let service: SqliteClassificationService;

  beforeEach(() => {
    db = openTestDatabase();
    service = new SqliteClassificationService(db);

    const unattributedProj = db
      .prepare("SELECT id FROM projects WHERE name = '__unattributed__'")
      .get() as { id: number };
    const projId = unattributedProj.id;

    db.prepare(
      `INSERT INTO source_imports (id, source_type, source_hash, byte_size)
       VALUES (1, 'daily_dump', 'h1', 100)`
    ).run();

    // Slice 1: regular slice
    db.prepare(
      `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id)
       VALUES (1, '2026-01-10', ?, '__unattributed__', 'unattributed', 1500, 1, 1)`
    ).run(projId);

    // Slice identities (e.g. machine or editor) associated with unattributed slice
    db.prepare(
      `INSERT INTO slice_identities (slice_id, selector_type, value, source)
       VALUES (1, 'machine', 'dev-machine-x', 'heartbeat')`
    ).run();
  });

  it('types unattributed slices correctly and keeps them unclassified unless an allocation exists', () => {
    const unattributedProj = db
      .prepare("SELECT id FROM projects WHERE name = '__unattributed__'")
      .get() as { id: number };
    const projId = unattributedProj.id;

    // Add broad rule that would match dev-machine-x
    service.unsafeSeedRule({
      name: 'Match Machine X',
      classification: 'work',
      selectorType: 'machine',
      selectorValue: 'dev-machine-x',
      priority: 100
    });

    // Unattributed slice must ignore rules and remain unclassified
    const evaluated = service.classifySlices({ date: '2026-01-10' });
    expect(evaluated).toHaveLength(1);
    const slice = evaluated[0];
    expect(slice.isUnattributed).toBe(true);
    expect(slice.entityType).toBe('unattributed');
    expect(slice.decision.classification).toBe('unclassified');
    expect(slice.decision.source).toBe('default');

    // Create a whole-slice allocation for the unattributed slice
    service.createAllocation({
      date: '2026-01-10',
      projectId: projId,
      entity: '__unattributed__',
      classification: 'work'
    });

    const evaluatedAfter = service.classifySlices({ date: '2026-01-10' });
    expect(evaluatedAfter[0].decision.classification).toBe('work');
    expect(evaluatedAfter[0].decision.source).toBe('override');
  });
});

describe('SqliteClassificationService - Coverage & Unclassified Suggestions', () => {
  let db: Database.Database;
  let service: SqliteClassificationService;

  beforeEach(async () => {
    db = openTestDatabase();
    service = new SqliteClassificationService(db);

    await importDumps(db, {
      dailyDumpPath: DAILY,
      heartbeatDumpPath: HEARTBEATS
    });
  });

  it('calculates classification coverage across imported data', () => {
    const coverageBefore = service.getCoverage();
    expect(coverageBefore.totalSeconds).toBeGreaterThan(0);
    expect(coverageBefore.unclassifiedSeconds).toBe(coverageBefore.totalSeconds);
    expect(coverageBefore.coveragePercentage).toBe(0);

    // Classify project alpha as work using unsafe seed
    service.unsafeSeedRule({
      name: 'Classify alpha',
      classification: 'work',
      selectorType: 'project',
      selectorValue: 'alpha'
    });

    const coverageAfter = service.getCoverage();
    expect(coverageAfter.workSeconds).toBeGreaterThan(0);
    expect(coverageAfter.classifiedSeconds).toBe(coverageAfter.workSeconds);
    expect(coverageAfter.coveragePercentage).toBeGreaterThan(0);
  });

  it('provides broad-to-narrow unclassified suggestions without auto-applying', () => {
    const rulesCountBefore = service.getRules().length;
    const suggestions = service.getUnclassifiedSuggestions();

    expect(suggestions.length).toBeGreaterThan(0);

    for (let i = 1; i < suggestions.length; i++) {
      expect(suggestions[i].specificity).toBeGreaterThanOrEqual(suggestions[i - 1].specificity);
    }

    expect(service.getRules().length).toBe(rulesCountBefore);
    expect(suggestions[0].specificity).toBeLessThanOrEqual(40);
  });
});
