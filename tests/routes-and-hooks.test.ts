import { describe, expect, it } from 'vitest';
import { handle } from '../src/hooks.server';
import { runtime } from '../src/lib/server/runtime';
import { ADMIN_SESSION_COOKIE, csrfTokenForSession } from '../src/lib/server/security/http';
import { hashPassword } from '../src/lib/server/security/password';
import { GET as healthGet } from '../src/routes/api/health/+server';
import { actions as loginActions, load as loginLoad } from '../src/routes/login/+page.server';
import { actions as apiKeyActions, load as apiKeyLoad } from '../src/routes/admin/api-keys/+page.server';
import { actions as oauthActions, load as oauthLoad } from '../src/routes/admin/oauth-clients/+page.server';
import { load as adminLayoutLoad } from '../src/routes/admin/+layout.server';

function createMockEvent(options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  body?: BodyInit;
  locals?: Partial<App.Locals>;
}) {
  const url = new URL(options.url);
  const method = options.method ?? 'GET';
  const headers = new Headers(options.headers ?? {});
  const cookieStore = new Map<string, { value: string; options: Record<string, unknown> }>(
    Object.entries(options.cookies ?? {}).map(([k, v]) => [k, { value: v, options: {} }])
  );

  const request = new Request(url, {
    method,
    headers,
    body: options.body
  });

  const locals: App.Locals = {
    admin: null,
    sessionToken: null,
    csrfToken: null,
    ...(options.locals ?? {})
  };

  const cookiesObj = {
    get: (name: string) => cookieStore.get(name)?.value,
    set: (name: string, value: string, opts: Record<string, unknown> = {}) => {
      cookieStore.set(name, { value, options: opts });
    },
    delete: (name: string, opts: Record<string, unknown> = {}) => {
      cookieStore.delete(name);
    },
    serialize: () => ''
  };

  const event: Parameters<typeof handle>[0]['event'] = {
    request,
    url,
    locals,
    cookies: cookiesObj as any,
    getClientAddress: () => '127.0.0.1',
    params: {},
    route: { id: url.pathname },
    isDataRequest: false,
    setHeaders: () => {},
    fetch: globalThis.fetch
  } as any;

  return { event, cookieStore };
}

