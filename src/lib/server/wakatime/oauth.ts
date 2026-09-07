import type { SqliteWakaTimeOAuthConnectionRepository } from '$lib/server/db/repositories';
import { openWakaTimeToken, sealWakaTimeToken } from './token-seal.js';

export const WAKATIME_OAUTH_SCOPES = [
  'read_heartbeats',
  'read_summaries',
  'read_stats.machines',
  'read_stats.editors',
  'read_stats.projects'
] as const;

const AUTHORIZE_URL = 'https://wakatime.com/oauth/authorize';
const TOKEN_URL = 'https://wakatime.com/oauth/token';
const REVOKE_URL = 'https://wakatime.com/oauth/revoke';
const REFRESH_EARLY_MS = 5 * 60 * 1000;

interface OAuthTokenPayload {
  accessToken: string;
  refreshToken: string | null;
  tokenType: 'Bearer';
  scopes: string[];
  expiresIn: number | null;
}

export interface WakaTimeOAuthStatus {
  appConfigured: boolean;
  encryptionReady: boolean;
  connected: boolean;
  callbackUrl: string;
  installUrl: string;
  scopes: string[];
  expiresAt: string | null;
  connectedAt: string | null;
}

export interface WakaTimeOAuthServiceOptions {
  repository: SqliteWakaTimeOAuthConnectionRepository;
  clientId: string | null;
  clientSecret: string | null;
  publicUrl: URL;
  encryptionSecret: string | null;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class WakaTimeOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WakaTimeOAuthError';
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseTokenPayload(body: string, contentType: string): OAuthTokenPayload {
  let source: Record<string, unknown>;
  try {
    source = contentType.includes('json')
      ? (JSON.parse(body) as Record<string, unknown>)
      : Object.fromEntries(new URLSearchParams(body));
  } catch {
    throw new WakaTimeOAuthError('WakaTime returned an invalid token response');
  }

  const accessToken = stringValue(source.access_token);
  if (!accessToken) throw new WakaTimeOAuthError('WakaTime token response omitted the access token');

  const rawType = stringValue(source.token_type) ?? 'Bearer';
  if (rawType.toLowerCase() !== 'bearer') {
    throw new WakaTimeOAuthError('WakaTime returned an unsupported token type');
  }

  const rawExpires = source.expires_in;
  const expiresIn = rawExpires === undefined || rawExpires === null || rawExpires === ''
    ? null
    : Number(rawExpires);
  if (expiresIn !== null && (!Number.isFinite(expiresIn) || expiresIn <= 0)) {
    throw new WakaTimeOAuthError('WakaTime returned an invalid token expiration');
  }

  const rawScope = stringValue(source.scope);
  const scopes = rawScope
    ? [...new Set(rawScope.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean))]
    : [...WAKATIME_OAUTH_SCOPES];

  return {
    accessToken,
    refreshToken: stringValue(source.refresh_token),
    tokenType: 'Bearer',
    scopes,
    expiresIn
  };
}

export class WakaTimeOAuthService {
  readonly callbackUrl: string;
  readonly installUrl: string;
  readonly #repository: SqliteWakaTimeOAuthConnectionRepository;
  readonly #clientId: string | null;
  readonly #clientSecret: string | null;
  readonly #encryptionSecret: string | null;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  #refreshPromise: Promise<string> | null = null;

  constructor(options: WakaTimeOAuthServiceOptions) {
    this.#repository = options.repository;
    this.#clientId = options.clientId?.trim() || null;
    this.#clientSecret = options.clientSecret?.trim() || null;
    this.#encryptionSecret = options.encryptionSecret;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? (() => new Date());
    this.callbackUrl = new URL('/oauth/wakatime/callback', options.publicUrl).toString();
    this.installUrl = new URL('/integrations/wakatime', options.publicUrl).toString();
  }

