import { timingSafeEqual } from 'node:crypto';
import { verifyPassword } from '$lib/server/security/password';
import { generateOpaqueToken, hashOpaqueToken } from '$lib/server/security/tokens';

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
