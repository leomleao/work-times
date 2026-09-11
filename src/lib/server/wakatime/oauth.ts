import type { SqliteWakaTimeOAuthConnectionRepository } from '$lib/server/db/repositories';
import { openWakaTimeToken, sealWakaTimeToken } from './token-seal.js';
import {
  WakaTimeOAuthRevokedError,
  WakaTimeOAuthTransientError,
  WakaTimeRequestTimeoutError,
  WakaTimeResponseSizeExceededError,
  WakaTimeError,
  sanitizeErrorMessage
} from './errors.js';
import {
  type WakaTimeRequestGate,
  getApplicationRequestGate
} from './request-gate.js';
import {
  UPSTREAM_REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_PAYLOAD_BYTES
} from '../sync/contracts.js';

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

export interface StoredOAuthRecord {
  accessTokenSealed: string;
  refreshTokenSealed: string;
  tokenType: 'Bearer';
  scopes: string[];
  expiresAt: string | null;
  connectedAt: string;
  updatedAt: string;
  generation?: number;
}

export interface WakaTimeOAuthServiceOptions {
  repository: SqliteWakaTimeOAuthConnectionRepository;
  clientId: string | null;
  clientSecret: string | null;
  publicUrl: URL;
  encryptionSecret: string | null;
  fetch?: typeof fetch;
  now?: () => Date;
  gate?: WakaTimeRequestGate;
  requestTimeoutMs?: number;
  maxResponseSizeBytes?: number;
}

export class WakaTimeOAuthError extends Error {
  readonly code?: string;

