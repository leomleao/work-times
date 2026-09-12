import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runtime } from '$lib/server/runtime';
import { validateAdminMutationAuth, AdminAuthError } from '$lib/server/auth/admin-auth';
import { getAdminSyncService, type AdminSyncRuntimeSurface } from '$lib/server/admin/sync';
import type { RefreshRegistryResponseBody, RunRequest, SyncService } from '$lib/server/sync/contracts';

export interface SyncRegistryRefreshRouteDeps {
  runtime?: AdminSyncRuntimeSurface;
  sync?: SyncService;
}

export function _createPostHandler(deps?: SyncRegistryRefreshRouteDeps): RequestHandler {
  return async ({ locals, request }) => {
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
        publicUrl: runtime.config.publicUrl,
        sessionSecret: runtime.sessionSecret,
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

    const rt = deps?.runtime ?? (deps?.sync ? { ...(runtime as unknown as AdminSyncRuntimeSurface), sync: deps.sync } : undefined);
    const db = rt?.db ?? runtime.db;

    let gen = 0;
    try {
      const conn = db
        .prepare(`SELECT generation FROM wakatime_oauth_connection WHERE id = 1`)
        .get() as { generation: number } | undefined;
      gen = conn?.generation ?? 0;
    } catch {}

    let lastRefreshAt = '';
    try {
      const lastRefreshRow = db
        .prepare(`SELECT MAX(refreshed_at) as last_refresh FROM user_agent_registry`)
        .get() as { last_refresh: string | null } | undefined;
      lastRefreshAt = lastRefreshRow?.last_refresh ?? '';
    } catch {}

    const idempotencyKey = `registry-refresh-gen${gen}-${lastRefreshAt || 'initial'}`;
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
        lastRefreshAt
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

export const POST = _createPostHandler();
