import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase } from '../../src/lib/server/db/connection.js';
import { createRuntime } from '../../src/lib/server/runtime.js';
import { parsePublicUrl } from '../../src/lib/server/config.js';
import { createMcpRequest } from '../../src/lib/server/mcp/test-helpers.js';
import { createS256Challenge } from '../../src/lib/server/oauth/pkce.js';

describe('Integration: Bearer/OAuth Work-Only MCP Boundary and Privacy Contracts', () => {
  let db: Database.Database;

  const MCP_URL = new URL('http://localhost:3002/mcp');
  const EXPECTED_METADATA_URL = 'http://localhost:3002/.well-known/oauth-protected-resource/mcp';

  // Dynamic recent date (yesterday) and fresh lastSuccessAt to exercise truthful dataQuality
  const TEST_DATE = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const LAST_SUCCESS_AT = new Date().toISOString();

  beforeEach(() => {
    db = openTestDatabase();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Ignore if already closed
    }
  });

  /**
   * Seeds an isolated database with realistic multi-project data:
   * - 1 Work project (5000s)
   * - 1 Personal project (2000s)
   * - 1 Unclassified project (1000s)
   * - Official daily totals (8000s)
   * - Heartbeats and layer state
   */
  function seedMcpTestDatabase(
    targetDb: Database.Database,
    date: string = TEST_DATE,
    lastSuccessAt: string = LAST_SUCCESS_AT
  ) {
    targetDb.exec(`
      INSERT INTO source_imports (id, source_type, source_hash, byte_size, status)
      VALUES (1, 'api_summaries', 'shash_001', 1024, 'completed');

      INSERT INTO projects (id, name, is_unattributed)
      VALUES
        (10, 'project-client-work', 0),
        (20, 'personal-finances', 0),
        (30, 'unassigned-experiments', 0);

      INSERT INTO daily_totals (date, timezone, total_seconds, grand_total_json, source_import_id, source_hash)
      VALUES ('${date}', 'Europe/London', 8000.0, '{"total_seconds":8000.0}', 1, 'shash_001');

      INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, kind, total_seconds, source_import_id)
      VALUES
        (1, '${date}', 10, 'src/api/auth.ts', 'file', 'entity', 5000.0, 1),
        (2, '${date}', 20, '/Users/private/banking/taxes.xlsx', 'file', 'entity', 2000.0, 1),
        (3, '${date}', 30, 'experiments/test.py', 'file', 'entity', 1000.0, 1);

      INSERT INTO daily_dimension_totals (id, date, scope, project_id, dimension, name, total_seconds, source_import_id)
      VALUES
        (1, '${date}', 'account', NULL, 'category', 'Coding', 8000.0, 1),
        (2, '${date}', 'project', 10, 'category', 'Coding', 5000.0, 1),
        (3, '${date}', 'project', 10, 'language', 'TypeScript', 5000.0, 1),
        (4, '${date}', 'project', 20, 'category', 'Finance', 2000.0, 1),
        (5, '${date}', 'project', 20, 'language', 'Excel', 2000.0, 1),
        (6, '${date}', 'project', 30, 'category', 'Coding', 1000.0, 1),
        (7, '${date}', 'project', 30, 'language', 'Python', 1000.0, 1);

      INSERT INTO classification_rules (id, name, classification, selector_type, selector_value, match_mode, priority, enabled)
      VALUES
        ('rule_work', 'Client Work is Work', 'work', 'project', 'project-client-work', 'exact', 10, 1),
        ('rule_personal', 'Finances are Personal', 'personal', 'project', 'personal-finances', 'exact', 10, 1);

      INSERT INTO sync_layer_state (
        date, layer, last_attempt_at, last_success_at, accepted_fidelity, accepted_source_reference,
        accepted_snapshot_version, accepted_content_hash, verified_timezone, evidence_matches_summary,
        status_code, next_retry_at, is_stale, unresolved_mismatch, has_detail_downgrade, has_restriction,
        has_failure, updated_at
      )
      VALUES (
        '${date}', 'summaries', '${lastSuccessAt}', '${lastSuccessAt}', 'entity_detail', 'api:sync',
        1, 'chash_001', 'Europe/London', 1,
        NULL, NULL, 0, 0, 0, 0,
        0, '${lastSuccessAt}'
      );
    `);
  }

  function setupRuntime() {
    seedMcpTestDatabase(db, TEST_DATE, LAST_SUCCESS_AT);

    const runtime = createRuntime(
      {
        databasePath: ':memory:',
        wakatimeOAuthClientId: null,
        wakatimeOAuthClientSecret: null,
        adminUsername: 'testadmin',
        adminPasswordHash: 'scrypt$dummy',
        sessionSecret: 'test-secret-at-least-32-chars-long-for-integration',
        publicUrl: parsePublicUrl('http://localhost:3002'),
        cookieSecure: false,
        maxDirectImportBytes: 10 * 1024 * 1024
      },
      db
    );

    return runtime;
  }

  async function parseMcpResponse<T = Record<string, any>>(response: Response): Promise<T> {
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          return JSON.parse(line.slice(6)) as T;
        }
      }
      throw new Error(`Failed to parse MCP response: ${text}`);
    }
  }

  // ==========================================================================
  // 1. Bearer and OAuth Authentication Boundary
  // ==========================================================================
  describe('Bearer and OAuth Authentication Boundary', () => {
    it('returns 401 with RFC 9728 resource metadata URL when Authorization header is missing', async () => {
      const runtime = setupRuntime();
      const request = createMcpRequest(MCP_URL, { authorization: undefined });

      const response = await runtime.authenticatedMcpHandler(request);
      expect(response.status).toBe(401);

      const wwwAuth = response.headers.get('www-authenticate');
      expect(wwwAuth).toBeTruthy();
      expect(wwwAuth).toContain('Bearer error="invalid_token"');
      expect(wwwAuth).toContain('scope="activity:read"');
      expect(wwwAuth).toContain(`resource_metadata="${EXPECTED_METADATA_URL}"`);
    });

    it('returns 401 when Authorization header is invalid or malformed', async () => {
      const runtime = setupRuntime();
      const request = createMcpRequest(MCP_URL, { authorization: 'Bearer wtk_invalid_token_does_not_exist' });

      const response = await runtime.authenticatedMcpHandler(request);
      expect(response.status).toBe(401);

      const wwwAuth = response.headers.get('www-authenticate');
      expect(wwwAuth).toContain('Bearer error="invalid_token"');
    });

    it('returns 403 or 401 when API key lacks required activity:read scope', async () => {
      const runtime = setupRuntime();

      // Create an API key with ONLY operations:read scope
      const { token } = await runtime.apiKeys.create({
        name: 'Ops Only Key',
        scopes: ['operations:read']
      });

      const request = createMcpRequest(MCP_URL, { token });
      const response = await runtime.authenticatedMcpHandler(request);

      // Must be rejected because activity:read scope is required for MCP
      expect([401, 403]).toContain(response.status);
      const wwwAuth = response.headers.get('www-authenticate');
      if (wwwAuth) {
        expect(wwwAuth).toContain('insufficient_scope');
      }
    });

    it('authenticates successfully with valid API key bearing activity:read scope', async () => {
      const runtime = setupRuntime();

      // Create valid API key
      const { token } = await runtime.apiKeys.create({
        name: 'Valid MCP Key',
        scopes: ['activity:read']
      });

      // Call tools/list
      const request = createMcpRequest(MCP_URL, {
        token,
        body: { jsonrpc: '2.0', method: 'tools/list', id: 1 }
      });

      const response = await runtime.authenticatedMcpHandler(request);
      expect(response.status).toBe(200);

      const body = await parseMcpResponse<{ result?: { tools?: Array<{ name: string }> } }>(response);
      expect(body.result?.tools).toBeDefined();
      const toolNames = body.result!.tools!.map((t) => t.name);
      expect(toolNames).toContain('get_work_summary');
      expect(toolNames).toContain('get_work_evidence');
    });

    it('authenticates successfully with valid OAuth access token bearing activity:read scope', async () => {
      const runtime = setupRuntime();
      const now = new Date();

      // 1. Register public client
      const client = await runtime.oauthClients.register({
        name: 'Claude Desktop Integration',
        redirectUris: ['http://localhost:8080/callback'],
        scopes: ['activity:read'],
        publicClient: true
      });

      // 2. Issue code with PKCE
      const verifier = '01234567890123456789012345678901234567890123456789';
      const issued = await runtime.oauthAuth.issueAuthorizationCode({
        clientId: client.metadata.clientId,
        redirectUri: 'http://localhost:8080/callback',
        resource: 'http://localhost:3002/mcp',
        scopes: ['activity:read'],
        codeChallenge: createS256Challenge(verifier),
        codeChallengeMethod: 'S256',
        state: 'oauth-state-1',
        now
      });

      // 3. Exchange code for access token
      const tokens = await runtime.oauthAuth.exchangeAuthorizationCode({
        code: issued.code,
        clientId: client.metadata.clientId,
        redirectUri: 'http://localhost:8080/callback',
        resource: 'http://localhost:3002/mcp',
        codeVerifier: verifier,
        now
      });

      expect(tokens?.accessToken).toMatch(/^wat_/);

      // 4. Request MCP tools/list with OAuth access token
      const request = createMcpRequest(MCP_URL, {
        token: tokens!.accessToken,
        body: { jsonrpc: '2.0', method: 'tools/list', id: 2 }
      });

      const response = await runtime.authenticatedMcpHandler(request);
      expect(response.status).toBe(200);
      const json = await parseMcpResponse<{ result?: { tools?: unknown[] } }>(response);
      expect(json.result?.tools).toBeDefined();
    });
  });

  // ==========================================================================
  // 2. Work-Only Output & Strict Privacy Boundary
  // ==========================================================================
  describe('Work-Only Output & Strict Privacy Boundary', () => {
    it('executes get_work_summary, quarantining personal time and exposing truthful dataQuality and unclassified warning', async () => {
      const runtime = setupRuntime();

      const { token } = await runtime.apiKeys.create({
        name: 'Work Summary Key',
        scopes: ['activity:read']
      });

      const request = createMcpRequest(MCP_URL, {
        token,
        body: {
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: {
            name: 'get_work_summary',
            arguments: {
              start: TEST_DATE,
              end: TEST_DATE
            }
          }
        }
      });

      const response = await runtime.authenticatedMcpHandler(request);
      expect(response.status).toBe(200);

      const json = (await parseMcpResponse(response)) as {
        result: {
          structuredContent: {
            start: string;
            end: string;
            workSeconds: number;
            unclassifiedSeconds: number;
            hasUnclassified: boolean;
            days: Array<{
              date: string;
              workSeconds: number;
              projects: Array<{
                project: string;
                seconds: number;
                categories: Array<{ name: string; seconds: number }>;
                languages: Array<{ name: string; seconds: number }>;
              }>;
            }>;
            dataQuality: {
              asOf: string | null;
              hasMissingDays: boolean;
              hasStaleDays: boolean;
              hasLimitedDetail: boolean;
              advisoryCodes: string[];
            };
          };
          content: Array<{ type: string; text: string }>;
        };
      };

      const result = json.result.structuredContent;

      // 1. Work totals strictly report ONLY work classified seconds (5000s)
      expect(result.workSeconds).toBe(5000.0);

      // 2. Personal time (2000s) is completely excluded from workSeconds
      // 3. Unclassified time (1000s) is truthfully warned in metadata
      expect(result.unclassifiedSeconds).toBe(1000.0);
      expect(result.hasUnclassified).toBe(true);

      // 4. Projects breakdown in days array contains ONLY work projects
      expect(result.days).toHaveLength(1);
      const day = result.days[0];
      expect(day.date).toBe(TEST_DATE);
      expect(day.workSeconds).toBe(5000.0);
      expect(day.projects).toHaveLength(1);
      expect(day.projects[0].project).toBe('project-client-work');
      expect(day.projects[0].seconds).toBe(5000.0);

      // 5. DataQuality reflects real sync_layer_state
      expect(result.dataQuality).toBeDefined();
      expect(result.dataQuality.asOf).toBe(LAST_SUCCESS_AT);
      expect(result.dataQuality.hasMissingDays).toBe(false);
      expect(result.dataQuality.hasStaleDays).toBe(false);

      // 6. Strict Privacy & Quarantine Guarantee:
      // Neither personal project name ('personal-finances') nor personal file path ('/Users/private/banking/taxes.xlsx')
      // nor personal category ('Finance') nor unclassified entity names appear anywhere in output string!
      const rawText = JSON.stringify(json);
      expect(rawText).not.toContain('personal-finances');
      expect(rawText).not.toContain('banking');
      expect(rawText).not.toContain('taxes.xlsx');
      expect(rawText).not.toContain('Finance');
      expect(rawText).not.toContain('unassigned-experiments');
      expect(rawText).not.toContain('test.py');
    });

    it('executes get_work_evidence, omitting exact file paths and returning 0 for personal project queries', async () => {
      const runtime = setupRuntime();

      const { token } = await runtime.apiKeys.create({
        name: 'Work Evidence Key',
        scopes: ['activity:read']
      });

      // 1. Query work evidence for the day
      const reqAll = createMcpRequest(MCP_URL, {
        token,
        body: {
          jsonrpc: '2.0',
          id: 20,
          method: 'tools/call',
          params: {
            name: 'get_work_evidence',
            arguments: {
              date: TEST_DATE
            }
          }
        }
      });

      const resAll = await runtime.authenticatedMcpHandler(reqAll);
      expect(resAll.status).toBe(200);

      const jsonAll = (await parseMcpResponse(resAll)) as {
        result: {
          structuredContent: {
            date: string;
            workSeconds: number;
            unclassifiedSeconds: number;
            hasUnclassified: boolean;
            projects: Array<{
              project: string;
              seconds: number;
              categories: Array<{ name: string; seconds: number }>;
              languages: Array<{ name: string; seconds: number }>;
            }>;
          };
        };
      };

      const resultAll = jsonAll.result.structuredContent;
      expect(resultAll.workSeconds).toBe(5000.0);
      expect(resultAll.unclassifiedSeconds).toBe(1000.0);
      expect(resultAll.projects.map((p) => p.project)).toEqual(['project-client-work']);

      // Exact files (e.g. 'src/api/auth.ts') are excluded from timesheet output
      const rawTextAll = JSON.stringify(jsonAll);
      expect(rawTextAll).not.toContain('auth.ts');
      expect(rawTextAll).not.toContain('taxes.xlsx');

      // 2. Adversarial Query: request evidence specifically for the personal project
      const reqPersonal = createMcpRequest(MCP_URL, {
        token,
        body: {
          jsonrpc: '2.0',
          id: 21,
          method: 'tools/call',
          params: {
            name: 'get_work_evidence',
            arguments: {
              date: TEST_DATE,
              project: 'personal-finances'
            }
          }
        }
      });

      const resPersonal = await runtime.authenticatedMcpHandler(reqPersonal);
      expect(resPersonal.status).toBe(200);

      const jsonPersonal = (await parseMcpResponse(resPersonal)) as {
        result: {
          structuredContent: {
            workSeconds: number;
            projects: unknown[];
          };
        };
      };

      // Invariant: querying personal project returns 0 work seconds and empty projects array!
      expect(jsonPersonal.result.structuredContent.workSeconds).toBe(0.0);
      expect(jsonPersonal.result.structuredContent.projects).toEqual([]);
      expect(JSON.stringify(jsonPersonal)).not.toContain('taxes.xlsx');
    });
  });
});
