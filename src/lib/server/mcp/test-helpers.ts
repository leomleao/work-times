import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
  type OAuthTokenVerifier,
  type ServerEventBus,
  type ServerNotifier
} from '@modelcontextprotocol/server';
import { vi } from 'vitest';

export interface MockTokenOptions {
  clientId?: string;
  scopes?: string[];
  expiresAt?: number;
  resource?: URL | string;
}

export function createMockTokenVerifier(
  tokens: Record<string, MockTokenOptions> = {},
  defaultResource: URL = new URL('http://localhost:3002/mcp')
): OAuthTokenVerifier & {
  setToken(token: string, opts: MockTokenOptions): void;
  removeToken(token: string): void;
} {
  const tokenStore = new Map<string, MockTokenOptions>(Object.entries(tokens));

  const verifier: OAuthTokenVerifier & {
    setToken(token: string, opts: MockTokenOptions): void;
    removeToken(token: string): void;
  } = {
    setToken(token: string, opts: MockTokenOptions) {
      tokenStore.set(token, opts);
    },
    removeToken(token: string) {
      tokenStore.delete(token);
    },
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const entry = tokenStore.get(token);
      if (!entry) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token is invalid or expired');
      }

      const resource = entry.resource
        ? (entry.resource instanceof URL ? entry.resource : new URL(entry.resource))
        : defaultResource;

      return {
        token,
        clientId: entry.clientId ?? 'mock-client-id',
        scopes: entry.scopes ? [...entry.scopes] : ['activity:read'],
        expiresAt: 'expiresAt' in entry ? entry.expiresAt : Math.floor(Date.now() / 1000) + 3600,
        resource
      };
    }
  };

  return verifier;
}

export interface MockMcpHandler extends McpHttpHandler {
  fetchMock: ReturnType<typeof vi.fn>;
  closeMock: ReturnType<typeof vi.fn>;
  receivedOptions: Array<McpHandlerRequestOptions | undefined>;
  receivedRequests: Request[];
}

export function createMockMcpHandler(
  responseGenerator: (request: Request, options?: McpHandlerRequestOptions) => Response | Promise<Response> = () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', result: { ok: true }, id: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
): MockMcpHandler {
  const receivedOptions: Array<McpHandlerRequestOptions | undefined> = [];
  const receivedRequests: Request[] = [];

  const fetchMock = vi.fn(async (request: Request, options?: McpHandlerRequestOptions) => {
    receivedRequests.push(request);
    receivedOptions.push(options);
    return responseGenerator(request, options);
  });

  const closeMock = vi.fn(async () => {});

  const dummyBus: ServerEventBus = {
    publish: vi.fn(),
    subscribe: vi.fn(() => () => {})
  };

  const dummyNotifier: ServerNotifier = {
    sendNotification: vi.fn(async () => {})
  } as unknown as ServerNotifier;

  return {
    fetch: fetchMock,
    close: closeMock,
    bus: dummyBus,
    notify: dummyNotifier,
    fetchMock,
    closeMock,
    receivedOptions,
    receivedRequests
  };
}

export function createMcpRequest(
  url: string | URL = 'http://localhost:3002/mcp',
  options?: {
    method?: string;
    token?: string;
    authorization?: string;
    host?: string | null;
    origin?: string;
    contentType?: string;
    accept?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }
): Request {
  const method = options?.method ?? 'POST';
  const headers = new Headers();

  if (options?.host !== null) {
    const hostValue = options?.host ?? (url instanceof URL ? url.host : new URL(url).host);
    headers.set('host', hostValue);
  }

  if (options?.origin !== undefined) {
    headers.set('origin', options.origin);
  }

  if (options?.authorization !== undefined) {
    headers.set('authorization', options.authorization);
  } else if (options?.token !== undefined) {
    headers.set('authorization', `Bearer ${options.token}`);
  }

  if (options?.contentType !== undefined) {
    headers.set('content-type', options.contentType);
  } else if (method === 'POST') {
    headers.set('content-type', 'application/json');
  }

  if (options?.accept !== undefined) {
    headers.set('accept', options.accept);
  } else {
    headers.set('accept', 'application/json, text/event-stream');
  }

  if (options?.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      headers.set(k, v);
    }
  }

  const reqInit: RequestInit = {
    method,
    headers
  };

  if (method === 'POST') {
    reqInit.body = options?.body !== undefined
      ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
      : JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
  }

  return new Request(url, reqInit);
}
