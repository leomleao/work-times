import { test, expect } from '@playwright/test';
import { seedCleanTestState, loginAsAdmin } from './helpers';

test.describe('P8B: Classify Preservation, Editor Registry Labels, Privacy, and Mobile Presentation', () => {
  test.beforeEach(() => {
    seedCleanTestState();
  });

  test('preserves existing classification tabs: suggestions queue, active rules, overrides, and audit log', async ({ page }) => {
    await loginAsAdmin(page, '/admin/classify');

    // 1. Suggestions Queue Tab
    await expect(page.locator('button:has-text("Suggestions Queue")')).toBeVisible();
    await expect(page.locator('h1')).toContainText('Teach the archive what counts as work.');

    // 2. Switch to Active Rules Tab
    await page.click('button:has-text("Active Rules")');
    await expect(page.locator('h2:has-text("All Classification Rules")')).toBeVisible();
    await expect(page.locator('text=Work Times Project')).toBeVisible();

    // 3. Switch to Slice Overrides Tab
    await page.click('button:has-text("Slice Overrides")');
    await expect(page.locator('h2:has-text("Single-Slice Overrides")')).toBeVisible();

    // 4. Switch to Audit Log (Revisions) Tab
    await page.click('button:has-text("Audit Log")');
    await expect(page.locator('h2:has-text("Classification Revisions")')).toBeVisible();
  });

  test('resolves friendly editor registry label with short UUID, falls back to unresolved for unknown, and exposes full UUID accessibly', async ({ page }) => {
    await loginAsAdmin(page, '/admin/classify?tab=rules');

    // Wait for Active Rules panel to load
    await expect(page.locator('h2:has-text("All Classification Rules")')).toBeVisible();

    // 1. Registered Editor: VS Code with ID a1b2c3d4-0000-0000-0000-000000000001
    // Expected display text: VS Code (a1b2c3d4)
    const knownEditorCell = page.locator('code:has-text("VS Code (a1b2c3d4)")');
    await expect(knownEditorCell).toBeVisible();

    // Verify accessibility: title and aria-label must expose the full canonical UUID
    await expect(knownEditorCell).toHaveAttribute('title', 'a1b2c3d4-0000-0000-0000-000000000001');
    await expect(knownEditorCell).toHaveAttribute(
      'aria-label',
      'Editor selector: a1b2c3d4-0000-0000-0000-000000000001'
    );

    // 2. Unregistered Editor: ffffffff-ffff-ffff-ffff-ffffffffffff
    // Expected display text: Unresolved editor (ffffffff-ffff-ffff-ffff-ffffffffffff)
    const unknownEditorCell = page.locator(
      'code:has-text("Unresolved editor (ffffffff-ffff-ffff-ffff-ffffffffffff)")'
    );
    await expect(unknownEditorCell).toBeVisible();
    await expect(unknownEditorCell).toHaveAttribute('title', 'ffffffff-ffff-ffff-ffff-ffffffffffff');
    await expect(unknownEditorCell).toHaveAttribute(
      'aria-label',
      'Editor selector: ffffffff-ffff-ffff-ffff-ffffffffffff'
    );
  });

  test('enforces strict privacy: never exposes raw tokens, secret credentials, or raw upstream errors in DOM', async ({ page }) => {
    // Check /admin/sync
    await loginAsAdmin(page, '/admin/sync');
    let syncContent = await page.content();
    expect(syncContent).not.toContain('sealed-access-token');
    expect(syncContent).not.toContain('sealed-refresh-token');
    expect(syncContent).not.toContain('test-session-secret');
    expect(syncContent).not.toContain('encrypted-test-token-payload');
    expect(syncContent).not.toContain('UPSTREAM_RAW_ERROR');

    // Check /admin/activity
    await page.goto('/admin/activity');
    let activityContent = await page.content();
    expect(activityContent).not.toContain('sealed-access-token');
    expect(activityContent).not.toContain('test-session-secret');

    // Check /admin/classify
    await page.goto('/admin/classify?tab=rules');
    let classifyContent = await page.content();
    expect(classifyContent).not.toContain('sealed-access-token');
    expect(classifyContent).not.toContain('test-session-secret');
  });

  test('renders responsively on mobile viewport (375x667) without layout breakdown', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    // 1. Mobile Sync Page
    await loginAsAdmin(page, '/admin/sync');
    await expect(page.locator('h1')).toContainText('Operational Sync & Capabilities');

    // Check that main controls fit within or scroll cleanly without breaking
    const syncButton = page.locator('[data-testid="sync-now-button"]');
    await expect(syncButton).toBeVisible();

    // Verify runs table is wrapped in a panel with scrollable table-wrap
    const runsPanel = page.locator('[data-testid="sync-runs-panel"]');
    await expect(runsPanel).toBeVisible();

    // 2. Mobile Classify Page
    await page.goto('/admin/classify');
    await expect(page.locator('h1')).toContainText('Teach the archive what counts as work.');
    const tabsBar = page.locator('button:has-text("Suggestions Queue")');
    await expect(tabsBar).toBeVisible();

    // Verify navigation tabs work on mobile viewport
    await page.click('button:has-text("Active Rules")');
    await expect(page.locator('h2:has-text("All Classification Rules")')).toBeVisible();
  });
});
