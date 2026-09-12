import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runtime } from '$lib/server/runtime';
import { validateAdminMutationAuth, AdminAuthError } from '$lib/server/auth/admin-auth';
import { getAdminSyncService, type AdminSyncRuntimeSurface } from '$lib/server/admin/sync';
import type { CancelSyncRunResponseBody, SyncService } from '$lib/server/sync/contracts';

export function _createPostHandler(runtimeSurface: AdminSyncRuntimeSurface): RequestHandler {
  return async ({ locals, params, request }) => {
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

    const id = Number(params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return json({ error: 'Invalid run ID: must be a positive integer', code: 'INVALID_RUN_ID' }, { status: 400 });
    }

    const db = rt.db;

    let existing: { id: number; status: string } | undefined;
    try {
      existing = db
        .prepare(`SELECT id, status FROM sync_runs WHERE id = ?`)
        .get(id) as { id: number; status: string } | undefined;
    } catch (err) {
      return json({ error: 'Sync state unavailable', code: 'SYNC_STATE_UNAVAILABLE' }, { status: 503 });
    }

    if (!existing) {
      return json({ error: 'Sync run not found', code: 'NOT_FOUND' }, { status: 404 });
    }

    const adminSync = getAdminSyncService(rt);
    try {
      const status = await adminSync.cancel(id);
      let runAfter: { finished_at: string | null; cancel_requested_at: string | null } | undefined;
      try {
        runAfter = db
          .prepare(`SELECT finished_at, cancel_requested_at FROM sync_runs WHERE id = ?`)
          .get(id) as { finished_at: string | null; cancel_requested_at: string | null } | undefined;
      } catch (err) {
        return json({ error: 'Sync state unavailable', code: 'SYNC_STATE_UNAVAILABLE' }, { status: 503 });
      }

      const cancelledAt = runAfter?.cancel_requested_at ?? runAfter?.finished_at ?? null;
      if (!cancelledAt) {
        return json({ error: 'Sync state unavailable', code: 'SYNC_STATE_UNAVAILABLE' }, { status: 503 });
      }

      const response: CancelSyncRunResponseBody = {
        runId: id,
        status,
        cancelledAt
      };
      return json(response);
    } catch (err) {
      return json(
        { error: 'Failed to cancel sync run', code: 'CANCEL_FAILED' },
        { status: 500 }
      );
    }
  };
}

export const POST = _createPostHandler(runtime);
