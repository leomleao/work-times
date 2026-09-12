import { describe, it, expect } from 'vitest';
import { GET, _createGetHandler as createDetailGetHandler } from './+server.js';
import { POST as cancelPOST, _createPostHandler as createCancelHandler } from './cancel/+server.js';
import { POST as retryPOST, _createPostHandler as createRetryHandler } from './retry/+server.js';
import { runtime } from '$lib/server/runtime';
import { csrfTokenForSession } from '$lib/server/security/http';
import type { SyncService, RunRequest, RunStatus } from '$lib/server/sync/contracts';

describe('/api/admin/sync-runs/[id] routes', () => {
  const adminPrincipal = { username: 'admin', sessionExpiresAt: '2099-01-01T00:00:00.000Z' };
  const validSessionToken = 'wts_session_test_token_12345';
  const publicUrl = runtime.config.publicUrl;
  const origin = publicUrl.origin;
  const validCsrf = csrfTokenForSession(validSessionToken, runtime.sessionSecret);

  describe('GET /api/admin/sync-runs/[id]', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await GET({
        locals: {} as any,
        params: { id: '1' } as any,
        url: new URL('http://localhost:3000/api/admin/sync-runs/1')
      } as any);

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data).toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    });

    it('rejects invalid run ID with 400', async () => {
      const res = await GET({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: 'not-an-id' } as any,
        url: new URL('http://localhost:3000/api/admin/sync-runs/not-an-id')
      } as any);

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('Invalid run ID');
    });

    it('returns 404 for unknown run ID', async () => {
      const res = await GET({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: '999999' } as any,
        url: new URL('http://localhost:3000/api/admin/sync-runs/999999')
      } as any);

      expect(res.status).toBe(404);
      expect((await res.json()).error).toContain('not found');
    });

    it('returns 200 with run detail when run exists', async () => {
      // Insert run into runtime.db
      const info = runtime.db
        .prepare(`INSERT INTO sync_runs (started_at, status, trigger, mode) VALUES ('2026-03-01T10:00:00.000Z', 'succeeded', 'manual', 'recent')`)
        .run();
      const runId = Number(info.lastInsertRowid);

      runtime.db
        .prepare(`INSERT INTO sync_days (sync_run_id, date, status, total_seconds, synced_at) VALUES (?, '2026-02-28', 'succeeded', 3600, '2026-03-01T10:00:00.000Z')`)
        .run(runId);

      const res = await GET({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: String(runId) } as any,
        url: new URL(`http://localhost:3000/api/admin/sync-runs/${runId}`)
      } as any);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.run.id).toBe(runId);
      expect(data.days).toHaveLength(1);
      expect(data.days[0].date).toBe('2026-02-28');
    });

    it('returns 503 on GET when query fails', async () => {
      const brokenDb = {
        prepare: () => {
          throw new Error('Database error');
        }
      } as any;
      const customGet = createDetailGetHandler({ ...runtime, db: brokenDb });

      const res = await customGet({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: '1' } as any,
        url: new URL('http://localhost:3000/api/admin/sync-runs/1')
      } as any);

      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.code).toBe('SYNC_STATE_UNAVAILABLE');
    });
  });

  describe('POST /api/admin/sync-runs/[id]/cancel', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const req = new Request('http://localhost:3000/api/admin/sync-runs/1/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf }
      });
      const res = await cancelPOST({
        locals: {} as any,
        params: { id: '1' } as any,
        request: req
      } as any);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data).toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    });

    it('rejects cross-origin requests with 403', async () => {
      const req = new Request('http://localhost:3000/api/admin/sync-runs/1/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://evil.com', 'x-csrf-token': validCsrf }
      });
      const res = await cancelPOST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: '1' } as any,
        request: req
      } as any);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data).toEqual({ error: 'Forbidden', code: 'FORBIDDEN' });
    });

    it('cancels existing run and returns 200', async () => {
      const info = runtime.db
        .prepare(`INSERT INTO sync_runs (started_at, status, trigger, mode) VALUES ('2026-03-01T10:00:00.000Z', 'queued', 'manual', 'recent')`)
        .run();
      const runId = Number(info.lastInsertRowid);

      let cancelledId: number | null = null;
      const mockService: SyncService = {
        enqueue: async () => ({ runId: 1, reused: false }),
        cancel: async (id: number) => {
          cancelledId = id;
          runtime.db
            .prepare(`UPDATE sync_runs SET status = 'cancelled', cancel_requested_at = '2026-03-01T10:05:00.000Z' WHERE id = ?`)
            .run(id);
          return 'cancelled' as RunStatus;
        },
        start: async () => {},
        stop: async () => {}
      };
      const customCancel = createCancelHandler({ ...runtime, sync: mockService });

      const req = new Request(`http://localhost:3000/api/admin/sync-runs/${runId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf }
      });

      const res = await customCancel({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: String(runId) } as any,
        request: req
      } as any);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.runId).toBe(runId);
      expect(data.status).toBe('cancelled');
      expect(data.cancelledAt).toBe('2026-03-01T10:05:00.000Z');
      expect(cancelledId).toBe(runId);
    });

    it('returns 503 when cancel lacks persisted cancellation timestamp', async () => {
      const info = runtime.db
        .prepare(`INSERT INTO sync_runs (started_at, status, trigger, mode) VALUES ('2026-03-01T10:00:00.000Z', 'running', 'manual', 'recent')`)
        .run();
      const runId = Number(info.lastInsertRowid);

      const mockService: SyncService = {
        enqueue: async () => ({ runId: 1, reused: false }),
        cancel: async () => 'cancelled' as RunStatus, // does not persist timestamp
        start: async () => {},
        stop: async () => {}
      };
      const customCancel = createCancelHandler({ ...runtime, sync: mockService });

      const req = new Request(`http://localhost:3000/api/admin/sync-runs/${runId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf }
      });

      const res = await customCancel({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: String(runId) } as any,
        request: req
      } as any);

      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.code).toBe('SYNC_STATE_UNAVAILABLE');
    });

    it('returns 404 when cancelling nonexistent run', async () => {
      const req = new Request('http://localhost:3000/api/admin/sync-runs/999999/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf }
      });
      const res = await cancelPOST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: '999999' } as any,
        request: req
      } as any);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/admin/sync-runs/[id]/retry', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const req = new Request('http://localhost:3000/api/admin/sync-runs/1/retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf }
      });
      const res = await retryPOST({
        locals: {} as any,
        params: { id: '1' } as any,
        request: req
      } as any);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data).toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    });

    it('returns 404 when parent run does not exist', async () => {
      const req = new Request('http://localhost:3000/api/admin/sync-runs/999999/retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf }
      });
      const res = await retryPOST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: '999999' } as any,
        request: req
      } as any);
      expect(res.status).toBe(404);
    });

    it('rejects targetDate not in parent run with 400', async () => {
      const info = runtime.db
        .prepare(`INSERT INTO sync_runs (started_at, status, trigger, mode) VALUES ('2026-03-01T10:00:00.000Z', 'failed', 'manual', 'recent')`)
        .run();
      const runId = Number(info.lastInsertRowid);

      runtime.db
        .prepare(`INSERT INTO sync_days (sync_run_id, date, status, total_seconds, synced_at) VALUES (?, '2026-02-28', 'failed', 0, '2026-03-01T10:00:00.000Z')`)
        .run(runId);

      const req = new Request(`http://localhost:3000/api/admin/sync-runs/${runId}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({ targetDate: '2026-02-20' }) // not in parent
      });

      const res = await retryPOST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: String(runId) } as any,
        request: req
      } as any);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('TARGET_DATE_NOT_IN_RUN');
    });

    it('rejects caller-supplied idempotencyKey with 400 INVALID_REQUEST', async () => {
      const info = runtime.db
        .prepare(`INSERT INTO sync_runs (started_at, status, trigger, mode) VALUES ('2026-03-01T10:00:00.000Z', 'failed', 'manual', 'recent')`)
        .run();
      const runId = Number(info.lastInsertRowid);
      runtime.db
        .prepare(`INSERT INTO sync_days (sync_run_id, date, status, total_seconds, synced_at) VALUES (?, '2026-02-28', 'failed', 0, '2026-03-01T10:00:00.000Z')`)
        .run(runId);

      const req = new Request(`http://localhost:3000/api/admin/sync-runs/${runId}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({ targetDate: '2026-02-28', idempotencyKey: 'caller-key-1' })
      });

      const res = await retryPOST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: String(runId) } as any,
        request: req
      } as any);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('INVALID_REQUEST');
    });

    it('rejects retrying restricted date without post-reconnect authorization', async () => {
      const info = runtime.db
        .prepare(`INSERT INTO sync_runs (started_at, status, trigger, mode) VALUES ('2026-03-01T10:00:00.000Z', 'failed', 'manual', 'recent')`)
        .run();
      const runId = Number(info.lastInsertRowid);

      runtime.db
        .prepare(`INSERT INTO sync_days (sync_run_id, date, status, total_seconds, summaries_status, synced_at) VALUES (?, '2026-02-28', 'skipped', 0, 'restricted', '2026-03-01T10:00:00.000Z')`)
        .run(runId);

      const req = new Request(`http://localhost:3000/api/admin/sync-runs/${runId}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({ targetDate: '2026-02-28' })
      });

      const res = await retryPOST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: String(runId) } as any,
        request: req
      } as any);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.code).toBe('RECONNECT_REQUIRED');
    });

    it('enqueues retry run for failed dates with deterministic key and returns 202', async () => {
      const info = runtime.db
        .prepare(`INSERT INTO sync_runs (started_at, status, trigger, mode) VALUES ('2026-03-01T10:00:00.000Z', 'failed', 'manual', 'recent')`)
        .run();
      const runId = Number(info.lastInsertRowid);

      runtime.db
        .prepare(`INSERT INTO sync_days (sync_run_id, date, status, total_seconds, synced_at) VALUES (?, '2026-02-27', 'succeeded', 3600, '2026-03-01T10:00:00.000Z')`)
        .run(runId);
      runtime.db
        .prepare(`INSERT INTO sync_days (sync_run_id, date, status, total_seconds, synced_at) VALUES (?, '2026-02-28', 'failed', 0, '2026-03-01T10:00:00.000Z')`)
        .run(runId);

      let enqueuedReq: RunRequest | null = null;
      const mockService: SyncService = {
        enqueue: async (req: RunRequest) => {
          enqueuedReq = req;
          return { runId: 55, reused: false };
        },
        cancel: async () => 'cancelled' as RunStatus,
        start: async () => {},
        stop: async () => {}
      };
      const customRetry = createRetryHandler({ ...runtime, sync: mockService });

      const req = new Request(`http://localhost:3000/api/admin/sync-runs/${runId}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf }
      });

      const res = await customRetry({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: String(runId) } as any,
        request: req
      } as any);

      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.newRunId).toBe(55);
      expect(data.parentRunId).toBe(runId);
      expect(data.scheduledDates).toEqual(['2026-02-28']);
      expect(enqueuedReq!.resumedFromRunId).toBe(runId);
      expect(enqueuedReq!.mode).toBe('retry');
      expect(enqueuedReq!.idempotencyKey).toBe(`retry-${runId}-gen0-2026-02-28`);
    });

    it('handles duplicate concurrent retry and returns 200 with existing run', async () => {
      const info = runtime.db
        .prepare(`INSERT INTO sync_runs (started_at, status, trigger, mode) VALUES ('2026-03-01T10:00:00.000Z', 'failed', 'manual', 'recent')`)
        .run();
      const runId = Number(info.lastInsertRowid);

      runtime.db
        .prepare(`INSERT INTO sync_days (sync_run_id, date, status, total_seconds, synced_at) VALUES (?, '2026-02-28', 'failed', 0, '2026-03-01T10:00:00.000Z')`)
        .run(runId);

      const mockService: SyncService = {
        enqueue: async () => ({ runId: 55, reused: true }),
        cancel: async () => 'cancelled' as RunStatus,
        start: async () => {},
        stop: async () => {}
      };
      const customRetry = createRetryHandler({ ...runtime, sync: mockService });

      const req = new Request(`http://localhost:3000/api/admin/sync-runs/${runId}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({ targetDate: '2026-02-28' })
      });

      const res = await customRetry({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: String(runId) } as any,
        request: req
      } as any);

      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.newRunId).toBe(55);
    });

    it('enforces single retry for restricted date per reconnect generation', async () => {
      // Set up connection row indicating reconnect
      runtime.db.prepare(`
        INSERT OR REPLACE INTO wakatime_oauth_connection (
          id, access_token_sealed, refresh_token_sealed, token_type, scopes,
          expires_at, connected_at, updated_at, generation, bound_archive_identity, rebound_at
        ) VALUES (
          1, 'enc_a', 'enc_b', 'Bearer', '["read_logged_time"]',
          datetime('now', '+1 hour'), '2026-03-01T00:00:00.000Z', '2026-03-02T12:00:00.000Z', 2, 'test-user', '2026-03-02T12:00:00.000Z'
        )
      `).run();

      // Parent run started before reconnect
      const info = runtime.db
        .prepare(`INSERT INTO sync_runs (started_at, status, trigger, mode) VALUES ('2026-03-01T10:00:00.000Z', 'failed', 'manual', 'recent')`)
        .run();
      const parentRunId = Number(info.lastInsertRowid);

      runtime.db
        .prepare(`INSERT INTO sync_days (sync_run_id, date, status, total_seconds, summaries_status, synced_at) VALUES (?, '2026-02-28', 'skipped', 0, 'restricted', '2026-03-01T10:00:00.000Z')`)
        .run(parentRunId);

      const mockService: SyncService = {
        enqueue: async () => ({ runId: 88, reused: false }),
        cancel: async () => 'cancelled' as RunStatus,
        start: async () => {},
        stop: async () => {}
      };
      const customRetry = createRetryHandler({ ...runtime, sync: mockService });

      const req1 = new Request(`http://localhost:3000/api/admin/sync-runs/${parentRunId}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({ targetDate: '2026-02-28' })
      });

      const res1 = await customRetry({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: String(parentRunId) } as any,
        request: req1
      } as any);

      expect(res1.status).toBe(202);

      // Record child run in DB as started after rebound
      const childRunInfo = runtime.db
        .prepare(`INSERT INTO sync_runs (started_at, status, trigger, mode, resumed_from_run_id) VALUES ('2026-03-02T13:00:00.000Z', 'succeeded', 'manual', 'retry', ?)`)
        .run(parentRunId);
      const childRunId = Number(childRunInfo.lastInsertRowid);
      runtime.db
        .prepare(`INSERT INTO sync_days (sync_run_id, date, status, total_seconds, synced_at) VALUES (?, '2026-02-28', 'succeeded', 3600, '2026-03-02T13:00:00.000Z')`)
        .run(childRunId);

      // Attempting to retry same restricted date again under same generation fails with 409
      const req2 = new Request(`http://localhost:3000/api/admin/sync-runs/${parentRunId}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({ targetDate: '2026-02-28' })
      });

      const res2 = await customRetry({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: String(parentRunId) } as any,
        request: req2
      } as any);

      expect(res2.status).toBe(409);
      const data2 = await res2.json();
      expect(data2.code).toBe('ALREADY_RETRIED');
    });

    it('returns 503 when connection query fails in retry', async () => {
      const brokenDb = {
        prepare: () => {
          throw new Error('Database connection error');
        }
      } as any;
      const customRetry = createRetryHandler({ ...runtime, db: brokenDb });

      const req = new Request(`http://localhost:3000/api/admin/sync-runs/1/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({ targetDate: '2026-02-28' })
      });

      const res = await customRetry({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: '1' } as any,
        request: req
      } as any);

      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.code).toBe('SYNC_STATE_UNAVAILABLE');
    });
  });
});

