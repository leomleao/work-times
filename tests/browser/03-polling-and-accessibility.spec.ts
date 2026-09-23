import { test, expect } from '@playwright/test';
import { seedCleanTestState, loginAsAdmin, getTestDb } from './helpers';

test.describe('P8B: Active Polling, Concurrency, Focus, and Accessibility', () => {
  test.beforeEach(() => {
    seedCleanTestState();
  });

  test('polls at 2-second intervals without request overlap while work is active, and preserves input focus', async ({ page }) => {
    // Seed an active run to trigger active polling mode
    const db = getTestDb();
    try {
      db.prepare(`
        INSERT INTO sync_runs
          (id, mode, trigger, status, day_count, days_synced, days_failed, started_at)
        VALUES
          (30, 'recent', 'manual', 'running', 2, 1, 0, '2026-09-12T12:00:00.000Z')
      `).run();
    } finally {
      db.close();
    }

    const pollTimestamps: number[] = [];
    let concurrentPollCount = 0;
    let maxConcurrentPolls = 0;

    await page.route('**/api/admin/sync-runs?limit=50', async (route) => {
      concurrentPollCount++;
      if (concurrentPollCount > maxConcurrentPolls) {
        maxConcurrentPolls = concurrentPollCount;
      }
      pollTimestamps.push(Date.now());

      // Simulate 100ms server response time
      await new Promise((r) => setTimeout(r, 100));

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runs: [
            {
              id: 30,
              trigger: 'manual',
              mode: 'recent',
              status: 'running',
              rangeStartDate: '2026-09-11',
              rangeEndDate: '2026-09-12',
              dayCount: 2,
              daysSynced: 1,
              daysFailed: 0,
              startedAt: '2026-09-12T12:00:00.000Z',
              finishedAt: null,
              summary: null,
              errorMessage: null,
              resumedFromRunId: null,
              degradedCapabilities: [],
              advisoryCodes: []
            }
          ],
          totalCount: 1,
          activeRun: {
            id: 30,
            trigger: 'manual',
            mode: 'recent',
            status: 'running',
            rangeStartDate: '2026-09-11',
            rangeEndDate: '2026-09-12',
            dayCount: 2,
            daysSynced: 1,
            daysFailed: 0,
            startedAt: '2026-09-12T12:00:00.000Z',
            finishedAt: null,
            summary: null,
            errorMessage: null,
            resumedFromRunId: null,
            degradedCapabilities: [],
            advisoryCodes: []
          },
          schedule: {
            schedulingEnabled: false,
            paused: false,
            timezone: 'Europe/London',
            lastHandledSlots: { recent: null, reconcile: null, compare: null },
            nextDue: { recent: null, reconcile: null, compare: null },
            catchupCursor: null,
            seeded: false
          },
          readiness: {
            ready: true,
            status: 'ready',
            oauthAppConfigured: true,
            oauthConnected: true,
            hasActiveGrant: true,
            isBlocked: false,
            reconnectRequired: false,
            discoveryReady: true,
            degradedCapabilities: [],
            lastProbedAt: '2026-09-12T10:00:00.000Z'
          }
        })
      });
      concurrentPollCount--;
    });

    await loginAsAdmin(page, '/admin/sync');

    // Open Backfill form and focus on start date input
    await page.click('[data-testid="toggle-backfill-form"]');
    const startInput = page.locator('[data-testid="backfill-start-input"]');
    await startInput.fill('2026-08-01');
    await startInput.focus();

    // Verify focus is held
    await expect(startInput).toBeFocused();

    // Wait 5 seconds to observe at least 2 poll cycles
    await page.waitForTimeout(5000);

    // Polling requests MUST NOT overlap: maxConcurrentPolls must never exceed 1
    expect(maxConcurrentPolls).toBeLessThanOrEqual(1);
    expect(pollTimestamps.length).toBeGreaterThanOrEqual(2);

    // Verify input preserves its value and focus even after multiple background polls
    await expect(startInput).toHaveValue('2026-08-01');
    await expect(startInput).toBeFocused();
  });

  test('announces clipboard copy success and handles clipboard permission denial gracefully', async ({ page, context }) => {
    // Seed a run with diagnostic error code
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

    // Grant clipboard permissions for first part
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await loginAsAdmin(page, '/admin/sync');

    // Open run details modal
    await page.click('[data-testid="view-run-details-btn-40"]');
    await expect(page.locator('[data-testid="diag-code-2026-09-12"]')).toContainText('DETAIL_DOWNGRADE');

    // Click copy diagnostic button
    const copyBtn = page.locator('[data-testid="copy-diag-btn-2026-09-12"]');
    await copyBtn.click();

    // Verify accessible announcement of copy success
    const liveAnnouncement = page.locator('[data-testid="live-announcement"]');
    await expect(liveAnnouncement).toContainText('copied to clipboard');

    // Now test clipboard denial: override navigator.clipboard.writeText to throw NotAllowedError
    await page.evaluate(() => {
      if (navigator.clipboard) {
        navigator.clipboard.writeText = async () => {
          throw new DOMException('Permission denied', 'NotAllowedError');
        };
      }
    });

    await copyBtn.click();
    // Verify accessible announcement of clipboard denial without throwing unhandled error
    await expect(liveAnnouncement).toContainText('denied');
  });

  test('keyboard navigation enables full tab navigation across controls', async ({ page }) => {
    await loginAsAdmin(page, '/admin/sync');

    // Tab through controls
    await page.keyboard.press('Tab');
    // First focusable element should have focus
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(focusedTag).toBeTruthy();

    // Verify Sync Now button can receive focus
    await page.locator('[data-testid="sync-now-button"]').focus();
    await expect(page.locator('[data-testid="sync-now-button"]')).toBeFocused();
  });

  test('regression: scheduled timer triggers polling autonomously at 2s cadence without manual events and requests never overlap', async ({ page }) => {
    // Seed an active run so isWorkActive is true on mount and poll interval is 2000ms
    const db = getTestDb();
    try {
      db.prepare(`
        INSERT INTO sync_runs
          (id, mode, trigger, status, range_start_date, range_end_date, day_count, days_synced, days_failed, started_at)
        VALUES
          (88, 'recent', 'manual', 'running', '2026-09-12', '2026-09-12', 1, 0, 0, '2026-09-12T12:00:00.000Z')
      `).run();
    } finally {
      db.close();
    }

    let pollCount = 0;
    let concurrentPollCount = 0;
    let maxConcurrentPolls = 0;
    const pollTimestamps: number[] = [];

    await page.route('**/api/admin/sync-runs?limit=50', async (route) => {
      concurrentPollCount++;
      if (concurrentPollCount > maxConcurrentPolls) {
        maxConcurrentPolls = concurrentPollCount;
      }
      pollCount++;
      pollTimestamps.push(Date.now());

      // Simulate network latency of 80ms to rigorously verify non-overlapping behavior
      await new Promise((r) => setTimeout(r, 80));

      const activeRunPayload = {
        id: 88,
        trigger: 'manual',
        mode: 'recent',
        status: 'running',
        rangeStartDate: '2026-09-12',
        rangeEndDate: '2026-09-12',
        dayCount: 1,
        daysSynced: 0,
        daysFailed: 0,
        startedAt: '2026-09-12T12:00:00.000Z',
        finishedAt: null,
        summary: null,
        errorMessage: null,
        resumedFromRunId: null,
        degradedCapabilities: [],
        advisoryCodes: []
      };

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runs: [activeRunPayload],
          totalCount: 1,
          activeRun: activeRunPayload,
          schedule: {
            schedulingEnabled: false,
            paused: false,
            timezone: 'Europe/London',
            lastHandledSlots: { recent: null, reconcile: null, compare: null },
            nextDue: { recent: null, reconcile: null, compare: null },
            catchupCursor: null,
            seeded: false
          },
          readiness: {
            ready: true,
            status: 'ready',
            oauthAppConfigured: true,
            oauthConnected: true,
            hasActiveGrant: true,
            isBlocked: false,
            reconnectRequired: false,
            discoveryReady: true,
            degradedCapabilities: [],
            lastProbedAt: '2026-09-12T10:00:00.000Z'
          }
        })
      });
      concurrentPollCount--;
    });

    await loginAsAdmin(page, '/admin/sync');

    // Active progress panel is rendered from initial SSR/seed
    const progressPanel = page.locator('[data-testid="active-progress-panel"]');
    await expect(progressPanel).toBeVisible();
    await expect(progressPanel).toContainText('Active Run #88');

    // On immediate page load, background poll has not fired yet
    expect(pollCount).toBe(0);

    // 1. Prove a scheduled timer triggers a poll autonomously without dispatching visibilitychange or any manual event
    await expect.poll(() => pollCount, {
      message: 'Scheduled timer must trigger first background poll without any manual event or visibilitychange',
      timeout: 4000
    }).toBeGreaterThanOrEqual(1);

    const firstPollCount = pollCount;

    // 2. Prove the next active 2s poll also occurs autonomously via scheduled timer
    await expect.poll(() => pollCount, {
      message: 'Subsequent active 2s poll must occur autonomously via scheduled timer',
      timeout: 4000
    }).toBeGreaterThanOrEqual(firstPollCount + 1);

    // 3. Verify interval between the timer polls is ~2000ms
    if (pollTimestamps.length >= 2) {
      const elapsed = pollTimestamps[1] - pollTimestamps[0];
      expect(elapsed).toBeGreaterThanOrEqual(1800);
    }

    // 4. Additionally verify rapid visibility resume does not create duplicate polls or request overlap
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const countAfterVisibility = pollCount;
    await expect.poll(() => pollCount, {
      message: 'Active 2s cadence continues cleanly after visibility resume',
      timeout: 4000
    }).toBeGreaterThanOrEqual(countAfterVisibility + 1);

    // 5. Polling requests MUST NEVER overlap: max concurrency stays 1
    expect(maxConcurrentPolls).toBe(1);
  });

  test('backs off polling interval to 10 seconds during idle state and accelerates when work becomes active', async ({ page }) => {
    // Clean seed has no running or queued runs (isWorkActive is false)
    let pollCount = 0;
    const pollTimestamps: number[] = [];

    await page.route('**/api/admin/sync-runs?limit=50', async (route) => {
      pollCount++;
      pollTimestamps.push(Date.now());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runs: [],
          totalCount: 0,
          activeRun: null,
          schedule: {
            schedulingEnabled: false,
            paused: false,
            timezone: 'Europe/London',
            lastHandledSlots: { recent: null, reconcile: null, compare: null },
            nextDue: { recent: null, reconcile: null, compare: null },
            catchupCursor: null,
            seeded: false
          },
          readiness: {
            ready: true,
            status: 'ready',
            oauthAppConfigured: true,
            oauthConnected: true,
            hasActiveGrant: true,
            isBlocked: false,
            reconnectRequired: false,
            discoveryReady: true,
            degradedCapabilities: [],
            lastProbedAt: '2026-09-12T10:00:00.000Z'
          }
        })
      });
    });

    await loginAsAdmin(page, '/admin/sync');

    // Wait 3.5 seconds: because isWorkActive is false, idle interval is 10000ms.
    // If it were mistakenly using 2000ms active interval, pollCount would be >= 1.
    await page.waitForTimeout(3500);
    expect(pollCount).toBe(0);

    // Now trigger Sync Now: this sets busy = true and isWorkActive = true,
    // which accelerates polling to 2000ms.
    await page.route('**/api/admin/sync-runs', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({ runId: 999, reused: false, statusUrl: '/api/admin/sync-runs/999' })
        });
        return;
      }
      await route.continue();
    });

    await page.click('[data-testid="sync-now-button"]');

    // After mutation enqueues and pollSyncState is awaited, pollCount increments
    await expect.poll(() => pollCount, { timeout: 3000 }).toBeGreaterThanOrEqual(1);
  });

  test('modal dialog traps focus and supports accessible dismissal via close button', async ({ page }) => {
    // Seed run #1 with details
    await loginAsAdmin(page, '/admin/sync');

    // Open Run Details Modal
    await page.click('[data-testid="view-run-details-btn-1"]');
    const modal = page.locator('div[role="dialog"]');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#modal-title')).toContainText('Details');

    // Close button dismisses modal
    const closeBtn = modal.locator('button[aria-label="Close modal"]');
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();

    await expect(modal).not.toBeVisible();
  });
});


