import { beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../src/hooks.server';
import { runtime } from '../src/lib/server/runtime';
import { csrfTokenForSession } from '../src/lib/server/security/http';
import { createS256Challenge } from '../src/lib/server/oauth/pkce';
import { load as authorizeLoad, actions as authorizeActions } from '../src/routes/oauth/authorize/+page.server';
import { POST as tokenPost } from '../src/routes/oauth/token/+server';
import { POST as revokePost } from '../src/routes/oauth/revoke/+server';
import { POST as registerPost } from '../src/routes/oauth/register/+server';
import { _safeRedirect as safeRedirect } from '../src/routes/login/+page.server';
import type { OAuthClientRecord } from '../src/lib/server/oauth/clients';

function createMockEvent(options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  body?: BodyInit;
  locals?: Partial<App.Locals>;
  clientIp?: string;
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
    delete: (name: string) => {
      cookieStore.delete(name);
    },
    serialize: () => ''
  };

  const event: Parameters<typeof handle>[0]['event'] = {
    request,
    url,
    locals,
    cookies: cookiesObj as any,
    getClientAddress: () => options.clientIp ?? '127.0.0.1',
    params: {},
    route: { id: url.pathname },
    isDataRequest: false,
    setHeaders: () => {},
    fetch: globalThis.fetch
  } as any;

  return { event, cookieStore };
}

