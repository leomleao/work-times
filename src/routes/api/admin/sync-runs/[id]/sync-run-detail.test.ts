import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GET } from './+server.js';
import { POST as cancelPOST } from './cancel/+server.js';
import { POST as retryPOST } from './retry/+server.js';
import { runtime } from '$lib/server/runtime';
import { csrfTokenForSession } from '$lib/server/security/http';
import { setSyncService, resetSyncService } from '$lib/server/admin/sync';
import type { SyncService, RunRequest, RunStatus } from '$lib/server/sync/contracts';

describe('/api/admin/sync-runs/[id] routes', () => {
  const adminPrincipal = { username: 'admin', sessionExpiresAt: '2099-01-01T00:00:00.000Z' };
  const validSessionToken = 'wts_session_test_token_12345';
  const publicUrl = runtime.config.publicUrl;
  const origin = publicUrl.origin;
  const validCsrf = csrfTokenForSession(validSessionToken, runtime.sessionSecret);

  beforeEach(() => {
    resetSyncService();
  });

  afterEach(() => {
    resetSyncService();
  });

  describe('GET /api/admin/sync-runs/[id]', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await GET({
        locals: {} as any,
        params: { id: '1' } as any,
        url: new URL('http://localhost:3000/api/admin/sync-runs/1')
      } as any);

      expect(res.status).toBe(401);
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
          return 'cancelled' as RunStatus;
        },
        start: async () => {},
        stop: async () => {}
      };
      setSyncService(mockService);

      const req = new Request(`http://localhost:3000/api/admin/sync-runs/${runId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf }
      });

      const res = await cancelPOST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        params: { id: String(runId) } as any,
        request: req
      } as any);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.runId).toBe(runId);
      expect(data.status).toBe('cancelled');
      expect(cancelledId).toBe(runId);
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
      expect((await res.json()).error).toContain('not part of parent sync run');
    });

    it('enqueues retry run for failed dates and returns 202', async () => {
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
      setSyncService(mockService);

      const req = new Request(`http://localhost:3000/api/admin/sync-runs/${runId}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf }
      });

      const res = await retryPOST({
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
    });
  });
});
