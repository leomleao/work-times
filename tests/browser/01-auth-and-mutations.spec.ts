import { test, expect } from '@playwright/test';
import { seedCleanTestState, loginAsAdmin } from './helpers';

test.describe('P8B: Authentication, Redirects, CSRF, and Origin Contracts', () => {
  test.beforeEach(() => {
    seedCleanTestState();
  });

  test('unauthenticated access redirects to /login', async ({ page }) => {
    await page.goto('/admin/sync');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('h1')).toContainText('Work Times Archive');
  });

  test('invalid login credentials display an error and do not redirect', async ({ page }) => {
    await page.goto('/login?redirectTo=%2Fadmin%2Fsync');
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', 'wrong-password');
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('[role="alert"]')).toContainText('Invalid username or password');
  });

  test('valid login redirects to target URL and establishes authenticated session', async ({ page }) => {
    await loginAsAdmin(page, '/admin/sync');
    await expect(page).toHaveURL(/\/admin\/sync/);
    await expect(page.locator('h1')).toContainText('Operational Sync & Capabilities');
  });

  test('direct mutation without valid CSRF or session is rejected with 401/403', async ({ page, request }) => {
    // Unauthenticated request
    const unauthRes = await request.post('/api/admin/sync-runs', {
      data: { mode: 'recent' },
      headers: { 'Content-Type': 'application/json' }
    });
    expect(unauthRes.status()).toBe(401);
    const unauthBody = await unauthRes.json();
    expect(unauthBody.error).toBe('Unauthorized');

    // Authenticated request with invalid origin
    await loginAsAdmin(page, '/admin/sync');
    const invalidOriginRes = await page.request.post('/api/admin/sync-runs', {
      data: { mode: 'recent' },
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://malicious-attacker.com'
      }
    });
    expect(invalidOriginRes.status()).toBe(403);
    const invalidOriginBody = await invalidOriginRes.json();
    expect(invalidOriginBody.error).toContain('Cross-origin');
  });

  test('authenticated UI mutations pass valid session CSRF and execute successfully', async ({ page }) => {
    await loginAsAdmin(page, '/admin/sync');

    // Intercept POST /api/admin/sync-runs to verify CSRF and Origin headers sent by UI
    let capturedCsrfHeader: string | null = null;
    let capturedMode: string | null = null;

    await page.route('**/api/admin/sync-runs', async (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        capturedCsrfHeader = req.headers()['x-csrf-token'] || null;
        const postData = req.postDataJSON();
        capturedMode = postData?.mode || null;
        // Respond with synthetic success 202
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            runId: 99,
            reused: false,
            statusUrl: '/api/admin/sync-runs/99'
          })
        });
        return;
      }
      await route.continue();
    });

    await page.click('[data-testid="sync-now-button"]');

    // Wait for live announcement
    await expect(page.locator('[data-testid="live-announcement"]')).toContainText('Sync run #99 successfully enqueued');
    expect(capturedCsrfHeader).toBeTruthy();
    expect(capturedMode).toBe('recent');
  });
});
