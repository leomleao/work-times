import { describe, expect, it } from 'vitest';
import { openTestDatabase } from '$lib/server/db/connection';
import { SqliteWakaTimeOAuthConnectionRepository } from '$lib/server/db/repositories';
import { WakaTimeOAuthService, WAKATIME_OAUTH_SCOPES } from './oauth.js';
import { openWakaTimeToken, sealWakaTimeToken } from './token-seal.js';
import {
  WakaTimeRequestGate,
  resetApplicationRequestGate
} from './request-gate.js';
import {
  WakaTimeRequestTimeoutError,
  WakaTimeResponseSizeExceededError
} from './errors.js';

const encryptionSecret = '0123456789abcdef0123456789abcdef';

function createService(
  fetchImpl: typeof fetch,
  now = new Date('2026-09-07T12:00:00.000Z'),
  options?: {
    gate?: WakaTimeRequestGate;
    requestTimeoutMs?: number;
    maxResponseSizeBytes?: number;
  }
) {
  const db = openTestDatabase();
  const repository = new SqliteWakaTimeOAuthConnectionRepository(db);
  const service = new WakaTimeOAuthService({
    repository,
    clientId: 'app-id',
    clientSecret: 'app-secret',
    publicUrl: new URL('http://localhost:3002'),
    encryptionSecret,
    fetch: fetchImpl,
    now: () => now,
    gate: options?.gate ?? new WakaTimeRequestGate({ minSpacingMs: 0, maxConcurrent: 1 }),
    requestTimeoutMs: options?.requestTimeoutMs,
    maxResponseSizeBytes: options?.maxResponseSizeBytes
  });
  return { db, repository, service };
}

