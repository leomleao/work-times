import { describe, expect, it } from 'vitest';
import { OAuthClientService, type OAuthClientMetadata, type OAuthClientRecord, type OAuthClientRepository } from './clients';
import {
  OAuthAuthorizationService,
  OAuthTokenReuseError,
  type AuthorizationCodeRecord,
  type OAuthAuthorizationRepository,
  type OAuthTokenRecord
} from './authorization';
import { createS256Challenge } from './pkce';

class MemoryClients implements OAuthClientRepository {
  records = new Map<string, OAuthClientRecord>();
  insert(record: OAuthClientRecord): void { this.records.set(record.clientId, record); }
  list(): OAuthClientMetadata[] { return [...this.records.values()].map(({ secretHash: _, ...record }) => record); }
  find(clientId: string): OAuthClientRecord | null { return this.records.get(clientId) ?? null; }
  revoke(clientId: string, revokedAt: string): boolean {
    const record = this.records.get(clientId);
    if (!record) return false;
    record.revokedAt = revokedAt;
    return true;
  }
}

class MemoryAuthorization implements OAuthAuthorizationRepository {
  codes = new Map<string, AuthorizationCodeRecord>();
  tokens: OAuthTokenRecord[] = [];

  insertAuthorizationCode(record: AuthorizationCodeRecord): void { this.codes.set(record.codeHash, record); }
  findAuthorizationCode(codeHash: string): AuthorizationCodeRecord | null { return this.codes.get(codeHash) ?? null; }
  consumeAuthorizationCode(codeHash: string, usedAt: string): boolean {
    const record = this.codes.get(codeHash);
    if (!record || record.usedAt) return false;
    record.usedAt = usedAt;
    return true;
  }
  insertToken(record: OAuthTokenRecord): void { this.tokens.push(record); }
  findByAccessTokenHash(tokenHash: string): OAuthTokenRecord | null {
    return this.tokens.find((token) => token.accessTokenHash === tokenHash) ?? null;
  }
  findByRefreshTokenHash(tokenHash: string): OAuthTokenRecord | null {
    return this.tokens.find((token) => token.refreshTokenHash === tokenHash) ?? null;
  }
  rotateRefreshToken(oldTokenHash: string, usedAt: string, replacement: OAuthTokenRecord): boolean {
    const current = this.findByRefreshTokenHash(oldTokenHash);
    if (!current || current.refreshUsedAt || current.revokedAt) return false;
    current.refreshUsedAt = usedAt;
    this.tokens.push(replacement);
    return true;
  }
  revokeFamily(familyId: string, revokedAt: string): number {
    let count = 0;
    for (const token of this.tokens) {
      if (token.familyId === familyId && !token.revokedAt) {
        token.revokedAt = revokedAt;
        count++;
      }
    }
    return count;
  }
  revokeByTokenHash(tokenHash: string, clientId: string, revokedAt: string): number {
    const target = this.tokens.find(
      (token) =>
        (token.accessTokenHash === tokenHash || token.refreshTokenHash === tokenHash) &&
        token.clientId === clientId
    );
    if (!target) return 0;
    return this.revokeFamily(target.familyId, revokedAt);
  }
}

const verifier = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
const resource = 'https://work-times.home/mcp';

async function fixture() {
  const clientRepository = new MemoryClients();
  const clients = new OAuthClientService(clientRepository);
  const client = await clients.register({
    name: 'Local MCP agent',
    publicClient: true,
    redirectUris: ['http://127.0.0.1:49152/callback'],
    scopes: ['activity:read', 'operations:read']
  });
  const authorizationRepository = new MemoryAuthorization();
  const authorization = new OAuthAuthorizationService(clients, authorizationRepository);
  return { client, clients, authorization, authorizationRepository };
}

