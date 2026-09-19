import { test, expect } from '@playwright/test';
import { seedCleanTestState, loginAsAdmin, getTestDb } from './helpers';

test.describe('P8B: Quality Projections, Pagination, Degradation, and Truthful Fidelity', () => {
  test.beforeEach(() => {
    seedCleanTestState();
  });

  test('paginates run date details (> 50 dates) with next/previous controls and page count updates', async ({ page }) => {
    // Seed run #100 with 55 dates
    const db = getTestDb();
    try {
      db.prepare(`
        INSERT INTO sync_runs
          (id, mode, trigger, status, range_start_date, range_end_date, day_count, days_synced, days_failed, started_at, finished_at)
        VALUES
          (100, 'backfill', 'manual', 'succeeded', '2026-07-01', '2026-08-24', 55, 55, 0, '2026-08-25T10:00:00.000Z', '2026-08-25T10:05:00.000Z')
      `).run();

      const insertDay = db.prepare(`
        INSERT INTO sync_days
          (id, sync_run_id, date, status, disposition, summaries_status, durations_status, heartbeats_status, total_seconds, heartbeat_count, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (let i = 1; i <= 55; i++) {
        const dateObj = new Date(Date.UTC(2026, 6, i));
        const dateStr = dateObj.toISOString().slice(0, 10);
        insertDay.run(1000 + i, 100, dateStr, 'succeeded', 'updated', 'succeeded', 'succeeded', 'succeeded', 3600, 10, '2026-08-25T10:00:00.000Z');
      }
    } finally {
      db.close();
    }

    await loginAsAdmin(page, '/admin/sync');

    // Click View Details on Run #100
    const viewBtn = page.locator('[data-testid="view-run-details-btn-100"]');
    await expect(viewBtn).toBeVisible();
    await viewBtn.click();

    // Verify modal pagination footer
    const nextBtn = page.locator('[data-testid="next-page-btn"]');
    const prevBtn = page.locator('[data-testid="prev-page-btn"]');

    // Page 1
    await expect(page.locator('text=Page 1 of 2')).toBeVisible();
    await expect(page.locator('text=55 total dates')).toBeVisible();
    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).toBeEnabled();

    // Navigate to Page 2
    await nextBtn.click();

    // Page 2
    await expect(page.locator('text=Page 2 of 2')).toBeVisible();
    await expect(nextBtn).toBeDisabled();
    await expect(prevBtn).toBeEnabled();

    // Navigate back to Page 1
    await prevBtn.click();
    await expect(page.locator('text=Page 1 of 2')).toBeVisible();
  });

  test('displays truthful rate-limit wait notice when rateLimitedUntil is set', async ({ page }) => {
    // Seed rate-limit retry wait into sync_layer_state
    const db = getTestDb();
    try {
      db.prepare(`
        INSERT INTO sync_layer_state
          (date, layer, next_retry_at, is_stale, has_detail_downgrade, has_restriction, has_failure)
        VALUES
          ('2026-09-12', 'durations', '2099-01-01T15:00:00.000Z', 0, 0, 0, 0)
      `).run();
    } finally {
      db.close();
    }

    await loginAsAdmin(page, '/admin/sync');

    const rateLimitBanner = page.locator('[data-testid="banner-rate-limited"]');
    await expect(rateLimitBanner).toBeVisible();
    await expect(rateLimitBanner).toContainText('Truthful rate limit wait active');
    await expect(rateLimitBanner).toContainText('Worker is paused and pacing requests');
  });

  test('displays concise degraded capabilities notice when durations or heartbeats are restricted', async ({ page }) => {
    // Seed degraded capabilities into app_settings & advisory codes into latest run
    const db = getTestDb();
    try {
      const policyState = {
        capabilities: {
          summaries: { status: 'available' },
          durations: { status: 'restricted' },
          heartbeats: { status: 'restricted' }
        },
        updatedAt: '2026-09-12T10:00:00.000Z'
      };
      db.prepare(`
        INSERT OR REPLACE INTO app_settings (key, value, updated_at)
        VALUES ('capability_policy_state', ?, '2026-09-12T10:00:00.000Z')
      `).run(JSON.stringify(policyState));

      db.prepare(`
        INSERT INTO sync_runs
          (id, mode, trigger, status, range_start_date, range_end_date, day_count, days_synced, days_failed, started_at, finished_at, advisory_codes)
        VALUES
          (200, 'recent', 'manual', 'succeeded', '2026-09-11', '2026-09-12', 2, 2, 0, '2026-09-12T12:00:00.000Z', '2026-09-12T12:00:05.000Z', 'PLAN_RESTRICTED')
      `).run();
    } finally {
      db.close();
    }

    await loginAsAdmin(page, '/admin/sync');

    const degradationBanner = page.locator('[data-testid="banner-degradation"]');
    await expect(degradationBanner).toBeVisible();
    await expect(degradationBanner).toContainText('Durations endpoint is restricted');
    await expect(degradationBanner).toContainText('Heartbeats endpoint is restricted');
    await expect(degradationBanner).toContainText('PLAN_RESTRICTED');

    // Accessibility & visual separation verification:
    // Ensure degradation sentences do not run together into "gracefully.Heartbeats"
    const bannerText = await degradationBanner.innerText();
    expect(bannerText).not.toContain('gracefully.Heartbeats');
    const degradationParagraphs = degradationBanner.locator('p');
    await expect(degradationParagraphs).toHaveCount(3);
    await expect(degradationParagraphs.nth(0)).toContainText('Durations endpoint is restricted on this plan');
    await expect(degradationParagraphs.nth(1)).toContainText('Heartbeats endpoint is restricted or unavailable');
    await expect(degradationParagraphs.nth(2)).toContainText('Active advisories: PLAN_RESTRICTED');
  });

  test('displays reconnect required notice and link when OAuth requires re-authorization', async ({ page }) => {
    // Seed AUTH_REVOKED status into sync_layer_state
    const db = getTestDb();
    try {
      db.prepare(`
        INSERT INTO sync_layer_state
          (date, layer, status_code, is_stale, has_detail_downgrade, has_restriction, has_failure)
        VALUES
          ('2026-09-12', 'durations', 'AUTH_REVOKED', 1, 0, 1, 1)
      `).run();
    } finally {
      db.close();
    }

    await loginAsAdmin(page, '/admin/sync');

    const reconnectBanner = page.locator('[data-testid="banner-reconnect-required"]');
    await expect(reconnectBanner).toBeVisible();
    await expect(reconnectBanner).toContainText('WakaTime reconnect required');
    const reconnectLink = reconnectBanner.locator('a[href="/integrations/wakatime"]');
    await expect(reconnectLink).toBeVisible();
  });

  test('renders partial run outcome badge accurately in runs history', async ({ page }) => {
    const db = getTestDb();
    try {
      db.prepare(`
        INSERT INTO sync_runs
          (id, mode, trigger, status, range_start_date, range_end_date, day_count, days_synced, days_failed, started_at, finished_at, summary)
        VALUES
          (101, 'recent', 'manual', 'partial', '2026-09-10', '2026-09-12', 3, 2, 1, '2026-09-12T11:00:00.000Z', '2026-09-12T11:00:05.000Z', 'Partial sync')
      `).run();
    } finally {
      db.close();
    }

    await loginAsAdmin(page, '/admin/sync');

    const runRow = page.locator('[data-testid="run-row-101"]');
    await expect(runRow).toBeVisible();
    await expect(runRow.locator('[data-testid="quality-badge"]')).toContainText('Partial');
  });

  test('strictly distinguishes verified-zero date from missing date on activity page', async ({ page }) => {
    const db = getTestDb();
    try {
      // 1. Seed 2026-09-08 as verified zero
      db.prepare(`
        INSERT INTO daily_totals (date, timezone, total_seconds, source_import_id, source_hash, grand_total_json)
        VALUES ('2026-09-08', 'Europe/London', 0, 1, 'hash-zero', '{}')
      `).run();

      db.prepare(`
        INSERT INTO sync_layer_state
          (date, layer, last_attempt_at, last_success_at, accepted_source_reference, accepted_snapshot_version, accepted_fidelity, accepted_content_hash, verified_timezone, is_stale, has_detail_downgrade, has_restriction, has_failure)
        VALUES
          ('2026-09-08', 'summaries', '2026-09-08T10:00:00.000Z', '2026-09-08T10:00:00.000Z', 'ref-zero', 1, 'verified_zero', 'hash-zero', 'Europe/London', 0, 0, 0, 0)
      `).run();
    } finally {
      db.close();
    }

    // Check Verified Zero date
    await loginAsAdmin(page, '/admin/activity?date=2026-09-08');
    const bannerZero = page.locator('[data-testid="activity-date-quality-banner"]');
    await expect(bannerZero).toBeVisible();
    await expect(bannerZero).toContainText('Date Quality (2026-09-08)');
    await expect(bannerZero.locator('[data-testid="quality-badge"]')).toContainText('Verified Zero');

    // Check Missing date (2026-09-07 not seeded)
    await page.goto('/admin/activity?date=2026-09-07');
    const bannerMissing = page.locator('[data-testid="activity-date-quality-banner"]');
    await expect(bannerMissing).toBeVisible();
    await expect(bannerMissing).toContainText('Date Quality (2026-09-07)');
    await expect(bannerMissing.locator('[data-testid="quality-badge"]')).toContainText('Missing');
  });

  test('displays stale date and archived detail preserved badges with descriptive indicators', async ({ page }) => {
    const db = getTestDb();
    try {
      // Seed 2026-09-06 as archived detail preserved (detail downgrade)
      db.prepare(`
        INSERT INTO daily_totals (date, timezone, total_seconds, source_import_id, source_hash, grand_total_json)
        VALUES ('2026-09-06', 'Europe/London', 1800, 1, 'hash-downgrade', '{}')
      `).run();

      db.prepare(`
        INSERT INTO sync_layer_state
          (date, layer, last_attempt_at, last_success_at, accepted_source_reference, accepted_snapshot_version, accepted_fidelity, accepted_content_hash, verified_timezone, is_stale, has_detail_downgrade, has_restriction, has_failure)
        VALUES
          ('2026-09-06', 'summaries', '2026-09-06T10:00:00.000Z', '2026-09-06T10:00:00.000Z', 'ref-dg', 1, 'coarse_project', 'hash-dg', 'Europe/London', 0, 1, 0, 0)
      `).run();

      // Seed 2026-09-05 as stale
      db.prepare(`
        INSERT INTO daily_totals (date, timezone, total_seconds, source_import_id, source_hash, grand_total_json)
        VALUES ('2026-09-05', 'Europe/London', 2400, 1, 'hash-stale', '{}')
      `).run();

      db.prepare(`
        INSERT INTO sync_layer_state
          (date, layer, last_attempt_at, last_success_at, accepted_source_reference, accepted_snapshot_version, accepted_fidelity, accepted_content_hash, verified_timezone, is_stale, has_detail_downgrade, has_restriction, has_failure)
        VALUES
          ('2026-09-05', 'summaries', '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', 'ref-stale', 1, 'entity_detail', 'hash-stale', 'Europe/London', 1, 0, 0, 0)
      `).run();
    } finally {
      db.close();
    }

    // Test Archived Detail Preserved on /admin/activity
    await loginAsAdmin(page, '/admin/activity?date=2026-09-06');
    const bannerPreserved = page.locator('[data-testid="activity-date-quality-banner"]');
    await expect(bannerPreserved).toBeVisible();
    await expect(bannerPreserved.locator('[data-testid="quality-badge"]')).toContainText('Archived Detail Preserved');
    await expect(bannerPreserved).toContainText('(Archived detail preserved: summary downgrade)');

    // Test Stale date on /admin/activity
    await page.goto('/admin/activity?date=2026-09-05');
    const bannerStale = page.locator('[data-testid="activity-date-quality-banner"]');
    await expect(bannerStale).toBeVisible();
    await expect(bannerStale.locator('[data-testid="quality-badge"]')).toContainText('Stale');
    await expect(bannerStale).toContainText('(Archive data is stale)');
  });
});
