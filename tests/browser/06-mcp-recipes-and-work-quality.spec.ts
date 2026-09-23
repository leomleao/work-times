import { test, expect } from '@playwright/test';
import { seedCleanTestState, loginAsAdmin, getTestDb } from './helpers';

test.describe('P10A3: Client-Specific MCP Recipes, Clipboard Diagnostics, and Work-Only DataQuality', () => {
  test.beforeEach(() => {
    seedCleanTestState();
  });

  test('presents client-specific MCP recipes (Codex, Claude Code, Claude Desktop, Generic) with dual auth modes and keyboard navigation', async ({ page }) => {
    await loginAsAdmin(page, '/admin/mcp-config');

    // 1. Initial State: Codex CLI with Bearer Token
    await expect(page.locator('h1')).toContainText('Model Context Protocol (MCP) Setup.');
    const codeBlock = page.locator('pre.code-block');
    await expect(codeBlock).toBeVisible();
    await expect(codeBlock).toContainText('[mcp_servers.work-times]');
    await expect(codeBlock).toContainText('url = "http://127.0.0.1:4173/mcp"');
    await expect(codeBlock).toContainText('WORK_TIMES_API_KEY');

    // Key status card should display active key ready with prefix
    const keyStatusPanel = page.locator('.panel').filter({ hasText: 'API Key Status' });
    await expect(keyStatusPanel).toContainText('Active Key Ready');
    await expect(keyStatusPanel).toContainText('wtk_test123…');
    await expect(keyStatusPanel).toContainText('are identifiers only');

    // 2. Switch Client: Claude Code
    await page.click('label.client-card:has-text("Claude Code")');
    await expect(page.locator('.code-card')).toContainText('.mcp.json');
    await expect(codeBlock).toContainText('"mcpServers"');
    await expect(codeBlock).toContainText('"type": "http"');
    await expect(codeBlock).toContainText('"url": "http://127.0.0.1:4173/mcp"');

    // 3. Switch Client: Claude Desktop (shows Remote Connector notice)
    await page.click('label.client-card:has-text("Claude Desktop")');
    const connectorNotice = page.locator('.notice.warning[role="alert"]');
    await expect(connectorNotice).toBeVisible();
    await expect(connectorNotice).toContainText('Claude Desktop remote connectors require OAuth 2.0 authentication');

    // 4. Switch Client: Generic MCP Client
    await page.click('label.client-card:has-text("Generic MCP Client")');
    await expect(codeBlock).toContainText('POST /mcp HTTP/1.1');
    await expect(codeBlock).toContainText('Authorization: Bearer ${WORK_TIMES_API_KEY}');

    // 5. Switch Auth Mode: OAuth 2.0
    await page.click('label.choice-label:has-text("OAuth 2.0")');
    await expect(page.locator('.form-hint')).toContainText('Interactive OAuth 2.0 flow discovered automatically via RFC 9728');
    // Notice explains keys are optional for OAuth
    await expect(page.locator('.notice.info', { hasText: 'API keys are optional for OAuth' })).toBeVisible();

    // 6. Switch back to Codex CLI with OAuth to verify OAuth login command
    await page.click('label.client-card:has-text("Codex CLI")');
    const commandBox = page.locator('.command-box');
    await expect(commandBox).toBeVisible();
    await expect(commandBox).toContainText('codex mcp login work-times');

    // 7. Keyboard Navigation across client cards
    const codexRadio = page.locator('input[name="mcp-client"][value="codex"]');
    await codexRadio.focus();
    await expect(codexRadio).toBeFocused();

    // Press ArrowRight to move to Claude Code
    await page.keyboard.press('ArrowRight');
    const claudeCodeRadio = page.locator('input[name="mcp-client"][value="claude-code"]');
    await expect(claudeCodeRadio).toBeChecked();
    await expect(page.locator('.code-card')).toContainText('.mcp.json');
  });

  test('announces clipboard copy success and handles clipboard permission denial with accessible alerts on MCP setup', async ({ page, context }) => {
    // Part 1: Clipboard Success
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await loginAsAdmin(page, '/admin/mcp-config');

    const liveAnnouncement = page.locator('.sr-only[role="status"]');

    // 1. Copy Snippet
    const copySnippetBtn = page.locator('button.copy-btn').filter({ hasText: 'Copy Snippet' });
    await copySnippetBtn.click();
    await expect(page.locator('button.copy-btn').filter({ hasText: 'Copied Snippet!' })).toBeVisible();
    await expect(liveAnnouncement).toContainText('configuration snippet copied to clipboard');

    // 2. Copy Endpoint URL
    const copyUrlBtn = page.locator('button.copy-btn').filter({ hasText: 'Copy URL' });
    await copyUrlBtn.click();
    await expect(page.locator('button.copy-btn').filter({ hasText: 'Copied URL' })).toBeVisible();
    await expect(liveAnnouncement).toContainText('MCP endpoint URL copied to clipboard');

    // 3. Switch to OAuth and Copy Command
    await page.click('label.choice-label:has-text("OAuth 2.0")');
    const copyCommandBtn = page.locator('button.copy-btn').filter({ hasText: 'Copy Command' });
    await copyCommandBtn.click();
    await expect(page.locator('button.copy-btn').filter({ hasText: 'Copied' })).toBeVisible();
    await expect(liveAnnouncement).toContainText('CLI command copied to clipboard');

    // Part 2: Clipboard Failure / Permission Denial
    await page.evaluate(() => {
      if (navigator.clipboard) {
        navigator.clipboard.writeText = async () => {
          throw new DOMException('Permission denied', 'NotAllowedError');
        };
      }
    });

    await page.click('label.choice-label:has-text("API Key (Bearer Token)")');
    const copySnippetBtn2 = page.locator('button.copy-btn').filter({ hasText: 'Copy Snippet' });
    await copySnippetBtn2.click();

    // Verify accessible danger alert is rendered
    const clipAlert = page.locator('.notice.danger[role="alert"]');
    await expect(clipAlert).toBeVisible();
    await expect(clipAlert).toContainText('Clipboard Error');
    await expect(clipAlert).toContainText('Unable to copy automatically');
    await expect(liveAnnouncement).toContainText('Unable to copy automatically');

    // Verify pre block remains accessible for manual selection
    const preBlock = page.locator('pre.code-block');
    await expect(preBlock).toHaveAttribute('role', 'region');
    await expect(preBlock).toHaveAttribute('tabindex', '0');
  });

  test('displays work-only dataQuality at desktop (1280x800) and mobile (375x667) without layout breakdown or private leakage', async ({ page }) => {
    // Seed verified work slices and verified zero date
    const db = getTestDb();
    try {
      // Seed 2026-09-11 as work slice
      db.prepare(`
        INSERT OR REPLACE INTO day_project_entity_slices
          (id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id, kind, snapshot_version)
        VALUES
          (301, '2026-09-11', 1, 'src/lib/server/work-evidence.ts', 'file', 3600, 0, 1, 'entity', 1)
      `).run();

      db.prepare(`
        INSERT OR REPLACE INTO daily_time_allocations
          (id, date, project_id, entity, entity_type, kind, classification, allocated_seconds)
        VALUES
          ('alloc-p10-work-1', '2026-09-11', 1, 'src/lib/server/work-evidence.ts', 'file', 'entity', 'work', 3600)
      `).run();
    } finally {
      db.close();
    }

    // --- Desktop Viewport (1280x800) ---
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAsAdmin(page, '/admin/activity?classification=work&date=2026-09-11');

    // 1. Date Quality Banner
    const banner = page.locator('[data-testid="activity-date-quality-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Date Quality (2026-09-11)');
    await expect(banner.locator('[data-testid="quality-badge"]')).toContainText('Updated');

    // 2. Metrics card for work
    const workMetric = page.locator('.metric-card').filter({ hasText: 'Classified as Work' });
    await expect(workMetric).toBeVisible();
    await expect(workMetric).toContainText('1h');

    // 3. Row-level QualityBadge in Slices Table
    const dateCell = page.locator('table.data-table tbody tr').first().locator('td').first();
    await expect(dateCell).toContainText('2026-09-11');
    await expect(dateCell.locator('[data-testid="quality-badge"]')).toBeVisible();

    // 4. Privacy verification on Desktop
    const desktopHtml = await page.content();
    expect(desktopHtml).not.toContain('sealed-access-token');
    expect(desktopHtml).not.toContain('test-session-secret');
    expect(desktopHtml).not.toContain('hash-test123');

    // --- Mobile Viewport (375x667) ---
    await page.setViewportSize({ width: 375, height: 667 });

    // 5. Activity page on Mobile: layout remains intact
    await page.reload();
    await expect(page.locator('h1')).toContainText('Activity Slices & Dimensions.');
    await expect(banner).toBeVisible();
    const tableWrap = page.locator('.table-wrap');
    await expect(tableWrap).toBeVisible();

    // Verify filter buttons wrap cleanly
    const filterPanel = page.locator('form.panel');
    await expect(filterPanel).toBeVisible();

    // 6. MCP Config page on Mobile: layout remains intact
    await page.goto('/admin/mcp-config');
    await expect(page.locator('h1')).toContainText('Model Context Protocol (MCP) Setup.');

    // Client cards grid wraps cleanly on mobile
    const clientGrid = page.locator('.client-grid');
    await expect(clientGrid).toBeVisible();
    const activeCard = page.locator('.client-card.active');
    await expect(activeCard).toBeVisible();

    // Code card and copy button are fully visible and clickable
    const mobileCopyBtn = page.locator('button.copy-btn').first();
    await expect(mobileCopyBtn).toBeVisible();

    // API Key status panel wraps neatly in mobile view
    const mobileKeyPanel = page.locator('.sidebar-panels .panel').filter({ hasText: 'API Key Status' });
    await expect(mobileKeyPanel).toBeVisible();
  });
});
