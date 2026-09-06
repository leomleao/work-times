import { describe, expect, it, vi } from 'vitest';
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo
} from '@modelcontextprotocol/server';
import { createAuthenticatedMcpHandler } from './http';
import {
  createMockMcpHandler,
  createMockTokenVerifier,
  createMcpRequest
} from './test-helpers';
import { createWorkTimesMcpHandler } from './server';
import type { WorkOnlyAnalytics } from '$lib/server/analytics/work-only';

const MCP_URL = new URL('http://localhost:3002/mcp');
const EXPECTED_METADATA_URL = 'http://localhost:3002/.well-known/oauth-protected-resource/mcp';

describe('authenticated MCP HTTP boundary', () => {
  const validToken = 'wtk_valid_read_token';
  const noScopeToken = 'wtk_no_activity_read';
  const wrongResourceToken = 'wtk_wrong_resource';
  const expiredToken = 'wtk_expired';
  const noExpToken = 'wtk_no_exp';

  function setupTestBoundary(options?: {
    allowedHosts?: string[];
    allowedOrigins?: string[];
    resource?: URL;
  }) {
    const resource = options?.resource ?? MCP_URL;
    const verifier = createMockTokenVerifier({
      [validToken]: {
        clientId: 'client-read',
        scopes: ['activity:read'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource
      },
      [noScopeToken]: {
        clientId: 'client-other',
        scopes: ['operations:read', 'activity:detail'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource
      },
      [wrongResourceToken]: {
        clientId: 'client-wrong-res',
        scopes: ['activity:read'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource: new URL('http://localhost:3002/other-resource')
      },
      [expiredToken]: {
        clientId: 'client-expired',
        scopes: ['activity:read'],
        expiresAt: Math.floor(Date.now() / 1000) - 100,
        resource
      },
      [noExpToken]: {
        clientId: 'client-no-exp',
        scopes: ['activity:read'],
        expiresAt: undefined,
        resource
      }
    }, resource);

    const handler = createMockMcpHandler();
    const wrapped = createAuthenticatedMcpHandler({
      handler,
      verifier,
      resource,
      allowedHosts: options?.allowedHosts,
      allowedOrigins: options?.allowedOrigins
    });

    return { wrapped, handler, verifier, resource };
  }

  describe('bearer authentication (missing / invalid 401)', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const { wrapped, handler } = setupTestBoundary();
      const request = createMcpRequest(MCP_URL, { authorization: undefined });

      const response = await wrapped(request);

      expect(response.status).toBe(401);
      const wwwAuth = response.headers.get('www-authenticate');
      expect(wwwAuth).toBeTruthy();
      expect(wwwAuth).toContain('Bearer error="invalid_token"');
      expect(wwwAuth).toContain('error_description="Missing Authorization header"');
      expect(wwwAuth).toContain('scope="activity:read"');
      expect(wwwAuth).toContain(`resource_metadata="${EXPECTED_METADATA_URL}"`);
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });

    it('returns 401 when Authorization header is not a Bearer token', async () => {
      const { wrapped, handler } = setupTestBoundary();
      const request = createMcpRequest(MCP_URL, { authorization: 'Basic dXNlcjpwYXNz' });

      const response = await wrapped(request);

      expect(response.status).toBe(401);
      const wwwAuth = response.headers.get('www-authenticate');
      expect(wwwAuth).toContain('Bearer error="invalid_token"');
      expect(wwwAuth).toContain(`resource_metadata="${EXPECTED_METADATA_URL}"`);
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });

    it('returns 401 when Bearer token is unknown / invalid', async () => {
      const { wrapped, handler } = setupTestBoundary();
      const request = createMcpRequest(MCP_URL, { token: 'unknown_token_xyz' });

      const response = await wrapped(request);

      expect(response.status).toBe(401);
      const wwwAuth = response.headers.get('www-authenticate');
      expect(wwwAuth).toContain('Bearer error="invalid_token"');
      expect(wwwAuth).toContain(`resource_metadata="${EXPECTED_METADATA_URL}"`);
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });

    it('returns 401 when Bearer token has expired', async () => {
      const { wrapped, handler } = setupTestBoundary();
      const request = createMcpRequest(MCP_URL, { token: expiredToken });

      const response = await wrapped(request);

      expect(response.status).toBe(401);
      const wwwAuth = response.headers.get('www-authenticate');
      expect(wwwAuth).toContain('Bearer error="invalid_token"');
      expect(wwwAuth).toContain('Token has expired');
      expect(wwwAuth).toContain(`resource_metadata="${EXPECTED_METADATA_URL}"`);
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });

    it('returns 401 when Bearer token has no expiration time', async () => {
      const { wrapped, handler } = setupTestBoundary();
      const request = createMcpRequest(MCP_URL, { token: noExpToken });

      const response = await wrapped(request);

      expect(response.status).toBe(401);
      const wwwAuth = response.headers.get('www-authenticate');
      expect(wwwAuth).toContain('Bearer error="invalid_token"');
      expect(wwwAuth).toContain('Token has no expiration time');
      expect(wwwAuth).toContain(`resource_metadata="${EXPECTED_METADATA_URL}"`);
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('scope enforcement (missing scope 403)', () => {
    it('returns 403 when token lacks activity:read scope', async () => {
      const { wrapped, handler } = setupTestBoundary();
      const request = createMcpRequest(MCP_URL, { token: noScopeToken });

      const response = await wrapped(request);

      expect(response.status).toBe(403);
      const wwwAuth = response.headers.get('www-authenticate');
      expect(wwwAuth).toBeTruthy();
      expect(wwwAuth).toContain('Bearer error="insufficient_scope"');
      expect(wwwAuth).toContain('error_description="Insufficient scope"');
      expect(wwwAuth).toContain('scope="activity:read"');
      expect(wwwAuth).toContain(`resource_metadata="${EXPECTED_METADATA_URL}"`);
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('resource URL validation (wrong resource)', () => {
    it('rejects when AuthInfo.resource does not match the exact configured MCP URL', async () => {
      const { wrapped, handler } = setupTestBoundary();
      const request = createMcpRequest(MCP_URL, { token: wrongResourceToken });

      const response = await wrapped(request);

      expect(response.status).toBe(401);
      const wwwAuth = response.headers.get('www-authenticate');
      expect(wwwAuth).toContain('Bearer error="invalid_token"');
      expect(wwwAuth).toContain('Token resource does not match configured MCP resource');
      expect(wwwAuth).toContain(`resource_metadata="${EXPECTED_METADATA_URL}"`);
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });

    it('rejects when AuthInfo.resource is undefined', async () => {
      const { wrapped, verifier, handler } = setupTestBoundary();
      verifier.setToken('no_resource_token', {
        clientId: 'client-no-resource',
        scopes: ['activity:read'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource: undefined
      });
      // Override verify to return no resource
      const originalVerify = verifier.verifyAccessToken.bind(verifier);
      verifier.verifyAccessToken = async (token: string): Promise<AuthInfo> => {
        if (token === 'no_resource_token') {
          return {
            token,
            clientId: 'client-no-resource',
            scopes: ['activity:read'],
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            resource: undefined
          };
        }
        return originalVerify(token);
      };

      const request = createMcpRequest(MCP_URL, { token: 'no_resource_token' });
      const response = await wrapped(request);

      expect(response.status).toBe(401);
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });

    it('rejects when AuthInfo.resource differs by host, port, or path', async () => {
      const { wrapped, verifier, handler } = setupTestBoundary();
      verifier.setToken('wrong_host_token', {
        clientId: 'client-wrong-host',
        scopes: ['activity:read'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource: new URL('http://other-host:3002/mcp')
      });

      const request = createMcpRequest(MCP_URL, { token: 'wrong_host_token' });
      const response = await wrapped(request);

      expect(response.status).toBe(401);
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('Host and Origin header validation', () => {
    it('returns 403 on hostile Host header', async () => {
      const { wrapped, handler } = setupTestBoundary({
        allowedHosts: ['localhost', '127.0.0.1']
      });
      const request = createMcpRequest(MCP_URL, {
        token: validToken,
        host: 'evil.com'
      });

      const response = await wrapped(request);

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json).toHaveProperty('error');
      expect(json.error.message).toContain('Invalid Host: evil.com');
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });

    it('returns 403 when Host header is missing', async () => {
      const { wrapped, handler } = setupTestBoundary({
        allowedHosts: ['localhost']
      });
      const request = createMcpRequest(MCP_URL, {
        token: validToken,
        host: null
      });

      const response = await wrapped(request);

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.error.message).toContain('Missing Host header');
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });

    it('returns 403 on hostile Origin header', async () => {
      const { wrapped, handler } = setupTestBoundary({
        allowedHosts: ['localhost'],
        allowedOrigins: ['localhost']
      });
      const request = createMcpRequest(MCP_URL, {
        token: validToken,
        host: 'localhost:3002',
        origin: 'https://evil.com'
      });

      const response = await wrapped(request);

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json).toHaveProperty('error');
      expect(json.error.message).toContain('Invalid Origin: evil.com');
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });

    it('returns 403 on unparseable / opaque null Origin header', async () => {
      const { wrapped, handler } = setupTestBoundary({
        allowedHosts: ['localhost'],
        allowedOrigins: ['localhost']
      });
      const request = createMcpRequest(MCP_URL, {
        token: validToken,
        host: 'localhost:3002',
        origin: 'null'
      });

      const response = await wrapped(request);

      expect(response.status).toBe(403);
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });

    it('accepts non-browser clients without Origin (absent Origin success)', async () => {
      const { wrapped, handler } = setupTestBoundary({
        allowedHosts: ['localhost'],
        allowedOrigins: ['localhost']
      });
      // Absent Origin header
      const request = createMcpRequest(MCP_URL, {
        token: validToken,
        host: 'localhost:3002'
      });
      expect(request.headers.get('origin')).toBeNull();

      const response = await wrapped(request);

      expect(response.status).toBe(200);
      expect(handler.fetchMock).toHaveBeenCalledTimes(1);
    });

    it('accepts requests with valid allowed Origin', async () => {
      const { wrapped, handler } = setupTestBoundary({
        allowedHosts: ['localhost'],
        allowedOrigins: ['localhost']
      });
      const request = createMcpRequest(MCP_URL, {
        token: validToken,
        host: 'localhost:3002',
        origin: 'http://localhost:3002'
      });

      const response = await wrapped(request);

      expect(response.status).toBe(200);
      expect(handler.fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('authInfo passthrough to handler.fetch', () => {
    it('passes validated AuthInfo directly into handler.fetch options', async () => {
      const { wrapped, handler } = setupTestBoundary();
      const request = createMcpRequest(MCP_URL, { token: validToken });

      const response = await wrapped(request);

      expect(response.status).toBe(200);
      expect(handler.fetchMock).toHaveBeenCalledTimes(1);
      const passedOptions = handler.receivedOptions[0];
      expect(passedOptions).toBeDefined();
      expect(passedOptions?.authInfo).toBeDefined();
      expect(passedOptions?.authInfo?.token).toBe(validToken);
      expect(passedOptions?.authInfo?.clientId).toBe('client-read');
      expect(passedOptions?.authInfo?.scopes).toEqual(['activity:read']);
      expect(passedOptions?.authInfo?.resource?.href).toBe(MCP_URL.href);
    });

    it('preserves requestOptions such as parsedBody alongside authInfo', async () => {
      const { wrapped, handler } = setupTestBoundary();
      const request = createMcpRequest(MCP_URL, { token: validToken });
      const customBody = { jsonrpc: '2.0', method: 'tools/list', id: 42 };

      await wrapped.fetch(request, { parsedBody: customBody });

      expect(handler.fetchMock).toHaveBeenCalledTimes(1);
      const passedOptions = handler.receivedOptions[0];
      expect(passedOptions?.parsedBody).toEqual(customBody);
      expect(passedOptions?.authInfo?.token).toBe(validToken);
    });
  });

  describe('HTTP method validation', () => {
    it('allows GET requests to reach the handler', async () => {
      const { wrapped, handler } = setupTestBoundary();
      const request = createMcpRequest(MCP_URL, {
        method: 'GET',
        token: validToken
      });

      const response = await wrapped(request);

      expect(response.status).toBe(200);
      expect(handler.fetchMock).toHaveBeenCalledTimes(1);
    });

    it('allows POST requests to reach the handler', async () => {
      const { wrapped, handler } = setupTestBoundary();
      const request = createMcpRequest(MCP_URL, {
        method: 'POST',
        token: validToken
      });

      const response = await wrapped(request);

      expect(response.status).toBe(200);
      expect(handler.fetchMock).toHaveBeenCalledTimes(1);
    });

    it('allows DELETE requests to reach the handler', async () => {
      const { wrapped, handler } = setupTestBoundary();
      const request = createMcpRequest(MCP_URL, {
        method: 'DELETE',
        token: validToken
      });

      const response = await wrapped(request);

      expect(response.status).toBe(200);
      expect(handler.fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects PUT with 405 Method Not Allowed and Allow header', async () => {
      const { wrapped, handler } = setupTestBoundary();
      const request = createMcpRequest(MCP_URL, {
        method: 'PUT',
        token: validToken
      });

      const response = await wrapped(request);

      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, POST, DELETE');
      const body = await response.json();
      expect(body.error).toBe('method_not_allowed');
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });

    it('rejects PATCH with 405 Method Not Allowed and Allow header', async () => {
      const { wrapped, handler } = setupTestBoundary();
      const request = createMcpRequest(MCP_URL, {
        method: 'PATCH',
        token: validToken
      });

      const response = await wrapped(request);

      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, POST, DELETE');
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });

    it('rejects OPTIONS with 405 Method Not Allowed and Allow header', async () => {
      const { wrapped, handler } = setupTestBoundary();
      const request = createMcpRequest(MCP_URL, {
        method: 'OPTIONS',
        token: validToken
      });

      const response = await wrapped(request);

      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, POST, DELETE');
      expect(handler.fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('privacy and logging guarantee', () => {
    it('never logs tokens, request bodies, tool arguments, or outputs', async () => {
      const logSpy = vi.spyOn(console, 'log');
      const warnSpy = vi.spyOn(console, 'warn');
      const errorSpy = vi.spyOn(console, 'error');
      const infoSpy = vi.spyOn(console, 'info');

      try {
        const secretToken = 'wtk_super_secret_token_12345';
        const secretPayload = {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'get_work_evidence',
            arguments: { secretArgument: 'confidential_project_name' }
          },
          id: 10
        };

        const { wrapped, verifier } = setupTestBoundary();
        verifier.setToken(secretToken, {
          clientId: 'client-secret',
          scopes: ['activity:read'],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          resource: MCP_URL
        });

        // 1. Unauthenticated request
        const reqUnauth = createMcpRequest(MCP_URL, { authorization: 'Bearer invalid_secret_token' });
        await wrapped(reqUnauth);

        // 2. Authenticated request with body
        const reqAuth = createMcpRequest(MCP_URL, {
          token: secretToken,
          body: secretPayload
        });
        await wrapped(reqAuth);

        // 3. Collect all calls across log methods
        const allLoggedStrings: string[] = [
          ...logSpy.mock.calls,
          ...warnSpy.mock.calls,
          ...errorSpy.mock.calls,
          ...infoSpy.mock.calls
        ].flatMap((args) => args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))));

        for (const logged of allLoggedStrings) {
          expect(logged).not.toContain(secretToken);
          expect(logged).not.toContain('invalid_secret_token');
          expect(logged).not.toContain('confidential_project_name');
          expect(logged).not.toContain('secretArgument');
        }
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
        infoSpy.mockRestore();
      }
    });
  });

  describe('handler lifecycle and integration', () => {
    it('delegates close(), notify, and bus to the underlying McpHttpHandler', async () => {
      const { wrapped, handler } = setupTestBoundary();

      await wrapped.close();
      expect(handler.closeMock).toHaveBeenCalledTimes(1);
      expect(wrapped.bus).toBe(handler.bus);
      expect(wrapped.notify).toBe(handler.notify);
      expect(wrapped.handler).toBe(handler);
    });

    it('integrates seamlessly with createWorkTimesMcpHandler and executes real MCP tools', async () => {
      const analytics: WorkOnlyAnalytics = {
        getRangeSummary: vi.fn(async () => ({
          start: '2026-09-01',
          end: '2026-09-02',
          workSeconds: 3600,
          unclassifiedSeconds: 0,
          hasUnclassified: false,
          days: []
        })),
        getDayEvidence: vi.fn(async () => ({
          date: '2026-09-01',
          workSeconds: 3600,
          unclassifiedSeconds: 0,
          hasUnclassified: false,
          projects: []
        }))
      };

      const realMcpHandler = createWorkTimesMcpHandler(analytics);
      const verifier = createMockTokenVerifier({
        [validToken]: {
          clientId: 'client-integration',
          scopes: ['activity:read'],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          resource: MCP_URL
        }
      }, MCP_URL);

      const wrapped = createAuthenticatedMcpHandler(realMcpHandler, {
        verifier,
        resource: MCP_URL,
        allowedHosts: ['localhost']
      });

      try {
        const request = createMcpRequest(MCP_URL, {
          token: validToken,
          host: 'localhost:3002',
          body: {
            jsonrpc: '2.0',
            method: 'tools/list',
            id: 1
          }
        });

        const response = await wrapped(request);
        expect(response.status).toBe(200);

        const responseText = await response.text();
        expect(responseText).toContain('get_work_summary');
        expect(responseText).toContain('get_work_evidence');
      } finally {
        await wrapped.close();
      }
    });

    it('rejects unauthenticated requests to real McpHandler before touching analytics', async () => {
      const analytics: WorkOnlyAnalytics = {
        getRangeSummary: vi.fn(),
        getDayEvidence: vi.fn()
      };

      const realMcpHandler = createWorkTimesMcpHandler(analytics);
      const verifier = createMockTokenVerifier({}, MCP_URL);

      const wrapped = createAuthenticatedMcpHandler(realMcpHandler, {
        verifier,
        resource: MCP_URL
      });

      try {
        const request = createMcpRequest(MCP_URL, {
          token: 'invalid_token',
          body: {
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
              name: 'get_work_summary',
              arguments: { start: '2026-09-01', end: '2026-09-02' }
            },
            id: 1
          }
        });

        const response = await wrapped(request);
        expect(response.status).toBe(401);
        expect(analytics.getRangeSummary).not.toHaveBeenCalled();
      } finally {
        await wrapped.close();
      }
    });
  });
});
