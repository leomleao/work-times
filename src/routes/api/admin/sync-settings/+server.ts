import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runtime } from '$lib/server/runtime';
import { validateAdminMutationAuth, AdminAuthError } from '$lib/server/auth/admin-auth';
import { SqliteSyncRepository } from '$lib/server/db/repositories/sync';
import { SqliteWakaTimeOAuthConnectionRepository } from '$lib/server/db/repositories/wakatime-oauth';
import type {
  UpdateSyncSettingsRequestBody,
  UpdateSyncSettingsResponseBody
} from '$lib/server/sync/contracts';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.admin) {
    return json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
  }

  const repo = new SqliteSyncRepository(runtime.db);
  const settings = repo.getSyncSettings();

  const appSettingRow = runtime.db
    .prepare(`SELECT updated_at FROM app_settings WHERE key = 'sync.scheduling_enabled'`)
    .get() as { updated_at: string } | undefined;

  return json({
    schedulingEnabled: settings.schedulingEnabled,
    connectionGeneration: settings.connectionGeneration,
    boundArchiveIdentity: settings.boundArchiveIdentity,
    updatedAt: appSettingRow?.updated_at ?? new Date().toISOString()
  });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  let body: UpdateSyncSettingsRequestBody & { csrfToken?: string } = {};
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

  const repo = new SqliteSyncRepository(runtime.db);

  if (body.schedulingEnabled !== undefined) {
    if (typeof body.schedulingEnabled !== 'boolean') {
      return json({ error: 'schedulingEnabled must be a boolean', code: 'INVALID_SETTINGS' }, { status: 400 });
    }
    repo.updateSyncSettings({ schedulingEnabled: body.schedulingEnabled });
  }

  if (body.bindCurrentConnection === true) {
    const conn = runtime.db
      .prepare(`SELECT bound_archive_identity FROM wakatime_oauth_connection WHERE id = 1`)
      .get() as { bound_archive_identity: string | null } | undefined;

    if (!conn) {
      return json(
        { error: 'Cannot bind: no active WakaTime OAuth connection found', code: 'NO_ACTIVE_CONNECTION' },
        { status: 400 }
      );
    }

    const oauthRepo = new SqliteWakaTimeOAuthConnectionRepository(runtime.db);
    try {
      oauthRepo.rebind(conn.bound_archive_identity ?? 'default');
    } catch {
      return json(
        { error: 'Failed to rebind connection', code: 'REBIND_FAILED' },
        { status: 500 }
      );
    }
  }

  const updated = repo.getSyncSettings();
  const response: UpdateSyncSettingsResponseBody = {
    schedulingEnabled: updated.schedulingEnabled,
    connectionGeneration: updated.connectionGeneration,
    boundArchiveIdentity: updated.boundArchiveIdentity,
    updatedAt: new Date().toISOString()
  };

  return json(response);
};
