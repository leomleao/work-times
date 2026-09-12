import { timingSafeEqual } from 'node:crypto';
import { verifyPassword } from '$lib/server/security/password';
import { generateOpaqueToken, hashOpaqueToken } from '$lib/server/security/tokens';
import { requestHasTrustedOrigin, verifyCsrfToken } from '$lib/server/security/http';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AdminSessionRecord {
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface AdminSessionRepository {
  insert(session: AdminSessionRecord): void | Promise<void>;
  findByTokenHash(tokenHash: string): AdminSessionRecord | null | Promise<AdminSessionRecord | null>;
  touch(tokenHash: string, lastSeenAt: string): void | Promise<void>;
  revoke(tokenHash: string, revokedAt: string): void | Promise<void>;
  deleteExpired(now: string): number | Promise<number>;
}

export interface AdminPrincipal {
  username: string;
  sessionExpiresAt: string;
}

function sameText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

export class AdminAuthenticator {
  constructor(
    private readonly options: {
      username: string;
      passwordHash: string | null;
      sessions: AdminSessionRepository;
      sessionTtlMs?: number;
      sessionIdleTtlMs?: number;
    }
  ) {}

  get configured(): boolean {
    return Boolean(this.options.passwordHash);
  }

  async login(
    username: string,
    password: string,
    now = new Date()
  ): Promise<{ token: string; principal: AdminPrincipal } | null> {
    const expectedHash = this.options.passwordHash;
    if (!expectedHash) return null;

    const usernameMatches = sameText(username, this.options.username);
    const passwordMatches = verifyPassword(password, expectedHash);
    if (!usernameMatches || !passwordMatches) return null;

    const generated = generateOpaqueToken('wts');
    const expiresAt = new Date(
      now.getTime() + (this.options.sessionTtlMs ?? SESSION_TTL_MS)
    ).toISOString();
    await this.options.sessions.insert({
      tokenHash: generated.hash,
      createdAt: now.toISOString(),
      expiresAt,
      lastSeenAt: now.toISOString(),
      revokedAt: null
    });

    return {
      token: generated.token,
      principal: { username: this.options.username, sessionExpiresAt: expiresAt }
    };
  }

  async authenticate(token: string | undefined, now = new Date()): Promise<AdminPrincipal | null> {
    if (!token) return null;
    const record = await this.options.sessions.findByTokenHash(hashOpaqueToken(token));
    if (!record || record.revokedAt || record.expiresAt <= now.toISOString()) return null;

    const lastSeenAt = Date.parse(record.lastSeenAt);
    const idleTtlMs = this.options.sessionIdleTtlMs ?? SESSION_IDLE_TTL_MS;
    if (!Number.isFinite(lastSeenAt) || now.getTime() - lastSeenAt > idleTtlMs) {
      await this.options.sessions.revoke(record.tokenHash, now.toISOString());
      return null;
    }

    await this.options.sessions.touch(record.tokenHash, now.toISOString());
    return { username: this.options.username, sessionExpiresAt: record.expiresAt };
  }

  async logout(token: string | undefined, now = new Date()): Promise<void> {
    if (!token) return;
    await this.options.sessions.revoke(hashOpaqueToken(token), now.toISOString());
  }
}

export class LoginAttemptLimiter {
  readonly #attempts = new Map<string, number[]>();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 15 * 60 * 1000
  ) {}

  allow(key: string, nowMs = Date.now()): boolean {
    const earliest = nowMs - this.windowMs;
    const recent = (this.#attempts.get(key) ?? []).filter((attempt) => attempt > earliest);
    if (recent.length >= this.limit) {
      this.#attempts.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.#attempts.set(key, recent);
    return true;
  }

  clear(key: string): void {
    this.#attempts.delete(key);
  }
}

export class AdminAuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string
  ) {
    super(message);
    this.name = 'AdminAuthError';
  }
}

export interface AdminMutationAuthContext {
  locals?: {
    admin?: AdminPrincipal | null;
    sessionToken?: string | null;
    csrfToken?: string | null;
  };
  request: Request;
  publicUrl: URL;
  sessionSecret: string;
  submittedCsrf?: string | null;
}

/**
 * Validates that an administrative mutation is authorized:
 * 1. An existing admin session is present in locals. API-key, MCP bearer, or OAuth bearer
 *    credentials cannot control or mutate admin endpoints.
 * 2. The HTTP request Origin exactly matches the server publicUrl.
 * 3. A valid HMAC session-bound CSRF token is provided via x-csrf-token header or submitted body.
 *
 * Throws AdminAuthError with status 401 or 403 on any failure.
 */
export function validateAdminMutationAuth(ctx: AdminMutationAuthContext): {
  admin: AdminPrincipal;
  sessionToken: string;
} {
  const admin = ctx.locals?.admin;
  const sessionToken = ctx.locals?.sessionToken;

  if (!admin || !sessionToken) {
    throw new AdminAuthError(401, 'Unauthorized');
  }

  if (!requestHasTrustedOrigin(ctx.request, ctx.publicUrl)) {
    throw new AdminAuthError(403, 'Cross-origin request rejected');
  }

  const submittedCsrf =
    ctx.submittedCsrf ??
    ctx.request.headers.get('x-csrf-token');

  if (!verifyCsrfToken(submittedCsrf, sessionToken, ctx.sessionSecret)) {
    throw new AdminAuthError(403, 'Invalid or missing CSRF token');
  }

  return { admin, sessionToken };
}