describe('Hooks & Route Protection', () => {
  it('applies standard security headers to all responses', async () => {
    const { event } = createMockEvent({ url: 'http://localhost:3002/api/health' });
    const resolve = async () => new Response('ok');

    const response = await handle({ event, resolve });
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('same-origin');
  });

  it('redirects unauthenticated browser requests to /admin to /login with 303', async () => {
    const { event } = createMockEvent({ url: 'http://localhost:3002/admin' });
    const resolve = async () => new Response('admin content');

    await expect(handle({ event, resolve })).rejects.toMatchObject({
      status: 303,
      location: '/login'
    });
  });

  it('returns 401 JSON for unauthenticated requests to /api/admin', async () => {
    const { event } = createMockEvent({ url: 'http://localhost:3002/api/admin/data' });
    const resolve = async () => new Response('data');

    const response = await handle({ event, resolve });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: 'Unauthorized' });
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('allows authenticated session through to /admin', async () => {
    // Mock authenticate to return an admin principal
    const origAuth = runtime.adminAuth.authenticate;
    (runtime.adminAuth as any).authenticate = async (token: string) => {
      if (token === 'valid-admin-token') {
        return { username: 'admin', sessionExpiresAt: new Date(Date.now() + 3600000).toISOString() };
      }
      return null;
    };

    try {
      const { event } = createMockEvent({
        url: 'http://localhost:3002/admin',
        cookies: { [ADMIN_SESSION_COOKIE]: 'valid-admin-token' }
      });
      const resolve = async () => new Response('admin content', { status: 200 });

      const response = await handle({ event, resolve });
      expect(response.status).toBe(200);
      expect(event.locals.admin?.username).toBe('admin');
      expect(event.locals.csrfToken).toBeTruthy();
    } finally {
      runtime.adminAuth.authenticate = origAuth;
    }
  });

  it('redirects authenticated user visiting /login GET to /admin', async () => {
    const origAuth = runtime.adminAuth.authenticate;
    (runtime.adminAuth as any).authenticate = async (token: string) => {
      if (token === 'valid-admin-token') {
        return { username: 'admin', sessionExpiresAt: new Date(Date.now() + 3600000).toISOString() };
      }
      return null;
    };

    try {
      const { event } = createMockEvent({
        url: 'http://localhost:3002/login',
        method: 'GET',
        cookies: { [ADMIN_SESSION_COOKIE]: 'valid-admin-token' }
      });
      const resolve = async () => new Response('login page');

      await expect(handle({ event, resolve })).rejects.toMatchObject({
        status: 303,
        location: '/admin'
      });
    } finally {
      runtime.adminAuth.authenticate = origAuth;
    }
  });

  it('rejects browser mutations with untrusted Origin', async () => {
    const { event } = createMockEvent({
      url: 'http://localhost:3002/login',
      method: 'POST',
      headers: {
        origin: 'http://attacker-controlled-site.com',
        'content-type': 'application/x-www-form-urlencoded'
      }
    });
    const resolve = async () => new Response('ok');

    const response = await handle({ event, resolve });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('Cross-origin request rejected');
  });

  it('rejects authenticated browser mutations with missing or invalid CSRF token', async () => {
    const origAuth = runtime.adminAuth.authenticate;
    (runtime.adminAuth as any).authenticate = async (token: string) => {
      if (token === 'valid-admin-token') {
        return { username: 'admin', sessionExpiresAt: new Date(Date.now() + 3600000).toISOString() };
      }
      return null;
    };

    try {
      const formData = new URLSearchParams();
      formData.set('csrfToken', 'tampered-csrf-token');

      const { event } = createMockEvent({
        url: 'http://localhost:3002/admin/api-keys',
        method: 'POST',
        headers: {
          origin: 'http://localhost:3002',
          'content-type': 'application/x-www-form-urlencoded'
        },
        cookies: { [ADMIN_SESSION_COOKIE]: 'valid-admin-token' },
        body: formData.toString()
      });
      const resolve = async () => new Response('ok');

      const response = await handle({ event, resolve });
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Invalid or missing CSRF token');
    } finally {
      runtime.adminAuth.authenticate = origAuth;
    }
  });

  it('allows authenticated browser mutation with matching HMAC session-bound CSRF token', async () => {
    const origAuth = runtime.adminAuth.authenticate;
    (runtime.adminAuth as any).authenticate = async (token: string) => {
      if (token === 'valid-admin-token') {
        return { username: 'admin', sessionExpiresAt: new Date(Date.now() + 3600000).toISOString() };
      }
      return null;
    };

    try {
      const validCsrf = csrfTokenForSession('valid-admin-token', runtime.sessionSecret);
      const formData = new URLSearchParams();
      formData.set('csrfToken', validCsrf);

      const { event } = createMockEvent({
        url: 'http://localhost:3002/admin/api-keys',
        method: 'POST',
        headers: {
          origin: 'http://localhost:3002',
          'content-type': 'application/x-www-form-urlencoded'
        },
        cookies: { [ADMIN_SESSION_COOKIE]: 'valid-admin-token' },
        body: formData.toString()
      });
      const resolve = async () => new Response('mutation processed', { status: 200 });

      const response = await handle({ event, resolve });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe('mutation processed');
    } finally {
      runtime.adminAuth.authenticate = origAuth;
    }
  });
});

describe('Health Endpoint (/api/health)', () => {
  it('reports status, service, and database readiness without sensitive data', async () => {
    const response = await healthGet();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');

    const data = await response.json();
    expect(data).toEqual({
      status: 'ok',
      service: 'work-times',
      database: 'ready'
    });

    // Verify absence of sensitive runtime info
    expect(data.databasePath).toBeUndefined();
    expect(data.adminUsername).toBeUndefined();
    expect(data.sessionSecret).toBeUndefined();
    expect(data.wakatimeApiKey).toBeUndefined();
  });
});

