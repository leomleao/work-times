import { describe, expect, it } from 'vitest';
import { openTestDatabase } from '$lib/server/db/connection';
import { SqliteWakaTimeOAuthConnectionRepository } from '$lib/server/db/repositories';
import { WakaTimeOAuthService, WAKATIME_OAUTH_SCOPES } from './oauth.js';
import { openWakaTimeToken, sealWakaTimeToken } from './token-seal.js';

const encryptionSecret = '0123456789abcdef0123456789abcdef';

function createService(fetchImpl: typeof fetch, now = new Date('2026-09-07T12:00:00.000Z')) {
  const db = openTestDatabase();
  const repository = new SqliteWakaTimeOAuthConnectionRepository(db);
  const service = new WakaTimeOAuthService({
    repository,
    clientId: 'app-id',
    clientSecret: 'app-secret',
    publicUrl: new URL('http://localhost:3002'),
    encryptionSecret,
    fetch: fetchImpl,
    now: () => now
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
});
