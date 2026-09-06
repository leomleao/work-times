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
  formatDuration
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

  beforeEach(() => {
    // Fresh in-memory database with migrations
    db = openDatabase({ path: ':memory:' });
    classification = new SqliteClassificationService(db);

    mockConfig = {
      databasePath: '/Users/test-user/secret-path/dev/work-times/data/work-times.sqlite',
      wakatimeApiKey: null,
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

    it('sync page returns honest empty state and states API key is unconfigured', () => {
      const syncData = getSyncData(db, mockConfig);

      expect(syncData.isEmpty).toBe(true);
      expect(syncData.syncRuns).toEqual([]);
      expect(syncData.syncDays).toEqual([]);
      expect(syncData.apiKeyConfigured).toBe(false);
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

      // Bounded limit: requests over 100 default back to 50
      const bounded = getActivityData(db, classification, { pageSize: 999 });
      expect(bounded.pagination.pageSize).toBe(50);
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
      expect((settings as any).wakatimeApiKey).toBeUndefined();
      expect((settings as any).sessionSecret).toBeUndefined();

      // Non-secret booleans and public info only
      expect(settings.wakatimeApiKeyConfigured).toBe(false);
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