describe('Login & Logout Server Actions', () => {
  it('uses named actions for both login and logout so SvelteKit can dispatch them together', () => {
    expect(loginActions.login).toBeTypeOf('function');
    expect(loginActions.logout).toBeTypeOf('function');
    expect(loginActions.default).toBeUndefined();
  });

  it('rejects invalid credentials with generic error', async () => {
    const formData = new FormData();
    formData.set('username', 'wrong-user');
    formData.set('password', 'wrong-password');

    const { event } = createMockEvent({
      url: 'http://localhost:3002/login',
      method: 'POST'
    });
    event.request = new Request('http://localhost:3002/login', {
      method: 'POST',
      body: formData
    });

    const result = await (loginActions.login as any)(event);
    expect(result.status).toBe(400);
    expect(result.data.error).toBe('Invalid username or password');
  });

  it('prevents open redirect on successful login', async () => {
    // Set admin password hash in runtime
    const passwordHash = hashPassword('correct-horse-battery');
    (runtime.adminAuth as any).options.passwordHash = passwordHash;
    (runtime.adminAuth as any).options.username = 'admin';

    const formData = new FormData();
    formData.set('username', 'admin');
    formData.set('password', 'correct-horse-battery');
    formData.set('redirectTo', 'https://evil.com/phish');

    const { event, cookieStore } = createMockEvent({
      url: 'http://localhost:3002/login',
      method: 'POST'
    });
    event.request = new Request('http://localhost:3002/login', {
      method: 'POST',
      body: formData
    });

    await expect((loginActions.login as any)(event)).rejects.toMatchObject({
      status: 303,
      location: '/admin' // Falls back to /admin instead of evil.com
    });

    expect(cookieStore.has(ADMIN_SESSION_COOKIE)).toBe(true);
    const cookie = cookieStore.get(ADMIN_SESSION_COOKIE)!;
    expect(cookie.value.startsWith('wts_')).toBe(true);
    expect(cookie.options.httpOnly).toBe(true);
    expect(cookie.options.sameSite).toBe('lax');
  });

  it('allows safe relative redirect starting with /admin', async () => {
    const formData = new FormData();
    formData.set('username', 'admin');
    formData.set('password', 'correct-horse-battery');
    formData.set('redirectTo', '/admin/oauth-clients');

    const { event } = createMockEvent({
      url: 'http://localhost:3002/login',
      method: 'POST'
    });
    event.request = new Request('http://localhost:3002/login', {
      method: 'POST',
      body: formData
    });

    await expect((loginActions.login as any)(event)).rejects.toMatchObject({
      status: 303,
      location: '/admin/oauth-clients'
    });
  });

  it('rate limits after multiple consecutive failed attempts', async () => {
    const { event } = createMockEvent({
      url: 'http://localhost:3002/login',
      method: 'POST'
    });

    // 5 allowed attempts
    for (let i = 0; i < 5; i++) {
      const formData = new FormData();
      formData.set('username', 'admin');
      formData.set('password', 'wrong-pass');
      event.request = new Request('http://localhost:3002/login', {
        method: 'POST',
        body: formData
      });
      const res = await (loginActions.login as any)(event);
      expect(res.status).toBe(400);
    }

    // 6th attempt should be blocked with 429
    const formData = new FormData();
    formData.set('username', 'admin');
    formData.set('password', 'wrong-pass');
    event.request = new Request('http://localhost:3002/login', {
      method: 'POST',
      body: formData
    });
    const limited = await (loginActions.login as any)(event);
    expect(limited.status).toBe(429);
    expect(limited.data.error).toContain('Too many login attempts');
  });

  it('logout rejects authenticated session with missing or invalid CSRF', async () => {
    const sessionToken = 'session-to-logout';
    const { event } = createMockEvent({
      url: 'http://localhost:3002/login?/logout',
      method: 'POST',
      cookies: { [ADMIN_SESSION_COOKIE]: sessionToken },
      locals: {
        admin: { username: 'admin', sessionExpiresAt: new Date(Date.now() + 3600000).toISOString() },
        sessionToken,
        csrfToken: 'csrf'
      }
    });
    event.request = new Request('http://localhost:3002/login?/logout', {
      method: 'POST',
      body: new FormData()
    });

    const result = await (loginActions.logout as any)(event);
    expect(result.status).toBe(403);
    expect(result.data.error).toBe('Invalid or missing CSRF token');
  });

  it('logout revokes session, clears cookie, and redirects to /login when CSRF is valid', async () => {
    const sessionToken = 'session-to-logout';
    const csrfToken = csrfTokenForSession(sessionToken, runtime.sessionSecret);
    const formData = new FormData();
    formData.set('csrfToken', csrfToken);

    const { event, cookieStore } = createMockEvent({
      url: 'http://localhost:3002/login?/logout',
      method: 'POST',
      cookies: { [ADMIN_SESSION_COOKIE]: sessionToken },
      locals: {
        admin: { username: 'admin', sessionExpiresAt: new Date(Date.now() + 3600000).toISOString() },
        sessionToken,
        csrfToken
      }
    });
    event.request = new Request('http://localhost:3002/login?/logout', {
      method: 'POST',
      body: formData
    });

    await expect((loginActions.logout as any)(event)).rejects.toMatchObject({
      status: 303,
      location: '/login'
    });

    expect(cookieStore.has(ADMIN_SESSION_COOKIE)).toBe(false);
  });
});

