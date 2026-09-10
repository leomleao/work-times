import { describe, expect, it } from 'vitest';
import {
  formatClaudeCodeBearerJson,
  formatClaudeCodeOAuthJson,
  formatClaudeDesktopBearer,
  formatClaudeDesktopOAuth,
  formatCodexBearerToml,
  formatCodexOAuthToml,
  formatGenericBearer,
  formatGenericOAuth,
  getAllRecipes,
  getRecipe,
  selectSafeApiKeyMetadata,
  serializeTomlString,
  type McpAuthMethod,
  type McpClientType
} from './config-recipes';

describe('MCP Configuration Recipes Module', () => {
  const standardEndpoint = 'http://localhost:3002/mcp';
  const httpsEndpoint = 'https://work-times.example.com/mcp';

  describe('URL Escaping & Malicious Input Handling', () => {
    it('properly serializes TOML strings and escapes quotes and backslashes', () => {
      expect(serializeTomlString('https://example.com/mcp')).toBe('"https://example.com/mcp"');
      expect(serializeTomlString('https://example.com/mcp?foo="bar"')).toBe('"https://example.com/mcp?foo=\\"bar\\""');
      expect(serializeTomlString('https://example.com/mcp\\test')).toBe('"https://example.com/mcp\\\\test"');
      expect(serializeTomlString('https://example.com/mcp\nnewline')).toBe('"https://example.com/mcp\\nnewline"');
    });

    it('escapes malicious characters in Codex TOML', () => {
      const evilUrl = 'https://evil.com/mcp?x="><script>alert(1)</script>';
      const tomlBearer = formatCodexBearerToml(evilUrl);
      const tomlOAuth = formatCodexOAuthToml(evilUrl);

      expect(tomlBearer).toContain(`url = ${JSON.stringify(evilUrl)}`);
      expect(tomlOAuth).toContain(`url = ${JSON.stringify(evilUrl)}`);
      // Quotes inside evilUrl must be escaped
      expect(tomlBearer).toContain('\\"');
      expect(tomlOAuth).toContain('\\"');
    });

    it('escapes malicious characters in Claude Code JSON', () => {
      const evilUrl = 'https://evil.com/mcp?q="><script>alert(1)</script>&nl=\n';
      const jsonBearer = formatClaudeCodeBearerJson(evilUrl);
      const parsedBearer = JSON.parse(jsonBearer);
      expect(parsedBearer.mcpServers['work-times'].url).toBe(evilUrl);

      const jsonOAuth = formatClaudeCodeOAuthJson(evilUrl);
      const parsedOAuth = JSON.parse(jsonOAuth);
      expect(parsedOAuth.mcpServers['work-times'].url).toBe(evilUrl);
    });
  });

  describe('Every Recipe and Auth Combination', () => {
    const clients: McpClientType[] = ['codex', 'claude-code', 'claude-desktop', 'generic'];
    const authMethods: McpAuthMethod[] = ['bearer', 'oauth'];

    it('generates non-empty valid recipes for all 8 combinations', () => {
      const all = getAllRecipes(httpsEndpoint);

      for (const client of clients) {
        expect(all[client]).toBeDefined();
        for (const auth of authMethods) {
          const recipe = all[client][auth];
          expect(recipe).toBeDefined();
          expect(recipe.client).toBe(client);
          expect(recipe.authMethod).toBe(auth);
          expect(recipe.snippet).toBeTruthy();
          expect(recipe.instructions.length).toBeGreaterThan(0);
          expect(recipe.endpoint).toBe(httpsEndpoint);

          // Test direct getRecipe matches
          const direct = getRecipe(client, auth, httpsEndpoint);
          expect(direct).toEqual(recipe);
        }
      }
    });

    it('Codex Bearer recipe uses TOML [mcp_servers.work-times], url, and bearer_token_env_var = "WORK_TIMES_API_KEY"', () => {
      const recipe = getRecipe('codex', 'bearer', httpsEndpoint);
      expect(recipe.format).toBe('toml');
      expect(recipe.snippet).toContain('[mcp_servers.work-times]');
      expect(recipe.snippet).toContain(`url = "${httpsEndpoint}"`);
      expect(recipe.snippet).toContain('bearer_token_env_var = "WORK_TIMES_API_KEY"');
      expect(recipe.instructions.join(' ')).toContain('WORK_TIMES_API_KEY');
    });

    it('Codex OAuth recipe omits bearer setting and includes "codex mcp login work-times"', () => {
      const recipe = getRecipe('codex', 'oauth', httpsEndpoint);
      expect(recipe.format).toBe('toml');
      expect(recipe.snippet).toContain('[mcp_servers.work-times]');
      expect(recipe.snippet).toContain(`url = "${httpsEndpoint}"`);
      expect(recipe.snippet).not.toContain('bearer_token_env_var');
      expect(recipe.command).toBe('codex mcp login work-times');
      expect(recipe.instructions.join(' ')).toContain('codex mcp login work-times');
    });

    it('Claude Code Bearer recipe uses type http, URL, and Authorization header with literal ${WORK_TIMES_API_KEY}', () => {
      const recipe = getRecipe('claude-code', 'bearer', httpsEndpoint);
      expect(recipe.format).toBe('json');
      const parsed = JSON.parse(recipe.snippet);
      expect(parsed.mcpServers['work-times']).toEqual({
        type: 'http',
        url: httpsEndpoint,
        headers: {
          Authorization: 'Bearer ${WORK_TIMES_API_KEY}'
        }
      });
      // The snippet itself must contain literal string "${WORK_TIMES_API_KEY}"
      expect(recipe.snippet).toContain('${WORK_TIMES_API_KEY}');
    });

    it('Claude Code OAuth recipe is URL-only with no headers', () => {
      const recipe = getRecipe('claude-code', 'oauth', httpsEndpoint);
      expect(recipe.format).toBe('json');
      const parsed = JSON.parse(recipe.snippet);
      expect(parsed.mcpServers['work-times']).toEqual({
        type: 'http',
        url: httpsEndpoint
      });
      expect(parsed.mcpServers['work-times'].headers).toBeUndefined();
      expect(recipe.snippet).not.toContain('headers');
      expect(recipe.snippet).not.toContain('Authorization');
    });

    it('Claude Desktop OAuth recipe provides remote connector settings and public reachability warning', () => {
      const recipe = getRecipe('claude-desktop', 'oauth', httpsEndpoint);
      expect(recipe.snippet).toContain(httpsEndpoint);
      expect(recipe.snippet).toContain('Work Times');
      expect(recipe.warning).toBeDefined();
      expect(recipe.warning).toMatch(/public reachability/i);
      expect(recipe.warning).toMatch(/anthropic infrastructure/i);
      expect(recipe.warning).toMatch(/not local.*json/i);
    });

    it('Claude Desktop Bearer recipe informs operator that remote connectors require OAuth 2.0', () => {
      const recipe = getRecipe('claude-desktop', 'bearer', httpsEndpoint);
      expect(recipe.warning).toMatch(/OAuth 2\.0/i);
      expect(recipe.snippet).toMatch(/OAuth 2\.0/i);
    });

    it('Generic client Bearer recipe provides streamable HTTP and Bearer header without invented syntax', () => {
      const recipe = getRecipe('generic', 'bearer', httpsEndpoint);
      expect(recipe.format).toBe('http');
      expect(recipe.snippet).toContain('POST /mcp HTTP/1.1');
      expect(recipe.snippet).toContain('Authorization: Bearer ${WORK_TIMES_API_KEY}');
      expect(recipe.snippet).toContain('Accept: application/json, text/event-stream');
      expect(recipe.snippet).toContain('jsonrpc": "2.0');
    });

    it('Generic client OAuth recipe provides RFC 9728 discovery and Bearer token workflow', () => {
      const recipe = getRecipe('generic', 'oauth', httpsEndpoint);
      expect(recipe.format).toBe('http');
      expect(recipe.snippet).toContain('GET /mcp HTTP/1.1');
      expect(recipe.snippet).toContain('Authorization: Bearer <access_token>');
    });
  });

  describe('Separation of Upstream WakaTime OAuth and MCP OAuth', () => {
    it('notes clarify that MCP OAuth is local agent authorization separate from upstream WakaTime OAuth', () => {
      const codexOAuth = getRecipe('codex', 'oauth', standardEndpoint);
      expect(codexOAuth.notes.some((n) => n.includes('WakaTime'))).toBe(true);

      const claudeOAuth = getRecipe('claude-code', 'oauth', standardEndpoint);
      expect(claudeOAuth.notes.some((n) => n.includes('WakaTime'))).toBe(true);

      const genericOAuth = getRecipe('generic', 'oauth', standardEndpoint);
      expect(genericOAuth.notes.some((n) => n.includes('WakaTime'))).toBe(true);
    });

    it('notes confirm API keys are optional for OAuth', () => {
      const codexOAuth = getRecipe('codex', 'oauth', standardEndpoint);
      expect(codexOAuth.notes.some((n) => /optional/i.test(n))).toBe(true);

      const claudeOAuth = getRecipe('claude-code', 'oauth', standardEndpoint);
      expect(claudeOAuth.notes.some((n) => /optional/i.test(n))).toBe(true);
    });
  });

  describe('Safe API Key Metadata Selection', () => {
    const fixedNow = new Date('2026-09-09T12:00:00.000Z');

    const sampleRawKeys = [
      {
        id: 'key-active',
        name: 'Active Key',
        tokenPrefix: 'wtk_active12',
        tokenHash: 'secret-hash-1234567890abcdef',
        scopes: ['activity:read', 'operations:read'],
        createdAt: '2026-09-01T00:00:00.000Z',
        expiresAt: '2026-10-01T00:00:00.000Z',
        lastUsedAt: '2026-09-08T10:00:00.000Z',
        revokedAt: null
      },
      {
        id: 'key-active-no-expiry',
        name: 'Active Non-expiring Key',
        tokenPrefix: 'wtk_noexp123',
        tokenHash: 'secret-hash-noexp',
        scopes: ['activity:read'],
        createdAt: '2026-09-01T00:00:00.000Z',
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null
      },
      {
        id: 'key-expired',
        name: 'Expired Key',
        tokenPrefix: 'wtk_expired1',
        tokenHash: 'secret-hash-expired',
        scopes: ['activity:read'],
        createdAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2026-09-01T00:00:00.000Z', // In the past relative to fixedNow
        lastUsedAt: null,
        revokedAt: null
      },
      {
        id: 'key-revoked',
        name: 'Revoked Key',
        tokenPrefix: 'wtk_revoked1',
        tokenHash: 'secret-hash-revoked',
        scopes: ['activity:read'],
        createdAt: '2026-09-01T00:00:00.000Z',
        expiresAt: '2026-10-01T00:00:00.000Z',
        lastUsedAt: null,
        revokedAt: '2026-09-05T00:00:00.000Z'
      },
      {
        id: 'key-wrong-scope',
        name: 'Wrong Scope Key',
        tokenPrefix: 'wtk_wrongscp',
        tokenHash: 'secret-hash-wrong',
        scopes: ['operations:read'], // Missing activity:read!
        createdAt: '2026-09-01T00:00:00.000Z',
        expiresAt: '2026-10-01T00:00:00.000Z',
        lastUsedAt: null,
        revokedAt: null
      }
    ];

    it('correctly classifies active, expired, revoked, and wrong-scope keys', () => {
      const evaluated = selectSafeApiKeyMetadata(sampleRawKeys, fixedNow);

      const activeKey = evaluated.find((k) => k.id === 'key-active')!;
      expect(activeKey.status).toBe('active');
      expect(activeKey.isActive).toBe(true);

      const noExpKey = evaluated.find((k) => k.id === 'key-active-no-expiry')!;
      expect(noExpKey.status).toBe('active');
      expect(noExpKey.isActive).toBe(true);

      const expiredKey = evaluated.find((k) => k.id === 'key-expired')!;
      expect(expiredKey.status).toBe('expired');
      expect(expiredKey.isActive).toBe(false);

      const revokedKey = evaluated.find((k) => k.id === 'key-revoked')!;
      expect(revokedKey.status).toBe('revoked');
      expect(revokedKey.isActive).toBe(false);

      const wrongScopeKey = evaluated.find((k) => k.id === 'key-wrong-scope')!;
      expect(wrongScopeKey.status).toBe('wrong-scope');
      expect(wrongScopeKey.isActive).toBe(false);
    });

    it('strictly omits secrets and hashes from metadata output', () => {
      const evaluated = selectSafeApiKeyMetadata(sampleRawKeys, fixedNow);

      for (const item of evaluated) {
        expect((item as any).tokenHash).toBeUndefined();
        expect((item as any).hash).toBeUndefined();
        expect((item as any).secret).toBeUndefined();
        expect((item as any).token).toBeUndefined();

        const json = JSON.stringify(item);
        expect(json).not.toContain('secret-hash');
        expect(json).not.toContain('tokenHash');
      }
    });

    it('treats active strictly as not revoked, not expired, and possessing activity:read', () => {
      // Key with revokedAt + expired + wrong scope => revoked
      const multiBad = [
        {
          id: 'multi-bad',
          name: 'Multi Bad',
          tokenPrefix: 'wtk_bad',
          scopes: ['operations:read'],
          createdAt: '2026-08-01T00:00:00.000Z',
          expiresAt: '2026-08-02T00:00:00.000Z',
          revokedAt: '2026-08-03T00:00:00.000Z'
        }
      ];
      const evaluated = selectSafeApiKeyMetadata(multiBad, fixedNow);
      expect(evaluated[0].status).toBe('revoked');
      expect(evaluated[0].isActive).toBe(false);

      // Key expired + wrong scope => expired
      const expiredWrongScope = [
        {
          id: 'exp-wrong',
          name: 'Expired Wrong Scope',
          tokenPrefix: 'wtk_expwrong',
          scopes: ['operations:read'],
          createdAt: '2026-08-01T00:00:00.000Z',
          expiresAt: '2026-08-02T00:00:00.000Z',
          revokedAt: null
        }
      ];
      const resExp = selectSafeApiKeyMetadata(expiredWrongScope, fixedNow);
      expect(resExp[0].status).toBe('expired');
      expect(resExp[0].isActive).toBe(false);
    });

    it('handles JSON string scopes and whitespace-delimited scopes cleanly', () => {
      const customScopeKeys = [
        {
          id: 'json-scope',
          name: 'JSON Scope',
          tokenPrefix: 'wtk_json',
          scopes: JSON.stringify(['activity:read']),
          createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: null,
          revokedAt: null
        },
        {
          id: 'string-scope',
          name: 'String Scope',
          tokenPrefix: 'wtk_str',
          scopes: 'activity:read operations:read',
          createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: null,
          revokedAt: null
        }
      ];
      const evaluated = selectSafeApiKeyMetadata(customScopeKeys, fixedNow);
      expect(evaluated[0].status).toBe('active');
      expect(evaluated[0].scopes).toEqual(['activity:read']);
      expect(evaluated[1].status).toBe('active');
      expect(evaluated[1].scopes).toEqual(['activity:read', 'operations:read']);
    });

    it('conservatively treats every malformed non-null expiry value as inactive/expired', () => {
      const malformedExpiryKeys = [
        {
          id: 'key-malformed-1',
          name: 'Malformed Garbage Date',
          tokenPrefix: 'wtk_malformed1',
          scopes: ['activity:read'],
          createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: 'not-a-valid-date-string',
          revokedAt: null
        },
        {
          id: 'key-malformed-2',
          name: 'Malformed ISO NaN',
          tokenPrefix: 'wtk_malformed2',
          scopes: ['activity:read'],
          createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: '2026-99-99T99:99:99.999Z',
          revokedAt: null
        },
        {
          id: 'key-malformed-3',
          name: 'Malformed Non-null Word',
          tokenPrefix: 'wtk_malformed3',
          scopes: ['activity:read'],
          createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: 'undefined',
          revokedAt: null
        }
      ];

      const evaluated = selectSafeApiKeyMetadata(malformedExpiryKeys, fixedNow);
      for (const item of evaluated) {
        expect(item.status).toBe('expired');
        expect(item.isActive).toBe(false);
      }
    });

    it('Claude Code OAuth recipe instructions are exact JSON-only without shell command concatenation', () => {
      const recipe = getRecipe('claude-code', 'oauth', 'https://example.com/mcp');
      expect(recipe.format).toBe('json');
      // Must not contain shell add commands concatenated with endpoint
      expect(recipe.instructions.join(' ')).not.toContain('claude mcp add');
      expect(recipe.instructions.some((i) => i.includes('.mcp.json'))).toBe(true);
      expect(recipe.command).toBeUndefined();
    });
  });
});

