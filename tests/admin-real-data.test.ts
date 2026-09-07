import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/lib/server/db/connection.js';
import { SqliteClassificationService } from '../src/lib/server/classification/sqlite.js';
import {
  getOverviewData,
  getActivityData,
  getSyncData,
  getImportsData,
  getSettingsData,
  abbreviateDatabasePath,
  formatDuration,
  validateActivityFilterQuery,
  parseCapabilityPolicyState,
  sourceHashPrefix,
  truncateText,
  ActivityFilterError,
  MAX_ACTIVITY_SLICES
} from '../src/lib/server/admin/index.js';
import { load as overviewLoad } from '../src/routes/admin/+page.server.js';
import { load as activityLoad } from '../src/routes/admin/activity/+page.server.js';
import { load as syncLoad } from '../src/routes/admin/sync/+page.server.js';
import { load as importsLoad } from '../src/routes/admin/imports/+page.server.js';
import { load as settingsLoad } from '../src/routes/admin/settings/+page.server.js';
import { load as classificationRedirectLoad } from '../src/routes/admin/classification/+page.server.js';
import type { RuntimeConfig } from '../src/lib/server/config.js';

describe('Admin Real Data & Behavioral View Models (tests/admin-real-data.test.ts)', () => {
  let db: Database.Database;
  let classification: SqliteClassificationService;
  let mockConfig: RuntimeConfig;

  /** Insert the `source_imports` row every fact table's FK requires. */
  function seedImport(id = 1, status = 'completed', sourceType = 'daily_dump'): number {
    db.prepare(
      `INSERT INTO source_imports (id, source_type, source_hash, byte_size, started_at, status, dry_run, day_count, record_count, duplicate_count, conflict_count)
       VALUES (?, ?, 'abcdef0123456789', 1024, '2026-09-01T00:00:00Z', ?, 0, 1, 1, 0, 0)`
    ).run(id, sourceType, status);
    return id;
  }

  function seedSlice(fields: {
    id: number;
    date: string;
    projectId: number;
    entity: string;
    totalSeconds: number;
    importId?: number;
  }): void {
    db.prepare(
      `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id)
       VALUES (?, ?, ?, ?, 'file', ?, 0, ?)`
    ).run(
      fields.id,
      fields.date,
      fields.projectId,
      fields.entity,
      fields.totalSeconds,
      fields.importId ?? 1
    );
  }

  function seedDailyTotal(date: string, totalSeconds: number, importId = 1): void {
    db.prepare(
      `INSERT INTO daily_totals (date, total_seconds, grand_total_json, source_import_id, source_hash)
       VALUES (?, ?, '{}', ?, 'abcdef0123456789')`
    ).run(date, totalSeconds, importId);
  }

  function seedProject(id: number, name: string): void {
    db.prepare(
      `INSERT INTO projects (id, name, is_unattributed, first_seen_at, last_seen_at) VALUES (?, ?, 0, '2026-09-01', '2026-09-01')`
    ).run(id, name);
  }

  beforeEach(() => {
    // Fresh in-memory database with migrations
    db = openDatabase({ path: ':memory:' });
    classification = new SqliteClassificationService(db);

    mockConfig = {
      databasePath: '/Users/test-user/secret-path/dev/work-times/data/work-times.sqlite',
      wakatimeOAuthClientId: null,
      wakatimeOAuthClientSecret: null,
      adminUsername: 'admin',
      adminPasswordHash: '$scrypt$N=32768,r=8,p=1$xyz123',
      sessionSecret: 'super-secret-session-key-at-least-32-chars',
      publicUrl: new URL('http://localhost:3002'),
      cookieSecure: false,
      maxDirectImportBytes: 96 * 1024 * 1024
    };
  });

  describe('1. Empty Database Truthful State', () => {
    it('overview returns honest empty state without synthetic metrics or fake activity', () => {
      const overview = getOverviewData(db, classification);

      expect(overview.isEmpty).toBe(true);
      expect(overview.dateSpan.activeDays).toBe(0);
      expect(overview.dateSpan.totalSeconds).toBe(0);
      expect(overview.dateSpan.minDate).toBeNull();
      expect(overview.dateSpan.maxDate).toBeNull();
      expect(overview.heartbeatCount).toBe(0);
      expect(overview.sourceImportState.totalImports).toBe(0);
      expect(overview.sourceImportState.latestImport).toBeNull();
      expect(overview.topProjects).toEqual([]);
      expect(overview.topEditors).toEqual([]);
      expect(overview.recentActivity).toEqual([]);
      expect(overview.hourlyActivity).toBeNull();
      expect(overview.coverage.totalSeconds).toBe(0);
      expect(overview.coverage.workSeconds).toBe(0);
      expect(overview.coverage.personalSeconds).toBe(0);
      expect(overview.coverage.unclassifiedSeconds).toBe(0);
      expect(overview.coverage.coveragePercentage).toBe(100);
    });

    it('activity explorer returns honest empty state when no slices exist', () => {
      const activity = getActivityData(db, classification, {});

      expect(activity.isEmpty).toBe(true);
      expect(activity.items).toEqual([]);
      expect(activity.latestDate).toBeNull();
      expect(activity.distinctDates).toEqual([]);
      expect(activity.metrics.totalDurationSeconds).toBe(0);
      expect(activity.pagination.totalItems).toBe(0);
    });

    it('sync page returns honest empty OAuth state', () => {
      const syncData = getSyncData(db, mockConfig);

      expect(syncData.isEmpty).toBe(true);
      expect(syncData.syncRuns).toEqual([]);
      expect(syncData.syncDays).toEqual([]);
      expect(syncData.oauthAppConfigured).toBe(false);
      expect(syncData.oauthConnected).toBe(false);
      expect(syncData.discoveryReady).toBe(false);
      expect(syncData.backgroundSyncDeferred).toBe(true);
    });

    it('imports page returns honest empty state with zero fake uploads', () => {
      const importsData = getImportsData(db);

      expect(importsData.isEmpty).toBe(true);
      expect(importsData.totalImports).toBe(0);
      expect(importsData.sourceImports).toEqual([]);
    });

    it('settings page returns accurate zero counts and no imported account preferences', () => {
      const settingsData = getSettingsData(db, mockConfig);

      expect(settingsData.sqliteStatus.tableCounts.dayProjectEntitySlices).toBe(0);
      expect(settingsData.sqliteStatus.tableCounts.heartbeats).toBe(0);
      expect(settingsData.sqliteStatus.tableCounts.sourceImports).toBe(0);
      expect(settingsData.accountPreferences).toBeNull();
    });
  });

  describe('2. Real Aggregates & Account-Scope Guard (No Double-Counting)', () => {
    beforeEach(() => {
      // Seed source import
      db.prepare(
        `INSERT INTO source_imports (
          id, source_type, source_hash, byte_size, range_start_date, range_end_date,
          started_at, finished_at, status, dry_run, day_count, record_count, duplicate_count, conflict_count
        ) VALUES (1, 'daily_dump', 'hash123', 2048, '2026-09-01', '2026-09-02',
          '2026-09-02T10:00:00Z', '2026-09-02T10:01:00Z', 'completed', 0, 2, 10, 0, 0)`
      ).run();

      // Seed projects
      db.prepare(`INSERT INTO projects (id, name, is_unattributed, first_seen_at, last_seen_at) VALUES (10, 'core-work', 0, '2026-09-01', '2026-09-02')`).run();
      db.prepare(`INSERT INTO projects (id, name, is_unattributed, first_seen_at, last_seen_at) VALUES (20, 'homelab', 0, '2026-09-01', '2026-09-02')`).run();

      // Seed slices:
      // Slice 1: Day 1, core-work, src/index.ts (3600s)
      db.prepare(
        `INSERT INTO day_project_entity_slices (
          id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id, ai_sessions
        ) VALUES (101, '2026-09-01', 10, 'src/index.ts', 'file', 3600, 0, 1, 2)`
      ).run();

      // Slice 2: Day 1, homelab, compose.yml (1800s)
      db.prepare(
        `INSERT INTO day_project_entity_slices (
          id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id, ai_sessions
        ) VALUES (102, '2026-09-01', 20, 'compose.yml', 'file', 1800, 0, 1, 0)`
      ).run();

      // Slice 3: Day 2, core-work, src/api.ts (7200s)
      db.prepare(
        `INSERT INTO day_project_entity_slices (
          id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id, ai_sessions
        ) VALUES (103, '2026-09-02', 10, 'src/api.ts', 'file', 7200, 0, 1, 1)`
      ).run();

      // Seed slice identities
      db.prepare(`INSERT INTO slice_identities (id, slice_id, selector_type, value, source, observed_heartbeats) VALUES (1, 101, 'editor', 'VS Code', 'slice', 10)`).run();
      db.prepare(`INSERT INTO slice_identities (id, slice_id, selector_type, value, source, observed_heartbeats) VALUES (2, 101, 'machine', 'mbp-work', 'slice', 10)`).run();
      db.prepare(`INSERT INTO slice_identities (id, slice_id, selector_type, value, source, observed_heartbeats) VALUES (3, 102, 'editor', 'Neovim', 'slice', 5)`).run();

      // Seed daily totals
      db.prepare(
        `INSERT INTO daily_totals (
          date, timezone, total_seconds, human_additions, human_deletions, ai_additions, ai_deletions,
          ai_sessions, ai_input_tokens, ai_cached_input_tokens, ai_output_tokens, ai_prompt_length_sum,
          ai_model_total_cost, grand_total_json, project_sum_seconds, project_sum_delta, source_import_id,
          source_hash, reconciled_at
        ) VALUES ('2026-09-01', 'UTC', 5400, 100, 20, 200, 10, 2, 1000, 200, 800, 50, 0.05, '{}', 5400, 0, 1, 'h1', '2026-09-02')`
      ).run();

      db.prepare(
        `INSERT INTO daily_totals (
          date, timezone, total_seconds, human_additions, human_deletions, ai_additions, ai_deletions,
          ai_sessions, ai_input_tokens, ai_cached_input_tokens, ai_output_tokens, ai_prompt_length_sum,
          ai_model_total_cost, grand_total_json, project_sum_seconds, project_sum_delta, source_import_id,
          source_hash, reconciled_at
        ) VALUES ('2026-09-02', 'UTC', 7200, 50, 5, 100, 0, 1, 500, 100, 400, 25, 0.02, '{}', 7200, 0, 1, 'h2', '2026-09-03')`
      ).run();

      // Seed daily dimension totals for editors:
      // Scope 'account' (TOP-LEVEL ROLLUP)
      db.prepare(
        `INSERT INTO daily_dimension_totals (
          id, date, scope, project_id, dimension, name, total_seconds, source_import_id
        ) VALUES (1, '2026-09-01', 'account', NULL, 'editor', 'VS Code', 3600, 1)`
      ).run();

      db.prepare(
        `INSERT INTO daily_dimension_totals (
          id, date, scope, project_id, dimension, name, total_seconds, source_import_id
        ) VALUES (2, '2026-09-01', 'account', NULL, 'editor', 'Neovim', 1800, 1)`
      ).run();

      // Scope 'project' (NESTED ROLLUP FOR PROJECT 10)
      // Must NOT be double-counted by top-level queries!
      db.prepare(
        `INSERT INTO daily_dimension_totals (
          id, date, scope, project_id, dimension, name, total_seconds, source_import_id
        ) VALUES (3, '2026-09-01', 'project', 10, 'editor', 'VS Code', 3600, 1)`
      ).run();

      // Seed heartbeats
      db.prepare(
        `INSERT INTO heartbeats (
          id, external_id, occurred_at_us, occurred_at, local_date, entity, entity_type,
          category, user_agent_id, is_write, canonical_hash, occurrence_count, source_import_id,
          first_seen_at, last_seen_at
        ) VALUES (1, 'ext-1', 1788273600000000, '2026-09-01T14:40:00Z', '2026-09-01', 'src/index.ts', 'file',
          'coding', 'agent1', 1, 'h1', 1, 1, '2026-09-01', '2026-09-01')`
      ).run();

      // Seed classification rules:
      // Project 'core-work' -> work
      // Project 'homelab' -> personal
      classification.unsafeSeedRule({
        name: 'Work Project Rule',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'core-work'
      });

      classification.unsafeSeedRule({
        name: 'Personal Project Rule',
        classification: 'personal',
        selectorType: 'project',
        selectorValue: 'homelab'
      });
    });

    it('calculates real aggregates with date span, active days, and immutable overlay classifications', () => {
      const overview = getOverviewData(db, classification);

      expect(overview.isEmpty).toBe(false);
      expect(overview.dateSpan.activeDays).toBe(2);
      expect(overview.dateSpan.minDate).toBe('2026-09-01');
      expect(overview.dateSpan.maxDate).toBe('2026-09-02');
      expect(overview.dateSpan.totalSeconds).toBe(12600); // 5400 + 7200
      expect(overview.dateSpan.totalAiSessions).toBe(3); // 2 + 1
      expect(overview.heartbeatCount).toBe(1);

      // Coverage via immutable overlay:
      // core-work: 3600 + 7200 = 10800s (Work)
      // homelab: 1800s (Personal)
      expect(overview.coverage.totalSeconds).toBe(12600);
      expect(overview.coverage.workSeconds).toBe(10800);
      expect(overview.coverage.personalSeconds).toBe(1800);
      expect(overview.coverage.unclassifiedSeconds).toBe(0);
      expect(overview.coverage.workPercent).toBe(86);
      expect(overview.coverage.personalPercent).toBe(14);
      expect(overview.coverage.unclassifiedPercent).toBe(0);

      // Top projects with real classifications from overlay
      expect(overview.topProjects).toHaveLength(2);
      expect(overview.topProjects[0].name).toBe('core-work');
      expect(overview.topProjects[0].classification).toBe('work');
      expect(overview.topProjects[0].totalSeconds).toBe(10800);
      expect(overview.topProjects[1].name).toBe('homelab');
      expect(overview.topProjects[1].classification).toBe('personal');
      expect(overview.topProjects[1].totalSeconds).toBe(1800);
    });

    it('enforces scope=account guard to prevent double-counting nested dimension rows', () => {
      const overview = getOverviewData(db, classification);

      // Top editors must reflect exactly account-scope totals:
      // VS Code: 3600 (NOT 7200 from summing account + project scope rows)
      // Neovim: 1800
      const vsCode = overview.topEditors.find((e) => e.name === 'VS Code');
      const neovim = overview.topEditors.find((e) => e.name === 'Neovim');

      expect(vsCode).toBeDefined();
      expect(vsCode?.totalSeconds).toBe(3600);
      expect(neovim).toBeDefined();
      expect(neovim?.totalSeconds).toBe(1800);
    });
  });

  describe('3. Activity Explorer Bounded Pagination & Filtering', () => {
    beforeEach(() => {
      db.prepare(
        `INSERT INTO source_imports (
          id, source_type, source_hash, byte_size, range_start_date, range_end_date,
          started_at, finished_at, status, dry_run, day_count, record_count, duplicate_count, conflict_count
        ) VALUES (1, 'daily_dump', 'hash123', 2048, '2026-09-01', '2026-09-02',
          '2026-09-02T10:00:00Z', '2026-09-02T10:01:00Z', 'completed', 0, 2, 10, 0, 0)`
      ).run();

      db.prepare(`INSERT INTO projects (id, name, is_unattributed, first_seen_at, last_seen_at) VALUES (10, 'work-proj', 0, '2026-09-01', '2026-09-02')`).run();
      db.prepare(`INSERT INTO projects (id, name, is_unattributed, first_seen_at, last_seen_at) VALUES (20, 'other-proj', 0, '2026-09-01', '2026-09-02')`).run();

      // Seed 5 slices across 2 dates
      db.prepare(
        `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id)
         VALUES (1, '2026-09-01', 10, 'src/auth.ts', 'file', 1000, 0, 1)`
      ).run();
      db.prepare(
        `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id)
         VALUES (2, '2026-09-01', 10, 'src/api.ts', 'file', 2000, 0, 1)`
      ).run();
      db.prepare(
        `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id)
         VALUES (3, '2026-09-02', 10, 'src/dashboard.svelte', 'file', 3000, 0, 1)`
      ).run();
      db.prepare(
        `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id)
         VALUES (4, '2026-09-02', 20, 'notes.md', 'file', 4000, 0, 1)`
      ).run();
      db.prepare(
        `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id)
         VALUES (5, '2026-09-02', 10, 'tests/auth.test.ts', 'file', 5000, 0, 1)`
      ).run();

      db.prepare(`INSERT INTO slice_identities (id, slice_id, selector_type, value, source, observed_heartbeats) VALUES (1, 1, 'machine', 'laptop-mac', 'slice', 5)`).run();
      db.prepare(`INSERT INTO slice_identities (id, slice_id, selector_type, value, source, observed_heartbeats) VALUES (2, 1, 'editor', 'cursor', 'slice', 5)`).run();

      classification.unsafeSeedRule({
        name: 'Work Project',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'work-proj'
      });
      classification.unsafeSeedRule({
        name: 'Personal Project',
        classification: 'personal',
        selectorType: 'project',
        selectorValue: 'other-proj'
      });
    });

    it('defaults to the latest slice-bearing date when no date parameter is supplied', () => {
      const result = getActivityData(db, classification, {});

      expect(result.filters.selectedDate).toBe('2026-09-02');
      expect(result.latestDate).toBe('2026-09-02');
      // Slices for 2026-09-02 are slice 3, 4, 5
      expect(result.items).toHaveLength(3);
      expect(result.items.map((s) => s.id).sort()).toEqual([3, 4, 5]);
    });

    it('filters slices by explicit validated date', () => {
      const result = getActivityData(db, classification, { date: '2026-09-01' });

      expect(result.filters.selectedDate).toBe('2026-09-01');
      expect(result.items).toHaveLength(2);
      expect(result.items.map((s) => s.id).sort()).toEqual([1, 2]);
    });

    it('filters slices by classification and query text', () => {
      const workOnly = getActivityData(db, classification, {
        date: '2026-09-02',
        classification: 'work'
      });
      // Slices 3 & 5 are work, slice 4 is personal
      expect(workOnly.items).toHaveLength(2);
      expect(workOnly.items.every((s) => s.classification === 'work')).toBe(true);

      const textFilter = getActivityData(db, classification, {
        date: '2026-09-02',
        q: 'dashboard'
      });
      expect(textFilter.items).toHaveLength(1);
      expect(textFilter.items[0].entity).toBe('src/dashboard.svelte');
    });

    it('enforces bounded pagination with pageSize limits', () => {
      // Date 2026-09-02 has 3 slices. Request pageSize=2, page=1
      const page1 = getActivityData(db, classification, {
        date: '2026-09-02',
        page: 1,
        pageSize: 2
      });

      expect(page1.items).toHaveLength(2);
      expect(page1.pagination.page).toBe(1);
      expect(page1.pagination.pageSize).toBe(2);
      expect(page1.pagination.totalItems).toBe(3);
      expect(page1.pagination.totalPages).toBe(2);
      expect(page1.pagination.hasNextPage).toBe(true);
      expect(page1.pagination.hasPrevPage).toBe(false);

      const page2 = getActivityData(db, classification, {
        date: '2026-09-02',
        page: 2,
        pageSize: 2
      });
      expect(page2.items).toHaveLength(1);
      expect(page2.pagination.page).toBe(2);
      expect(page2.pagination.hasNextPage).toBe(false);
      expect(page2.pagination.hasPrevPage).toBe(true);

      // Out-of-range page sizes are rejected outright rather than silently
      // clamped: a clamped result would report totals for a page the caller
      // never asked for.
      expect(() => getActivityData(db, classification, { pageSize: 999 })).toThrow(
        ActivityFilterError
      );

      // The unfiltered default is the documented page size.
      const defaults = getActivityData(db, classification, {});
      expect(defaults.pagination.pageSize).toBe(50);
      expect(defaults.pagination.page).toBe(1);
    });

    it('surfaces effective decision, source, and identity selectors', () => {
      const result = getActivityData(db, classification, { date: '2026-09-01', q: 'auth.ts' });

      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item.entity).toBe('src/auth.ts');
      expect(item.classification).toBe('work');
      expect(item.decisionSource).toBe('rule');
      expect(item.machineIds).toEqual(['laptop-mac']);
      expect(item.editors).toEqual(['cursor']);
    });
  });

  describe('4. Settings Secret Redaction & Non-Sensitive Exposure', () => {
    it('safely abbreviates database path without exposing user home directories', () => {
      const fullPath = '/Users/leo/workspace/secret/dev/work-times/data/work-times.sqlite';
      const abbreviated = abbreviateDatabasePath(fullPath);

      expect(abbreviated).toBe('./data/work-times.sqlite');
      expect(abbreviated).not.toContain('/Users/');
      expect(abbreviateDatabasePath(':memory:')).toBe(':memory:');
    });

    it('never exposes sensitive secrets or hashes in settings view data', () => {
      const settings = getSettingsData(db, mockConfig);

      // Secret values must NOT be present on the returned payload
      expect((settings as any).adminPasswordHash).toBeUndefined();
      expect((settings as any).wakatimeOAuthClientSecret).toBeUndefined();
      expect((settings as any).sessionSecret).toBeUndefined();

      // Non-secret booleans and public info only
      expect(settings.wakatimeOAuthAppConfigured).toBe(false);
      expect(settings.wakatimeOAuthConnected).toBe(false);
      expect(settings.adminPasswordConfigured).toBe(true);
      expect(settings.sessionSecretConfigured).toBe(true);
      expect(settings.publicOrigin).toBe('http://localhost:3002');
      expect(settings.cookieSecure).toBe(false);
      expect(settings.adminUsername).toBe('admin');
      expect(settings.abbreviatedDbPath).toBe('./data/work-times.sqlite');
    });

    it('exposes imported account preferences truthfully', () => {
      db.prepare(
        `INSERT INTO account_settings (
          wakatime_user_id, timezone, weekday_start, keystroke_timeout_seconds,
          writes_only, plan, has_premium_features, updated_at
        ) VALUES ('user_12345', 'America/Chicago', 0, 150, 1, 'premium', 1, '2026-08-30T12:00:00Z')`
      ).run();

      const settings = getSettingsData(db, mockConfig);
      expect(settings.accountPreferences).not.toBeNull();
      expect(settings.accountPreferences?.timezone).toBe('America/Chicago');
      expect(settings.accountPreferences?.weekdayStart).toBe(0);
      expect(settings.accountPreferences?.weekdayStartLabel).toBe('Sunday');
      expect(settings.accountPreferences?.keystrokeTimeoutSeconds).toBe(150);
      expect(settings.accountPreferences?.writesOnly).toBe(true);
      expect(settings.accountPreferences?.plan).toBe('premium');
      expect(settings.accountPreferences?.hasPremiumFeatures).toBe(true);
      // Raw user ID should not be leaked in preferences
      expect((settings.accountPreferences as any).wakatime_user_id).toBeUndefined();
    });
  });

  describe('5. Classification Alias Redirect Contract', () => {
    it('redirects /admin/classification to canonical /admin/classify via 307', async () => {
      await expect(classificationRedirectLoad({} as any)).rejects.toMatchObject({
        status: 307,
        location: '/admin/classify'
      });
    });
  });

  describe('6. Server Loaders Return Truthful SQLite View Models', () => {
    it('all admin page server loaders resolve successfully with SQLite data', async () => {
      const overviewRes = await (overviewLoad as any)({} as any);
      expect(overviewRes?.overview).toBeDefined();

      const activityRes = await (activityLoad as any)({
        url: new URL('http://localhost:3002/admin/activity?date=2026-09-01')
      } as any);
      expect(activityRes?.activity).toBeDefined();

      const syncRes = await (syncLoad as any)({} as any);
      expect(syncRes?.sync).toBeDefined();

      const importsRes = await (importsLoad as any)({} as any);
      expect(importsRes?.imports).toBeDefined();

      const settingsRes = await (settingsLoad as any)({} as any);
      expect(settingsRes?.settings).toBeDefined();
    });
  });

  describe('8. Activity Query Validation Rejects Malformed Input', () => {
    it('accepts only strict ISO calendar dates', () => {
      for (const bad of ['2026-13-01', '2026-02-30', '2026-9-1', '2026-09-01T00:00:00Z', 'yesterday', '  2026-09-01 ']) {
        const result = validateActivityFilterQuery({ date: bad });
        expect(result.ok, `expected '${bad}' to be rejected`).toBe(false);
      }

      // 2026 is not a leap year, so 2026-02-29 must be rejected while the real
      // leap day is accepted.
      expect(validateActivityFilterQuery({ date: '2026-02-29' }).ok).toBe(false);
      expect(validateActivityFilterQuery({ date: '2024-02-29' }).ok).toBe(true);
    });

    it('accepts only whole-string integers for page and pageSize', () => {
      for (const bad of ['1.5', '1e3', '0', '-1', ' 2', '2 ', '02x', '', ' ', 'NaN', 'Infinity']) {
        // An empty/blank page falls back to the default rather than erroring,
        // so only genuinely malformed values are asserted here.
        if (bad.trim() === '') continue;
        expect(validateActivityFilterQuery({ page: bad }).ok, `page '${bad}'`).toBe(false);
        expect(validateActivityFilterQuery({ pageSize: bad }).ok, `pageSize '${bad}'`).toBe(false);
      }

      expect(validateActivityFilterQuery({ page: '7', pageSize: '25' })).toMatchObject({
        ok: true,
        filters: { page: 7, pageSize: 25 }
      });
      // '0100' is not a whole-string integer even though Number() would accept it.
      expect(validateActivityFilterQuery({ page: '0100' }).ok).toBe(false);
    });

    it('bounds page and pageSize instead of trusting the caller', () => {
      expect(validateActivityFilterQuery({ page: 100_001 }).ok).toBe(false);
      expect(validateActivityFilterQuery({ page: 100_000 }).ok).toBe(true);
      expect(validateActivityFilterQuery({ pageSize: 101 }).ok).toBe(false);
      expect(validateActivityFilterQuery({ pageSize: 100 }).ok).toBe(true);
      expect(validateActivityFilterQuery({ pageSize: Number.MAX_SAFE_INTEGER }).ok).toBe(false);
    });

    it('treats a selected date and a date range as mutually exclusive', () => {
      expect(
        validateActivityFilterQuery({ date: '2026-09-01', startDate: '2026-08-01', endDate: '2026-08-31' }).ok
      ).toBe(false);
      expect(validateActivityFilterQuery({ date: '2026-09-01', endDate: '2026-08-31' }).ok).toBe(false);
    });

    it('requires a complete range with start <= end and at most 366 days', () => {
      expect(validateActivityFilterQuery({ startDate: '2026-08-01' }).ok).toBe(false);
      expect(validateActivityFilterQuery({ endDate: '2026-08-31' }).ok).toBe(false);
      expect(validateActivityFilterQuery({ startDate: '2026-09-02', endDate: '2026-09-01' }).ok).toBe(false);

      // 2024 is a leap year: 2024-01-01..2024-12-31 is exactly 366 days.
      expect(validateActivityFilterQuery({ startDate: '2024-01-01', endDate: '2024-12-31' }).ok).toBe(true);
      expect(validateActivityFilterQuery({ startDate: '2024-01-01', endDate: '2025-01-01' }).ok).toBe(false);
      expect(validateActivityFilterQuery({ startDate: '2026-09-01', endDate: '2026-09-01' }).ok).toBe(true);
    });

    it('rejects unknown classification values and oversized query text', () => {
      expect(validateActivityFilterQuery({ classification: 'secret' }).ok).toBe(false);
      expect(validateActivityFilterQuery({ q: 'x'.repeat(201) }).ok).toBe(false);
      expect(validateActivityFilterQuery({ q: 'x'.repeat(200) }).ok).toBe(true);
    });

    it('never echoes an unbounded query value back in the rejection message', () => {
      const result = validateActivityFilterQuery({ date: 'z'.repeat(5000) });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.length).toBeLessThan(200);
      }
    });

    it('surfaces a rejected filter as HTTP 400, not a server fault', async () => {
      await expect(
        (activityLoad as any)({
          url: new URL('http://localhost:3002/admin/activity?date=not-a-date')
        } as any)
      ).rejects.toMatchObject({ status: 400 });

      await expect(
        (activityLoad as any)({
          url: new URL('http://localhost:3002/admin/activity?page=0')
        } as any)
      ).rejects.toMatchObject({ status: 400 });

      await expect(
        (activityLoad as any)({
          url: new URL('http://localhost:3002/admin/activity?startDate=2026-09-05&endDate=2026-09-01')
        } as any)
      ).rejects.toMatchObject({ status: 400 });
    });

    it('carries a 400 status on the thrown filter error itself', () => {
      try {
        getActivityData(db, classification, { pageSize: 0 });
        throw new Error('expected a rejection');
      } catch (err) {
        expect(err).toBeInstanceOf(ActivityFilterError);
        expect((err as ActivityFilterError).status).toBe(400);
      }
    });
  });

  describe('9. Activity Bounded Rows & Consistent Empty Pagination', () => {
    it('reports the same pagination shape for an empty database and an empty filter', () => {
      const emptyDb = getActivityData(db, classification, { page: 3, pageSize: 25 });
      expect(emptyDb.isEmpty).toBe(true);
      expect(emptyDb.pagination).toEqual({
        page: 3,
        pageSize: 25,
        totalItems: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPrevPage: false
      });

      seedImport();
      seedProject(10, 'proj');
      seedSlice({ id: 1, date: '2026-09-01', projectId: 10, entity: 'src/a.ts', totalSeconds: 100 });

      // A filter that matches nothing must produce the identical shape.
      const noMatches = getActivityData(db, classification, {
        date: '2026-09-01',
        q: 'no-such-entity',
        page: 3,
        pageSize: 25
      });
      expect(noMatches.isEmpty).toBe(false);
      expect(noMatches.items).toEqual([]);
      expect(noMatches.pagination).toEqual(emptyDb.pagination);

      // A page past the end yields no rows but still reports the real totals,
      // so the operator can see the selection is non-empty and page back into
      // it rather than being told the data does not exist.
      const pastEnd = getActivityData(db, classification, { date: '2026-09-01', page: 9 });
      expect(pastEnd.items).toEqual([]);
      expect(pastEnd.pagination.totalItems).toBe(1);
      expect(pastEnd.pagination.totalPages).toBe(1);
      expect(pastEnd.pagination.hasNextPage).toBe(false);
      expect(pastEnd.pagination.hasPrevPage).toBe(true);
    });

    it('echoes the requested filters back on an empty database instead of blanking them', () => {
      const result = getActivityData(db, classification, {
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        classification: 'work',
        q: 'auth'
      });

      expect(result.isEmpty).toBe(true);
      expect(result.filters).toEqual({
        selectedDate: null,
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        classification: 'work',
        q: 'auth'
      });
    });

    it('bounds row output and truncates untrusted slice strings', () => {
      const longEntity = 'a'.repeat(5000);
      seedImport();
      seedProject(10, 'p'.repeat(4000));
      seedSlice({ id: 1, date: '2026-09-01', projectId: 10, entity: longEntity, totalSeconds: 100 });
      for (let i = 0; i < 40; i++) {
        db.prepare(
          `INSERT INTO slice_identities (slice_id, selector_type, value, source, observed_heartbeats) VALUES (1, 'machine', ?, 'slice', 1)`
        ).run(`machine-${i}`);
      }

      const result = getActivityData(db, classification, { date: '2026-09-01' });
      const item = result.items[0];

      expect(item.entity.length).toBeLessThanOrEqual(121);
      expect(item.projectName.length).toBeLessThanOrEqual(121);
      expect(item.machineIds.length).toBeLessThanOrEqual(10);
      expect(result.distinctDates.length).toBeLessThanOrEqual(60);
      // Nothing was capped at this size, so the view must not claim otherwise.
      expect(result.isTruncated).toBe(false);
      expect(result.maxSlices).toBe(MAX_ACTIVITY_SLICES);
    });
  });

  describe('10. Persisted Status, Capability & Diagnostic Sanitization', () => {
    it('allowlists persisted import statuses and source types', () => {
      seedImport();
      // Write values the CHECK constraint forbids, standing in for schema drift
      // or a row written by an older/newer build.
      db.pragma('ignore_check_constraints = ON');
      db.prepare(`UPDATE source_imports SET status = 'pwned', source_type = 'evil' WHERE id = 1`).run();
      db.pragma('ignore_check_constraints = OFF');

      const imports = getImportsData(db);
      expect(imports.sourceImports[0].status).toBe('unknown');
      expect(imports.sourceImports[0].sourceType).toBe('unknown');

      const overview = getOverviewData(db, classification);
      expect(overview.sourceImportState.latestImport?.status).toBe('unknown');
      expect(overview.sourceImportState.latestImport?.sourceType).toBe('unknown');
    });

    it("reports a real 'running' import status rather than mapping it to unknown", () => {
      seedImport(1, 'running', 'api_summaries');

      expect(getImportsData(db).sourceImports[0].status).toBe('running');
      expect(getOverviewData(db, classification).sourceImportState.latestImport?.status).toBe('running');
    });

    it('discloses only a prefix of the import content hash', () => {
      const fullHash = 'a'.repeat(64);
      seedImport();
      db.prepare(`UPDATE source_imports SET source_hash = ? WHERE id = 1`).run(fullHash);

      const imports = getImportsData(db);
      const row = imports.sourceImports[0];
      expect(row.sourceHashPrefix).toBe('a'.repeat(12));
      expect(row.sourceHashPrefix).not.toBe(fullHash);
      expect(JSON.stringify(imports)).not.toContain(fullHash);
      expect((row as any).sourceHash).toBeUndefined();

      expect(sourceHashPrefix('deadbeefcafebabe0123')).toBe('deadbeefcafe');
      expect(sourceHashPrefix('NOT-HEX')).toBe('unknown');
      expect(sourceHashPrefix(null)).toBe('unknown');
    });

    it('caps and truncates untrusted import warnings and error summaries', () => {
      const warnings = Array.from({ length: 80 }, (_, i) => `warning ${i} ${'w'.repeat(2000)}`);
      seedImport(1, 'failed');
      db.prepare(`UPDATE source_imports SET warnings_json = ?, error_summary = ? WHERE id = 1`).run(
        JSON.stringify(warnings),
        'e'.repeat(10_000)
      );

      const row = getImportsData(db).sourceImports[0];
      expect(row.warnings.length).toBe(25);
      expect(row.omittedWarnings).toBe(55);
      expect(Math.max(...row.warnings.map((w) => w.length))).toBeLessThanOrEqual(121);
      expect((row.errorSummary ?? '').length).toBeLessThanOrEqual(501);
    });

    it('reports a malformed warnings blob as no warnings rather than failing the page', () => {
      seedImport(1, 'failed');
      db.prepare(`UPDATE source_imports SET warnings_json = '{not json' WHERE id = 1`).run();

      const row = getImportsData(db).sourceImports[0];
      expect(row.warnings).toEqual([]);
      expect(row.omittedWarnings).toBe(0);
    });

    it('allowlists persisted sync run, day and per-capability statuses', () => {
      db.prepare(
        `INSERT INTO sync_runs (id, started_at, trigger, status, day_count, days_synced, days_failed, degraded_capabilities, advisory_codes)
         VALUES (1, '2026-09-01T00:00:00Z', 'manual', 'succeeded', 1, 1, 0, ?, ?)`
      ).run(
        Array.from({ length: 60 }, (_, i) => `cap-${i}`).join(','),
        Array.from({ length: 60 }, (_, i) => `adv-${i}`).join(',')
      );
      db.prepare(
        `INSERT INTO sync_days (id, sync_run_id, date, status, summaries_status, durations_status, heartbeats_status, total_seconds, heartbeat_count)
         VALUES (1, 1, '2026-09-01', 'succeeded', 'succeeded', 'restricted', 'skipped', 100.0, 5)`
      ).run();

      const clean = getSyncData(db, mockConfig);
      expect(clean.syncRuns[0].status).toBe('succeeded');
      expect(clean.syncRuns[0].trigger).toBe('manual');
      expect(clean.syncDays[0].status).toBe('succeeded');
      expect(clean.syncDays[0].durationsStatus).toBe('restricted');
      expect(clean.syncRuns[0].degradedCapabilities.length).toBe(25);
      expect(clean.syncRuns[0].advisoryCodes.length).toBe(25);

      db.pragma('ignore_check_constraints = ON');
      db.prepare(`UPDATE sync_runs SET status = 'owned', trigger = 'owned' WHERE id = 1`).run();
      db.prepare(`UPDATE sync_days SET status = 'owned', durations_status = 'owned' WHERE id = 1`).run();
      db.pragma('ignore_check_constraints = OFF');

      const dirty = getSyncData(db, mockConfig);
      expect(dirty.syncRuns[0].status).toBe('unknown');
      expect(dirty.syncRuns[0].trigger).toBe('unknown');
      expect(dirty.syncDays[0].status).toBe('unknown');
      expect(dirty.syncDays[0].durationsStatus).toBe('unknown');
      // A NULL per-capability status stays null rather than becoming 'unknown'.
      expect(dirty.syncDays[0].heartbeatsStatus).toBe('skipped');
    });

    it('truncates untrusted sync diagnostics and strips control characters', () => {
      db.prepare(
        `INSERT INTO sync_runs (id, started_at, trigger, status, day_count, days_synced, days_failed, summary, error_message)
         VALUES (1, '2026-09-01T00:00:00Z', 'manual', 'failed', 1, 0, 1, ?, ?)`
      ).run('s'.repeat(9000), 'line one\nline two\u0007bell');

      const run = getSyncData(db, mockConfig).syncRuns[0];
      expect((run.summary ?? '').length).toBeLessThanOrEqual(501);
      expect(run.errorMessage).toBe('line one line two bell');
      expect(run.errorMessage).not.toContain('\n');
    });

    it('rejects a capability policy state that is not the expected shape', () => {
      expect(parseCapabilityPolicyState('{not json')).toBeNull();
      expect(parseCapabilityPolicyState(JSON.stringify([1, 2, 3]))).toBeNull();
      expect(parseCapabilityPolicyState(JSON.stringify({ capabilities: 'all of them' }))).toBeNull();
      expect(parseCapabilityPolicyState(JSON.stringify({ capabilities: { nonsense: {} } }))).toBeNull();
      expect(parseCapabilityPolicyState(null)).toBeNull();
    });

    it('rebuilds a persisted capability policy state with allowlisted statuses and bounded strings', () => {
      db.prepare(
        `INSERT INTO app_settings (key, value) VALUES ('capability_policy_state', ?)`
      ).run(
        JSON.stringify({
          capabilities: {
            summaries: { capability: 'summaries', status: 'available', lastProbedAt: '2026-09-01T00:00:00Z', lastSuccessAt: null, nextReprobeAt: null },
            durations: { capability: 'durations', status: 'pwned', lastProbedAt: null, lastSuccessAt: null, nextReprobeAt: null, errorMessage: 'x'.repeat(9000) },
            attacker: { capability: 'attacker', status: 'available' }
          },
          updatedAt: 'u'.repeat(9000),
          extraField: 'dropped'
        })
      );

      const state = getSyncData(db, mockConfig).capabilityState;
      expect(state).not.toBeNull();
      expect(state?.capabilities.summaries.status).toBe('available');
      // An unrecognized status degrades to 'untested', never to a fake success.
      expect(state?.capabilities.durations.status).toBe('untested');
      expect(state?.capabilities.durations.errorMessage?.length).toBeLessThanOrEqual(501);
      expect(Object.keys(state?.capabilities ?? {})).toEqual(['summaries', 'durations']);
      expect((state as any).extraField).toBeUndefined();
      expect(state?.updatedAt.length).toBeLessThanOrEqual(121);
    });

    it('bounds untrusted editor and project names on the overview', () => {
      seedImport();
      seedProject(10, 'p'.repeat(4000));
      seedSlice({ id: 1, date: '2026-09-01', projectId: 10, entity: 'src/a.ts', totalSeconds: 100 });
      db.prepare(
        `INSERT INTO daily_dimension_totals (date, scope, dimension, name, total_seconds, source_import_id)
         VALUES ('2026-09-01', 'account', 'editor', ?, 100, 1)`
      ).run('e'.repeat(4000));

      const overview = getOverviewData(db, classification);
      expect(overview.topEditors[0].name.length).toBeLessThanOrEqual(121);
      expect(overview.topProjects[0].name.length).toBeLessThanOrEqual(121);
    });

    it('strips control characters and bounds any untrusted string', () => {
      expect(truncateText('a\u0000b\u001fc\u007fd')).toBe('a b c d');
      expect(truncateText('x'.repeat(600)).length).toBe(501);
      expect(truncateText(null)).toBe('');
      expect(truncateText(undefined)).toBe('');
    });
  });

  describe('11. Overview Counts Only Positive & Slice-Bearing Days', () => {
    beforeEach(() => {
      seedImport();
      // Two zero-second days that must not count as activity, plus a real one.
      seedDailyTotal('2026-08-01', 0);
      seedDailyTotal('2026-08-02', 0);
      seedDailyTotal('2026-08-03', 3600);

      seedProject(10, 'proj');
      // A slice-bearing day with no daily_totals row at all.
      seedSlice({ id: 1, date: '2026-08-05', projectId: 10, entity: 'src/a.ts', totalSeconds: 1800 });
      // A zero-second slice on an otherwise empty day.
      seedSlice({ id: 2, date: '2026-08-09', projectId: 10, entity: 'src/b.ts', totalSeconds: 0 });
    });

    it('counts only days that actually carry time', () => {
      const overview = getOverviewData(db, classification);

      expect(overview.dateSpan.activeDays).toBe(2);
      expect(overview.dateSpan.minDate).toBe('2026-08-03');
      expect(overview.dateSpan.maxDate).toBe('2026-08-05');
      expect(overview.isEmpty).toBe(false);
    });

    it('lists only positive or slice-bearing days in recent activity', () => {
      const dates = getOverviewData(db, classification).recentActivity.map((d) => d.date);

      expect(dates).toEqual(['2026-08-05', '2026-08-03']);
      expect(dates).not.toContain('2026-08-01');
      expect(dates).not.toContain('2026-08-09');
      expect(getOverviewData(db, classification).recentActivity.length).toBeLessThanOrEqual(14);
    });
  });

  describe('12. Mixed Project Classification Is Never Mislabelled', () => {
    beforeEach(() => {
      seedImport();
      seedProject(10, 'mixed-proj');
      seedProject(20, 'pure-work');
      seedProject(30, 'no-rules');

      // mixed-proj: one work slice by rule, one slice left unclassified.
      seedSlice({ id: 1, date: '2026-09-01', projectId: 10, entity: 'work.ts', totalSeconds: 5000 });
      seedSlice({ id: 2, date: '2026-09-01', projectId: 10, entity: 'unknown.ts', totalSeconds: 10 });
      seedSlice({ id: 3, date: '2026-09-01', projectId: 20, entity: 'a.ts', totalSeconds: 4000 });
      seedSlice({ id: 4, date: '2026-09-01', projectId: 30, entity: 'b.ts', totalSeconds: 3000 });

      classification.unsafeSeedRule({
        name: 'Work by entity',
        classification: 'work',
        selectorType: 'entity',
        selectorValue: 'work.ts'
      });
      classification.unsafeSeedRule({
        name: 'Pure work project',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'pure-work'
      });
    });

    it("labels a partly-classified project 'mixed' rather than borrowing the majority label", () => {
      const byName = new Map(
        getOverviewData(db, classification).topProjects.map((p) => [p.name, p])
      );

      const mixed = byName.get('mixed-proj');
      expect(mixed?.classification).toBe('mixed');
      expect(mixed?.workSeconds).toBe(5000);
      expect(mixed?.unclassifiedSeconds).toBe(10);

      // A project with no classified time at all stays 'unclassified'.
      expect(byName.get('no-rules')?.classification).toBe('unclassified');
      // A wholly-classified project keeps its real label.
      expect(byName.get('pure-work')?.classification).toBe('work');
    });
  });

  describe('13. Database Path Disclosure', () => {
    it('reveals at most a generic ./data marker plus the filename', () => {
      expect(abbreviateDatabasePath('/Users/leo/secret-client/dev/data/work-times.sqlite')).toBe(
        './data/work-times.sqlite'
      );
      // Directories nested under data/ are deployment detail and are dropped too.
      expect(
        abbreviateDatabasePath('/srv/customer-acme/data/tenants/acme-prod/work-times.sqlite')
      ).toBe('./data/work-times.sqlite');
      // Without a data/ segment, only the filename survives.
      expect(abbreviateDatabasePath('/home/operator-jsmith/db/work-times.sqlite')).toBe(
        '.../work-times.sqlite'
      );
      expect(abbreviateDatabasePath(':memory:')).toBe(':memory:');

      for (const path of [
        '/Users/leo/secret-client/dev/data/work-times.sqlite',
        '/srv/customer-acme/data/tenants/acme-prod/work-times.sqlite',
        '/home/operator-jsmith/db/work-times.sqlite'
      ]) {
        const shown = abbreviateDatabasePath(path);
        expect(shown).not.toContain('/Users/');
        expect(shown).not.toContain('/home/');
        expect(shown).not.toContain('/srv/');
        expect(shown).not.toContain('secret-client');
        expect(shown).not.toContain('acme');
        expect(shown).not.toContain('operator-jsmith');
      }
    });
  });

  describe('7. Duration Formatting Utilities', () => {
    it('formats durations cleanly into hours, minutes, and seconds', () => {
      expect(formatDuration(0)).toBe('0m');
      expect(formatDuration(45)).toBe('45s');
      expect(formatDuration(90)).toBe('1m 30s');
      expect(formatDuration(3600)).toBe('1h');
      expect(formatDuration(3660)).toBe('1h 1m');
      expect(formatDuration(7200)).toBe('2h');
    });
  });
});