describe('Admin Layout Loader', () => {
  it('exposes only admin metadata and CSRF token', async () => {
    const data = await adminLayoutLoad({
      locals: {
        admin: { username: 'admin', sessionExpiresAt: '2026-10-01T00:00:00Z' },
        sessionToken: 'opaque-secret-token',
        csrfToken: 'csrf-token-abc'
      }
    } as any);

    expect(data).toEqual({
      admin: {
        username: 'admin',
        sessionExpiresAt: '2026-10-01T00:00:00Z'
      },
      csrfToken: 'csrf-token-abc'
    });
    expect((data as any).sessionToken).toBeUndefined();
  });
});

describe('API Keys Server Loader & Actions', () => {
  it('rejects unauthenticated direct action calls with 401', async () => {
    const { event } = createMockEvent({
      url: 'http://localhost:3002/admin/api-keys?/createKey',
      method: 'POST'
    });
    const result = await (apiKeyActions.createKey as any)(event);
    expect(result.status).toBe(401);
    expect(result.data.error).toBe('Unauthorized');

    const revokeResult = await (apiKeyActions.revokeKey as any)(event);
    expect(revokeResult.status).toBe(401);
    expect(revokeResult.data.error).toBe('Unauthorized');
  });

  it('rejects direct action calls with missing or invalid CSRF token with 403', async () => {
    const sessionToken = 'admin-session-token';
    const formData = new FormData();
    formData.set('name', 'Test Key');
    formData.set('csrfToken', 'invalid-token');

    const { event } = createMockEvent({
      url: 'http://localhost:3002/admin/api-keys?/createKey',
      method: 'POST',
      locals: {
        admin: { username: 'admin', sessionExpiresAt: new Date(Date.now() + 3600000).toISOString() },
        sessionToken,
        csrfToken: csrfTokenForSession(sessionToken, runtime.sessionSecret)
      }
    });
    event.request = new Request('http://localhost:3002/admin/api-keys?/createKey', {
      method: 'POST',
      body: formData
    });

    const result = await (apiKeyActions.createKey as any)(event);
    expect(result.status).toBe(403);
    expect(result.data.error).toBe('Invalid or missing CSRF token');
  });

  it('creates an API key with wtk_ prefix and returns secret once', async () => {
    const sessionToken = 'admin-session-token';
    const csrfToken = csrfTokenForSession(sessionToken, runtime.sessionSecret);
    const formData = new FormData();
    formData.set('csrfToken', csrfToken);
    formData.set('name', 'Telemetry Ingest Agent');
    formData.append('scopes', 'activity:read');
    formData.append('scopes', 'operations:read');

    const { event } = createMockEvent({
      url: 'http://localhost:3002/admin/api-keys?/createKey',
      method: 'POST',
      locals: {
        admin: { username: 'admin', sessionExpiresAt: new Date(Date.now() + 3600000).toISOString() },
        sessionToken,
        csrfToken
      }
    });
    event.request = new Request('http://localhost:3002/admin/api-keys?/createKey', {
      method: 'POST',
      body: formData
    });

    const result = await (apiKeyActions.createKey as any)(event);
    expect(result.secret).toBeDefined();
    expect(result.secret.startsWith('wtk_')).toBe(true);
    expect(result.key.name).toBe('Telemetry Ingest Agent');
    expect(result.key.scopes).toEqual(['activity:read', 'operations:read']);

    // Loader reflects the created key
    const loaded = await (apiKeyLoad as any)();
    const found = loaded.keys.find((k: any) => k.id === result.key.id);
    expect(found).toBeDefined();
    expect(found.prefix.startsWith('wtk_')).toBe(true);
  });

  it('revokes an existing API key', async () => {
    const created = await runtime.apiKeys.create({
      name: 'To Revoke',
      scopes: ['activity:read']
    });

    const sessionToken = 'admin-session-token';
    const csrfToken = csrfTokenForSession(sessionToken, runtime.sessionSecret);
    const formData = new FormData();
    formData.set('csrfToken', csrfToken);
    formData.set('keyId', created.metadata.id);

    const { event } = createMockEvent({
      url: 'http://localhost:3002/admin/api-keys?/revokeKey',
      method: 'POST',
      locals: {
        admin: { username: 'admin', sessionExpiresAt: new Date(Date.now() + 3600000).toISOString() },
        sessionToken,
        csrfToken
      }
    });
    event.request = new Request('http://localhost:3002/admin/api-keys?/revokeKey', {
      method: 'POST',
      body: formData
    });

    const res = await (apiKeyActions.revokeKey as any)(event);
    expect(res.revokedKeyId).toBe(created.metadata.id);

    const loaded = await (apiKeyLoad as any)();
    const found = loaded.keys.find((k: any) => k.id === created.metadata.id);
    expect(found).toBeDefined();
    expect(found.status).toBe('revoked');
  });
});

