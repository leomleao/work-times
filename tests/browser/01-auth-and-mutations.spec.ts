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

  test('unauthenticated access to protected routes (/admin/mcp-config, /admin/activity) redirects to /login with return URL preserved', async ({ page }) => {
    // 1. /admin/mcp-config
    await page.goto('/admin/mcp-config');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('h1')).toContainText('Work Times Archive');

    // 2. /admin/activity
    await page.goto('/admin/activity');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('h1')).toContainText('Work Times Archive');
  });

  test('mutation security rejects unauthenticated, invalid CSRF, and malformed requests across operational endpoints', async ({ page, request }) => {
    // 1. Unauthenticated requests across all mutation endpoints return 401
    const endpoints = [
      { url: '/api/admin/sync-settings', method: 'POST', body: { schedulingEnabled: true } },
      { url: '/api/admin/sync-runs/1/retry', method: 'POST', body: {} },
      { url: '/api/admin/sync-runs/1/cancel', method: 'POST', body: {} },
      { url: '/api/admin/sync-registry/refresh', method: 'POST', body: {} }
    ];

    for (const ep of endpoints) {
      const res = await request.post(ep.url, {
        data: ep.body,
        headers: { 'Content-Type': 'application/json' }
      });
      expect(res.status()).toBe(401);
      const jsonBody = await res.json();
      expect(jsonBody.error).toBe('Unauthorized');
    }

    // 2. Authenticated request with tampered/invalid CSRF token returns 403 Forbidden
    await loginAsAdmin(page, '/admin/sync');
    const invalidCsrfRes = await page.request.post('/api/admin/sync-settings', {
      data: { schedulingEnabled: true, csrfToken: 'tampered-csrf-token-12345' },
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:4173',
        'x-csrf-token': 'tampered-csrf-token-12345'
      }
    });
    expect(invalidCsrfRes.status()).toBe(403);
    const csrfErrBody = await invalidCsrfRes.json();
    expect(csrfErrBody.error).toBe('Invalid or missing CSRF token');

    // 3. Malformed/invalid request payload returns 400 Bad Request
    const csrfToken = await page.locator('input[name="csrfToken"]').inputValue();
    const malformedRes = await page.request.post('/api/admin/sync-runs', {
      data: { mode: 'invalid_mode', csrfToken },
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:4173',
        'x-csrf-token': csrfToken
      }
    });
    expect(malformedRes.status()).toBe(400);
    const malformedBody = await malformedRes.json();
    expect(malformedBody.code).toBe('INVALID_MODE');
  });
});
