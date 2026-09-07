import { describe, expect, it } from 'vitest';
import { runtime, createRuntime } from './runtime';
import { openTestDatabase } from '$lib/server/db/connection';
import { parsePublicUrl } from '$lib/server/config';

describe('server runtime singleton', () => {
  it('initializes module singleton with migrated database and services', () => {
    expect(runtime).toBeDefined();
    expect(runtime.config.databasePath).toBe(':memory:');
    expect(runtime.db).toBeDefined();
    expect(runtime.db.name).toBe(':memory:');
    expect(runtime.adminAuth).toBeDefined();
    expect(runtime.loginLimiter).toBeDefined();
    expect(runtime.registrationLimiter).toBeDefined();
    expect(runtime.apiKeys).toBeDefined();
    expect(runtime.oauthClients).toBeDefined();
    expect(runtime.oauthAuth).toBeDefined();
    expect(runtime.classification).toBeDefined();
    expect(runtime.analytics).toBeDefined();
    expect(runtime.tokenVerifier).toBeDefined();
    expect(runtime.mcpHandler).toBeDefined();
    expect(runtime.authenticatedMcpHandler).toBeDefined();
    expect(runtime.sessionSecret).toBeDefined();
    expect(runtime.sessionSecret.length).toBeGreaterThanOrEqual(32);

    // Database tables exist
    const tables = runtime.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((t) => t.name));

    expect(tableNames.has('schema_migrations')).toBe(true);
    expect(tableNames.has('admin_sessions')).toBe(true);
    expect(tableNames.has('api_keys')).toBe(true);
    expect(tableNames.has('oauth_clients')).toBe(true);
    expect(tableNames.has('oauth_tokens')).toBe(true);
    expect(tableNames.has('classification_rules')).toBe(true);
  });

  it('can create an isolated runtime with custom test database', async () => {
    const testDb = openTestDatabase();
    const testRuntime = createRuntime(
      {
        databasePath: ':memory:',
        wakatimeOAuthClientId: null,
        wakatimeOAuthClientSecret: null,
        adminUsername: 'testadmin',
        adminPasswordHash: null,
        sessionSecret: '0123456789abcdef0123456789abcdef',
        publicUrl: parsePublicUrl('http://localhost:3002'),
        cookieSecure: false,
        maxDirectImportBytes: 10 * 1024 * 1024
      },
      testDb
    );

    expect(testRuntime.config.adminUsername).toBe('testadmin');
    const createdKey = await testRuntime.apiKeys.create({
      name: 'test-key',
      scopes: ['activity:read']
    });
    expect(createdKey.token.startsWith('wtk_')).toBe(true);

    const keys = await testRuntime.apiKeys.list();
    expect(keys.length).toBe(1);
    expect(keys[0].name).toBe('test-key');
  });

  it('rejects unauthorized MCP request through authenticatedMcpHandler', async () => {
    const request = new Request('http://localhost:3002/mcp', {
      method: 'POST',
      headers: {
        Host: 'localhost:3002',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 })
    });

    const response = await runtime.authenticatedMcpHandler(request);
    expect(response.status).toBe(401);
    const wwwAuth = response.headers.get('www-authenticate');
    expect(wwwAuth).toContain('Bearer');
    expect(wwwAuth).toContain('activity:read');
  });
});