  constructor(message: string, options?: { code?: string }) {
    super(sanitizeErrorMessage(message));
    this.name = 'WakaTimeOAuthError';
    this.code = options?.code;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseTokenPayload(body: string, contentType: string): OAuthTokenPayload {
  let source: Record<string, unknown>;
  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      source = Object.fromEntries(new URLSearchParams(body));
    } else {
      try {
        source = JSON.parse(body) as Record<string, unknown>;
      } catch {
        source = Object.fromEntries(new URLSearchParams(body));
      }
    }
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
  readonly #gate: WakaTimeRequestGate;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseSizeBytes: number;

  #refreshPromise: Promise<string> | null = null;
  #lastKnownGeneration = 0;

  constructor(options: WakaTimeOAuthServiceOptions) {
    this.#repository = options.repository;
    this.#clientId = options.clientId?.trim() || null;
    this.#clientSecret = options.clientSecret?.trim() || null;
    this.#encryptionSecret = options.encryptionSecret;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? (() => new Date());
    this.#gate = options.gate ?? getApplicationRequestGate();
    this.#requestTimeoutMs = options.requestTimeoutMs ?? UPSTREAM_REQUEST_TIMEOUT_MS;
    this.#maxResponseSizeBytes = options.maxResponseSizeBytes ?? MAX_RESPONSE_PAYLOAD_BYTES;
    this.callbackUrl = new URL('/oauth/wakatime/callback', options.publicUrl).toString();
    this.installUrl = new URL('/integrations/wakatime', options.publicUrl).toString();

    try {
      this.#lastKnownGeneration = this.#repository.get()?.generation ?? 0;
    } catch {
      this.#lastKnownGeneration = 0;
    }
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

  get generation(): number {
    return this.#repository.get()?.generation ?? this.#lastKnownGeneration;
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

  async exchangeCode(code: string, signal?: AbortSignal): Promise<void> {
    this.#assertReady();
    if (!code.trim()) throw new WakaTimeOAuthError('Authorization code is required');

    const token = await this.#requestToken(
      {
        grant_type: 'authorization_code',
        code: code.trim(),
        redirect_uri: this.callbackUrl
      },
      signal
    );

    if (!token.refreshToken) {
      throw new WakaTimeOAuthError('WakaTime token response omitted the refresh token');
    }

    const current = this.#repository.get();
    const nextGeneration = Math.max(this.#lastKnownGeneration, current?.generation ?? 0) + 1;
    this.#lastKnownGeneration = nextGeneration;

    const record = this.#buildStoredRecord(
      token,
      token.refreshToken,
      this.#now().toISOString(),
      nextGeneration
    );
    this.#repository.upsert(record);
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    const connection = this.#repository.get();
    if (!connection) throw new WakaTimeOAuthError('WakaTime is not connected');
    if (connection.expiresAt) {
      const expiresAt = Date.parse(connection.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= this.#now().getTime() + REFRESH_EARLY_MS) {
        return this.refreshAccessToken(signal);
      }
    }
    return this.#open(connection.accessTokenSealed);
  }

  async refreshAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.#refreshPromise) return this.#refreshPromise;
    this.#refreshPromise = this.#refreshAccessToken(signal).finally(() => {
      this.#refreshPromise = null;
    });
    return this.#refreshPromise;
  }

  async disconnect(signal?: AbortSignal): Promise<void> {
    const connection = this.#repository.get();
    if (!connection) return;
    this.#assertReady();

    // Monotonically advance/capture lastKnownGeneration so any in-flight refresh cannot match after delete
    this.#lastKnownGeneration = Math.max(this.#lastKnownGeneration, connection.generation);

    const refreshToken = this.#open(connection.refreshTokenSealed);
    try {
      const { status } = await this.#executeHttp(
        REVOKE_URL,
        {
          client_id: this.#clientId!,
          client_secret: this.#clientSecret!,
          token: refreshToken
        },
        signal
      );

      if (status < 200 || status >= 300) {
        throw new WakaTimeOAuthError(`WakaTime token revocation failed (HTTP ${status})`);
      }
    } finally {
      this.#repository.delete();
    }
  }

  async #refreshAccessToken(signal?: AbortSignal): Promise<string> {
    this.#assertReady();
    const existing = this.#repository.get();
    if (!existing) throw new WakaTimeOAuthError('WakaTime is not connected');

    const expectedGeneration = existing.generation;
    this.#lastKnownGeneration = Math.max(this.#lastKnownGeneration, expectedGeneration);

    const existingRefreshToken = this.#open(existing.refreshTokenSealed);
    const token = await this.#requestToken(
      {
        grant_type: 'refresh_token',
        refresh_token: existingRefreshToken,
        redirect_uri: this.callbackUrl
      },
      signal
    );

    const refreshToken = token.refreshToken ?? existingRefreshToken;
    const now = this.#now();

    const tokens = {
      accessTokenSealed: sealWakaTimeToken(token.accessToken, this.#encryptionSecret!),
      refreshTokenSealed: sealWakaTimeToken(refreshToken, this.#encryptionSecret!),
      expiresAt:
        token.expiresIn === null
          ? null
          : new Date(now.getTime() + token.expiresIn * 1000).toISOString(),
      updatedAt: now.toISOString()
    };

    try {
      const updated = this.#repository.updateTokensCAS(tokens, expectedGeneration);
      if (!updated) {
        throw new WakaTimeOAuthError(
          'STALE_CONNECTION_GENERATION: Token refresh persistence aborted because connection was deleted or updated concurrently',
          { code: 'STALE_CONNECTION_GENERATION' }
        );
      }
    } catch (err) {
      if (err instanceof WakaTimeOAuthError) throw err;
      throw new WakaTimeOAuthError(
        `STALE_CONNECTION_GENERATION: ${err instanceof Error ? err.message : 'CAS generation mismatch'}`,
        { code: 'STALE_CONNECTION_GENERATION' }
      );
    }

    return token.accessToken;
  }

  async #readResponseBody(
    response: Response,
    signal?: AbortSignal,
    endpoint?: string
  ): Promise<string> {
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const bytes = Number.parseInt(contentLength, 10);
      if (!Number.isNaN(bytes) && bytes > this.#maxResponseSizeBytes) {
        throw new WakaTimeResponseSizeExceededError(this.#maxResponseSizeBytes, endpoint);
      }
    }

    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      try {
        while (true) {
          if (signal?.aborted) {
            await reader.cancel(signal.reason).catch(() => {});
            throw signal.reason ?? new Error('Request aborted');
          }

          let abortListener: (() => void) | undefined;
          const abortPromise = new Promise<never>((_, reject) => {
            if (signal?.aborted) {
              reject(signal.reason ?? new Error('Request aborted'));
              return;
            }
            abortListener = () => {
              reader.cancel(signal?.reason).catch(() => {});
              reject(signal?.reason ?? new Error('Request aborted'));
            };
            signal?.addEventListener('abort', abortListener, { once: true });
          });

          try {
            const { done, value } = await Promise.race([reader.read(), abortPromise]);
            if (abortListener) {
              signal?.removeEventListener('abort', abortListener);
            }
            if (signal?.aborted) {
              throw signal.reason ?? new Error('Request aborted');
            }
            if (done) break;

            if (value) {
              totalBytes += value.byteLength;
              if (totalBytes > this.#maxResponseSizeBytes) {
                await reader.cancel('Response payload size limit exceeded').catch(() => {});
                throw new WakaTimeResponseSizeExceededError(this.#maxResponseSizeBytes, endpoint);
              }
              chunks.push(value);
            }
          } catch (err) {
            if (abortListener) {
              signal?.removeEventListener('abort', abortListener);
            }
            throw err;
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }

      if (signal?.aborted) {
        throw signal.reason ?? new Error('Request aborted');
      }

      const totalBuffer = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        totalBuffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(totalBuffer);
    }

    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > this.#maxResponseSizeBytes) {
      throw new WakaTimeResponseSizeExceededError(this.#maxResponseSizeBytes, endpoint);
    }
    return text;
  }

  async #executeHttp(
    url: string,
    bodyParams: Record<string, string>,
    callerSignal?: AbortSignal
  ): Promise<{ status: number; text: string; contentType: string }> {
    if (callerSignal?.aborted) {
      throw callerSignal.reason ?? new Error('Request aborted before start');
    }

    const permit = await this.#gate.acquire({ signal: callerSignal });

    const attemptController = new AbortController();
    const onCallerAbort = () => {
      attemptController.abort(callerSignal?.reason ?? new Error('Request aborted by caller'));
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    const timeoutTimer = setTimeout(() => {
      attemptController.abort(
        new WakaTimeRequestTimeoutError(this.#requestTimeoutMs, new URL(url).pathname)
      );
    }, this.#requestTimeoutMs);

    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Accept: 'application/json, application/x-www-form-urlencoded',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams(bodyParams).toString(),
        signal: attemptController.signal
      });

      const text = await this.#readResponseBody(
        response,
        attemptController.signal,
        new URL(url).pathname
      );
      return {
        status: response.status,
        text,
        contentType: response.headers.get('content-type') ?? ''
      };
    } catch (err) {
      if (attemptController.signal.aborted) {
        const reason = attemptController.signal.reason;
        if (reason instanceof WakaTimeRequestTimeoutError) {
          throw reason;
        }
        if (callerSignal?.aborted) {
          throw callerSignal.reason ?? new Error('Request aborted by caller');
        }
      }
      if (err instanceof WakaTimeOAuthError || err instanceof WakaTimeError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : 'Network transport error';
      throw new WakaTimeOAuthTransientError(sanitizeErrorMessage(msg), new URL(url).pathname);
    } finally {
      clearTimeout(timeoutTimer);
      if (callerSignal) {
        callerSignal.removeEventListener('abort', onCallerAbort);
      }
      permit.release();
    }
  }

  async #requestToken(
    parameters: Record<string, string>,
    signal?: AbortSignal
  ): Promise<OAuthTokenPayload> {
    const { status, text, contentType } = await this.#executeHttp(
      TOKEN_URL,
      {
        client_id: this.#clientId!,
        client_secret: this.#clientSecret!,
        ...parameters
      },
      signal
    );

    if (status < 200 || status >= 300) {
      if (status === 400 || status === 401) {
        // Upstream explicitly revoked or rejected refresh token / client auth
        throw new WakaTimeOAuthRevokedError('/oauth/token');
      }
      if (status >= 500 && status <= 599) {
        throw new WakaTimeOAuthTransientError(
          `WakaTime token server error (HTTP ${status})`,
          '/oauth/token',
          status
        );
      }
      throw new WakaTimeOAuthError(`WakaTime token exchange failed (HTTP ${status})`);
    }

    return parseTokenPayload(text, contentType);
  }

  #buildStoredRecord(
    token: OAuthTokenPayload,
    refreshToken: string,
    connectedAt: string,
    generation?: number
  ): StoredOAuthRecord {
    const now = this.#now();
    return {
      accessTokenSealed: sealWakaTimeToken(token.accessToken, this.#encryptionSecret!),
      refreshTokenSealed: sealWakaTimeToken(refreshToken, this.#encryptionSecret!),
      tokenType: 'Bearer',
      scopes: token.scopes,
      expiresAt:
        token.expiresIn === null
          ? null
          : new Date(now.getTime() + token.expiresIn * 1000).toISOString(),
      connectedAt,
      updatedAt: now.toISOString(),
      generation
    };
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
