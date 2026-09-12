import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runtime } from '$lib/server/runtime';
import { validateAdminMutationAuth, AdminAuthError } from '$lib/server/auth/admin-auth';
import { getAdminSyncService } from '$lib/server/admin/sync';
import type { RefreshRegistryResponseBody, RunRequest } from '$lib/server/sync/contracts';

export const POST: RequestHandler = async ({ locals, request }) => {
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

  const lastRefreshRow = runtime.db
    .prepare(`SELECT MAX(refreshed_at) as last_refresh FROM user_agent_registry`)
    .get() as { last_refresh: string | null } | undefined;
  const lastRefreshAt = lastRefreshRow?.last_refresh ?? new Date().toISOString();

  // Deduplicate against currently running or queued registry refreshes
  const activeRegistryRun = runtime.db
    .prepare(
      `SELECT id, status FROM sync_runs WHERE mode = 'registry' AND status IN ('queued', 'running') LIMIT 1`
    )
    .get() as { id: number; status: string } | undefined;

  if (activeRegistryRun) {
    const response: RefreshRegistryResponseBody = {
      queued: false,
      status: 'published',
      lastRefreshAt
    };
    return json(response, { status: 200 });
  }

  const adminSync = getAdminSyncService();
  const runRequest: RunRequest = {
    mode: 'registry',
    trigger: 'manual',
    idempotencyKey: `registry-refresh-${Date.now()}`
  };

  try {
    await adminSync.enqueue(runRequest);
    const response: RefreshRegistryResponseBody = {
      queued: true,
      status: 'published',
      lastRefreshAt
    };
    return json(response, { status: 202 });
  } catch (err) {
    return json(
      { error: 'Failed to enqueue registry refresh', code: 'REGISTRY_REFRESH_FAILED' },
      { status: 500 }
    );
  }
};
