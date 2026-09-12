import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runtime } from '$lib/server/runtime';
import { validateAdminMutationAuth, AdminAuthError } from '$lib/server/auth/admin-auth';
import { getAdminSyncService } from '$lib/server/admin/sync';
import type { CancelSyncRunResponseBody } from '$lib/server/sync/contracts';

export const POST: RequestHandler = async ({ locals, params, request }) => {
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
      return json({ error: err.message, code: err.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' }, { status: err.status });
    }
    throw err;
  }

  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return json({ error: 'Invalid run ID: must be a positive integer', code: 'INVALID_RUN_ID' }, { status: 400 });
  }

  const existing = runtime.db
    .prepare(`SELECT id, status FROM sync_runs WHERE id = ?`)
    .get(id) as { id: number; status: string } | undefined;

  if (!existing) {
    return json({ error: `Sync run ${id} not found`, code: 'NOT_FOUND' }, { status: 404 });
  }

  const adminSync = getAdminSyncService();
  try {
    const status = await adminSync.cancel(id);
    const response: CancelSyncRunResponseBody = {
      runId: id,
      status,
      cancelledAt: new Date().toISOString()
    };
    return json(response);
  } catch (err) {
    return json(
      { error: 'Failed to cancel sync run', code: 'CANCEL_FAILED' },
      { status: 500 }
    );
  }
};
