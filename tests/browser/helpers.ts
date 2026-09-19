import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export const TEST_DB_PATH = join(tmpdir(), 'work-times-p8b-playwright.sqlite');

export function getTestDb(): Database.Database {
  return new Database(TEST_DB_PATH);
}

export function seedCleanTestState(): void {
  const db = getTestDb();
  try {
    db.pragma('foreign_keys = OFF');

    // Clean dynamic test tables
    db.exec(`
      DELETE FROM sync_days;
      DELETE FROM sync_runs;
      DELETE FROM sync_layer_state;
      DELETE FROM day_project_entity_slices;
      DELETE FROM daily_totals;
      DELETE FROM daily_time_allocations;
      DELETE FROM classification_rules;
      DELETE FROM user_agent_registry;
      DELETE FROM projects;
      DELETE FROM source_imports;
      DELETE FROM app_settings WHERE key LIKE 'sync.%';
    `);

    // Ensure account settings with Europe/London
    db.prepare(`
      INSERT OR REPLACE INTO account_settings (wakatime_user_id, timezone, updated_at)
      VALUES ('test-user-1', 'Europe/London', '2026-09-01T00:00:00.000Z')
    `).run();

    // Ensure WakaTime OAuth connection (connected, generation 1)
    db.prepare(`
      INSERT OR REPLACE INTO wakatime_oauth_connection
        (id, generation, access_token_sealed, refresh_token_sealed, token_type, scopes, expires_at, connected_at, updated_at, bound_archive_identity, rebound_at)
      VALUES
        (1, 1, 'sealed-access-token', 'sealed-refresh-token', 'Bearer', '["email"]', '2099-01-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'archive-1', '2026-09-01T00:00:00.000Z')
    `).run();

    // Default app settings: scheduling disabled
    db.prepare(`
      INSERT OR REPLACE INTO app_settings (key, value, updated_at)
      VALUES ('sync.scheduling_enabled', 'false', '2026-09-01T00:00:00.000Z')
    `).run();

    // Seed authoritative User-Agent Registry
    const insertRegistry = db.prepare(`
      INSERT INTO user_agent_registry
        (id, editor, user_agent_value, os, version, is_historical, first_seen_at, last_seen_at, refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertRegistry.run(
      'a1b2c3d4-0000-0000-0000-000000000001',
      'VS Code',
      'vscode/1.80.0',
      'Macintosh',
      '1.80.0',
      0,
      '2026-09-01T00:00:00.000Z',
      '2026-09-12T00:00:00.000Z',
      '2026-09-12T12:00:00.000Z'
    );

    insertRegistry.run(
      'b2c3d4e5-0000-0000-0000-000000000002',
      'Neovim',
      'neovim/0.9.1',
      'Linux',
      '0.9.1',
      0,
      '2026-09-01T00:00:00.000Z',
      '2026-09-12T00:00:00.000Z',
      '2026-09-12T12:00:00.000Z'
    );

    // Seed Projects & Source Imports
    db.prepare(`
      INSERT OR REPLACE INTO source_imports (id, source_type, source_hash, byte_size, started_at, finished_at, status)
      VALUES (1, 'api_summaries', 'hash123', 100, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:01.000Z', 'completed')
    `).run();

    db.prepare(`
      INSERT OR REPLACE INTO projects (id, name, first_seen_at, last_seen_at)
      VALUES
        (1, 'Work Times', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
        (2, 'Client Project', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    `).run();

    // Seed Historical Sync Run 1 (Succeeded, 2 dates)
    db.prepare(`
      INSERT INTO sync_runs
        (id, mode, trigger, status, range_start_date, range_end_date, day_count, days_synced, days_failed, started_at, finished_at, summary)
      VALUES
        (1, 'recent', 'manual', 'succeeded', '2026-09-11', '2026-09-12', 2, 2, 0, '2026-09-12T10:00:00.000Z', '2026-09-12T10:00:05.000Z', 'Sync succeeded')
    `).run();

    // Dates for Run 1
    const insertDay = db.prepare(`
      INSERT INTO sync_days
        (id, sync_run_id, date, status, disposition, summaries_status, durations_status, heartbeats_status, total_seconds, heartbeat_count, synced_at, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertDay.run(1, 1, '2026-09-11', 'succeeded', 'updated', 'succeeded', 'succeeded', 'succeeded', 3600, 10, '2026-09-12T10:00:02.000Z', null);
    insertDay.run(2, 1, '2026-09-12', 'succeeded', 'updated', 'succeeded', 'succeeded', 'succeeded', 7200, 20, '2026-09-12T10:00:04.000Z', null);

    // Layer state for 2026-09-11 & 2026-09-12
    const insertLayer = db.prepare(`
      INSERT INTO sync_layer_state
        (date, layer, last_attempt_at, last_success_at, accepted_source_reference, accepted_snapshot_version, accepted_fidelity, accepted_content_hash, verified_timezone, is_stale, has_detail_downgrade, has_restriction, has_failure, status_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertLayer.run('2026-09-11', 'summaries', '2026-09-12T10:00:02.000Z', '2026-09-12T10:00:02.000Z', 'ref-1', 1, 'entity_detail', 'hash-11', 'Europe/London', 0, 0, 0, 0, null);
    insertLayer.run('2026-09-12', 'summaries', '2026-09-12T10:00:04.000Z', '2026-09-12T10:00:04.000Z', 'ref-2', 1, 'coarse_project', 'hash-12', 'Europe/London', 0, 0, 0, 0, null);

    // Seed Daily Totals
    db.prepare(`
      INSERT INTO daily_totals (date, timezone, total_seconds, source_import_id, source_hash, grand_total_json)
      VALUES
        ('2026-09-11', 'Europe/London', 3600, 1, 'hash-11', '{}'),
        ('2026-09-12', 'Europe/London', 7200, 1, 'hash-12', '{}')
    `).run();

    // Seed Slices
    const insertSlice = db.prepare(`
      INSERT INTO day_project_entity_slices
        (id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id, kind, snapshot_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertSlice.run(1, '2026-09-11', 1, 'src/lib/server/runtime.ts', 'file', 3600, 0, 1, 'entity', 1);
    insertSlice.run(2, '2026-09-12', 2, 'Client Project', 'unattributed', 7200, 0, 1, 'project_summary', 1);

    // Seed Rules
    const insertRule = db.prepare(`
      INSERT INTO classification_rules
        (id, name, classification, selector_type, selector_value, match_mode, priority, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertRule.run(
      'rule-project-work',
      'Work Times Project',
      'work',
      'project',
      'Work Times',
      'exact',
      10,
      1,
      '2026-09-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z'
    );

    insertRule.run(
      'rule-editor-vscode',
      'VS Code Rule',
      'work',
      'editor',
      'a1b2c3d4-0000-0000-0000-000000000001',
      'exact',
      5,
      1,
      '2026-09-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z'
    );

    insertRule.run(
      'rule-editor-unknown',
      'Unresolved Editor Rule',
      'personal',
      'editor',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      'exact',
      1,
      1,
      '2026-09-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z'
    );
  } finally {
    db.pragma('foreign_keys = ON');
    db.close();
  }
}

export async function loginAsAdmin(page: Page, redirectTo = '/admin/sync'): Promise<void> {
  await page.goto(`/login?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.fill('input[name="username"]', 'admin');
  await page.fill('input[name="password"]', 'admin-password-123');
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login')),
    page.click('button[type="submit"]')
  ]);
}
