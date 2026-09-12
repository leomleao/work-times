import { describe, it, expect } from 'vitest';
import { POST, _createPostHandler as createPostHandler } from './refresh/+server.js';
import { runtime } from '$lib/server/runtime';
import { csrfTokenForSession } from '$lib/server/security/http';
import type { SyncService, RunRequest, RunStatus } from '$lib/server/sync/contracts';

describe('/api/admin/sync-registry/refresh route', () => {
  const adminPrincipal = { username: 'admin', sessionExpiresAt: '2099-01-01T00:00:00.000Z' };
  const validSessionToken = 'wts_session_test_token_12345';
  const publicUrl = runtime.config.publicUrl;
  const origin = publicUrl.origin;
  const validCsrf = csrfTokenForSession(validSessionToken, runtime.sessionSecret);

  it('returns 401 when unauthenticated', async () => {
    const req = new Request('http://localhost:3000/api/admin/sync-registry/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf }
    });
    const res = await POST({ locals: {} as any, request: req } as any);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data).toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
  });

  it('returns 403 on cross-origin request', async () => {
    const req = new Request('http://localhost:3000/api/admin/sync-registry/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.com', 'x-csrf-token': validCsrf }
    });
    const res = await POST({
      locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
      request: req
    } as any);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data).toEqual({ error: 'Forbidden', code: 'FORBIDDEN' });
  });

  it('deduplicates against active registry run and returns 200 with queued: false, status: retained', async () => {
    let enqueuedReq: RunRequest | null = null;
    const mockService: SyncService = {
      enqueue: async (req: RunRequest) => {
        enqueuedReq = req;
        return { runId: 101, reused: true };
      },
      cancel: async () => 'cancelled' as RunStatus,
      start: async () => {},
      stop: async () => {}
    };
    const customPost = createPostHandler({ ...runtime, sync: mockService });

    const req = new Request('http://localhost:3000/api/admin/sync-registry/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf }
    });

    const res = await customPost({
      locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
      request: req
    } as any);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.queued).toBe(false);
    expect(data.status).toBe('retained');
    expect(data).toHaveProperty('lastRefreshAt');
    expect(enqueuedReq!.mode).toBe('registry');
    expect(enqueuedReq!.idempotencyKey).toMatch(/^registry-refresh/);
  });

  it('enqueues registry run when not already running and returns 202 with queued: true, status: retained', async () => {
    let enqueuedReq: RunRequest | null = null;
    const mockService: SyncService = {
      enqueue: async (req: RunRequest) => {
        enqueuedReq = req;
        return { runId: 77, reused: false };
      },
      cancel: async () => 'cancelled' as RunStatus,
      start: async () => {},
      stop: async () => {}
    };
    const customPost = createPostHandler({ ...runtime, sync: mockService });

    const req = new Request('http://localhost:3000/api/admin/sync-registry/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf }
    });

    const res = await customPost({
      locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
      request: req
    } as any);

    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.queued).toBe(true);
    expect(data.status).toBe('retained');
    expect(enqueuedReq!.mode).toBe('registry');
    expect(enqueuedReq!.idempotencyKey).toMatch(/^registry-refresh/);
  });

  it('replays exact idempotency key if a registry run is active (running or queued)', async () => {
    runtime.db.exec(`
      INSERT INTO sync_runs (id, started_at, status, trigger, mode, idempotency_key, day_count, days_synced)
      VALUES (999, '2026-03-01T10:00:00.000Z', 'running', 'manual', 'registry', 'exact-active-key-999', 0, 0);
    `);

    let enqueuedReq: RunRequest | null = null;
    const mockService: SyncService = {
      enqueue: async (req: RunRequest) => {
        enqueuedReq = req;
        return { runId: 999, reused: true };
      },
      cancel: async () => 'cancelled' as RunStatus,
      start: async () => {},
      stop: async () => {}
    };
    const customPost = createPostHandler({ ...runtime, sync: mockService });

    const req = new Request('http://localhost:3000/api/admin/sync-registry/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf }
    });

    const res = await customPost({
      locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
      request: req
    } as any);

    expect(res.status).toBe(200);
    expect(enqueuedReq!.idempotencyKey).toBe('exact-active-key-999');

    // Clean up
    runtime.db.exec(`DELETE FROM sync_runs WHERE id = 999;`);
  });

  it('derives key from latest terminal registry run id and published refresh marker', async () => {
    runtime.db.exec(`
      INSERT INTO sync_runs (id, started_at, finished_at, status, trigger, mode, idempotency_key, day_count, days_synced)
      VALUES (888, '2026-03-01T10:00:00.000Z', '2026-03-01T10:01:00.000Z', 'failed', 'manual', 'registry', 'prior-failed-key', 0, 0);
      INSERT INTO user_agent_registry (id, editor, user_agent_value, os, refreshed_at)
      VALUES ('reg-test-1', 'vscode', 'v1', 'mac', '2026-03-01T09:30:00.000Z')
      ON CONFLICT(id) DO UPDATE SET refreshed_at = '2026-03-01T09:30:00.000Z';
    `);

    let enqueuedReq: RunRequest | null = null;
    const mockService: SyncService = {
      enqueue: async (req: RunRequest) => {
        enqueuedReq = req;
        return { runId: 889, reused: false };
      },
      cancel: async () => 'cancelled' as RunStatus,
      start: async () => {},
      stop: async () => {}
    };
    const customPost = createPostHandler({ ...runtime, sync: mockService });

    const req = new Request('http://localhost:3000/api/admin/sync-registry/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf }
    });

    const res = await customPost({
      locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
      request: req
    } as any);

    expect(res.status).toBe(202);
    expect(enqueuedReq!.idempotencyKey).toContain('registry-refresh-after-888-gen');
    expect(enqueuedReq!.idempotencyKey).toContain('2026-03-01T09:30:00.000Z');

    // Clean up
    runtime.db.exec(`DELETE FROM sync_runs WHERE id = 888; DELETE FROM user_agent_registry WHERE id = 'reg-test-1';`);
  });

  it('fails with 503 when prerequisite query fails', async () => {
    const brokenDb = {
      prepare: () => {
        throw new Error('DB connection failed');
      }
    } as any;
    const customPost = createPostHandler({ ...runtime, db: brokenDb });

    const req = new Request('http://localhost:3000/api/admin/sync-registry/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf }
    });

    const res = await customPost({
      locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
      request: req
    } as any);

    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.code).toBe('SYNC_STATE_UNAVAILABLE');
  });
});

