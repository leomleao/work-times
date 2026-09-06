import { describe, expect, it } from 'vitest';
import { hashPassword } from '$lib/server/security/password';
import {
  AdminAuthenticator,
  LoginAttemptLimiter,
  type AdminSessionRecord,
  type AdminSessionRepository
} from './admin-auth';

class MemorySessions implements AdminSessionRepository {
  records = new Map<string, AdminSessionRecord>();

  insert(session: AdminSessionRecord): void {
    this.records.set(session.tokenHash, session);
  }

  findByTokenHash(tokenHash: string): AdminSessionRecord | null {
    return this.records.get(tokenHash) ?? null;
  }

  touch(tokenHash: string, lastSeenAt: string): void {
    const record = this.records.get(tokenHash);
    if (record) record.lastSeenAt = lastSeenAt;
  }

  revoke(tokenHash: string, revokedAt: string): void {
    const record = this.records.get(tokenHash);
    if (record) record.revokedAt = revokedAt;
  }

  deleteExpired(now: string): number {
    let deleted = 0;
    for (const [key, value] of this.records) {
      if (value.expiresAt <= now) {
        this.records.delete(key);
        deleted++;
      }
    }
    return deleted;
  }
}

describe('admin authentication', () => {
  it('creates, authenticates, and revokes an opaque session', async () => {
    const sessions = new MemorySessions();
    const auth = new AdminAuthenticator({
      username: 'admin',
      passwordHash: hashPassword('safe-local-password'),
      sessions
    });
    const now = new Date('2026-01-01T10:00:00.000Z');

    const login = await auth.login('admin', 'safe-local-password', now);
    expect(login?.token).toMatch(/^wts_/);
    expect(JSON.stringify([...sessions.records.values()])).not.toContain(login?.token);
    await expect(auth.authenticate(login?.token, now)).resolves.toMatchObject({ username: 'admin' });

    await auth.logout(login?.token, now);
    await expect(auth.authenticate(login?.token, now)).resolves.toBeNull();
  });

  it('fails closed when credentials are absent, incorrect, or expired', async () => {
    const sessions = new MemorySessions();
    const unconfigured = new AdminAuthenticator({ username: 'admin', passwordHash: null, sessions });
    await expect(unconfigured.login('admin', 'anything-at-all')).resolves.toBeNull();

    const auth = new AdminAuthenticator({
      username: 'admin',
      passwordHash: hashPassword('safe-local-password'),
      sessions,
      sessionTtlMs: 1
    });
    await expect(auth.login('wrong', 'safe-local-password')).resolves.toBeNull();
    await expect(auth.login('admin', 'wrong-local-password')).resolves.toBeNull();

    const login = await auth.login('admin', 'safe-local-password', new Date(0));
    await expect(auth.authenticate(login?.token, new Date(2))).resolves.toBeNull();
  });

  it('revokes a session after its idle timeout even before absolute expiry', async () => {
    const sessions = new MemorySessions();
    const auth = new AdminAuthenticator({
      username: 'admin',
      passwordHash: hashPassword('safe-local-password'),
      sessions,
      sessionTtlMs: 10_000,
      sessionIdleTtlMs: 100
    });
    const login = await auth.login('admin', 'safe-local-password', new Date(0));

    await expect(auth.authenticate(login?.token, new Date(101))).resolves.toBeNull();
    expect([...sessions.records.values()][0]?.revokedAt).toBe(new Date(101).toISOString());
  });
});

describe('login attempt limiter', () => {
  it('limits repeated attempts per opaque client key and can be cleared', () => {
    const limiter = new LoginAttemptLimiter(2, 1_000);
    expect(limiter.allow('client', 0)).toBe(true);
    expect(limiter.allow('client', 1)).toBe(true);
    expect(limiter.allow('client', 2)).toBe(false);
    expect(limiter.allow('other', 2)).toBe(true);
    expect(limiter.allow('client', 1_001)).toBe(true);
    limiter.clear('client');
    expect(limiter.allow('client', 1_002)).toBe(true);
  });
});
