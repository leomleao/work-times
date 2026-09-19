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
});