  get appConfigured(): boolean {
    return Boolean(this.#clientId && this.#clientSecret);
  }

  get encryptionReady(): boolean {
    return Boolean(this.#encryptionSecret && this.#encryptionSecret.length >= 32);
  }

  get ready(): boolean {
    return this.appConfigured && this.encryptionReady;
  }

  status(): WakaTimeOAuthStatus {
    const connection = this.#repository.get();
    return {
      appConfigured: this.appConfigured,
      encryptionReady: this.encryptionReady,
      connected: Boolean(connection),
      callbackUrl: this.callbackUrl,
      installUrl: this.installUrl,
      scopes: connection?.scopes ?? [...WAKATIME_OAUTH_SCOPES],
      expiresAt: connection?.expiresAt ?? null,
      connectedAt: connection?.connectedAt ?? null
    };
  }

  authorizationUrl(state: string): string {
    this.#assertReady();
    if (!state) throw new WakaTimeOAuthError('OAuth state is required');
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', this.#clientId!);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.callbackUrl);
    url.searchParams.set('scope', WAKATIME_OAUTH_SCOPES.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<void> {
    this.#assertReady();
    if (!code.trim()) throw new WakaTimeOAuthError('Authorization code is required');
    const token = await this.#requestToken({
      grant_type: 'authorization_code',
      code: code.trim(),
      redirect_uri: this.callbackUrl
    });
    if (!token.refreshToken) {
      throw new WakaTimeOAuthError('WakaTime token response omitted the refresh token');
    }
    this.#saveToken(token, token.refreshToken, this.#now().toISOString());
  }

  async getAccessToken(): Promise<string> {
    const connection = this.#repository.get();
    if (!connection) throw new WakaTimeOAuthError('WakaTime is not connected');
    if (connection.expiresAt) {
      const expiresAt = Date.parse(connection.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= this.#now().getTime() + REFRESH_EARLY_MS) {
        return this.refreshAccessToken();
      }
    }
    return this.#open(connection.accessTokenSealed);
  }

  async refreshAccessToken(): Promise<string> {
    if (this.#refreshPromise) return this.#refreshPromise;
    this.#refreshPromise = this.#refreshAccessToken().finally(() => {
      this.#refreshPromise = null;
    });
    return this.#refreshPromise;
  }

  async disconnect(): Promise<void> {
    const connection = this.#repository.get();
    if (!connection) return;
    this.#assertReady();
    const refreshToken = this.#open(connection.refreshTokenSealed);
    const response = await this.#fetch(REVOKE_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: this.#clientId!,
        client_secret: this.#clientSecret!,
        token: refreshToken
      }).toString()
    });
    if (!response.ok) {
      throw new WakaTimeOAuthError(`WakaTime token revocation failed (HTTP ${response.status})`);
    }
    this.#repository.delete();
  }

  async #refreshAccessToken(): Promise<string> {
    this.#assertReady();
    const existing = this.#repository.get();
    if (!existing) throw new WakaTimeOAuthError('WakaTime is not connected');
    const existingRefreshToken = this.#open(existing.refreshTokenSealed);
    const token = await this.#requestToken({
      grant_type: 'refresh_token',
      refresh_token: existingRefreshToken,
      redirect_uri: this.callbackUrl
    });
    const refreshToken = token.refreshToken ?? existingRefreshToken;
    this.#saveToken(token, refreshToken, existing.connectedAt);
    return token.accessToken;
  }

  async #requestToken(parameters: Record<string, string>): Promise<OAuthTokenPayload> {
    const response = await this.#fetch(TOKEN_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Accept: 'application/json, application/x-www-form-urlencoded',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: this.#clientId!,
        client_secret: this.#clientSecret!,
        ...parameters
      }).toString()
    });
    if (!response.ok) {
      throw new WakaTimeOAuthError(`WakaTime token exchange failed (HTTP ${response.status})`);
    }
    return parseTokenPayload(await response.text(), response.headers.get('content-type') ?? '');
  }

  #saveToken(token: OAuthTokenPayload, refreshToken: string, connectedAt: string): void {
    const now = this.#now();
    this.#repository.upsert({
      accessTokenSealed: sealWakaTimeToken(token.accessToken, this.#encryptionSecret!),
      refreshTokenSealed: sealWakaTimeToken(refreshToken, this.#encryptionSecret!),
      tokenType: 'Bearer',
      scopes: token.scopes,
      expiresAt: token.expiresIn === null
        ? null
        : new Date(now.getTime() + token.expiresIn * 1000).toISOString(),
      connectedAt,
      updatedAt: now.toISOString()
    });
  }

  #open(sealed: string): string {
    if (!this.#encryptionSecret) throw new WakaTimeOAuthError('OAuth token encryption is unavailable');
    return openWakaTimeToken(sealed, this.#encryptionSecret);
  }

  #assertReady(): void {
    if (!this.appConfigured) {
      throw new WakaTimeOAuthError('WakaTime OAuth App ID and App Secret are not configured');
    }
    if (!this.encryptionReady) {
      throw new WakaTimeOAuthError('A persistent SESSION_SECRET is required before connecting WakaTime');
    }
  }
}