describe('OAuth Clients Server Loader & Actions', () => {
  it('rejects unauthenticated direct action calls with 401', async () => {
    const { event } = createMockEvent({
      url: 'http://localhost:3002/admin/oauth-clients?/registerClient',
      method: 'POST'
    });
    const result = await (oauthActions.registerClient as any)(event);
    expect(result.status).toBe(401);
    expect(result.data.error).toBe('Unauthorized');

    const revokeResult = await (oauthActions.revokeClient as any)(event);
    expect(revokeResult.status).toBe(401);
    expect(revokeResult.data.error).toBe('Unauthorized');
  });

  it('rejects direct action calls with missing or invalid CSRF token with 403', async () => {
    const sessionToken = 'admin-session-token';
    const formData = new FormData();
    formData.set('name', 'Test Client');
    formData.set('clientType', 'public');
    formData.set('csrfToken', 'invalid-token');

    const { event } = createMockEvent({
      url: 'http://localhost:3002/admin/oauth-clients?/registerClient',
      method: 'POST',
      locals: {
        admin: { username: 'admin', sessionExpiresAt: new Date(Date.now() + 3600000).toISOString() },
        sessionToken,
        csrfToken: csrfTokenForSession(sessionToken, runtime.sessionSecret)
      }
    });
    event.request = new Request('http://localhost:3002/admin/oauth-clients?/registerClient', {
      method: 'POST',
      body: formData
    });

    const result = await (oauthActions.registerClient as any)(event);
    expect(result.status).toBe(403);
    expect(result.data.error).toBe('Invalid or missing CSRF token');
  });

  it('rejects invalid clientType with 400', async () => {
    const sessionToken = 'admin-session-token';
    const csrfToken = csrfTokenForSession(sessionToken, runtime.sessionSecret);
    const formData = new FormData();
    formData.set('csrfToken', csrfToken);
    formData.set('name', 'Invalid Client');
    formData.set('clientType', 'spa');
    formData.set('redirectUris', 'http://127.0.0.1:8085/callback');

    const { event } = createMockEvent({
      url: 'http://localhost:3002/admin/oauth-clients?/registerClient',
      method: 'POST',
      locals: {
        admin: { username: 'admin', sessionExpiresAt: new Date(Date.now() + 3600000).toISOString() },
        sessionToken,
        csrfToken
      }
    });
    event.request = new Request('http://localhost:3002/admin/oauth-clients?/registerClient', {
      method: 'POST',
      body: formData
    });

    const result = await (oauthActions.registerClient as any)(event);
    expect(result.status).toBe(400);
    expect(result.data.error).toBe("Client type must be either 'public' or 'confidential'");
  });

  it('registers a public OAuth client without secret', async () => {
    const sessionToken = 'admin-session-token';
    const csrfToken = csrfTokenForSession(sessionToken, runtime.sessionSecret);
    const formData = new FormData();
    formData.set('csrfToken', csrfToken);
    formData.set('name', 'Desktop Widget');
    formData.set('clientType', 'public');
    formData.set('redirectUris', 'http://127.0.0.1:8085/callback');
    formData.append('scopes', 'activity:read');

    const { event } = createMockEvent({
      url: 'http://localhost:3002/admin/oauth-clients?/registerClient',
      method: 'POST',
      locals: {
        admin: { username: 'admin', sessionExpiresAt: new Date(Date.now() + 3600000).toISOString() },
        sessionToken,
        csrfToken
      }
    });
    event.request = new Request('http://localhost:3002/admin/oauth-clients?/registerClient', {
      method: 'POST',
      body: formData
    });

    const result = await (oauthActions.registerClient as any)(event);
    expect(result.clientId).toBeDefined();
    expect(result.clientSecret).toBeUndefined();
    expect(result.client.clientType).toBe('public');

    const loaded = await (oauthLoad as any)();
    const found = loaded.clients.find((c: any) => c.id === result.clientId);
    expect(found).toBeDefined();
    expect(found.clientType).toBe('public');
  });

  it('registers a confidential OAuth client with one-time secret', async () => {
    const sessionToken = 'admin-session-token';
    const csrfToken = csrfTokenForSession(sessionToken, runtime.sessionSecret);
    const formData = new FormData();
    formData.set('csrfToken', csrfToken);
    formData.set('name', 'Backend Sync Server');
    formData.set('clientType', 'confidential');
    formData.set('redirectUris', 'https://sync.example.corp/callback');
    formData.append('scopes', 'activity:read');
    formData.append('scopes', 'operations:read');

    const { event } = createMockEvent({
      url: 'http://localhost:3002/admin/oauth-clients?/registerClient',
      method: 'POST',
      locals: {
        admin: { username: 'admin', sessionExpiresAt: new Date(Date.now() + 3600000).toISOString() },
        sessionToken,
        csrfToken
      }
    });
    event.request = new Request('http://localhost:3002/admin/oauth-clients?/registerClient', {
      method: 'POST',
      body: formData
    });

    const result = await (oauthActions.registerClient as any)(event);
    expect(result.clientId).toBeDefined();
    expect(result.clientSecret).toBeDefined();
    expect(result.clientSecret.startsWith('wcs_')).toBe(true);
    expect(result.client.clientType).toBe('confidential');
  });

  it('revokes an existing OAuth client', async () => {
    const registered = await runtime.oauthClients.register({
      name: 'To Revoke Client',
      publicClient: true,
      redirectUris: ['http://127.0.0.1:8085/callback'],
      scopes: ['activity:read']
    });

    const sessionToken = 'admin-session-token';
    const csrfToken = csrfTokenForSession(sessionToken, runtime.sessionSecret);
    const formData = new FormData();
    formData.set('csrfToken', csrfToken);
    formData.set('clientId', registered.metadata.clientId);

    const { event } = createMockEvent({
      url: 'http://localhost:3002/admin/oauth-clients?/revokeClient',
      method: 'POST',
      locals: {
        admin: { username: 'admin', sessionExpiresAt: new Date(Date.now() + 3600000).toISOString() },
        sessionToken,
        csrfToken
      }
    });
    event.request = new Request('http://localhost:3002/admin/oauth-clients?/revokeClient', {
      method: 'POST',
      body: formData
    });

    const res = await (oauthActions.revokeClient as any)(event);
    expect(res.revokedClientId).toBe(registered.metadata.clientId);

    const loaded = await (oauthLoad as any)();
    const found = loaded.clients.find((c: any) => c.id === registered.metadata.clientId);
    expect(found).toBeDefined();
    expect(found.status).toBe('revoked');
  });
});

describe('Test Environment Database Isolation', () => {
  it('ensures runtime uses in-memory database and test environment is isolated', () => {
    expect(runtime.config.databasePath).toBe(':memory:');
    expect(runtime.db.name).toBe(':memory:');
    expect(process.env.DATABASE_PATH).toBe(':memory:');
  });
});
