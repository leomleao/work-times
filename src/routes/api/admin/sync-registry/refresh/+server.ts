import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runtime } from '$lib/server/runtime';
import { validateAdminMutationAuth, AdminAuthError } from '$lib/server/auth/admin-auth';
import { getAdminSyncService, type AdminSyncRuntimeSurface } from '$lib/server/admin/sync';
import type { RefreshRegistryResponseBody, RunRequest, SyncService } from '$lib/server/sync/contracts';

export function _createPostHandler(runtimeSurface: AdminSyncRuntimeSurface): RequestHandler {
  return async ({ locals, request }) => {
    const rt = runtimeSurface;
    let body: Record<string, unknown> = {};
    try {
      const text = await request.text();
      if (text.trim().length > 0) {
        body = JSON.parse(text);
      }
    } catch {
      return json({ error: 'Malformed JSON payload', code: 'MALFORMED_JSON' }, { status: 400 });
    }

    const submittedCsrf =
      (typeof body.csrfToken === 'string' ? body.csrfToken : null) ??
      request.headers.get('x-csrf-token');

    try {
      validateAdminMutationAuth({
        locals,
        request,
        publicUrl: rt.config.publicUrl,
        sessionSecret: rt.sessionSecret,
        submittedCsrf
      });
    } catch (err) {
      if (err instanceof AdminAuthError) {
        return json(
          { error: err.status === 401 ? 'Unauthorized' : 'Forbidden', code: err.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' },
          { status: err.status }
        );
      }
      throw err;
    }

    const db = rt.db;

    let gen = 0;
    try {
      const conn = db
        .prepare(`SELECT generation FROM wakatime_oauth_connection WHERE id = 1`)
        .get() as { generation: number } | undefined;
      gen = conn?.generation ?? 0;
    } catch (err) {
      return json({ error: 'Sync state unavailable', code: 'SYNC_STATE_UNAVAILABLE' }, { status: 503 });
    }

    let lastRefreshAt: string | null = null;
    try {
      const lastRefreshRow = db
        .prepare(`SELECT MAX(refreshed_at) as last_refresh FROM user_agent_registry`)
        .get() as { last_refresh: string | null } | undefined;
      lastRefreshAt = lastRefreshRow?.last_refresh ?? null;
    } catch (err) {
      return json({ error: 'Sync state unavailable', code: 'SYNC_STATE_UNAVAILABLE' }, { status: 503 });
    }

    type LatestRunRow = { id: number; status: string; idempotency_key: string };
    let latestRegistryRun: LatestRunRow | undefined = undefined;
    try {
      latestRegistryRun = db
        .prepare(
          `SELECT id, status, idempotency_key FROM sync_runs WHERE mode = 'registry' ORDER BY id DESC LIMIT 1`
        )
        .get() as LatestRunRow | undefined;
    } catch (err) {
      return json({ error: 'Sync state unavailable', code: 'SYNC_STATE_UNAVAILABLE' }, { status: 503 });
    }

    let idempotencyKey: string;
    if (
      latestRegistryRun &&
      (latestRegistryRun.status === 'queued' || latestRegistryRun.status === 'running')
    ) {
      idempotencyKey = latestRegistryRun.idempotency_key;
    } else if (latestRegistryRun) {
      idempotencyKey = `registry-refresh-after-${latestRegistryRun.id}-gen${gen}-${lastRefreshAt || 'initial'}`;
    } else {
      idempotencyKey = `registry-refresh-initial-gen${gen}-${lastRefreshAt || 'none'}`;
    }

    const runRequest: RunRequest = {
      mode: 'registry',
      trigger: 'manual',
      idempotencyKey
    };

    const adminSync = getAdminSyncService(rt);
    try {
      const result = await adminSync.enqueue(runRequest);
      const response: RefreshRegistryResponseBody = {
        queued: !result.reused,
        status: 'retained',
        lastRefreshAt: lastRefreshAt ?? ''
      };
      return json(response, { status: result.reused ? 200 : 202 });
    } catch (err) {
      return json(
        { error: 'Failed to enqueue registry refresh', code: 'REGISTRY_REFRESH_FAILED' },
        { status: 500 }
      );
    }
  };
}

export const POST = _createPostHandler(runtime);
