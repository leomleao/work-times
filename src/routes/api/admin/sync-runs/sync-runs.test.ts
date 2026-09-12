import { describe, it, expect, beforeEach } from 'vitest';
import { GET, POST, _createPostHandler as createPostHandler, _createGetHandler as createGetHandler } from './+server.js';
import { runtime } from '$lib/server/runtime';
import { csrfTokenForSession } from '$lib/server/security/http';
import type { SyncService, RunRequest, RunStatus } from '$lib/server/sync/contracts';
import { IdempotencyConflictError, QueueFullError } from '$lib/server/db/repositories/sync';
import Database from 'better-sqlite3';

describe('/api/admin/sync-runs route', () => {
  const adminPrincipal = { username: 'admin', sessionExpiresAt: '2099-01-01T00:00:00.000Z' };
  const validSessionToken = 'wts_session_test_token_12345';
  const publicUrl = runtime.config.publicUrl;
  const origin = publicUrl.origin;
  const validCsrf = csrfTokenForSession(validSessionToken, runtime.sessionSecret);

  beforeEach(() => {
    try {
      runtime.db.prepare(`
        INSERT OR REPLACE INTO account_settings (wakatime_user_id, timezone, weekday_start, keystroke_timeout_seconds, writes_only, plan, has_premium_features, updated_at)
        VALUES ('test-user', 'America/New_York', 1, 120, 0, 'free', 0, '2026-01-01T00:00:00.000Z')
      `).run();
    } catch {
      // Table might already have row or custom schema
    }
  });

  describe('GET', () => {
    it('returns 401 if unauthenticated', async () => {
      const response = await GET({
        locals: {} as any,
        url: new URL('http://localhost:3000/api/admin/sync-runs')
      } as any);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data).toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    });

    it('returns 200 with collection DTO when authenticated', async () => {
      const response = await GET({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        url: new URL('http://localhost:3000/api/admin/sync-runs')
      } as any);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('runs');
      expect(data).toHaveProperty('totalCount');
      expect(data).toHaveProperty('activeRun');
    });
  });

  describe('POST', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const req = new Request('http://localhost:3000/api/admin/sync-runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          'x-csrf-token': validCsrf
        },
        body: JSON.stringify({ mode: 'recent', idempotencyKey: 'key-1' })
      });

      const response = await POST({ locals: {} as any, request: req } as any);
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data).toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    });

    it('rejects cross-origin requests with 403', async () => {
      const req = new Request('http://localhost:3000/api/admin/sync-runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://evil.attacker.com',
          'x-csrf-token': validCsrf
        },
        body: JSON.stringify({ mode: 'recent', idempotencyKey: 'key-1' })
      });

      const response = await POST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: req
      } as any);
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data).toEqual({ error: 'Forbidden', code: 'FORBIDDEN' });
    });

    it('rejects invalid CSRF token with 403', async () => {
      const req = new Request('http://localhost:3000/api/admin/sync-runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          'x-csrf-token': 'bad-csrf'
        },
        body: JSON.stringify({ mode: 'recent', idempotencyKey: 'key-1' })
      });

      const response = await POST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: req
      } as any);
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data).toEqual({ error: 'Forbidden', code: 'FORBIDDEN' });
    });

    it('validates mode and idempotencyKey', async () => {
      // Bad mode
      const reqBadMode = new Request('http://localhost:3000/api/admin/sync-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({ mode: 'invalid_mode', idempotencyKey: 'key-1' })
      });
      const resBadMode = await POST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: reqBadMode
      } as any);
      expect(resBadMode.status).toBe(400);

      // Missing idempotencyKey
      const reqNoKey = new Request('http://localhost:3000/api/admin/sync-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({ mode: 'recent', idempotencyKey: '' })
      });
      const resNoKey = await POST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: reqNoKey
      } as any);
      expect(resNoKey.status).toBe(400);
    });

    it('rejects range fields for recent mode with RANGE_FIELDS_REJECTED_FOR_RECENT', async () => {
      const req = new Request('http://localhost:3000/api/admin/sync-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({
          mode: 'recent',
          idempotencyKey: 'key-recent-range',
          rangeStartDate: '2026-03-01'
        })
      });
      const res = await POST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: req
      } as any);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('RANGE_FIELDS_REJECTED_FOR_RECENT');
    });

    it('fails with 422 when verified source timezone is unavailable', async () => {
      const emptyDb = new Database(':memory:');
      const customPost = createPostHandler({
        runtime: {
          db: emptyDb,
          sync: {
            enqueue: async () => ({ runId: 1, reused: false }),
            cancel: async () => 'cancelled' as RunStatus,
            start: async () => {},
            stop: async () => {}
          }
        } as any
      });

      const req = new Request('http://localhost:3000/api/admin/sync-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({
          mode: 'recent',
          idempotencyKey: 'key-no-tz'
        })
      });
      const res = await customPost({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: req
      } as any);
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.code).toBe('TIMEZONE_UNAVAILABLE');
    });

    it('validates date range for backfill mode', async () => {
      // Missing range dates
      const reqMissing = new Request('http://localhost:3000/api/admin/sync-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({ mode: 'backfill', idempotencyKey: 'key-bf-1' })
      });
      const resMissing = await POST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: reqMissing
      } as any);
      expect(resMissing.status).toBe(400);

      // Start date after end date
      const reqInverted = new Request('http://localhost:3000/api/admin/sync-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({
          mode: 'backfill',
          idempotencyKey: 'key-bf-2',
          rangeStartDate: '2026-03-05',
          rangeEndDate: '2026-03-01'
        })
      });
      const resInverted = await POST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: reqInverted
      } as any);
      expect(resInverted.status).toBe(400);
      expect((await resInverted.json()).error).toContain('rangeStartDate must not be after rangeEndDate');

      // Future end date
      const reqFuture = new Request('http://localhost:3000/api/admin/sync-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({
          mode: 'backfill',
          idempotencyKey: 'key-bf-3',
          rangeStartDate: '2026-01-01',
          rangeEndDate: '2099-01-01'
        })
      });
      const resFuture = await POST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: reqFuture
      } as any);
      expect(resFuture.status).toBe(400);
      expect((await resFuture.json()).error).toContain('future');

      // Range exceeding 366 days
      const reqTooLong = new Request('http://localhost:3000/api/admin/sync-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({
          mode: 'backfill',
          idempotencyKey: 'key-bf-4',
          rangeStartDate: '2024-01-01',
          rangeEndDate: '2025-02-01' // > 366 days
        })
      });
      const resTooLong = await POST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: reqTooLong
      } as any);
      expect(resTooLong.status).toBe(400);
      expect((await resTooLong.json()).error).toContain('exceeds maximum limit');
    });

    it('enqueues run and returns 202 on valid payload', async () => {
      let enqueuedReq: RunRequest | null = null;
      const mockService: SyncService = {
        enqueue: async (req: RunRequest) => {
          enqueuedReq = req;
          return { runId: 42, reused: false };
        },
        cancel: async () => 'cancelled' as RunStatus,
        start: async () => {},
        stop: async () => {}
      };
      const customPost = createPostHandler({ sync: mockService });

      const req = new Request('http://localhost:3000/api/admin/sync-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({
          mode: 'recent',
          idempotencyKey: 'key-success-1'
        })
      });

      const response = await customPost({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: req
      } as any);

      expect(response.status).toBe(202);
      const data = await response.json();
      expect(data.runId).toBe(42);
      expect(data.statusUrl).toBe('/api/admin/sync-runs/42');
      expect(data.reused).toBe(false);
      expect(enqueuedReq!.mode).toBe('recent');
      expect(enqueuedReq!.trigger).toBe('manual');
    });

    it('handles idempotency conflict with 409', async () => {
      const mockService: SyncService = {
        enqueue: async () => {
          throw new IdempotencyConflictError('Key exists with different payload');
        },
        cancel: async () => 'cancelled' as RunStatus,
        start: async () => {},
        stop: async () => {}
      };
      const customPost = createPostHandler({ sync: mockService });

      const req = new Request('http://localhost:3000/api/admin/sync-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({
          mode: 'recent',
          idempotencyKey: 'key-conflict'
        })
      });

      const response = await customPost({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: req
      } as any);

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('handles queue full error with 409', async () => {
      const mockService: SyncService = {
        enqueue: async () => {
          throw new QueueFullError();
        },
        cancel: async () => 'cancelled' as RunStatus,
        start: async () => {},
        stop: async () => {}
      };
      const customPost = createPostHandler({ sync: mockService });

      const req = new Request('http://localhost:3000/api/admin/sync-runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({
          mode: 'recent',
          idempotencyKey: 'key-queue-full'
        })
      });

      const response = await customPost({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: req
      } as any);

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.code).toBe('SYNC_QUEUE_FULL');
    });
  });
});

