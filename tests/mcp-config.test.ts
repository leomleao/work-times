import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load as mcpConfigLoad } from '../src/routes/admin/mcp-config/+page.server';
import { runtime } from '../src/lib/server/runtime';
import {
  selectSafeApiKeyMetadata,
  getAllRecipes,
  getRecipe,
  serializeTomlString,
  type McpClientType,
  type McpAuthMethod
} from '../src/lib/server/mcp/config-recipes';

const ROOT = resolve(import.meta.dirname, '..');

function loadSource(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf-8');
}

describe('P9 MCP Configuration & Integration Contracts', () => {
  const pageSvelte = loadSource('src/routes/admin/mcp-config/+page.svelte');
  const pageServer = loadSource('src/routes/admin/mcp-config/+page.server.ts');
  const appShellSrc = loadSource('src/lib/components/AppShell.svelte');
  const configRecipesSrc = loadSource('src/lib/server/mcp/config-recipes.ts');

  describe('AppShell Navigation Contract', () => {
    it('places /admin/mcp-config between OAuth clients and Settings', () => {
      const oauthIdx = appShellSrc.indexOf("href: '/admin/oauth-clients'");
      const mcpIdx = appShellSrc.indexOf("href: '/admin/mcp-config'");
      const settingsIdx = appShellSrc.indexOf("href: '/admin/settings'");

      expect(oauthIdx).toBeGreaterThan(-1);
      expect(mcpIdx).toBeGreaterThan(-1);
      expect(settingsIdx).toBeGreaterThan(-1);

      expect(mcpIdx).toBeGreaterThan(oauthIdx);
      expect(settingsIdx).toBeGreaterThan(mcpIdx);
    });

    it('matches /admin/mcp-config paths cleanly', () => {
      expect(appShellSrc).toMatch(/label:\s*'(MCP config|MCP setup)'/i);
      expect(appShellSrc).toContain("p.startsWith('/admin/mcp-config')");
    });
  });

  describe('Server Loader Contracts', () => {
    it('builds endpoint exactly with new URL("/mcp", runtime.config.publicUrl).toString()', async () => {
      expect(pageServer).toContain("new URL('/mcp', runtime.config.publicUrl).toString()");

      const expectedEndpoint = new URL('/mcp', runtime.config.publicUrl).toString();
      const loaded = await (mcpConfigLoad as any)({} as any);
      expect(loaded.endpoint).toBe(expectedEndpoint);
    });

    it('returns only safe explicitly selected API-key metadata without secrets or hashes', async () => {
      const loaded = await (mcpConfigLoad as any)({} as any);
      expect(Array.isArray(loaded.keys)).toBe(true);

      for (const key of loaded.keys) {
        expect(key.id).toBeDefined();
        expect(key.name).toBeDefined();
        expect(key.prefix).toBeDefined();
        expect(key.scopes).toBeDefined();
        expect(key.status).toBeDefined();
        expect(typeof key.isActive).toBe('boolean');

        // Verify strictly absence of secret, token, or tokenHash
        expect((key as any).tokenHash).toBeUndefined();
        expect((key as any).hash).toBeUndefined();
        expect((key as any).secret).toBeUndefined();
        expect((key as any).token).toBeUndefined();
      }

      const serialized = JSON.stringify(loaded.keys);
      expect(serialized).not.toContain('tokenHash');
      expect(serialized).not.toContain('secret');
    });

    it('treats active as not revoked, not expired, and possessing activity:read', () => {
      const now = new Date('2026-09-09T15:00:00.000Z');

      const testKeys = [
        {
          id: 'k1-active',
          name: 'Active Key',
          tokenPrefix: 'wtk_active01',
          scopes: ['activity:read'],
          createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: '2026-10-01T00:00:00.000Z',
          revokedAt: null
        },
        {
          id: 'k2-expired',
          name: 'Expired Key',
          tokenPrefix: 'wtk_expired1',
          scopes: ['activity:read'],
          createdAt: '2026-08-01T00:00:00.000Z',
          expiresAt: '2026-09-01T00:00:00.000Z', // Before now
          revokedAt: null
        },
        {
          id: 'k3-revoked',
          name: 'Revoked Key',
          tokenPrefix: 'wtk_revoked1',
          scopes: ['activity:read'],
          createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: '2026-10-01T00:00:00.000Z',
          revokedAt: '2026-09-05T00:00:00.000Z'
        },
        {
          id: 'k4-wrong-scope',
          name: 'Wrong Scope Key',
          tokenPrefix: 'wtk_wrongscp',
          scopes: ['operations:read', 'activity:detail'], // Missing activity:read!
          createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: '2026-10-01T00:00:00.000Z',
          revokedAt: null
        }
      ];

      const safe = selectSafeApiKeyMetadata(testKeys, now);

      const k1 = safe.find((k) => k.id === 'k1-active')!;
      expect(k1.status).toBe('active');
      expect(k1.isActive).toBe(true);

      const k2 = safe.find((k) => k.id === 'k2-expired')!;
      expect(k2.status).toBe('expired');
      expect(k2.isActive).toBe(false);

      const k3 = safe.find((k) => k.id === 'k3-revoked')!;
      expect(k3.status).toBe('revoked');
      expect(k3.isActive).toBe(false);

      const k4 = safe.find((k) => k.id === 'k4-wrong-scope')!;
      expect(k4.status).toBe('wrong-scope');
      expect(k4.isActive).toBe(false);
    });

    it('conservatively treats malformed non-null expiry values as inactive/expired', () => {
      const now = new Date('2026-09-09T15:00:00.000Z');
      const malformedKey = [
        {
          id: 'k-malformed',
          name: 'Malformed Date Key',
          tokenPrefix: 'wtk_malformed',
          scopes: ['activity:read'],
          createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: 'not-a-real-date',
          revokedAt: null
        }
      ];
      const safe = selectSafeApiKeyMetadata(malformedKey, now);
      expect(safe[0].status).toBe('expired');
      expect(safe[0].isActive).toBe(false);
    });

    it('supports no-key OAuth without blocking or failing', async () => {
      const endpoint = 'http://localhost:3002/mcp';
      const recipes = getAllRecipes(endpoint);

      // Verify OAuth recipes for all clients are complete and functional
      expect(recipes.codex.oauth.snippet).toBeTruthy();
      expect(recipes.codex.oauth.command).toBe('codex mcp login work-times');
      expect(recipes['claude-code'].oauth.snippet).toBeTruthy();
      expect(recipes['claude-desktop'].oauth.snippet).toBeTruthy();
      expect(recipes.generic.oauth.snippet).toBeTruthy();

      // Verify OAuth recipes state API keys are optional
      for (const client of ['codex', 'claude-code', 'claude-desktop', 'generic'] as McpClientType[]) {
        const oauthRecipe = recipes[client].oauth;
        const notesStr = oauthRecipe.notes.join(' ');
        expect(notesStr).toMatch(/optional|not required/i);
      }
    });
  });

  describe('Recipe Specifications & Text Escaping', () => {
    const clients: McpClientType[] = ['codex', 'claude-code', 'claude-desktop', 'generic'];
    const authMethods: McpAuthMethod[] = ['bearer', 'oauth'];

    it('covers all recipe and auth combinations', () => {
      const endpoint = 'https://example.com/mcp';
      for (const client of clients) {
        for (const auth of authMethods) {
          const recipe = getRecipe(client, auth, endpoint);
          expect(recipe).toBeDefined();
          expect(recipe.snippet).toBeTruthy();
          expect(recipe.instructions.length).toBeGreaterThan(0);
        }
      }
    });

    it('escapes malicious URL text across formats', () => {
      const maliciousUrl = 'https://evil.com/mcp?param="><script>alert(1)</script>&x=\\';
      const tomlSerialized = serializeTomlString(maliciousUrl);
      expect(tomlSerialized).toContain('\\"');
      expect(tomlSerialized.startsWith('"')).toBe(true);
      expect(tomlSerialized.endsWith('"')).toBe(true);

      const codexRecipe = getRecipe('codex', 'bearer', maliciousUrl);
      expect(codexRecipe.snippet).toContain(tomlSerialized);

      const claudeRecipe = getRecipe('claude-code', 'bearer', maliciousUrl);
      const parsed = JSON.parse(claudeRecipe.snippet);
      expect(parsed.mcpServers['work-times'].url).toBe(maliciousUrl);
    });

    it('never interpolates upstream labels into commands', () => {
      const endpoint = 'https://example.com/mcp';
      const codexOAuth = getRecipe('codex', 'oauth', endpoint);
      expect(codexOAuth.command).toBe('codex mcp login work-times');
      expect(codexOAuth.command).not.toContain('upstream');
      expect(codexOAuth.command).not.toContain('wakatime');
    });

    it('Claude Code OAuth recipe is exact JSON-only without shell command concatenation', () => {
      const endpoint = 'https://example.com/mcp';
      const recipe = getRecipe('claude-code', 'oauth', endpoint);
      expect(recipe.format).toBe('json');
      expect(recipe.snippet).toContain('mcpServers');
      expect(recipe.snippet).not.toContain('headers');
      expect(recipe.instructions.join(' ')).not.toContain('claude mcp add');
      expect(recipe.command).toBeUndefined();
    });

    it('Claude Code Bearer recipe references literal ${WORK_TIMES_API_KEY}', () => {
      const endpoint = 'https://example.com/mcp';
      const recipe = getRecipe('claude-code', 'bearer', endpoint);
      expect(recipe.snippet).toContain('Bearer ${WORK_TIMES_API_KEY}');
      expect(recipe.snippet).not.toContain('wtk_');
    });

    it('Claude Desktop remote connector requires OAuth and warns about public reachability', () => {
      const endpoint = 'https://example.com/mcp';
      const recipe = getRecipe('claude-desktop', 'oauth', endpoint);
      expect(recipe.warning).toBeDefined();
      expect(recipe.warning).toMatch(/public reachability/i);
      expect(recipe.warning).toMatch(/anthropic infrastructure/i);
      expect(recipe.warning).toMatch(/not local.*json/i);
    });
  });

  describe('UI & Accessibility Contracts in +page.svelte', () => {
    it('provides all copy controls (snippet, endpoint, command)', () => {
      expect(pageSvelte).toContain('handleCopy(data.endpoint, \'endpoint\')');
      expect(pageSvelte).toContain('handleCopy(currentRecipe.snippet, \'snippet\')');
      expect(pageSvelte).toContain('handleCopy(currentRecipe.command');
      expect(pageSvelte).toContain('Copy URL');
      expect(pageSvelte).toContain('Copy Snippet');
    });

    it('clears copy feedback timer on component destroy', () => {
      expect(pageSvelte).toMatch(/onDestroy\(/);
      expect(pageSvelte).toContain('clearTimeout(copyTimer)');
    });

    it('provides complete keyboard radio behavior using native radio inputs and arrow handlers', () => {
      expect(pageSvelte).toContain('type="radio"');
      expect(pageSvelte).toContain('name="mcp-client"');
      expect(pageSvelte).toContain('name="mcp-auth"');
      expect(pageSvelte).toContain('handleClientKeydown');
      expect(pageSvelte).toContain('handleAuthKeydown');
      expect(pageSvelte).toContain('ArrowRight');
      expect(pageSvelte).toContain('ArrowLeft');
      expect(pageSvelte).toContain(':focus-within');
    });

    it('announces copy success and failure accessibly with role="status" and aria-live="polite"', () => {
      expect(pageSvelte).toMatch(/role="status"/);
      expect(pageSvelte).toMatch(/aria-live="polite"/);
      expect(pageSvelte).toContain('liveAnnouncement');
    });

    it('preserves selectable text on clipboard failure and displays accessible error state', () => {
      expect(pageSvelte).toContain('copyError');
      expect(pageSvelte).toContain('user-select: all');
      expect(pageSvelte).toContain('-webkit-user-select: all');
      expect(pageSvelte).toContain('Please select and copy the text manually');
      expect(pageSvelte).toContain('role="alert"');
    });

    it('enforces visible keyboard focus and horizontal code scroll', () => {
      expect(pageSvelte).toContain('.code-block:focus-visible');
      expect(pageSvelte).toContain('overflow-x: auto');
      expect(pageSvelte).toContain('white-space: pre');
      expect(pageSvelte).toContain('tabindex="0"');
    });

    it('supports responsive mobile viewports', () => {
      expect(pageSvelte).toContain('@media (max-width: 768px)');
      expect(pageSvelte).toContain('grid-template-columns: 1fr');
    });

    it('presents compact key status, prefix warning, and replacement guidance', () => {
      expect(pageSvelte).toContain('API Key Status');
      expect(pageSvelte).toContain('activity:read');
      expect(pageSvelte).toContain('Prefix Identity Standard');
      expect(pageSvelte).toMatch(/cannot be (expanded|reversed|restored)/i);
      expect(pageSvelte).toContain('href="/admin/api-keys"');
    });

    it('links to exact resolvable OPERATIONS guide on GitHub and includes reverse-proxy guidance', () => {
      const exactOpsUrl = 'https://github.com/leomleao/work-times/blob/main/docs/OPERATIONS.md';
      expect(pageSvelte).toContain(exactOpsUrl);
      expect(pageSvelte).not.toMatch(/href="docs\/OPERATIONS\.md"/);

      const parsed = new URL(exactOpsUrl);
      expect(parsed.protocol).toBe('https:');
      expect(parsed.hostname).toBe('github.com');
      expect(parsed.pathname).toBe('/leomleao/work-times/blob/main/docs/OPERATIONS.md');

      expect(pageSvelte).toContain('Operations & Network Reachability');
      expect(pageSvelte).toContain('PUBLIC_URL');
      expect(pageSvelte).toContain('Reverse-proxy origin');
    });

    it('keeps upstream WakaTime OAuth clearly separate from Work Times MCP OAuth', () => {
      expect(pageSvelte).toContain('OAuth Architecture & Credential Scopes');
      expect(pageSvelte).toContain('strictly separate from the upstream WakaTime OAuth connection');
      expect(pageSvelte).toContain('API keys are optional for OAuth');
    });
  });
});
