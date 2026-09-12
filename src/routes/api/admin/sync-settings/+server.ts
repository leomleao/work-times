import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type Database from 'better-sqlite3';
import { runtime } from '$lib/server/runtime';
import { validateAdminMutationAuth, AdminAuthError } from '$lib/server/auth/admin-auth';
import { SqliteSyncRepository } from '$lib/server/db/repositories/sync';
import { SqliteWakaTimeOAuthConnectionRepository } from '$lib/server/db/repositories/wakatime-oauth';
import type {
  UpdateSyncSettingsRequestBody,
  UpdateSyncSettingsResponseBody
} from '$lib/server/sync/contracts';
import type { AdminSyncRuntimeSurface } from '$lib/server/admin/sync';

function getPersistedSettingsUpdatedAt(db: Database.Database): string {
  const row = db
    .prepare(
      `SELECT MAX(updated_at) as latest_updated FROM (
         SELECT updated_at FROM app_settings WHERE key = 'sync.scheduling_enabled'
         UNION
         SELECT rebound_at as updated_at FROM wakatime_oauth_connection WHERE id = 1
         UNION
         SELECT updated_at FROM wakatime_oauth_connection WHERE id = 1
         UNION
         SELECT connected_at as updated_at FROM wakatime_oauth_connection WHERE id = 1
       ) WHERE updated_at IS NOT NULL`
    )
    .get() as { latest_updated: string | null } | undefined;
  return row?.latest_updated ?? '';
}

export function _createGetHandler(runtimeSurface: AdminSyncRuntimeSurface): RequestHandler {
  return async ({ locals }) => {
    if (!locals.admin) {
      return json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
    }

    const rt = runtimeSurface;
    const db = rt.db;
    try {
      const repo = new SqliteSyncRepository(db);
      const settings = repo.getSyncSettings();

      return json({
        schedulingEnabled: settings.schedulingEnabled,
        connectionGeneration: settings.connectionGeneration,
        boundArchiveIdentity: settings.boundArchiveIdentity,
        updatedAt: getPersistedSettingsUpdatedAt(db)
      });
    } catch (err) {
      return json({ error: 'Sync state unavailable', code: 'SYNC_STATE_UNAVAILABLE' }, { status: 503 });
    }
  };
}

export const GET = _createGetHandler(runtime);

export function _createPostHandler(runtimeSurface: AdminSyncRuntimeSurface): RequestHandler {
  return async ({ locals, request }) => {
    const rt = runtimeSurface;
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

    // Validate all prerequisites before any mutation
    if (body.schedulingEnabled !== undefined && typeof body.schedulingEnabled !== 'boolean') {
      return json({ error: 'schedulingEnabled must be a boolean', code: 'INVALID_SETTINGS' }, { status: 400 });
    }

    let conn: { bound_archive_identity: string | null } | undefined;
    if (body.bindCurrentConnection === true) {
      try {
        conn = db
          .prepare(`SELECT bound_archive_identity FROM wakatime_oauth_connection WHERE id = 1`)
          .get() as { bound_archive_identity: string | null } | undefined;
      } catch (err) {
        return json({ error: 'Sync state unavailable', code: 'SYNC_STATE_UNAVAILABLE' }, { status: 503 });
      }

      if (!conn || !conn.bound_archive_identity || conn.bound_archive_identity.trim().length === 0) {
        return json(
          { error: 'Archive identity unavailable', code: 'ARCHIVE_IDENTITY_UNAVAILABLE' },
          { status: 400 }
        );
      }
    }

    // Now execute mutations
    const repo = new SqliteSyncRepository(db);

    if (body.schedulingEnabled !== undefined) {
      try {
        repo.updateSyncSettings({ schedulingEnabled: body.schedulingEnabled });
      } catch (err) {
        return json({ error: 'Sync state unavailable', code: 'SYNC_STATE_UNAVAILABLE' }, { status: 503 });
      }
    }

    if (body.bindCurrentConnection === true) {
      const oauthRepo = new SqliteWakaTimeOAuthConnectionRepository(db);
      try {
        oauthRepo.rebind(conn!.bound_archive_identity!);
      } catch {
        return json(
          { error: 'Failed to rebind connection', code: 'REBIND_FAILED' },
          { status: 500 }
        );
      }
    }

    try {
      const updated = repo.getSyncSettings();
      const response: UpdateSyncSettingsResponseBody = {
        schedulingEnabled: updated.schedulingEnabled,
        connectionGeneration: updated.connectionGeneration,
        boundArchiveIdentity: updated.boundArchiveIdentity,
        updatedAt: getPersistedSettingsUpdatedAt(db)
      };

      return json(response);
    } catch (err) {
      return json({ error: 'Sync state unavailable', code: 'SYNC_STATE_UNAVAILABLE' }, { status: 503 });
    }
  };
}

export const POST = _createPostHandler(runtime);
