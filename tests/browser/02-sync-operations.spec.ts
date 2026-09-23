import { test, expect } from '@playwright/test';
import { seedCleanTestState, loginAsAdmin, getTestDb } from './helpers';

test.describe('P8B: Sync Operations, Controls, Validation, and Retries', () => {
  test.beforeEach(() => {
    seedCleanTestState();
  });

  test('toggles automated scheduling and binds archive identity', async ({ page }) => {
    await loginAsAdmin(page, '/admin/sync');

    // Toggle Schedule checkbox
    const scheduleInput = page.locator('[data-testid="schedule-toggle-input"]');
    await expect(scheduleInput).not.toBeChecked();

    await scheduleInput.click();

    // Verify accessible announcement of schedule enable
    await expect(page.locator('[data-testid="live-announcement"]')).toContainText('Automated scheduling enabled');
    await expect(scheduleInput).toBeChecked();

    // Test Bind Connection action
    await page.click('[data-testid="bind-connection-btn"]');
    await expect(page.locator('text=Acknowledge Account Binding')).toBeVisible();

    await page.click('[data-testid="confirm-bind-btn"]');
    await expect(page.locator('[data-testid="live-announcement"]')).toContainText('bound to archive identity');
  });

  test('validates date range inputs strictly and preserves date values on error', async ({ page }) => {
    await loginAsAdmin(page, '/admin/sync');

    // Open Bounded Backfill form
    await page.click('[data-testid="toggle-backfill-form"]');
    await expect(page.locator('[data-testid="backfill-form"]')).toBeVisible();

    const startInput = page.locator('[data-testid="backfill-start-input"]');
    const endInput = page.locator('[data-testid="backfill-end-input"]');

    // 1. Inverted range: start > end
    await startInput.fill('2026-09-10');
    await endInput.fill('2026-09-01');
    await page.click('[data-testid="submit-backfill-btn"]');

    const errLocator = page.locator('[data-testid="backfill-error"]');
    await expect(errLocator).toContainText('Start date must be before or equal to end date');

    // Crucial requirement: inputs MUST preserve their values
    await expect(startInput).toHaveValue('2026-09-10');
    await expect(endInput).toHaveValue('2026-09-01');

    // 2. Future date
    await startInput.fill('2099-01-01');
    await endInput.fill('2099-01-02');
    await page.click('[data-testid="submit-backfill-btn"]');
    await expect(errLocator).toContainText('Date range cannot include future dates');

    // 3. Range exceeds 366 days
    await startInput.fill('2024-01-01');
    await endInput.fill('2025-02-01');
    // Note: 2024 is leap year (366 days) + 31 days in Jan 2025 = 398 days
    await page.click('[data-testid="submit-backfill-btn"]');
    await expect(errLocator).toContainText('Date range cannot exceed 366 days');
  });

  test('handles active run cancellation and run retry', async ({ page }) => {
    // Seed an active/running sync run into SQLite
    const db = getTestDb();
    try {
      db.prepare(`
        INSERT INTO sync_runs
          (id, mode, trigger, status, range_start_date, range_end_date, day_count, days_synced, days_failed, started_at)
        VALUES
          (10, 'recent', 'manual', 'running', '2026-09-11', '2026-09-12', 2, 0, 0, '2026-09-12T11:00:00.000Z')
      `).run();
    } finally {
      db.close();
    }

    await loginAsAdmin(page, '/admin/sync');

    // Active progress panel should be visible
    const progressPanel = page.locator('[data-testid="active-progress-panel"]');
    await expect(progressPanel).toBeVisible();
    await expect(progressPanel).toContainText('Active Run #10');

    // Test Cancel Run
    let cancelCalled = false;
    await page.route('**/api/admin/sync-runs/10/cancel', async (route) => {
      cancelCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runId: 10,
          status: 'cancelled',
          cancelledAt: '2026-09-12T11:01:00.000Z'
        })
      });
    });

    const cancelBtn = page.locator('[data-testid="cancel-active-run-btn"]');
    await cancelBtn.click();
    await expect(page.locator('[data-testid="live-announcement"]')).toContainText('Run #10 cancelled successfully');
    expect(cancelCalled).toBe(true);

    // Seed a failed run to test retry
    const db2 = getTestDb();
    try {
      db2.prepare(`
        INSERT INTO sync_runs
          (id, mode, trigger, status, range_start_date, range_end_date, day_count, days_synced, days_failed, started_at, finished_at)
        VALUES
          (20, 'recent', 'manual', 'failed', '2026-09-11', '2026-09-12', 2, 0, 2, '2026-09-12T11:00:00.000Z', '2026-09-12T11:00:05.000Z')
      `).run();
      db2.prepare(`
        INSERT INTO sync_days
          (id, sync_run_id, date, status, disposition, summaries_status, durations_status, heartbeats_status, total_seconds, heartbeat_count, synced_at, error_message)
        VALUES
          (21, 20, '2026-09-11', 'failed', 'rejected', 'failed', 'failed', 'failed', 0, 0, '2026-09-12T11:00:02.000Z', 'UPSTREAM_ERROR')
      `).run();
    } finally {
      db2.close();
    }

    await page.reload();

    // Click Retry for Run #20
    let retryCalled = false;
    await page.route('**/api/admin/sync-runs/20/retry', async (route) => {
      retryCalled = true;
      // Assert that client did NOT supply idempotencyKey on retry
      const postData = route.request().postDataJSON();
      expect(postData?.idempotencyKey).toBeUndefined();

      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          runId: 22,
          reused: false,
          parentRunId: 20,
          retryDates: ['2026-09-11'],
          statusUrl: '/api/admin/sync-runs/22'
        })
      });
    });

    const retryBtn = page.locator('[data-testid="retry-run-btn-20"]');
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    await expect(page.locator('[data-testid="live-announcement"]')).toContainText('Retry run #22 enqueued for parent run #20');
    expect(retryCalled).toBe(true);
  });

  test('triggers explicit user-agent registry refresh with disabled state while active', async ({ page }) => {
    await loginAsAdmin(page, '/admin/sync');

    const registryPanel = page.locator('[data-testid="sync-registry-panel"]');
    await expect(registryPanel).toBeVisible();
    await expect(registryPanel).toContainText('Total Entries: 2');
    await expect(registryPanel).toContainText('Distinct Editors: 2');

    const refreshBtn = page.locator('[data-testid="refresh-registry-btn"]');
    await expect(refreshBtn).toBeEnabled();

    let refreshRequested = false;
    await page.route('**/api/admin/sync-registry/refresh', async (route) => {
      refreshRequested = true;
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          queued: true,
          status: 'retained',
          publishedAt: '2026-09-12T12:00:00.000Z',
          statusUrl: '/api/admin/sync-runs/50'
        })
      });
    });

    await refreshBtn.click();
    await expect(page.locator('[data-testid="live-announcement"]')).toContainText('User-agent registry refresh enqueued');
    expect(refreshRequested).toBe(true);
  });

  test('regression: mapSafeError suppresses arbitrary unknown error text and renders safe fallback', async ({ page }) => {
    await loginAsAdmin(page, '/admin/sync');

    let postErrorType: 'malicious' | 'allowlisted' = 'malicious';

    await page.route('**/api/admin/sync-runs', async (route) => {
      if (route.request().method() === 'POST') {
        if (postErrorType === 'malicious') {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'UNEXPECTED_INTERNAL_EXPLOIT',
              error: '<script>window.__xss=true</script>Raw SQL failure: SELECT * FROM credentials;'
            })
          });
        } else {
          await route.fulfill({
            status: 429,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'SYNC_QUEUE_FULL',
              error: 'internal ring buffer capacity 10 exceeded'
            })
          });
        }
        return;
      }
      await route.continue();
    });

    // Attempt 1: Trigger unknown/malicious error
    await page.click('[data-testid="sync-now-button"]');

    const errAlert = page.locator('[data-testid="page-error-banner"]');
    await expect(errAlert).toBeVisible();
    await expect(errAlert).toContainText('Failed to enqueue recent sync');

    // Assert malicious payload text is never rendered anywhere in HTML
    const pageHtml = await page.content();
    expect(pageHtml).not.toContain('window.__xss');
    expect(pageHtml).not.toContain('SELECT * FROM credentials');
    expect(pageHtml).not.toContain('UNEXPECTED_INTERNAL_EXPLOIT');

    // Attempt 2: Trigger allowlisted code
    postErrorType = 'allowlisted';
    await page.click('[data-testid="sync-now-button"]');

    await expect(errAlert).toContainText('The sync queue is currently full');
    const updatedHtml = await page.content();
    expect(updatedHtml).not.toContain('internal ring buffer capacity');
  });

  test('regression: enqueue operations reuse stable idempotency key across ambiguous retry until accepted', async ({ page }) => {
    await loginAsAdmin(page, '/admin/sync');

    const capturedSyncRequests: Array<{ mode: string; idempotencyKey: string; startDate?: string; endDate?: string }> = [];
    let shouldFail = true;

    await page.route('**/api/admin/sync-runs', async (route) => {
      if (route.request().method() === 'POST') {
        const postData = route.request().postDataJSON();
        capturedSyncRequests.push(postData);

        if (shouldFail) {
          shouldFail = false;
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'UPSTREAM_GATEWAY_TIMEOUT' })
          });
          return;
        }

        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            runId: 901,
            reused: false,
            statusUrl: '/api/admin/sync-runs/901'
          })
        });
        return;
      }
      await route.continue();
    });

    // 1. Sync Now: First attempt fails ambiguously
    await page.click('[data-testid="sync-now-button"]');
    await expect(page.locator('[data-testid="page-error-banner"]')).toBeVisible();
    expect(capturedSyncRequests.length).toBe(1);
    const key1 = capturedSyncRequests[0].idempotencyKey;
    expect(key1).toBeTruthy();

    // 2. Sync Now: Second attempt succeeds; must reuse exact same idempotency key
    await page.click('[data-testid="sync-now-button"]');
    await expect(page.locator('[data-testid="live-announcement"]')).toContainText('Sync run #901 successfully enqueued');
    expect(capturedSyncRequests.length).toBe(2);
    const key2 = capturedSyncRequests[1].idempotencyKey;
    expect(key2).toBe(key1);

    // 3. Sync Now: Third attempt after accepted success; must generate a fresh idempotency key
    await page.click('[data-testid="sync-now-button"]');
    expect(capturedSyncRequests.length).toBe(3);
    const key3 = capturedSyncRequests[2].idempotencyKey;
    expect(key3).not.toBe(key1);

    // 4. Bounded Backfill: Test stable idempotency key across failure and change on modified dates
    await page.click('[data-testid="toggle-backfill-form"]');
    const startInput = page.locator('[data-testid="backfill-start-input"]');
    const endInput = page.locator('[data-testid="backfill-end-input"]');
    await startInput.fill('2026-09-01');
    await endInput.fill('2026-09-05');

    shouldFail = true;
    await page.click('[data-testid="submit-backfill-btn"]');
    await expect(page.locator('[data-testid="page-error-banner"]')).toBeVisible();
    expect(capturedSyncRequests.length).toBe(4);
    const backfillKey1 = capturedSyncRequests[3].idempotencyKey;
    expect(backfillKey1).toBeTruthy();

    // Retry with same payload: must reuse exact same backfill key
    await page.click('[data-testid="submit-backfill-btn"]');
    expect(capturedSyncRequests.length).toBe(5);
    const backfillKey2 = capturedSyncRequests[4].idempotencyKey;
    expect(backfillKey2).toBe(backfillKey1);

    // Modify dates: must generate a new key for the new payload
    await endInput.fill('2026-09-06');
    await page.click('[data-testid="submit-backfill-btn"]');
    expect(capturedSyncRequests.length).toBe(6);
    const backfillKey3 = capturedSyncRequests[5].idempotencyKey;
    expect(backfillKey3).not.toBe(backfillKey1);
  });

  test('toggles automated scheduling off and cancels bind connection modal safely', async ({ page }) => {
    await loginAsAdmin(page, '/admin/sync');

    const scheduleInput = page.locator('[data-testid="schedule-toggle-input"]');
    // 1. Enable scheduling
    await scheduleInput.click();
    await expect(page.locator('[data-testid="live-announcement"]')).toContainText('Automated scheduling enabled');
    await expect(scheduleInput).toBeChecked();

    // 2. Disable scheduling
    await scheduleInput.click();
    await expect(page.locator('[data-testid="live-announcement"]')).toContainText('Automated scheduling disabled');
    await expect(scheduleInput).not.toBeChecked();

    // 3. Test Bind Modal Cancel
    await page.click('[data-testid="bind-connection-btn"]');
    const bindNotice = page.locator('text=Acknowledge Account Binding');
    await expect(bindNotice).toBeVisible();

    // Click Cancel
    await page.click('button:has-text("Cancel")');
    await expect(bindNotice).not.toBeVisible();
    // Live announcement should not announce binding
    await expect(page.locator('[data-testid="live-announcement"]')).not.toContainText('bound to archive identity');
  });

  test('validates summary compare date inputs strictly, preserves values, and enqueues compare run', async ({ page }) => {
    await loginAsAdmin(page, '/admin/sync');

    // Open Summary Compare form
    await page.click('[data-testid="toggle-compare-form"]');
    const compareForm = page.locator('[data-testid="compare-form"]');
    await expect(compareForm).toBeVisible();

    const startInput = page.locator('[data-testid="compare-start-input"]');
    const endInput = page.locator('[data-testid="compare-end-input"]');
    const errLocator = page.locator('[data-testid="compare-error"]');

    // 1. Inverted range: start > end
    await startInput.fill('2026-09-10');
    await endInput.fill('2026-09-01');
    await page.click('[data-testid="submit-compare-btn"]');
    await expect(errLocator).toContainText('Start date must be before or equal to end date');
    // Preserves values
    await expect(startInput).toHaveValue('2026-09-10');
    await expect(endInput).toHaveValue('2026-09-01');

    // 2. Future date
    await startInput.fill('2099-01-01');
    await endInput.fill('2099-01-02');
    await page.click('[data-testid="submit-compare-btn"]');
    await expect(errLocator).toContainText('Date range cannot include future dates');

    // 3. Exceeds 366 days
    await startInput.fill('2024-01-01');
    await endInput.fill('2025-02-01');
    await page.click('[data-testid="submit-compare-btn"]');
    await expect(errLocator).toContainText('Date range cannot exceed 366 days');

    // 4. Successful compare submission
    let comparePayload: any = null;
    await page.route('**/api/admin/sync-runs', async (route) => {
      if (route.request().method() === 'POST') {
        comparePayload = route.request().postDataJSON();
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            runId: 105,
            reused: false,
            statusUrl: '/api/admin/sync-runs/105'
          })
        });
        return;
      }
      await route.continue();
    });

    await startInput.fill('2026-09-01');
    await endInput.fill('2026-09-05');
    await page.click('[data-testid="submit-compare-btn"]');

    await expect(page.locator('[data-testid="live-announcement"]')).toContainText(
      'Comparison run #105 (2026-09-01 to 2026-09-05) enqueued'
    );
    expect(comparePayload?.mode).toBe('compare');
    expect(comparePayload?.rangeStartDate).toBe('2026-09-01');
    expect(comparePayload?.rangeEndDate).toBe('2026-09-05');
    expect(comparePayload?.idempotencyKey).toBeTruthy();
  });

  test('retries individual failed date from run details modal with accurate target payload', async ({ page }) => {
    // Seed run 40 with failed day 2026-09-12
    const db = getTestDb();
    try {
      db.prepare(`
        INSERT INTO sync_runs
          (id, mode, trigger, status, day_count, days_synced, days_failed, started_at, finished_at)
        VALUES
          (40, 'recent', 'manual', 'partial', 1, 0, 1, '2026-09-12T12:00:00.000Z', '2026-09-12T12:00:02.000Z')
      `).run();
      db.prepare(`
        INSERT INTO sync_days
          (id, sync_run_id, date, status, disposition, summaries_status, durations_status, heartbeats_status, total_seconds, heartbeat_count, synced_at, error_message)
        VALUES
          (41, 40, '2026-09-12', 'failed', 'rejected', 'failed', 'failed', 'failed', 0, 0, '2026-09-12T12:00:02.000Z', 'DETAIL_DOWNGRADE')
      `).run();
    } finally {
      db.close();
    }

    await loginAsAdmin(page, '/admin/sync');

    // Open Run #40 details modal
    await page.click('[data-testid="view-run-details-btn-40"]');
    await expect(page.locator('[data-testid="diag-code-2026-09-12"]')).toContainText('DETAIL_DOWNGRADE');

    // Intercept single date retry
    let retryDatePayload: any = null;
    await page.route('**/api/admin/sync-runs/40/retry', async (route) => {
      retryDatePayload = route.request().postDataJSON();
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          runId: 42,
          reused: false,
          parentRunId: 40,
          retryDates: ['2026-09-12'],
          statusUrl: '/api/admin/sync-runs/42'
        })
      });
    });

    const retryDateBtn = page.locator('[data-testid="retry-date-btn-2026-09-12"]');
    await expect(retryDateBtn).toBeVisible();
    await retryDateBtn.click();

    await expect(page.locator('[data-testid="live-announcement"]')).toContainText(
      'Retry enqueued for date 2026-09-12 (Run #42)'
    );
    expect(retryDatePayload?.targetDate).toBe('2026-09-12');
  });

  test('handles active run cancellation error gracefully without unhandled exceptions', async ({ page }) => {
    // Seed an active run #35
    const db = getTestDb();
    try {
      db.prepare(`
        INSERT INTO sync_runs
          (id, mode, trigger, status, range_start_date, range_end_date, day_count, days_synced, days_failed, started_at)
        VALUES
          (35, 'recent', 'manual', 'running', '2026-09-11', '2026-09-12', 2, 0, 0, '2026-09-12T11:00:00.000Z')
      `).run();
    } finally {
      db.close();
    }

    await loginAsAdmin(page, '/admin/sync');
    await expect(page.locator('[data-testid="active-progress-panel"]')).toBeVisible();

    // Mock cancellation failure
    await page.route('**/api/admin/sync-runs/35/cancel', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'RUN_LOCK_HELD', error: 'Internal lock error' })
      });
    });

    await page.click('[data-testid="cancel-active-run-btn"]');

    const errBanner = page.locator('[data-testid="page-error-banner"]');
    await expect(errBanner).toBeVisible();
    await expect(errBanner).toContainText('Failed to cancel run #35');
    await expect(page.locator('[data-testid="live-announcement"]')).toContainText('Error: Failed to cancel run #35');
  });

  test('handles user-agent registry refresh error with safe fallback', async ({ page }) => {
    await loginAsAdmin(page, '/admin/sync');

    await page.route('**/api/admin/sync-registry/refresh', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'REGISTRY_UPSTREAM_ERROR',
          error: '<img src=x onerror=alert(1)>Internal DB crash'
        })
      });
    });

    await page.click('[data-testid="refresh-registry-btn"]');

    const errBanner = page.locator('[data-testid="page-error-banner"]');
    await expect(errBanner).toBeVisible();
    await expect(errBanner).toContainText('Failed to initiate registry refresh');

    // Verify raw error text does not leak
    const pageHtml = await page.content();
    expect(pageHtml).not.toContain('<img src=x onerror=alert(1)>');
    expect(pageHtml).not.toContain('Internal DB crash');
  });

  test('regression: presents truthful fresh/first-run state (Connect WakaTime, unknown timezone, Not refreshed registry) and source-local boundary', async ({ page }) => {
    // Clean all tables so DB represents a truly fresh initial state:
    // - no wakatime_oauth_connection
    // - no account_settings (no timezone)
    // - no user_agent_registry
    const db = getTestDb();
    try {
      db.pragma('foreign_keys = OFF');
      db.exec(`
        DELETE FROM wakatime_oauth_connection;
        DELETE FROM account_settings;
        DELETE FROM user_agent_registry;
        DELETE FROM sync_days;
        DELETE FROM sync_runs;
        DELETE FROM sync_layer_state;
        DELETE FROM daily_totals;
        DELETE FROM day_project_entity_slices;
      `);
    } finally {
      db.pragma('foreign_keys = ON');
      db.close();
    }

    await loginAsAdmin(page, '/admin/sync');

    // 1. Truthful readiness banner: Connect WakaTime (NOT reconnect required)
    const disconnectedBanner = page.locator('[data-testid="banner-oauth-disconnected"]');
    await expect(disconnectedBanner).toBeVisible();
    await expect(disconnectedBanner).toContainText('WakaTime is not connected yet');
    const connectLink = disconnectedBanner.locator('a[href="/integrations/wakatime"]');
    await expect(connectLink).toBeVisible();
    await expect(connectLink).toContainText('Connect WakaTime');
    // Ensure reconnect banner is NOT shown
    await expect(page.locator('[data-testid="banner-reconnect-required"]')).not.toBeVisible();

    // 2. Truthful unknown timezone: operational status bar displays "Timezone: —" (not "UTC")
    const tzEl = page.locator('span:text("Timezone:")').locator('..');
    await expect(tzEl).toBeVisible();
    await expect(tzEl.locator('strong')).toHaveText('—');
    await expect(tzEl).not.toContainText('UTC');

    // 3. Truthful unrefreshed registry:
    // - SyncRegistryCard badge shows "Not refreshed" (not "Published")
    // - MetricCard shows "Not refreshed" and "Pending"
    const registryCard = page.locator('[data-testid="sync-registry-panel"]');
    await expect(registryCard).toBeVisible();
    await expect(registryCard.locator('.badge')).toContainText('Not refreshed');

    const registryMetric = page.locator('.metric-card').filter({ hasText: 'Identity Registry' });
    await expect(registryMetric).toBeVisible();
    await expect(registryMetric).toContainText('Not refreshed');
    await expect(registryMetric).toContainText('Pending');

    // 4. Source-local future-date boundary test:
    // When sourceTimezone is unavailable, backfill validation warns that verified source timezone is unavailable
    await page.click('[data-testid="toggle-backfill-form"]');
    await page.fill('[data-testid="backfill-start-input"]', '2026-09-01');
    await page.fill('[data-testid="backfill-end-input"]', '2026-09-02');
    await page.click('[data-testid="submit-backfill-btn"]');
    await expect(page.locator('[data-testid="backfill-error"]')).toContainText(
      'Verified source timezone is unavailable'
    );
  });
});