describe('OAuth Protocol Routes', () => {
  let publicClient: { metadata: any; clientSecret: string | null };
  let confidentialClient: { metadata: any; clientSecret: string | null };
  const validVerifier = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
  const validChallenge = createS256Challenge(validVerifier);
  const mcpResource = 'http://localhost:3002/mcp';
  const redirectUri = 'http://127.0.0.1:8085/callback';

  beforeEach(async () => {
    runtime.registrationLimiter.reset();

    publicClient = await runtime.oauthClients.register({
      name: 'Public CLI Client',
      publicClient: true,
      redirectUris: [redirectUri],
      scopes: ['activity:read', 'operations:read']
    });

    confidentialClient = await runtime.oauthClients.register({
      name: 'Confidential Daemon',
      publicClient: false,
      redirectUris: ['https://daemon.example.corp/callback'],
      scopes: ['activity:read', 'activity:detail']
    });
  });

  describe('/oauth/authorize GET', () => {
    it('redirects unauthenticated user to /login with strictly validated redirectTo', async () => {
      const authUrl = `http://localhost:3002/oauth/authorize?client_id=${publicClient.metadata.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&resource=${encodeURIComponent(mcpResource)}&scope=activity:read&code_challenge=${validChallenge}&code_challenge_method=S256&state=xyz123`;
      const { event } = createMockEvent({ url: authUrl });

      await expect(authorizeLoad(event as any)).rejects.toMatchObject({
        status: 303,
        location: `/login?redirectTo=${encodeURIComponent('/oauth/authorize' + new URL(authUrl).search)}`
      });
    });

    it('renders consent screen data for authenticated admin', async () => {
      const authUrl = `http://localhost:3002/oauth/authorize?client_id=${publicClient.metadata.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&resource=${encodeURIComponent(mcpResource)}&scope=activity:read&code_challenge=${validChallenge}&code_challenge_method=S256&state=xyz123`;
      const { event } = createMockEvent({
        url: authUrl,
        locals: {
          admin: { username: 'admin', sessionExpiresAt: '2026-12-01' },
          sessionToken: 'sess-123',
          csrfToken: 'csrf-123'
        }
      });

      const data = (await authorizeLoad(event as any)) as any;
      expect(data.client.clientId).toBe(publicClient.metadata.clientId);
      expect(data.client.name).toBe('Public CLI Client');
      expect(data.scopes).toEqual(['activity:read']);
      expect(data.resource).toBe(mcpResource);
      expect(data.state).toBe('xyz123');
      expect(data.csrfToken).toBe('csrf-123');
    });

    it('never redirects on invalid client_id (prevents open redirect)', async () => {
      const authUrl = `http://localhost:3002/oauth/authorize?client_id=nonexistent&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&resource=${encodeURIComponent(mcpResource)}&scope=activity:read&code_challenge=${validChallenge}&code_challenge_method=S256`;
      const { event } = createMockEvent({ url: authUrl });

      await expect(authorizeLoad(event as any)).rejects.toMatchObject({
        status: 400
      });
    });

    it('never redirects on invalid or unregistered redirect_uri', async () => {
      const authUrl = `http://localhost:3002/oauth/authorize?client_id=${publicClient.metadata.clientId}&redirect_uri=https://evil.attacker.com/callback&response_type=code&resource=${encodeURIComponent(mcpResource)}&scope=activity:read&code_challenge=${validChallenge}&code_challenge_method=S256`;
      const { event } = createMockEvent({ url: authUrl });

      await expect(authorizeLoad(event as any)).rejects.toMatchObject({
        status: 400
      });
    });

    it('never redirects on resource mismatch', async () => {
      const authUrl = `http://localhost:3002/oauth/authorize?client_id=${publicClient.metadata.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&resource=https://attacker.com/mcp&scope=activity:read&code_challenge=${validChallenge}&code_challenge_method=S256`;
      const { event } = createMockEvent({ url: authUrl });

      await expect(authorizeLoad(event as any)).rejects.toMatchObject({
        status: 400
      });
    });

    it('never redirects on missing or invalid PKCE challenge', async () => {
      const authUrl = `http://localhost:3002/oauth/authorize?client_id=${publicClient.metadata.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&resource=${encodeURIComponent(mcpResource)}&scope=activity:read&code_challenge_method=plain`;
      const { event } = createMockEvent({ url: authUrl });

      await expect(authorizeLoad(event as any)).rejects.toMatchObject({
        status: 400
      });
    });

    it('never redirects on unregistered scope', async () => {
      const authUrl = `http://localhost:3002/oauth/authorize?client_id=${publicClient.metadata.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&resource=${encodeURIComponent(mcpResource)}&scope=activity:detail&code_challenge=${validChallenge}&code_challenge_method=S256`;
      const { event } = createMockEvent({ url: authUrl });

      await expect(authorizeLoad(event as any)).rejects.toMatchObject({
        status: 400
      });
    });
  });

  describe('/oauth/authorize POST Actions (Approve & Deny)', () => {
    const sessionToken = 'admin-session';
    const adminLocals = {
      admin: { username: 'admin', sessionExpiresAt: '2026-12-01' },
      sessionToken
    };

    /** Builds the query string that defines one authorization request. */
    function authorizeQuery(overrides: Record<string, string | null> = {}): string {
      const params: Record<string, string | null> = {
        client_id: publicClient.metadata.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        resource: mcpResource,
        scope: 'activity:read',
        code_challenge: validChallenge,
        code_challenge_method: 'S256',
        ...overrides
      };
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== null) search.set(key, value);
      }
      return search.toString();
    }

    /** Posts a consent decision to the action URL that carries the authorization request. */
    function consentEvent(options: {
      action: 'approve' | 'deny';
      query: string;
      body?: FormData;
      csrf?: string | null;
      locals?: Record<string, unknown>;
    }) {
      const formData = options.body ?? new FormData();
      const csrf =
        options.csrf === undefined
          ? csrfTokenForSession(sessionToken, runtime.sessionSecret)
          : options.csrf;
      if (csrf !== null) formData.set('csrfToken', csrf);

      return createMockEvent({
        url: `http://localhost:3002/oauth/authorize?${options.query}&/${options.action}`,
        method: 'POST',
        headers: { origin: 'http://localhost:3002' },
        locals: (options.locals ?? adminLocals) as Partial<App.Locals>,
        body: formData
      }).event;
    }

    /** Runs a consent action, returning the redirect location or the returned failure. */
    async function runConsent(action: 'approve' | 'deny', event: unknown) {
      try {
        const result = await (authorizeActions[action] as any)(event);
        return { location: null as string | null, failure: result };
      } catch (err: any) {
        expect(err.status).toBe(303);
        return { location: err.location as string, failure: null };
      }
    }

    it('rejects unauthenticated consent submission with 401', async () => {
      const event = consentEvent({
        action: 'approve',
        query: authorizeQuery(),
        locals: {}
      });

      const res = await (authorizeActions.approve as any)(event);
      expect(res.status).toBe(401);
    });

    it('rejects consent submission with missing or invalid CSRF with 403', async () => {
      const event = consentEvent({
        action: 'approve',
        query: authorizeQuery(),
        csrf: 'invalid-token'
      });

      const res = await (authorizeActions.approve as any)(event);
      expect(res.status).toBe(403);
    });

    it('approves request, generates one-time code, and redirects to exact redirect_uri preserving state', async () => {
      const event = consentEvent({
        action: 'approve',
        query: authorizeQuery({ state: 'client-state-abc' })
      });

      const { location } = await runConsent('approve', event);
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe(redirectUri);
      expect(redirectUrl.searchParams.get('code')).toMatch(/^wac_/);
      expect(redirectUrl.searchParams.get('state')).toBe('client-state-abc');
    });

    it('denies request and redirects to exact redirect_uri with access_denied preserving state', async () => {
      const event = consentEvent({
        action: 'deny',
        query: authorizeQuery({ state: 'client-state-xyz' })
      });

      const { location } = await runConsent('deny', event);
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe(redirectUri);
      expect(redirectUrl.searchParams.get('error')).toBe('access_denied');
      expect(redirectUrl.searchParams.get('state')).toBe('client-state-xyz');
    });

    it('denial with invalid redirect_uri returns 400 and never redirects', async () => {
      const event = consentEvent({
        action: 'deny',
        query: authorizeQuery({ redirect_uri: 'https://evil.attacker.com' })
      });

      const { location, failure } = await runConsent('deny', event);
      expect(location).toBeNull();
      expect(failure.status).toBe(400);
    });

    it('binds approval to the action URL and ignores every authorization parameter in the POST body', async () => {
      const tampered = new FormData();
      tampered.set('client_id', confidentialClient.metadata.clientId);
      tampered.set('redirect_uri', 'https://evil.attacker.com/callback');
      tampered.set('response_type', 'token');
      tampered.set('resource', 'https://evil.attacker.com/mcp');
      tampered.set('scope', 'activity:read activity:detail operations:read');
      tampered.set('code_challenge', 'A'.repeat(43));
      tampered.set('code_challenge_method', 'plain');
      tampered.set('state', 'attacker-state');

      const event = consentEvent({
        action: 'approve',
        query: authorizeQuery({ state: 'genuine-state' }),
        body: tampered
      });

      const { location } = await runConsent('approve', event);
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe(redirectUri);
      expect(redirectUrl.origin).not.toBe('https://evil.attacker.com');
      expect(redirectUrl.searchParams.get('state')).toBe('genuine-state');

      // The issued code carries the URL's client, resource, and scope — not the body's.
      const code = redirectUrl.searchParams.get('code')!;
      const tokens = await runtime.oauthAuth.exchangeAuthorizationCode({
        code,
        clientId: publicClient.metadata.clientId,
        redirectUri,
        resource: mcpResource,
        codeVerifier: validVerifier
      });
      expect(tokens).not.toBeNull();
      expect(tokens!.scope).toBe('activity:read');
    });

    it('binds denial to the action URL and ignores redirect_uri and state in the POST body', async () => {
      const tampered = new FormData();
      tampered.set('redirect_uri', 'https://evil.attacker.com/callback');
      tampered.set('state', 'attacker-state');

      const event = consentEvent({
        action: 'deny',
        query: authorizeQuery({ state: 'genuine-state' }),
        body: tampered
      });

      const { location } = await runConsent('deny', event);
      expect(location).toBeTruthy();
      const redirectUrl = new URL(location!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe(redirectUri);
      expect(redirectUrl.searchParams.get('state')).toBe('genuine-state');
    });

    it('refuses a consent submission whose action URL carries no authorization request', async () => {
      for (const action of ['approve', 'deny'] as const) {
        const body = new FormData();
        body.set('client_id', publicClient.metadata.clientId);
        body.set('redirect_uri', redirectUri);
        body.set('response_type', 'code');
        body.set('resource', mcpResource);
        body.set('scope', 'activity:read');
        body.set('code_challenge', validChallenge);
        body.set('code_challenge_method', 'S256');

        const event = consentEvent({ action, query: '', body });
        const { location, failure } = await runConsent(action, event);
        expect(location).toBeNull();
        expect(failure.status).toBe(400);
      }
    });

    it('treats state as opaque: preserved byte-for-byte, untrimmed, and never re-encoded', async () => {
      const state = '  pad ded/+%20 ünïcode&=?  ';
      const event = consentEvent({
        action: 'approve',
        query: authorizeQuery({ state })
      });

      const { location } = await runConsent('approve', event);
      expect(new URL(location!).searchParams.get('state')).toBe(state);
    });

    it('preserves a present-but-empty state on approval and denial', async () => {
      const approveEvent = consentEvent({
        action: 'approve',
        query: `${authorizeQuery()}&state=`
      });
      const approved = await runConsent('approve', approveEvent);
      expect(new URL(approved.location!).searchParams.get('state')).toBe('');

      const denyEvent = consentEvent({
        action: 'deny',
        query: `${authorizeQuery()}&state=`
      });
      const denied = await runConsent('deny', denyEvent);
      expect(new URL(denied.location!).searchParams.get('state')).toBe('');
    });

    it('omits state entirely when the request carried none', async () => {
      const event = consentEvent({ action: 'approve', query: authorizeQuery() });
      const { location } = await runConsent('approve', event);
      expect(new URL(location!).searchParams.has('state')).toBe(false);
    });

    it('rejects a state that exceeds the byte bound, counting bytes not characters', async () => {
      // 1024 multi-byte characters are well under the character count but over 1024 bytes.
      const event = consentEvent({
        action: 'approve',
        query: authorizeQuery({ state: 'é'.repeat(1024) })
      });

      const { location, failure } = await runConsent('approve', event);
      expect(location).toBeNull();
      expect(failure.status).toBe(400);

      const atBound = consentEvent({
        action: 'approve',
        query: authorizeQuery({ state: 'a'.repeat(1024) })
      });
      const accepted = await runConsent('approve', atBound);
      expect(accepted.location).toBeTruthy();
    });
  });

  describe('/oauth/token Endpoint', () => {
    it('rejects non-form-urlencoded Content-Type with 400', async () => {
      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code' })
      });

      const response = await tokenPost(event);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe('invalid_request');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('pragma')).toBe('no-cache');
    });

    it('exchanges authorization code for tokens for public client with PKCE S256', async () => {
      const issued = await runtime.oauthAuth.issueAuthorizationCode({
        clientId: publicClient.metadata.clientId,
        redirectUri,
        resource: mcpResource,
        scopes: ['activity:read'],
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256'
      });

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: publicClient.metadata.clientId,
        code: issued.code,
        redirect_uri: redirectUri,
        code_verifier: validVerifier,
        resource: mcpResource
      });

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });

      const response = await tokenPost(event);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('pragma')).toBe('no-cache');

      const data = await response.json();
      expect(data.access_token).toMatch(/^wat_/);
      expect(data.refresh_token).toMatch(/^wrt_/);
      expect(data.token_type).toBe('Bearer');
      expect(data.expires_in).toBe(3600);
      expect(data.scope).toBe('activity:read');
    });

    it('enforces one-use code: code cannot be exchanged twice', async () => {
      const issued = await runtime.oauthAuth.issueAuthorizationCode({
        clientId: publicClient.metadata.clientId,
        redirectUri,
        resource: mcpResource,
        scopes: ['activity:read'],
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256'
      });

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: publicClient.metadata.clientId,
        code: issued.code,
        redirect_uri: redirectUri,
        code_verifier: validVerifier,
        resource: mcpResource
      });

      const { event: event1 } = createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });

      const res1 = await tokenPost(event1);
      expect(res1.status).toBe(200);

      // Second attempt with same code
      const { event: event2 } = createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });

      const res2 = await tokenPost(event2);
      expect(res2.status).toBe(400);
      const json2 = await res2.json();
      expect(json2.error).toBe('invalid_grant');
    });

    it('exchanges code for confidential client using HTTP Basic authentication', async () => {
      const issued = await runtime.oauthAuth.issueAuthorizationCode({
        clientId: confidentialClient.metadata.clientId,
        redirectUri: 'https://daemon.example.corp/callback',
        resource: mcpResource,
        scopes: ['activity:read'],
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256'
      });

      const credentials = Buffer.from(
        `${confidentialClient.metadata.clientId}:${confidentialClient.clientSecret}`
      ).toString('base64');

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: issued.code,
        redirect_uri: 'https://daemon.example.corp/callback',
        code_verifier: validVerifier,
        resource: mcpResource
      });

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${credentials}`
        },
        body: body.toString()
      });

      const response = await tokenPost(event);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.access_token).toMatch(/^wat_/);
      expect(data.refresh_token).toMatch(/^wrt_/);
    });

    it('exchanges code for confidential client using client_secret_post', async () => {
      const issued = await runtime.oauthAuth.issueAuthorizationCode({
        clientId: confidentialClient.metadata.clientId,
        redirectUri: 'https://daemon.example.corp/callback',
        resource: mcpResource,
        scopes: ['activity:read'],
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256'
      });

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: confidentialClient.metadata.clientId,
        client_secret: confidentialClient.clientSecret!,
        code: issued.code,
        redirect_uri: 'https://daemon.example.corp/callback',
        code_verifier: validVerifier,
        resource: mcpResource
      });

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });

      const response = await tokenPost(event);
      expect(response.status).toBe(200);
    });

    it('rejects confidential client with invalid client secret with 401', async () => {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: confidentialClient.metadata.clientId,
        client_secret: 'wrong-secret',
        code: 'any_code',
        redirect_uri: 'https://daemon.example.corp/callback',
        code_verifier: validVerifier
      });

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });

      const response = await tokenPost(event);
      expect(response.status).toBe(401);
      const json = await response.json();
      expect(json.error).toBe('invalid_client');
    });

    it('rejects multiple client authentication methods (both Basic and body secret)', async () => {
      const credentials = Buffer.from(
        `${confidentialClient.metadata.clientId}:${confidentialClient.clientSecret}`
      ).toString('base64');

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_secret: confidentialClient.clientSecret!,
        code: 'any_code',
        redirect_uri: 'https://daemon.example.corp/callback',
        code_verifier: validVerifier
      });

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${credentials}`
        },
        body: body.toString()
      });

      const response = await tokenPost(event);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe('invalid_client');
    });

    it('rejects invalid code_verifier without consuming authorization code', async () => {
      const issued = await runtime.oauthAuth.issueAuthorizationCode({
        clientId: publicClient.metadata.clientId,
        redirectUri,
        resource: mcpResource,
        scopes: ['activity:read'],
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256'
      });

      const badBody = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: publicClient.metadata.clientId,
        code: issued.code,
        redirect_uri: redirectUri,
        code_verifier: `${validVerifier.slice(0, -1)}X`,
        resource: mcpResource
      });

      const { event: badEvent } = createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: badBody.toString()
      });

      const badRes = await tokenPost(badEvent);
      expect(badRes.status).toBe(400);
      const badJson = await badRes.json();
      expect(badJson.error).toBe('invalid_grant');

      // Now attempt with correct verifier - should succeed because code was not consumed
      const goodBody = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: publicClient.metadata.clientId,
        code: issued.code,
        redirect_uri: redirectUri,
        code_verifier: validVerifier,
        resource: mcpResource
      });

      const { event: goodEvent } = createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: goodBody.toString()
      });

      const goodRes = await tokenPost(goodEvent);
      expect(goodRes.status).toBe(200);
    });

    it('enforces resource binding: mismatch fails exchange', async () => {
      const issued = await runtime.oauthAuth.issueAuthorizationCode({
        clientId: publicClient.metadata.clientId,
        redirectUri,
        resource: mcpResource,
        scopes: ['activity:read'],
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256'
      });

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: publicClient.metadata.clientId,
        code: issued.code,
        redirect_uri: redirectUri,
        code_verifier: validVerifier,
        resource: 'http://other.corp/mcp'
      });

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });

      const response = await tokenPost(event);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe('invalid_grant');
    });

    it('rotates refresh tokens on refresh grant and revokes family on refresh token reuse', async () => {
      const issued = await runtime.oauthAuth.issueAuthorizationCode({
        clientId: publicClient.metadata.clientId,
        redirectUri,
        resource: mcpResource,
        scopes: ['activity:read'],
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256'
      });

      const initTokens = await runtime.oauthAuth.exchangeAuthorizationCode({
        code: issued.code,
        clientId: publicClient.metadata.clientId,
        redirectUri,
        resource: mcpResource,
        codeVerifier: validVerifier
      });
      expect(initTokens).not.toBeNull();

      // First refresh succeeds and gives rotated refresh token
      const refreshBody1 = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: publicClient.metadata.clientId,
        refresh_token: initTokens!.refreshToken,
        resource: mcpResource
      });

      const { event: refEvent1 } = createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: refreshBody1.toString()
      });

      const refRes1 = await tokenPost(refEvent1);
      expect(refRes1.status).toBe(200);
      const refData1 = await refRes1.json();
      expect(refData1.refresh_token).not.toBe(initTokens!.refreshToken);

      // Refresh token reuse: attempt refresh with already-used initial refresh token
      const { event: refReuseEvent } = createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: refreshBody1.toString()
      });

      const reuseRes = await tokenPost(refReuseEvent);
      expect(reuseRes.status).toBe(400);
      const reuseJson = await reuseRes.json();
      expect(reuseJson.error).toBe('invalid_grant');

      // Due to reuse detection, the entire family was revoked: second token is now dead
      const verifySecond = await runtime.oauthAuth.verifyAccessToken(
        refData1.access_token,
        ['activity:read'],
        new Date(),
        mcpResource
      );
      expect(verifySecond).toBeNull();
    });

    it('rejects unsupported grant_type with 400', async () => {
      const body = new URLSearchParams({
        grant_type: 'password',
        client_id: publicClient.metadata.clientId
      });

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });

      const response = await tokenPost(event);
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe('unsupported_grant_type');
    });
  });

  describe('/oauth/revoke Endpoint', () => {
    it('revokes matching token family using access token', async () => {
      const issued = await runtime.oauthAuth.issueAuthorizationCode({
        clientId: publicClient.metadata.clientId,
        redirectUri,
        resource: mcpResource,
        scopes: ['activity:read'],
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256'
      });

      const tokens = await runtime.oauthAuth.exchangeAuthorizationCode({
        code: issued.code,
        clientId: publicClient.metadata.clientId,
        redirectUri,
        resource: mcpResource,
        codeVerifier: validVerifier
      });
      expect(tokens).not.toBeNull();

      const body = new URLSearchParams({
        token: tokens!.accessToken,
        client_id: publicClient.metadata.clientId
      });

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/revoke',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });

      const response = await revokePost(event);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');

      // Token and family are revoked
      const verified = await runtime.oauthAuth.verifyAccessToken(
        tokens!.accessToken,
        ['activity:read'],
        new Date(),
        mcpResource
      );
      expect(verified).toBeNull();
    });

    it('revokes matching token family using refresh token', async () => {
      const issued = await runtime.oauthAuth.issueAuthorizationCode({
        clientId: publicClient.metadata.clientId,
        redirectUri,
        resource: mcpResource,
        scopes: ['activity:read'],
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256'
      });

      const tokens = await runtime.oauthAuth.exchangeAuthorizationCode({
        code: issued.code,
        clientId: publicClient.metadata.clientId,
        redirectUri,
        resource: mcpResource,
        codeVerifier: validVerifier
      });

      const body = new URLSearchParams({
        token: tokens!.refreshToken,
        client_id: publicClient.metadata.clientId
      });

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/revoke',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });

      const response = await revokePost(event);
      expect(response.status).toBe(200);

      const refreshed = await runtime.oauthAuth.refresh({
        refreshToken: tokens!.refreshToken,
        clientId: publicClient.metadata.clientId,
        resource: mcpResource
      });
      expect(refreshed).toBeNull();
    });

    it('returns 200 for an unknown token when client authentication succeeds', async () => {
      const body = new URLSearchParams({
        token: 'wat_unknown_token_value_xyz',
        client_id: publicClient.metadata.clientId
      });

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/revoke',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });

      const response = await revokePost(event);
      expect(response.status).toBe(200);
    });

    it('rejects unauthenticated client with 401 on revocation', async () => {
      const body = new URLSearchParams({
        token: 'wat_some_token',
        client_id: 'nonexistent_client'
      });

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/revoke',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });

      const response = await revokePost(event);
      expect(response.status).toBe(401);
    });
  });

  describe('/oauth/register Dynamic Client Registration', () => {
    it('registers valid public client and returns 201 RFC 7591 metadata without secret', async () => {
      const payload = {
        client_name: 'Dynamic Test MCP Agent',
        redirect_uris: ['http://127.0.0.1:9099/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'activity:read operations:read'
      };

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/register',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const response = await registerPost(event);
      expect(response.status).toBe(201);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('pragma')).toBe('no-cache');

      const data = await response.json();
      expect(data.client_id).toMatch(/^woc_/);
      expect(data.client_name).toBe('Dynamic Test MCP Agent');
      expect(data.redirect_uris).toEqual(['http://127.0.0.1:9099/callback']);
      expect(data.token_endpoint_auth_method).toBe('none');
      expect(data.grant_types).toEqual(['authorization_code', 'refresh_token']);
      expect(data.response_types).toEqual(['code']);
      expect(data.client_secret).toBeUndefined();

      // Client is active in database and public
      const created = await runtime.oauthClients.findActive(data.client_id);
      expect(created).not.toBeNull();
      expect(created?.publicClient).toBe(true);
      expect(created?.secretHash).toBeNull();
    });

    it('rejects confidential registration attempts (token_endpoint_auth_method != none)', async () => {
      const payload = {
        client_name: 'Evil Confidential Request',
        redirect_uris: ['https://daemon.example.com/callback'],
        token_endpoint_auth_method: 'client_secret_post'
      };

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/register',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const response = await registerPost(event);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('invalid_client_metadata');
    });

    it('rejects invalid redirect URIs (non-loopback HTTP, userinfo, fragment)', async () => {
      const payload = {
        client_name: 'Invalid Redirect Agent',
        redirect_uris: ['http://evil.com/callback'] // HTTP non-loopback is forbidden
      };

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/register',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const response = await registerPost(event);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('invalid_redirect_uri');
    });

    it('rejects unsupported grant_types or response_types', async () => {
      const payload = {
        client_name: 'Implicit Flow Request',
        redirect_uris: ['http://127.0.0.1:9099/callback'],
        response_types: ['token']
      };

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/register',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const response = await registerPost(event);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('invalid_client_metadata');
    });

    it('rate limits registration requests per client IP with 429 slow_down', async () => {
      const clientIp = '198.51.100.42';

      for (let i = 0; i < 10; i++) {
        const { event } = createMockEvent({
          url: 'http://localhost:3002/oauth/register',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          clientIp,
          body: JSON.stringify({
            client_name: `Agent ${i}`,
            redirect_uris: [`http://127.0.0.1:${9100 + i}/callback`]
          })
        });
        const res = await registerPost(event);
        expect(res.status).toBe(201);
      }

      // 11th registration attempt from same IP should be blocked
      const { event: blockedEvent } = createMockEvent({
        url: 'http://localhost:3002/oauth/register',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        clientIp,
        body: JSON.stringify({
          client_name: 'Blocked Agent',
          redirect_uris: ['http://127.0.0.1:9199/callback']
        })
      });

      const blockedRes = await registerPost(blockedEvent);
      expect(blockedRes.status).toBe(429);
      const json = await blockedRes.json();
      expect(json.error).toBe('slow_down');
    });
  });

  describe('Global Hook Protocol Exemptions', () => {
    it('exempts /oauth/token from browser Origin & CSRF checks', async () => {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'dummy_code',
        redirect_uri: redirectUri,
        code_verifier: validVerifier
      });

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://external-untrusted-cli.corp'
        },
        body: body.toString()
      });

      const resolve = async () => new Response('token endpoint hit', { status: 200 });
      const res = await handle({ event, resolve });
      // Should not be rejected by hook with 403 Cross-origin request rejected
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('token endpoint hit');
    });

    it('exempts /oauth/revoke from browser Origin & CSRF checks', async () => {
      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/revoke',
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://external-cli.corp'
        },
        body: 'token=wat_test&client_id=wtc_test'
      });

      const resolve = async () => new Response('revoke endpoint hit', { status: 200 });
      const res = await handle({ event, resolve });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('revoke endpoint hit');
    });

    it('exempts /oauth/register from browser Origin & CSRF checks', async () => {
      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/register',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://external-client-creator.corp'
        },
        body: JSON.stringify({ client_name: 'test' })
      });

      const resolve = async () => new Response('register endpoint hit', { status: 200 });
      const res = await handle({ event, resolve });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('register endpoint hit');
    });

    it('does NOT exempt /oauth/authorize POST from Origin checks', async () => {
      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/authorize',
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://evil.attacker.com'
        },
        body: 'client_id=test'
      });

      const resolve = async () => new Response('should not reach here');
      const res = await handle({ event, resolve });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe('Cross-origin request rejected');
    });
  });

  describe('Login Safe Redirect Validation', () => {
    it('allows valid relative /oauth/authorize paths with query parameters', () => {
      const target = '/oauth/authorize?client_id=123&response_type=code&resource=http%3A%2F%2Flocalhost%3A3002%2Fmcp';
      expect(safeRedirect(target)).toBe(target);
    });

    it('allows valid relative /admin paths', () => {
      expect(safeRedirect('/admin')).toBe('/admin');
      expect(safeRedirect('/admin/oauth-clients')).toBe('/admin/oauth-clients');
      expect(safeRedirect('/admin/api-keys?sort=name')).toBe('/admin/api-keys?sort=name');
    });

    it('strictly prevents open redirect attacks', () => {
      // Protocol-relative
      expect(safeRedirect('//evil.com')).toBe('/admin');
      expect(safeRedirect('//evil.com/admin')).toBe('/admin');

      // Backslash evasion
      expect(safeRedirect('/\\evil.com')).toBe('/admin');
      expect(safeRedirect('/admin\\evil')).toBe('/admin');
      expect(safeRedirect('/oauth/authorize\\evil')).toBe('/admin');

      // Alternate origins
      expect(safeRedirect('https://evil.com/oauth/authorize')).toBe('/admin');
      expect(safeRedirect('http://localhost:3002/oauth/authorize')).toBe('/admin');
      expect(safeRedirect('javascript:alert(1)')).toBe('/admin');

      // Credentials in URL
      expect(safeRedirect('http://user:pass@localhost:3002/admin')).toBe('/admin');

      // Path traversal escaping allowed prefixes
      expect(safeRedirect('/admin/../../evil')).toBe('/admin');
      expect(safeRedirect('/oauth/authorize/../../evil')).toBe('/admin');

      // Unrelated relative paths
      expect(safeRedirect('/')).toBe('/admin');
      expect(safeRedirect('/api/health')).toBe('/admin');
      expect(safeRedirect('/mcp')).toBe('/admin');
    });
  });

  describe('Protocol Endpoint Body Parsing', () => {
    const daemonRedirect = 'https://daemon.example.corp/callback';

    function tokenRequest(options: {
      body: string;
      contentType?: string | null;
      contentLength?: string;
    }) {
      const headers: Record<string, string> = {};
      if (options.contentType !== null) {
        headers['content-type'] = options.contentType ?? 'application/x-www-form-urlencoded';
      }
      if (options.contentLength !== undefined) {
        headers['content-length'] = options.contentLength;
      }
      return createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers,
        body: options.body
      }).event;
    }

    /** Every rejection is a generic, uncacheable `invalid_request`. */
    async function expectGenericRejection(response: Response) {
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('pragma')).toBe('no-cache');
      const json = await response.json();
      expect(json.error).toBe('invalid_request');
      return json;
    }

    it('accepts a form-urlencoded content type that carries parameters', async () => {
      const response = await tokenPost(
        tokenRequest({
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: publicClient.metadata.clientId,
            refresh_token: 'wrt_unknown'
          }).toString(),
          contentType: 'application/x-www-form-urlencoded; charset=UTF-8'
        })
      );

      // Parsed and dispatched: rejected on the grant, not on the media type.
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid_grant');
    });

    it('rejects media types other than form-urlencoded, including multipart and none', async () => {
      for (const contentType of [
        'application/json',
        'multipart/form-data; boundary=x',
        'text/plain',
        'application/x-www-form-urlencoded-extra',
        null
      ]) {
        const response = await tokenPost(
          tokenRequest({ body: 'grant_type=refresh_token', contentType })
        );
        await expectGenericRejection(response);
      }
    });

    it('rejects a Content-Length the body does not actually match', async () => {
      const body = 'grant_type=refresh_token&refresh_token=wrt_x';

      for (const declared of [String(body.length - 5), String(body.length + 5)]) {
        const response = await tokenPost(tokenRequest({ body, contentLength: declared }));
        await expectGenericRejection(response);
      }

      // The honest length is accepted and the request reaches grant handling.
      const honest = await tokenPost(
        tokenRequest({ body, contentLength: String(Buffer.byteLength(body, 'utf-8')) })
      );
      expect((await honest.json()).error).not.toBe('invalid_request');
    });

    it('counts Content-Length in bytes, so a multi-byte body is not mistaken for a mismatch', async () => {
      const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent('ünïcode')}`;
      const response = await tokenPost(
        tokenRequest({ body, contentLength: String(Buffer.byteLength(body, 'utf-8')) })
      );
      expect((await response.json()).error).not.toBe('invalid_request');
    });

    it('rejects a malformed Content-Length rather than coercing it', async () => {
      for (const declared of ['abc', '-1', '1.5', '0x10', '1e3', ' ', '12, 12', '+12']) {
        const response = await tokenPost(
          tokenRequest({ body: 'grant_type=refresh_token', contentLength: declared })
        );
        await expectGenericRejection(response);
      }
    });

    it('rejects an oversized body whether or not it declares its length', async () => {
      const oversized = `grant_type=refresh_token&refresh_token=${'a'.repeat(64 * 1024)}`;

      const declared = await tokenPost(
        tokenRequest({
          body: oversized,
          contentLength: String(Buffer.byteLength(oversized, 'utf-8'))
        })
      );
      await expectGenericRejection(declared);

      // Without a declared length the cap has to be enforced while reading.
      const undeclared = await tokenPost(tokenRequest({ body: oversized }));
      await expectGenericRejection(undeclared);
    });

    it('rejects a duplicated security-critical parameter instead of silently taking the first', async () => {
      for (const body of [
        'grant_type=refresh_token&grant_type=authorization_code&refresh_token=wrt_x',
        `client_id=${publicClient.metadata.clientId}&client_id=attacker&grant_type=refresh_token`,
        'grant_type=refresh_token&refresh_token=wrt_a&refresh_token=wrt_b',
        `grant_type=authorization_code&code=abc&redirect_uri=${encodeURIComponent(redirectUri)}&redirect_uri=${encodeURIComponent('https://evil.attacker.com/cb')}`
      ]) {
        const response = await tokenPost(tokenRequest({ body }));
        const json = await expectGenericRejection(response);
        expect(json.error_description).toBe('Duplicate parameter in request');
      }
    });

    it('rejects a duplicate even when both copies carry the same value', async () => {
      const response = await tokenPost(
        tokenRequest({
          body: `grant_type=refresh_token&client_id=${publicClient.metadata.clientId}&client_id=${publicClient.metadata.clientId}`
        })
      );
      await expectGenericRejection(response);
    });

    it('applies the same body rules to /oauth/revoke', async () => {
      const jsonBody = await revokePost(
        createMockEvent({
          url: 'http://localhost:3002/oauth/revoke',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: 'wat_x', client_id: publicClient.metadata.clientId })
        }).event
      );
      await expectGenericRejection(jsonBody);

      const duplicated = await revokePost(
        createMockEvent({
          url: 'http://localhost:3002/oauth/revoke',
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: `client_id=${publicClient.metadata.clientId}&token=wat_a&token=wat_b`
        }).event
      );
      await expectGenericRejection(duplicated);

      const dishonest = await revokePost(
        createMockEvent({
          url: 'http://localhost:3002/oauth/revoke',
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': '2'
          },
          body: `client_id=${publicClient.metadata.clientId}&token=wat_a`
        }).event
      );
      await expectGenericRejection(dishonest);
    });

    it('still completes a well-formed revocation', async () => {
      const issued = await runtime.oauthAuth.issueAuthorizationCode({
        clientId: publicClient.metadata.clientId,
        redirectUri,
        resource: mcpResource,
        scopes: ['activity:read'],
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256'
      });
      const tokens = await runtime.oauthAuth.exchangeAuthorizationCode({
        code: issued.code,
        clientId: publicClient.metadata.clientId,
        redirectUri,
        resource: mcpResource,
        codeVerifier: validVerifier
      });

      const body = new URLSearchParams({
        token: tokens!.accessToken,
        client_id: publicClient.metadata.clientId
      }).toString();

      const response = await revokePost(
        createMockEvent({
          url: 'http://localhost:3002/oauth/revoke',
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': String(Buffer.byteLength(body, 'utf-8'))
          },
          body
        }).event
      );
      expect(response.status).toBe(200);
    });

    it('leaves the valid DCR, authorization_code, and refresh flows intact end to end', async () => {
      const registration = await registerPost(
        createMockEvent({
          url: 'http://localhost:3002/oauth/register',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_name: 'Round Trip Agent',
            redirect_uris: [daemonRedirect],
            token_endpoint_auth_method: 'none',
            scope: 'activity:read'
          })
        }).event
      );
      expect(registration.status).toBe(201);
      const registered = await registration.json();

      const issued = await runtime.oauthAuth.issueAuthorizationCode({
        clientId: registered.client_id,
        redirectUri: daemonRedirect,
        resource: mcpResource,
        scopes: ['activity:read'],
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256'
      });

      const exchangeBody = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registered.client_id,
        code: issued.code,
        redirect_uri: daemonRedirect,
        code_verifier: validVerifier,
        resource: mcpResource
      }).toString();

      const exchanged = await tokenPost(
        tokenRequest({
          body: exchangeBody,
          contentLength: String(Buffer.byteLength(exchangeBody, 'utf-8'))
        })
      );
      expect(exchanged.status).toBe(200);
      const tokens = await exchanged.json();
      expect(tokens.access_token).toMatch(/^wat_/);

      const refreshBody = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: registered.client_id,
        refresh_token: tokens.refresh_token,
        resource: mcpResource
      }).toString();

      const refreshed = await tokenPost(
        tokenRequest({
          body: refreshBody,
          contentLength: String(Buffer.byteLength(refreshBody, 'utf-8'))
        })
      );
      expect(refreshed.status).toBe(200);
      expect((await refreshed.json()).access_token).toMatch(/^wat_/);
    });
  });

  describe('HTTP Basic Client Authentication Parsing', () => {
    const daemonRedirect = 'https://daemon.example.corp/callback';

    function basicTokenEvent(credentials: string) {
      return createMockEvent({
        url: 'http://localhost:3002/oauth/token',
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${credentials}`
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'wac_placeholder',
          redirect_uri: daemonRedirect,
          code_verifier: validVerifier,
          resource: mcpResource
        }).toString()
      }).event;
    }

    /** Asserts a generic 401 that never restates what was submitted. */
    async function expectCredentialRejection(response: Response, submitted: string) {
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('www-authenticate')).toBe('Basic realm="OAuth"');
      const raw = await response.text();
      expect(JSON.parse(raw).error).toBe('invalid_client');
      expect(raw).not.toContain(submitted);
      expect(raw).not.toContain(confidentialClient.clientSecret!);
      expect(raw).not.toContain(confidentialClient.metadata.clientId);
    }

    const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

    /**
     * Re-spells the last significant Base64 character with its unused trailing bits set.
     * The result decodes to the very same bytes but is not what an encoder would emit.
     */
    function withTrailingBitsSet(canonical: string): string {
      const padding = (canonical.match(/=+$/) ?? [''])[0].length;
      const index = canonical.length - padding - 1;
      const value = BASE64_ALPHABET.indexOf(canonical[index]);
      const unusedBits = padding === 1 ? 0b11 : 0b1111;
      const replacement = (value & ~unusedBits) | ((value & unusedBits) === 0 ? 1 : 0);
      return canonical.slice(0, index) + BASE64_ALPHABET[replacement] + canonical.slice(index + 1);
    }

    it('rejects non-canonical Base64 spellings of otherwise valid credentials', async () => {
      const raw = `${confidentialClient.metadata.clientId}:${confidentialClient.clientSecret}`;
      const canonical = Buffer.from(raw, 'utf-8').toString('base64');
      expect(canonical).toMatch(/=$/);

      const trailingBits = withTrailingBitsSet(canonical);
      // Node decodes it to the identical credentials; only the spelling differs.
      expect(Buffer.from(trailingBits, 'base64').toString('utf-8')).toBe(raw);

      const variants = [
        canonical.replace(/=+$/, ''), // padding stripped
        canonical.replace(/\+/g, '-').replace(/\//g, '_'), // base64url alphabet
        `${canonical.slice(0, 4)} ${canonical.slice(4)}`, // internal whitespace
        `${canonical}=`, // over-padded
        trailingBits // unused trailing bits set
      ].filter((variant) => variant !== canonical);

      expect(variants.length).toBeGreaterThanOrEqual(4);
      for (const variant of variants) {
        await expectCredentialRejection(await tokenPost(basicTokenEvent(variant)), variant);
      }
    });

    it('rejects credentials that decode without a colon separator', async () => {
      const credentials = Buffer.from(confidentialClient.metadata.clientId, 'utf-8').toString(
        'base64'
      );
      await expectCredentialRejection(await tokenPost(basicTokenEvent(credentials)), credentials);
    });

    it('rejects credentials that decode to control characters', async () => {
      for (const control of ['\u0000', '\r', '\n', '\u007f']) {
        const credentials = Buffer.from(
          `${confidentialClient.metadata.clientId}${control}:${confidentialClient.clientSecret}`,
          'utf-8'
        ).toString('base64');
        await expectCredentialRejection(await tokenPost(basicTokenEvent(credentials)), credentials);
      }
    });

    it('rejects malformed percent-encoding inside a credential component', async () => {
      for (const spelling of ['%', '%2', '%zz', '%2G', '%%41']) {
        const credentials = Buffer.from(
          `${confidentialClient.metadata.clientId}${spelling}:secret`,
          'utf-8'
        ).toString('base64');
        await expectCredentialRejection(await tokenPost(basicTokenEvent(credentials)), credentials);
      }
    });

    it('rejects an empty or absent credential after the scheme', async () => {
      for (const header of ['Basic', 'Basic ', 'Basic    ']) {
        const response = await tokenPost(
          createMockEvent({
            url: 'http://localhost:3002/oauth/token',
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              authorization: header
            },
            body: 'grant_type=refresh_token&refresh_token=wrt_x'
          }).event
        );
        expect(response.status).toBe(401);
        expect((await response.json()).error).toBe('invalid_client');
      }
    });

    it('accepts form-urlencoded credentials, as RFC 6749 Section 2.3.1 requires', async () => {
      const percentEncode = (value: string) =>
        [...Buffer.from(value, 'utf-8')]
          .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
          .join('');

      const issued = await runtime.oauthAuth.issueAuthorizationCode({
        clientId: confidentialClient.metadata.clientId,
        redirectUri: daemonRedirect,
        resource: mcpResource,
        scopes: ['activity:read'],
        codeChallenge: validChallenge,
        codeChallengeMethod: 'S256'
      });

      const credentials = Buffer.from(
        `${percentEncode(confidentialClient.metadata.clientId)}:${percentEncode(confidentialClient.clientSecret!)}`,
        'utf-8'
      ).toString('base64');

      const response = await tokenPost(
        createMockEvent({
          url: 'http://localhost:3002/oauth/token',
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: `Basic ${credentials}`
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: issued.code,
            redirect_uri: daemonRedirect,
            code_verifier: validVerifier,
            resource: mcpResource
          }).toString()
        }).event
      );

      expect(response.status).toBe(200);
      expect((await response.json()).access_token).toMatch(/^wat_/);
    });
  });
});
