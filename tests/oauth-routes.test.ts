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
    it('rejects unauthenticated consent submission with 401', async () => {
      const formData = new FormData();
      formData.set('client_id', publicClient.metadata.clientId);
      formData.set('redirect_uri', redirectUri);

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/authorize?/approve',
        method: 'POST',
        body: formData
      });

      const res = await (authorizeActions.approve as any)(event);
      expect(res.status).toBe(401);
    });

    it('rejects consent submission with missing or invalid CSRF with 403', async () => {
      const sessionToken = 'admin-session';
      const formData = new FormData();
      formData.set('client_id', publicClient.metadata.clientId);
      formData.set('redirect_uri', redirectUri);
      formData.set('csrfToken', 'invalid-token');

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/authorize?/approve',
        method: 'POST',
        headers: { origin: 'http://localhost:3002' },
        locals: {
          admin: { username: 'admin', sessionExpiresAt: '2026-12-01' },
          sessionToken
        },
        body: formData
      });

      const res = await (authorizeActions.approve as any)(event);
      expect(res.status).toBe(403);
    });

    it('approves request, generates one-time code, and redirects to exact redirect_uri preserving state', async () => {
      const sessionToken = 'admin-session';
      const csrfToken = csrfTokenForSession(sessionToken, runtime.sessionSecret);

      const formData = new FormData();
      formData.set('csrfToken', csrfToken);
      formData.set('client_id', publicClient.metadata.clientId);
      formData.set('redirect_uri', redirectUri);
      formData.set('response_type', 'code');
      formData.set('resource', mcpResource);
      formData.set('scope', 'activity:read');
      formData.set('code_challenge', validChallenge);
      formData.set('code_challenge_method', 'S256');
      formData.set('state', 'client-state-abc');

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/authorize?/approve',
        method: 'POST',
        headers: { origin: 'http://localhost:3002' },
        locals: {
          admin: { username: 'admin', sessionExpiresAt: '2026-12-01' },
          sessionToken
        },
        body: formData
      });

      let location = '';
      try {
        await (authorizeActions.approve as any)(event);
      } catch (err: any) {
        expect(err.status).toBe(303);
        location = err.location;
      }

      expect(location).toBeTruthy();
      const redirectUrl = new URL(location);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe(redirectUri);
      expect(redirectUrl.searchParams.get('code')).toMatch(/^wac_/);
      expect(redirectUrl.searchParams.get('state')).toBe('client-state-abc');
    });

    it('denies request and redirects to exact redirect_uri with access_denied preserving state', async () => {
      const sessionToken = 'admin-session';
      const csrfToken = csrfTokenForSession(sessionToken, runtime.sessionSecret);

      const formData = new FormData();
      formData.set('csrfToken', csrfToken);
      formData.set('client_id', publicClient.metadata.clientId);
      formData.set('redirect_uri', redirectUri);
      formData.set('state', 'client-state-xyz');

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/authorize?/deny',
        method: 'POST',
        headers: { origin: 'http://localhost:3002' },
        locals: {
          admin: { username: 'admin', sessionExpiresAt: '2026-12-01' },
          sessionToken
        },
        body: formData
      });

      let location = '';
      try {
        await (authorizeActions.deny as any)(event);
      } catch (err: any) {
        expect(err.status).toBe(303);
        location = err.location;
      }

      expect(location).toBeTruthy();
      const redirectUrl = new URL(location);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe(redirectUri);
      expect(redirectUrl.searchParams.get('error')).toBe('access_denied');
      expect(redirectUrl.searchParams.get('state')).toBe('client-state-xyz');
    });

    it('denial with invalid redirect_uri returns 400 and never redirects', async () => {
      const sessionToken = 'admin-session';
      const csrfToken = csrfTokenForSession(sessionToken, runtime.sessionSecret);

      const formData = new FormData();
      formData.set('csrfToken', csrfToken);
      formData.set('client_id', publicClient.metadata.clientId);
      formData.set('redirect_uri', 'https://evil.attacker.com');

      const { event } = createMockEvent({
        url: 'http://localhost:3002/oauth/authorize?/deny',
        method: 'POST',
        headers: { origin: 'http://localhost:3002' },
        locals: {
          admin: { username: 'admin', sessionExpiresAt: '2026-12-01' },
          sessionToken
        },
        body: formData
      });

      const res = await (authorizeActions.deny as any)(event);
      expect(res.status).toBe(400);
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
});