describe('WakaTime outbound OAuth', () => {
  it('seals tokens with authenticated encryption and never embeds plaintext', () => {
    const sealed = sealWakaTimeToken('waka_tok_private', encryptionSecret);
    expect(sealed).not.toContain('waka_tok_private');
    expect(openWakaTimeToken(sealed, encryptionSecret)).toBe('waka_tok_private');
    expect(() => openWakaTimeToken(sealed, 'fedcba9876543210fedcba9876543210')).toThrow(
      'could not be decrypted'
    );
  });

  it('builds an exact authorization-code URL with the minimum read scopes', () => {
    const { service } = createService(async () => new Response(null, { status: 500 }));
    const url = new URL(service.authorizationUrl('state-value'));
    expect(url.origin + url.pathname).toBe('https://wakatime.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('app-id');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3002/oauth/wakatime/callback'
    );
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...WAKATIME_OAUTH_SCOPES]);
    expect(url.searchParams.get('state')).toBe('state-value');
  });

  it('exchanges a code, accepts form-encoded tokens, and stores only sealed credentials', async () => {
    let requestBody = '';
    const { repository, service } = createService(async (_input, init) => {
      requestBody = String(init?.body ?? '');
      return new Response(
        new URLSearchParams({
          access_token: 'waka_tok_access',
          refresh_token: 'waka_ref_refresh',
          token_type: 'bearer',
          expires_in: '3600',
          scope: WAKATIME_OAUTH_SCOPES.join(',')
        }).toString(),
        { status: 200, headers: { 'content-type': 'application/x-www-form-urlencoded' } }
      );
    });

    await service.exchangeCode('authorization-code');

    const sent = new URLSearchParams(requestBody);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('redirect_uri')).toBe('http://localhost:3002/oauth/wakatime/callback');
    expect(sent.get('client_secret')).toBe('app-secret');

    const stored = repository.get();
    expect(stored?.accessTokenSealed).not.toContain('waka_tok_access');
    expect(stored?.refreshTokenSealed).not.toContain('waka_ref_refresh');
    expect(stored?.expiresAt).toBe('2026-09-07T13:00:00.000Z');
    expect(await service.getAccessToken()).toBe('waka_tok_access');
  });

  it('refreshes an expiring token once and preserves a non-rotated refresh token', async () => {
    let calls = 0;
    const { repository, service } = createService(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          access_token: calls === 1 ? 'initial-access' : 'refreshed-access',
          ...(calls === 1 ? { refresh_token: 'stable-refresh' } : {}),
          token_type: 'Bearer',
          expires_in: calls === 1 ? 60 : 3600
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    await service.exchangeCode('code');
    expect(await service.getAccessToken()).toBe('refreshed-access');
    expect(calls).toBe(2);
    expect(openWakaTimeToken(repository.get()!.refreshTokenSealed, encryptionSecret)).toBe(
      'stable-refresh'
    );
  });

  it('revokes upstream before deleting the local connection', async () => {
    const requestedUrls: string[] = [];
    const { repository, service } = createService(async (input) => {
      requestedUrls.push(String(input));
      if (String(input).endsWith('/oauth/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'access',
            refresh_token: 'refresh',
            token_type: 'Bearer',
            expires_in: 3600
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('', { status: 200 });
    });
    await service.exchangeCode('code');
    await service.disconnect();
    expect(requestedUrls.at(-1)).toBe('https://wakatime.com/oauth/revoke');
    expect(repository.get()).toBeNull();
  });

  it('distinguishes revoked authorization (400/401) from transient refresh failure (5xx/network)', async () => {
    // 1. Revoked authorization (400)
    const { service: revokedService } = createService(async (input) => {
      if (String(input).endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(null, { status: 200 });
    });

    // Seed connection
    const { repository } = createService(async () => new Response(null, { status: 200 }));
    repository.upsert({
      accessTokenSealed: sealWakaTimeToken('exp', encryptionSecret),
      refreshTokenSealed: sealWakaTimeToken('ref', encryptionSecret),
      tokenType: 'Bearer',
      scopes: [...WAKATIME_OAUTH_SCOPES],
      expiresAt: '2026-09-07T11:00:00.000Z',
      connectedAt: '2026-09-07T10:00:00.000Z',
      updatedAt: '2026-09-07T10:00:00.000Z'
    });

    const revokedTestService = new WakaTimeOAuthService({
      repository,
      clientId: 'app-id',
      clientSecret: 'app-secret',
      publicUrl: new URL('http://localhost:3002'),
      encryptionSecret,
      fetch: async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        })
    });

    await expect(revokedTestService.refreshAccessToken()).rejects.toThrow();

    // 2. Transient server error (502 Bad Gateway)
    const transientTestService = new WakaTimeOAuthService({
      repository,
      clientId: 'app-id',
      clientSecret: 'app-secret',
      publicUrl: new URL('http://localhost:3002'),
      encryptionSecret,
      fetch: async () => new Response('Bad Gateway', { status: 502 })
    });

    await expect(transientTestService.refreshAccessToken()).rejects.toThrow();
  });

  it('prevents stale in-flight refresh persistence using SqliteWakaTimeOAuthConnectionRepository updateTokensCAS', async () => {
    let fetchResolve: (res: Response) => void;
    let fetchStartedResolve: () => void;
    const fetchStarted = new Promise<void>((r) => {
      fetchStartedResolve = r;
    });

    const slowFetch: typeof fetch = async () => {
      fetchStartedResolve();
      return new Promise<Response>((r) => {
        fetchResolve = r;
      });
    };

    const { repository, service } = createService(
      slowFetch,
      undefined,
      { gate: new WakaTimeRequestGate({ minSpacingMs: 0, maxConcurrent: 2 }) }
    );

    repository.upsert({
      accessTokenSealed: sealWakaTimeToken('initial-access', encryptionSecret),
      refreshTokenSealed: sealWakaTimeToken('initial-refresh', encryptionSecret),
      tokenType: 'Bearer',
      scopes: [...WAKATIME_OAUTH_SCOPES],
      expiresAt: '2026-09-07T11:00:00.000Z',
      connectedAt: '2026-09-07T10:00:00.000Z',
      updatedAt: '2026-09-07T10:00:00.000Z'
    });

    // Start refresh under generation 1
    const refreshPromise = service.refreshAccessToken();
    await fetchStarted;

    // Concurrently, database generation advances (e.g. another update/connection)
    repository.upsert({
      accessTokenSealed: sealWakaTimeToken('other-access', encryptionSecret),
      refreshTokenSealed: sealWakaTimeToken('other-refresh', encryptionSecret),
      tokenType: 'Bearer',
      scopes: [...WAKATIME_OAUTH_SCOPES],
      expiresAt: '2026-09-07T15:00:00.000Z',
      connectedAt: '2026-09-07T10:00:00.000Z',
      updatedAt: '2026-09-07T12:00:00.000Z',
      generation: 2
    });
    expect(repository.get()!.generation).toBe(2);

    // Upstream refresh now returns
    fetchResolve!(
      new Response(
        JSON.stringify({
          access_token: 'stale-refreshed-token',
          refresh_token: 'stale-refreshed-refresh',
          token_type: 'Bearer',
          expires_in: 3600
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    // Refresh should reject because CAS failed!
    await expect(refreshPromise).rejects.toThrow(/STALE_CONNECTION_GENERATION/);

    // Repository was NOT overwritten with stale token
    const stored = repository.get();
    expect(openWakaTimeToken(stored!.accessTokenSealed, encryptionSecret)).toBe('other-access');
  });

  it('prevents stale in-flight refresh persistence across disconnect and reconnect (ABA protection)', async () => {
    let refreshFetchResolve: (res: Response) => void;
    let refreshStartedResolve: () => void;
    const refreshStarted = new Promise<void>((r) => {
      refreshStartedResolve = r;
    });

    const mockFetch: typeof fetch = async (_input, init) => {
      const body = String(init?.body ?? '');

      if (body.includes('grant_type=refresh_token')) {
        refreshStartedResolve();
        return new Promise<Response>((r) => {
          refreshFetchResolve = r;
        });
      }

      if (body.includes('grant_type=authorization_code')) {
        return new Response(
          JSON.stringify({
            access_token: 'freshly-reconnected-access',
            refresh_token: 'freshly-reconnected-refresh',
            token_type: 'Bearer',
            expires_in: 3600
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      return new Response(null, { status: 404 });
    };

    const { repository, service } = createService(
      mockFetch,
      undefined,
      { gate: new WakaTimeRequestGate({ minSpacingMs: 0, maxConcurrent: 2 }) }
    );

    repository.upsert({
      accessTokenSealed: sealWakaTimeToken('gen1-access', encryptionSecret),
      refreshTokenSealed: sealWakaTimeToken('gen1-refresh', encryptionSecret),
      tokenType: 'Bearer',
      scopes: [...WAKATIME_OAUTH_SCOPES],
      expiresAt: '2026-09-07T11:00:00.000Z',
      connectedAt: '2026-09-07T10:00:00.000Z',
      updatedAt: '2026-09-07T10:00:00.000Z'
    });

    // 1. Background worker triggers refresh for generation 1
    const inFlightRefresh = service.refreshAccessToken();
    await refreshStarted;

    // 2. User disconnects locally (deletes row)
    repository.delete();
    expect(repository.get()).toBeNull();

    // 3. User reconnects concurrently via exchangeCode
    // WakaTimeOAuthService monotonically increments generation (new generation >= 2)
    await service.exchangeCode('reconnected-code');

    const connAfterExchange = repository.get();
    expect(connAfterExchange).not.toBeNull();
    expect(connAfterExchange!.generation).toBeGreaterThanOrEqual(2);
    expect(openWakaTimeToken(connAfterExchange!.accessTokenSealed, encryptionSecret)).toBe(
      'freshly-reconnected-access'
    );

    // 4. Now the slow refresh for generation 1 returns
    refreshFetchResolve!(
      new Response(
        JSON.stringify({
          access_token: 'stale-gen1-access',
          token_type: 'Bearer',
          expires_in: 3600
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    // In-flight refresh must fail because generation 1 is stale
    await expect(inFlightRefresh).rejects.toThrow(/STALE_CONNECTION_GENERATION/);

    // The stored connection MUST retain the reconnected access token!
    const finalStored = repository.get();
    expect(openWakaTimeToken(finalStored!.accessTokenSealed, encryptionSecret)).toBe(
      'freshly-reconnected-access'
    );
  });

  it('aborts in-flight refresh when connection was deleted', async () => {
    let fetchResolve: (res: Response) => void;
    let fetchStartedResolve: () => void;
    const fetchStarted = new Promise<void>((r) => {
      fetchStartedResolve = r;
    });

    const slowFetch: typeof fetch = async () => {
      fetchStartedResolve();
      return new Promise<Response>((r) => {
        fetchResolve = r;
      });
    };

    const { repository, service } = createService(
      slowFetch,
      undefined,
      { gate: new WakaTimeRequestGate({ minSpacingMs: 0, maxConcurrent: 1 }) }
    );

    repository.upsert({
      accessTokenSealed: sealWakaTimeToken('initial-access', encryptionSecret),
      refreshTokenSealed: sealWakaTimeToken('initial-refresh', encryptionSecret),
      tokenType: 'Bearer',
      scopes: [...WAKATIME_OAUTH_SCOPES],
      expiresAt: '2026-09-07T11:00:00.000Z',
      connectedAt: '2026-09-07T10:00:00.000Z',
      updatedAt: '2026-09-07T10:00:00.000Z'
    });

    const refreshPromise = service.refreshAccessToken();
    await fetchStarted;

    // Connection deleted while refresh was in flight
    repository.delete();
    expect(repository.get()).toBeNull();

    fetchResolve!(
      new Response(
        JSON.stringify({
          access_token: 'stale-access',
          refresh_token: 'stale-refresh',
          token_type: 'Bearer',
          expires_in: 3600
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    await expect(refreshPromise).rejects.toThrow(/STALE_CONNECTION_GENERATION/);
    expect(repository.get()).toBeNull();
  });

  it('enforces whole-request timeout on OAuth calls', async () => {
    const hangingFetch: typeof fetch = async (_url, init) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new Error('Aborted'));
        });
      });
    };
    const { service } = createService(hangingFetch, undefined, {
      requestTimeoutMs: 25
    });

    await expect(service.exchangeCode('code')).rejects.toThrow(WakaTimeRequestTimeoutError);
  });

  it('enforces response payload limit on OAuth calls', async () => {
    const hugePayloadFetch: typeof fetch = async () =>
      new Response('x'.repeat(2048), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': '2048'
        }
      });
    const { service } = createService(hugePayloadFetch, undefined, {
      maxResponseSizeBytes: 1024
    });

    await expect(service.exchangeCode('code')).rejects.toThrow(WakaTimeResponseSizeExceededError);
  });

  it('sanitizes error messages so credentials and sensitive URLs are not leaked', async () => {
    const leakyFetch: typeof fetch = async () => {
      throw new Error(
        'Connect failed to https://user:secret_pass@wakatime.com/oauth/token with token waka_sec_12345'
      );
    };
    const { repository, service } = createService(leakyFetch);
    repository.upsert({
      accessTokenSealed: sealWakaTimeToken('initial-access', encryptionSecret),
      refreshTokenSealed: sealWakaTimeToken('initial-refresh', encryptionSecret),
      tokenType: 'Bearer',
      scopes: [...WAKATIME_OAUTH_SCOPES],
      expiresAt: '2026-09-07T11:00:00.000Z',
      connectedAt: '2026-09-07T10:00:00.000Z',
      updatedAt: '2026-09-07T10:00:00.000Z'
    });

    try {
      await service.refreshAccessToken();
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err.message).not.toContain('secret_pass');
      expect(err.message).not.toContain('waka_sec_12345');
    }
  });

  it('uses the shared application request gate by default', async () => {
    const timestamps: number[] = [];
    let fakeNow = 10000;
    const gate = new WakaTimeRequestGate({
      minSpacingMs: 1000,
      maxConcurrent: 1,
      now: () => fakeNow,
      delay: async (ms) => {
        fakeNow += ms;
      }
    });
    resetApplicationRequestGate(gate);

    try {
      const db = openTestDatabase();
      const repository = new SqliteWakaTimeOAuthConnectionRepository(db);
      // Service constructed without explicit gate - should pick up shared application gate!
      const service = new WakaTimeOAuthService({
        repository,
        clientId: 'app-id',
        clientSecret: 'app-secret',
        publicUrl: new URL('http://localhost:3002'),
        encryptionSecret,
        fetch: async () => {
          timestamps.push(fakeNow);
          return new Response(
            JSON.stringify({
              access_token: 'acc',
              refresh_token: 'ref',
              token_type: 'Bearer',
              expires_in: 3600
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
      });

      await service.exchangeCode('code-1');
      await service.exchangeCode('code-2');

      expect(timestamps).toEqual([10000, 11000]);
    } finally {
      resetApplicationRequestGate();
    }
  });
});
