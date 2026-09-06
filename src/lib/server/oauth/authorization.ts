import { randomUUID } from 'node:crypto';
import { hasRequiredScopes, parseScopes, type ApplicationScope } from '$lib/server/auth/scopes';
import { generateOpaqueToken, hashOpaqueToken } from '$lib/server/security/tokens';
import type { OAuthClientService } from './clients';
import { verifyS256Challenge } from './pkce';
import { normalizeRedirectUri, redirectUriMatches } from './redirect-uri';

const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface AuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: ApplicationScope[];
  codeChallenge: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface OAuthTokenRecord {
  id: string;
  familyId: string;
  clientId: string;
  resource: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  scopes: ApplicationScope[];
  createdAt: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  refreshUsedAt: string | null;
  revokedAt: string | null;
}

export interface OAuthAuthorizationRepository {
  insertAuthorizationCode(record: AuthorizationCodeRecord): void | Promise<void>;
  findAuthorizationCode(codeHash: string): AuthorizationCodeRecord | null | Promise<AuthorizationCodeRecord | null>;
  consumeAuthorizationCode(codeHash: string, usedAt: string): boolean | Promise<boolean>;
  insertToken(record: OAuthTokenRecord): void | Promise<void>;
  findByAccessTokenHash(tokenHash: string): OAuthTokenRecord | null | Promise<OAuthTokenRecord | null>;
  findByRefreshTokenHash(tokenHash: string): OAuthTokenRecord | null | Promise<OAuthTokenRecord | null>;
  rotateRefreshToken(
    oldTokenHash: string,
    usedAt: string,
    replacement: OAuthTokenRecord
  ): boolean | Promise<boolean>;
  revokeFamily(familyId: string, revokedAt: string): number | Promise<number>;
  revokeByTokenHash(tokenHash: string, clientId: string, revokedAt: string): number | Promise<number>;
}

export class OAuthTokenReuseError extends Error {
  constructor() {
    super('Refresh token reuse detected; token family revoked');
    this.name = 'OAuthTokenReuseError';
  }
}

export interface OAuthTokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  scope: string;
}

function requestedSubset(requested: readonly ApplicationScope[], allowed: readonly ApplicationScope[]) {
  return hasRequiredScopes(allowed, requested);
}

