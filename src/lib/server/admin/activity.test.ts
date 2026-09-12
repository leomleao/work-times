import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { getActivityData, ActivityFilterError } from './activity.js';
import { SqliteClassificationService } from '../classification/sqlite.js';
import { openTestDatabase } from '../db/connection.js';

describe('getActivityData', () => {
  let db: Database.Database;
  let classification: SqliteClassificationService;

  beforeEach(() => {
    db = openTestDatabase();
    classification = new SqliteClassificationService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty activity view when database has no slices', () => {
    const data = getActivityData(db, classification, {});
    expect(data.isEmpty).toBe(true);
    expect(data.items).toHaveLength(0);
    expect(data.metrics.totalDurationSeconds).toBe(0);
  });

  it('returns slices with mapped quality and disposition attributes', () => {
    db.exec(`
      INSERT INTO sync_runs (id, started_at, status)
      VALUES (1, '2026-03-01T10:00:00.000Z', 'succeeded');

      INSERT INTO sync_days (id, sync_run_id, date, status, disposition, synced_at, total_seconds)
      VALUES (1, 1, '2026-03-01', 'succeeded', 'updated', '2026-03-01T10:00:00.000Z', 3600);

      INSERT INTO sync_layer_state (date, layer, last_success_at, updated_at, verified_timezone)
      VALUES ('2026-03-01', 'summaries', '2026-03-01T10:00:00.000Z', '2026-03-01T10:00:00.000Z', 'Europe/London');

      INSERT INTO source_imports (id, source_type, source_hash, byte_size, status)
      VALUES (1, 'daily_dump', 'abcdef', 100, 'completed');

      INSERT INTO projects (id, name) VALUES (10, 'MyProject');

      INSERT INTO classification_rules (id, name, classification, selector_type, selector_value, created_at, updated_at)
      VALUES ('rule-1', 'Work rule', 'work', 'project', 'MyProject', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z');

      INSERT INTO day_project_entity_slices (id, source_import_id, date, project_id, entity, entity_type, kind, total_seconds)
      VALUES (1, 1, '2026-03-01', 10, '/src/index.ts', 'file', 'entity', 3600);
    `);

    const data = getActivityData(db, classification, { date: '2026-03-01' });
    expect(data.isEmpty).toBe(false);
    expect(data.items).toHaveLength(1);
    const item = data.items[0];
    expect(item.projectName).toBe('MyProject');
    expect(item.classification).toBe('work');
    expect(item.disposition).toBe('updated');
    expect(item.qualityStatus).toBeDefined();
  });

  it('throws ActivityFilterError on invalid date filter', () => {
    expect(() =>
      getActivityData(db, classification, { date: 'not-a-date' })
    ).toThrow(ActivityFilterError);
  });
});