describe('OAuth authorization-code flow', () => {
  it('issues a short-lived one-time code and work-only access tokens using PKCE', async () => {
    const { client, authorization, authorizationRepository } = await fixture();
    const now = new Date('2026-01-01T00:00:00.000Z');
    const issued = await authorization.issueAuthorizationCode({
      clientId: client.metadata.clientId,
      redirectUri: 'http://127.0.0.1:49152/callback',
      resource,
      scopes: ['activity:read'],
      codeChallenge: createS256Challenge(verifier),
      codeChallengeMethod: 'S256',
      state: 'opaque-client-state',
      now
    });

    expect(new URL(issued.redirectTo).searchParams.get('state')).toBe('opaque-client-state');
    const tokens = await authorization.exchangeAuthorizationCode({
      code: issued.code,
      clientId: client.metadata.clientId,
      redirectUri: 'http://127.0.0.1:49152/callback',
      resource,
      codeVerifier: verifier,
      now
    });

    expect(tokens?.accessToken).toMatch(/^wat_/);
    expect(tokens?.refreshToken).toMatch(/^wrt_/);
    expect(authorizationRepository.tokens[0]?.refreshExpiresAt).toBe('2026-04-01T00:00:00.000Z');
    await expect(
      authorization.verifyAccessToken(tokens?.accessToken ?? '', ['activity:read'], now, resource)
    ).resolves.toMatchObject({ clientId: client.metadata.clientId, scopes: ['activity:read'] });
    await expect(
      authorization.exchangeAuthorizationCode({
        code: issued.code,
        clientId: client.metadata.clientId,
        redirectUri: 'http://127.0.0.1:49152/callback',
        resource,
        codeVerifier: verifier,
        now
      })
    ).resolves.toBeNull();
  });

  it('does not consume a code when PKCE verification fails', async () => {
    const { client, authorization } = await fixture();
    const issued = await authorization.issueAuthorizationCode({
      clientId: client.metadata.clientId,
      redirectUri: 'http://127.0.0.1:49152/callback',
      resource,
      scopes: ['activity:read'],
      codeChallenge: createS256Challenge(verifier),
      codeChallengeMethod: 'S256'
    });
    await expect(
      authorization.exchangeAuthorizationCode({
        code: issued.code,
        clientId: client.metadata.clientId,
        redirectUri: 'http://127.0.0.1:49152/callback',
        resource,
        codeVerifier: `${verifier.slice(0, -1)}Z`
      })
    ).resolves.toBeNull();
    await expect(
      authorization.exchangeAuthorizationCode({
        code: issued.code,
        clientId: client.metadata.clientId,
        redirectUri: 'http://127.0.0.1:49152/callback',
        resource,
        codeVerifier: verifier
      })
    ).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  it('binds authorization codes, access tokens, and refresh tokens to the MCP resource', async () => {
    const { client, authorization } = await fixture();
    const now = new Date('2026-01-01T00:00:00.000Z');
    const issued = await authorization.issueAuthorizationCode({
      clientId: client.metadata.clientId,
      redirectUri: 'http://127.0.0.1:49152/callback',
      resource,
      scopes: ['activity:read'],
      codeChallenge: createS256Challenge(verifier),
      codeChallengeMethod: 'S256',
      now
    });

    await expect(
      authorization.exchangeAuthorizationCode({
        code: issued.code,
        clientId: client.metadata.clientId,
        redirectUri: 'http://127.0.0.1:49152/callback',
        resource: 'https://other.example/mcp',
        codeVerifier: verifier,
        now
      })
    ).resolves.toBeNull();

    const tokens = await authorization.exchangeAuthorizationCode({
      code: issued.code,
      clientId: client.metadata.clientId,
      redirectUri: 'http://127.0.0.1:49152/callback',
      resource,
      codeVerifier: verifier,
      now
    });
    await expect(
      authorization.verifyAccessToken(
        tokens?.accessToken ?? '',
        ['activity:read'],
        now,
        'https://other.example/mcp'
      )
    ).resolves.toBeNull();
    await expect(
      authorization.refresh({
        refreshToken: tokens?.refreshToken ?? '',
        clientId: client.metadata.clientId,
        resource: 'https://other.example/mcp',
        now
      })
    ).resolves.toBeNull();
  });

  it('invalidates existing access tokens when their client is revoked', async () => {
    const { client, clients, authorization } = await fixture();
    const now = new Date('2026-01-01T00:00:00.000Z');
    const issued = await authorization.issueAuthorizationCode({
      clientId: client.metadata.clientId,
      redirectUri: 'http://127.0.0.1:49152/callback',
      resource,
      scopes: ['activity:read'],
      codeChallenge: createS256Challenge(verifier),
      codeChallengeMethod: 'S256',
      now
    });
    const tokens = await authorization.exchangeAuthorizationCode({
      code: issued.code,
      clientId: client.metadata.clientId,
      redirectUri: 'http://127.0.0.1:49152/callback',
      resource,
      codeVerifier: verifier,
      now
    });

    await clients.revoke(client.metadata.clientId, now);
    await expect(
      authorization.verifyAccessToken(tokens?.accessToken ?? '', ['activity:read'], now, resource)
    ).resolves.toBeNull();
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const { client, authorization } = await fixture();
    const now = new Date('2026-01-01T00:00:00.000Z');
    const issued = await authorization.issueAuthorizationCode({
      clientId: client.metadata.clientId,
      redirectUri: 'http://127.0.0.1:49152/callback',
      resource,
      scopes: ['activity:read'],
      codeChallenge: createS256Challenge(verifier),
      codeChallengeMethod: 'S256',
      now
    });
    const first = await authorization.exchangeAuthorizationCode({
      code: issued.code,
      clientId: client.metadata.clientId,
      redirectUri: 'http://127.0.0.1:49152/callback',
      resource,
      codeVerifier: verifier,
      now
    });
    const second = await authorization.refresh({
      refreshToken: first?.refreshToken ?? '',
      clientId: client.metadata.clientId,
      resource,
      now: new Date('2026-01-01T00:01:00.000Z')
    });
    expect(second?.refreshToken).not.toBe(first?.refreshToken);

    await expect(
      authorization.refresh({
        refreshToken: first?.refreshToken ?? '',
        clientId: client.metadata.clientId,
        resource,
        now: new Date('2026-01-01T00:02:00.000Z')
      })
    ).rejects.toBeInstanceOf(OAuthTokenReuseError);
    await expect(
      authorization.verifyAccessToken(
        second?.accessToken ?? '',
        ['activity:read'],
        new Date('2026-01-01T00:02:00.000Z'),
        resource
      )
    ).resolves.toBeNull();
  });

  it('rejects unregistered scopes and redirect URIs before issuing a code', async () => {
    const { client, authorization } = await fixture();
    await expect(
      authorization.issueAuthorizationCode({
        clientId: client.metadata.clientId,
        redirectUri: 'https://attacker.example/callback',
        resource,
        scopes: ['activity:read'],
        codeChallenge: createS256Challenge(verifier),
        codeChallengeMethod: 'S256'
      })
    ).rejects.toThrow('redirect URI');
    await expect(
      authorization.issueAuthorizationCode({
        clientId: client.metadata.clientId,
        redirectUri: 'http://127.0.0.1:49152/callback',
        resource,
        scopes: ['activity:detail'],
        codeChallenge: createS256Challenge(verifier),
        codeChallengeMethod: 'S256'
      })
    ).rejects.toThrow('scope');
  });

  it('revokes the matching token family by access token or refresh token', async () => {
    const { client, authorization } = await fixture();
    const now = new Date('2026-01-01T00:00:00.000Z');
    const issued = await authorization.issueAuthorizationCode({
      clientId: client.metadata.clientId,
      redirectUri: 'http://127.0.0.1:49152/callback',
      resource,
      scopes: ['activity:read'],
      codeChallenge: createS256Challenge(verifier),
      codeChallengeMethod: 'S256',
      now
    });
    const tokens = await authorization.exchangeAuthorizationCode({
      code: issued.code,
      clientId: client.metadata.clientId,
      redirectUri: 'http://127.0.0.1:49152/callback',
      resource,
      codeVerifier: verifier,
      now
    });
    expect(tokens).not.toBeNull();

    // Revoking an unknown token returns true (idempotent / safe)
    await expect(
      authorization.revokeToken({
        token: 'wat_unknown_token',
        clientId: client.metadata.clientId,
        now
      })
    ).resolves.toBe(true);

    // Revoking with invalid client credentials returns false
    await expect(
      authorization.revokeToken({
        token: tokens!.accessToken,
        clientId: 'unknown_client',
        now
      })
    ).resolves.toBe(false);

    // Revoke by access token revokes family (both access and refresh)
    await expect(
      authorization.revokeToken({
        token: tokens!.accessToken,
        clientId: client.metadata.clientId,
        now
      })
    ).resolves.toBe(true);

    await expect(
      authorization.verifyAccessToken(tokens!.accessToken, ['activity:read'], now, resource)
    ).resolves.toBeNull();
    await expect(
      authorization.refresh({
        refreshToken: tokens!.refreshToken,
        clientId: client.metadata.clientId,
        resource,
        now
      })
    ).resolves.toBeNull();
  });
});

