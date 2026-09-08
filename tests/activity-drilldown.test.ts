import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { openTestDatabase } from '../src/lib/server/db/connection.js';
import { createClassificationService, SqliteClassificationService } from '../src/lib/server/classification/sqlite.js';
import { getActivityData, ActivityFilterError } from '../src/lib/server/admin/activity.js';

const ROOT = resolve(import.meta.dirname, '..');

function loadSource(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf-8');
}

describe('Activity Page Telemetry Drilldown with matchMode (tests/activity-drilldown.test.ts)', () => {
  let db: Database.Database;
  let classification: SqliteClassificationService;

  beforeEach(() => {
    db = openTestDatabase();
    classification = createClassificationService(db);

    // Seed test project and slices
    db.prepare(`INSERT INTO projects (id, name, is_unattributed) VALUES (10, 'drilldown-proj', 0)`).run();
    db.prepare(
      `INSERT INTO source_imports (id, source_type, source_hash, byte_size)
       VALUES (1, 'daily_dump', 'hash1', 100)`
    ).run();

    // Slices with various entities and folder structures
    db.prepare(
      `INSERT INTO day_project_entity_slices
       (id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id)
       VALUES
       (1, '2026-08-01', 10, '/Users/dev/repos/work-times/src/index.ts', 'file', 1200, 0, 1),
       (2, '2026-08-01', 10, '/Users/dev/repos/work-times/tests/main.test.ts', 'file', 600, 0, 1),
       (3, '2026-08-02', 10, '/Users/dev/repos/other-proj/docs/readme.md', 'file', 300, 0, 1)`
    ).run();

    // Slice identities (machine)
    db.prepare(
      `INSERT INTO slice_identities (slice_id, selector_type, value)
       VALUES
       (1, 'machine', 'desktop-work from 10.0.0.5'),
       (2, 'machine', 'desktop-work from 10.0.0.5'),
       (3, 'machine', 'laptop-personal')`
    ).run();
  });

  describe('getActivityData matchMode parameter handling', () => {
    it('defaults matchMode to exact when not specified', () => {
      const data = getActivityData(db, classification, {
        date: 'all'
      });
      expect(data.filters.matchMode).toBe('exact');
    });

    it('accepts matchMode="glob" and filters slices matching wildcard pattern', () => {
      // Glob matching folder_prefix with wildcard
      const data = getActivityData(db, classification, {
        date: 'all',
        selectorType: 'folder_prefix',
        selectorValue: '*/src/*',
        matchMode: 'glob'
      });

      expect(data.filters.matchMode).toBe('glob');
      expect(data.items).toHaveLength(1);
      expect(data.items[0].entity).toBe('/Users/dev/repos/work-times/src/index.ts');
    });

    it('matches machine glob pattern with IP wildcard stripping', () => {
      const data = getActivityData(db, classification, {
        date: 'all',
        selectorType: 'machine',
        selectorValue: 'desktop-work*',
        matchMode: 'glob'
      });

      expect(data.filters.matchMode).toBe('glob');
      expect(data.items).toHaveLength(2);
      expect(data.items.map((i) => i.id).sort()).toEqual([1, 2]);
    });

    it('rejects invalid matchMode with ActivityFilterError (HTTP 400)', () => {
      expect(() => {
        getActivityData(db, classification, {
          date: 'all',
          matchMode: 'invalid-mode' as any
        });
      }).toThrow(ActivityFilterError);

      try {
        getActivityData(db, classification, {
          date: 'all',
          matchMode: 'regex' as any
        });
      } catch (err: any) {
        expect(err).toBeInstanceOf(ActivityFilterError);
        expect(err.status).toBe(400);
        expect(err.message).toContain("must be 'exact' or 'glob'");
      }
    });
  });

  describe('UI Contracts: Classify -> Activity Drilldown and Activity Explorer Controls', () => {
    it('verifies Classify page threads matchMode in activityDrilldownUrl', () => {
      const classifySrc = loadSource('src/routes/admin/classify/+page.svelte');
      expect(classifySrc).toContain("matchMode: suggestion.matchMode ?? 'exact'");
      expect(classifySrc).toContain('activityDrilldownUrl(activeSuggestion)');
    });

    it('verifies Activity page server load extracts matchMode and forwards to getActivityData', () => {
      const serverSrc = loadSource('src/routes/admin/activity/+page.server.ts');
      expect(serverSrc).toContain("const matchMode = url.searchParams.get('matchMode');");
      expect(serverSrc).toContain('matchMode,');
    });

    it('verifies Activity page Svelte template renders matchMode hidden input, badge, and dismiss', () => {
      const activitySrc = loadSource('src/routes/admin/activity/+page.svelte');

      // Hidden form input to preserve matchMode on filter changes
      expect(activitySrc).toContain('<input type="hidden" name="matchMode" value={activity.filters.matchMode} />');

      // GLOB badge display on active filter pill
      expect(activitySrc).toContain("activity.filters.matchMode === 'glob'");
      expect(activitySrc).toContain('GLOB');

      // Dismiss handler clears matchMode
      expect(activitySrc).toContain("matchMode: null");
    });
  });
});
