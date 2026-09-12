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
    const customPost = createPostHandler({ sync: mockService });

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
    expect(enqueuedReq!.idempotencyKey).toMatch(/^registry-refresh-gen/);
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
    const customPost = createPostHandler({ sync: mockService });

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
    expect(enqueuedReq!.idempotencyKey).toMatch(/^registry-refresh-gen/);
  });
});