export function normalizeResourceIdentifier(value: string): string {
  let resource: URL;
  try {
    resource = new URL(value);
  } catch {
    throw new Error('OAuth resource must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(resource.protocol) || resource.username || resource.password || resource.hash) {
    throw new Error('OAuth resource must be an HTTP(S) URL without credentials or fragment');
  }
  return resource.href;
}

export class OAuthAuthorizationService {
  constructor(
    private readonly clients: OAuthClientService,
    private readonly repository: OAuthAuthorizationRepository
  ) {}

  async issueAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    resource: string;
    scopes: string | readonly string[];
    codeChallenge: string;
    codeChallengeMethod: string;
    state?: string;
    now?: Date;
  }): Promise<{ redirectTo: string; code: string }> {
    const client = await this.clients.findActive(input.clientId);
    if (!client) throw new Error('Unknown OAuth client');
    if (!redirectUriMatches(input.redirectUri, client.redirectUris)) {
      throw new Error('OAuth redirect URI does not match registration');
    }
    if (input.codeChallengeMethod !== 'S256' || !CHALLENGE_PATTERN.test(input.codeChallenge)) {
      throw new Error('OAuth authorization requires PKCE S256');
    }
    const scopes = parseScopes(input.scopes);
    if (!requestedSubset(scopes, client.scopes)) throw new Error('Requested scope is not registered');

    const now = input.now ?? new Date();
    const generated = generateOpaqueToken('wac');
    await this.repository.insertAuthorizationCode({
      codeHash: generated.hash,
      clientId: client.clientId,
      redirectUri: normalizeRedirectUri(input.redirectUri),
      resource: normalizeResourceIdentifier(input.resource),
      scopes,
      codeChallenge: input.codeChallenge,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS).toISOString(),
      usedAt: null
    });

    const redirectTo = new URL(input.redirectUri);
    redirectTo.searchParams.set('code', generated.token);
    if (input.state !== undefined) redirectTo.searchParams.set('state', input.state);
    return { redirectTo: redirectTo.href, code: generated.token };
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    resource: string;
    codeVerifier: string;
    now?: Date;
  }): Promise<OAuthTokenResponse | null> {
    const client = await this.clients.authenticate(input.clientId, input.clientSecret);
    if (!client) return null;

    const now = input.now ?? new Date();
    const codeHash = hashOpaqueToken(input.code);
    const code = await this.repository.findAuthorizationCode(codeHash);
    if (
      !code ||
      code.usedAt ||
      code.expiresAt <= now.toISOString() ||
      code.clientId !== client.clientId ||
      code.redirectUri !== normalizeRedirectUri(input.redirectUri) ||
      code.resource !== normalizeResourceIdentifier(input.resource) ||
      !verifyS256Challenge(input.codeVerifier, code.codeChallenge)
    ) {
      return null;
    }
    if (!(await this.repository.consumeAuthorizationCode(codeHash, now.toISOString()))) return null;

    return this.issueTokens(client.clientId, code.resource, code.scopes, randomUUID(), now);
  }

  async refresh(input: {
    refreshToken: string;
    clientId: string;
    clientSecret?: string;
    resource: string;
    now?: Date;
  }): Promise<OAuthTokenResponse | null> {
    const client = await this.clients.authenticate(input.clientId, input.clientSecret);
    if (!client) return null;
    const now = input.now ?? new Date();
    const tokenHash = hashOpaqueToken(input.refreshToken);
    const current = await this.repository.findByRefreshTokenHash(tokenHash);
    if (
      !current ||
      current.clientId !== client.clientId ||
      current.resource !== normalizeResourceIdentifier(input.resource)
    ) return null;
    if (current.refreshUsedAt) {
      await this.repository.revokeFamily(current.familyId, now.toISOString());
      throw new OAuthTokenReuseError();
    }
    if (current.revokedAt || current.refreshExpiresAt <= now.toISOString()) return null;

    const generated = this.buildTokenRecord(
      current.clientId,
      current.resource,
      current.scopes,
      current.familyId,
      now
    );
    if (!(await this.repository.rotateRefreshToken(tokenHash, now.toISOString(), generated.record))) {
      await this.repository.revokeFamily(current.familyId, now.toISOString());
      throw new OAuthTokenReuseError();
    }
    return generated.response;
  }

  async revokeToken(input: {
    token: string;
    clientId: string;
    clientSecret?: string;
    now?: Date;
  }): Promise<boolean> {
    const client = await this.clients.authenticate(input.clientId, input.clientSecret);
    if (!client) return false;
    const now = input.now ?? new Date();
    const tokenHash = hashOpaqueToken(input.token);
    await this.repository.revokeByTokenHash(tokenHash, client.clientId, now.toISOString());
    return true;
  }

  async verifyAccessToken(
    token: string,
    requiredScopes: readonly ApplicationScope[],
    now = new Date(),
    expectedResource?: string
  ): Promise<{ clientId: string; scopes: ApplicationScope[]; expiresAt: number } | null> {
    const record = await this.repository.findByAccessTokenHash(hashOpaqueToken(token));
    if (
      !record ||
      record.revokedAt ||
      record.accessExpiresAt <= now.toISOString() ||
      (expectedResource !== undefined &&
        record.resource !== normalizeResourceIdentifier(expectedResource)) ||
      !hasRequiredScopes(record.scopes, requiredScopes)
    ) {
      return null;
    }
    if (!(await this.clients.findActive(record.clientId))) return null;
    return {
      clientId: record.clientId,
      scopes: [...record.scopes],
      expiresAt: Math.floor(new Date(record.accessExpiresAt).getTime() / 1000)
    };
  }

  private async issueTokens(
    clientId: string,
    resource: string,
    scopes: ApplicationScope[],
    familyId: string,
    now: Date
  ): Promise<OAuthTokenResponse> {
    const generated = this.buildTokenRecord(clientId, resource, scopes, familyId, now);
    await this.repository.insertToken(generated.record);
    return generated.response;
  }

  private buildTokenRecord(
    clientId: string,
    resource: string,
    scopes: ApplicationScope[],
    familyId: string,
    now: Date
  ): { record: OAuthTokenRecord; response: OAuthTokenResponse } {
    const access = generateOpaqueToken('wat');
    const refresh = generateOpaqueToken('wrt');
    const record: OAuthTokenRecord = {
      id: randomUUID(),
      familyId,
      clientId,
      resource,
      accessTokenHash: access.hash,
      refreshTokenHash: refresh.hash,
      scopes: [...scopes],
      createdAt: now.toISOString(),
      accessExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString(),
      refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
      refreshUsedAt: null,
      revokedAt: null
    };
    return {
      record,
      response: {
        accessToken: access.token,
        refreshToken: refresh.token,
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_TTL_MS / 1000,
        scope: scopes.join(' ')
      }
    };
  }
}
