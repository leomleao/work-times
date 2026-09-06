import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

function loadFile(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf-8');
}

describe('Admin UI Acceptance Review Contracts', () => {
  const loginSrc = loadFile('src/routes/login/+page.svelte');
  const apiKeysSrc = loadFile('src/routes/admin/api-keys/+page.svelte');
  const oauthClientsSrc = loadFile('src/routes/admin/oauth-clients/+page.svelte');
  const classifySrc = loadFile('src/routes/admin/classify/+page.svelte');
  const appShellSrc = loadFile('src/lib/components/AppShell.svelte');

  describe('Requirement 1: Scopes', () => {
    it('removes classification:write entirely and restricts scopes to the allowed set', () => {
      const allowedScopes = ['activity:read', 'activity:detail', 'operations:read'];

      expect(apiKeysSrc).not.toContain('classification:write');
      expect(oauthClientsSrc).not.toContain('classification:write');
      expect(apiKeysSrc).not.toContain('admin:all');

      // Check availableScopes in api-keys
      const apiKeyScopesMatch = apiKeysSrc.match(/const availableScopes = \[([\s\S]*?)\];/);
      expect(apiKeyScopesMatch).toBeTruthy();
      const apiKeyScopeIds = Array.from(apiKeyScopesMatch![1].matchAll(/id:\s*'([^']+)'/g)).map((m) => m[1]);
      expect(apiKeyScopeIds.sort()).toEqual(allowedScopes.sort());

      // Check standardScopes in oauth-clients
      const oauthScopesMatch = oauthClientsSrc.match(/const standardScopes = \[([\s\S]*?)\];/);
      expect(oauthScopesMatch).toBeTruthy();
      const oauthScopeIds = Array.from(oauthScopesMatch![1].matchAll(/id:\s*'([^']+)'/g)).map((m) => m[1]);
      expect(oauthScopeIds.sort()).toEqual(allowedScopes.sort());
    });
  });

  describe('Requirement 2: Eliminate Math.random / mock IDs/secrets and fake successful actions', () => {
    it('does not use Math.random in api-keys or oauth-clients', () => {
      expect(apiKeysSrc).not.toContain('Math.random');
      expect(oauthClientsSrc).not.toContain('Math.random');
    });

    it('uses native POST forms with disabled submit states for credential creation without server actions', () => {
      expect(apiKeysSrc).toMatch(/<form[^>]*method="POST"[^>]*action="\?\/createKey"/);
      expect(apiKeysSrc).toMatch(/type="submit"[^>]*disabled/);

      expect(oauthClientsSrc).toMatch(/<form[^>]*method="POST"[^>]*action="\?\/registerClient"/);
      expect(oauthClientsSrc).toMatch(/type="submit"[^>]*disabled/);
    });

    it('does not simulate fake revocation status mutation on client side', () => {
      expect(apiKeysSrc).not.toContain("status = 'revoked'");
      expect(oauthClientsSrc).not.toContain("status = 'revoked'");
      expect(apiKeysSrc).toMatch(/<form[^>]*method="POST"[^>]*action="\?\/revokeKey"/);
      expect(oauthClientsSrc).toMatch(/<form[^>]*method="POST"[^>]*action="\?\/revokeClient"/);
    });
  });

  describe('Classification selector contract', () => {
    it('uses entity as the canonical exact-match selector name', () => {
      expect(classifySrc).toContain("'entity'");
      expect(classifySrc).not.toContain('entity_exact');
    });
  });

  describe('Requirement 3: Login form semantics', () => {
    it('uses a real POST form and does not accept arbitrary credentials or redirect client-side', () => {
      expect(loginSrc).not.toContain('window.location');
      expect(loginSrc).not.toContain('setTimeout');
      expect(loginSrc).toMatch(/<form[^>]*method="POST"/);
      expect(loginSrc).not.toMatch(/onsubmit=\{handleSubmit\}/);
    });
  });

  describe('Requirement 4: Whole-slice overrides description', () => {
    it('describes whole-slice overrides as official day/project/entity slices and not arbitrary intervals or heartbeats', () => {
      expect(classifySrc).not.toMatch(/isolated activity interval, day, or heartbeat/i);
      expect(classifySrc).not.toMatch(/arbitrary activity interval/i);
      expect(classifySrc).toContain('official day/project/entity slice');
    });
  });

  describe('Requirement 5: Redirect URI matching', () => {
    it('removes unsupported arbitrary loopback-port claims', () => {
      expect(oauthClientsSrc).not.toContain('arbitrary port');
      expect(oauthClientsSrc).not.toContain('port flexibility');
      expect(oauthClientsSrc).toContain('Exact registered match required');
    });
  });

  describe('Requirement 6: Accurate neutral readiness label', () => {
    it('replaces Active & verified with a neutral readiness label in AppShell', () => {
      expect(appShellSrc).not.toContain('Active & verified');
      expect(appShellSrc).toContain('<small>Ready</small>');
    });
  });

  describe('Requirement 7: Sign-out semantics', () => {
    it('uses a POST form instead of an anchor for sign-out in AppShell', () => {
      expect(appShellSrc).not.toMatch(/<a[^>]*href="\/login"[^>]*aria-label="Sign out"/);
      expect(appShellSrc).toMatch(/<form[^>]*method="POST"[^>]*action="\/login\?\/logout"/);
      expect(appShellSrc).toMatch(/<button[^>]*type="submit"[^>]*aria-label="Sign out"/);
    });
  });
});
