import { describe, it, expect } from 'vitest';
import { GET, POST } from './+server.js';
import { runtime } from '$lib/server/runtime';
import { csrfTokenForSession } from '$lib/server/security/http';

describe('/api/admin/sync-settings route', () => {
  const adminPrincipal = { username: 'admin', sessionExpiresAt: '2099-01-01T00:00:00.000Z' };
  const validSessionToken = 'wts_session_test_token_12345';
  const publicUrl = runtime.config.publicUrl;
  const origin = publicUrl.origin;
  const validCsrf = csrfTokenForSession(validSessionToken, runtime.sessionSecret);

  describe('GET', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await GET({ locals: {} as any } as any);
      expect(res.status).toBe(401);
    });

    it('returns 200 with current settings when authenticated', async () => {
      const res = await GET({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any
      } as any);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('schedulingEnabled');
      expect(data).toHaveProperty('connectionGeneration');
      expect(data).toHaveProperty('boundArchiveIdentity');
      expect(data).toHaveProperty('updatedAt');
    });
  });

  describe('POST', () => {
    it('returns 401 when unauthenticated', async () => {
      const req = new Request('http://localhost:3000/api/admin/sync-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({ schedulingEnabled: false })
      });
      const res = await POST({ locals: {} as any, request: req } as any);
      expect(res.status).toBe(401);
    });

    it('returns 403 on cross-origin request', async () => {
      const req = new Request('http://localhost:3000/api/admin/sync-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://bad-origin.com', 'x-csrf-token': validCsrf },
        body: JSON.stringify({ schedulingEnabled: false })
      });
      const res = await POST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: req
      } as any);
      expect(res.status).toBe(403);
    });

    it('updates schedulingEnabled and returns 200', async () => {
      const req = new Request('http://localhost:3000/api/admin/sync-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({ schedulingEnabled: true })
      });
      const res = await POST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: req
      } as any);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.schedulingEnabled).toBe(true);

      // Turn it off again
      const reqOff = new Request('http://localhost:3000/api/admin/sync-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({ schedulingEnabled: false })
      });
      const resOff = await POST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: reqOff
      } as any);

      expect(resOff.status).toBe(200);
      const dataOff = await resOff.json();
      expect(dataOff.schedulingEnabled).toBe(false);
    });

    it('rebinds connection when bindCurrentConnection is true', async () => {
      // Ensure connection row exists
      runtime.db
        .prepare(`
          INSERT INTO wakatime_oauth_connection (id, access_token_sealed, refresh_token_sealed, token_type, scopes, generation, bound_archive_identity, connected_at, updated_at)
          VALUES (1, 'sealed', 'refresh', 'Bearer', '["email"]', 1, 'user_test', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')
          ON CONFLICT(id) DO UPDATE SET generation = 1, bound_archive_identity = 'user_test'
        `)
        .run();

      const req = new Request('http://localhost:3000/api/admin/sync-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-csrf-token': validCsrf },
        body: JSON.stringify({ bindCurrentConnection: true })
      });

      const res = await POST({
        locals: { admin: adminPrincipal, sessionToken: validSessionToken } as any,
        request: req
      } as any);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.connectionGeneration).toBe(2);
      expect(data.boundArchiveIdentity).toBe('user_test');
    });
  });
});
