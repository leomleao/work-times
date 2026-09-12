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

export interface SyncSettingsRouteDeps {
  runtime?: AdminSyncRuntimeSurface;
}

function getPersistedSettingsUpdatedAt(db: Database.Database): string {
  try {
    const row = db
      .prepare(
        `SELECT MAX(updated_at) as latest_updated FROM (
           SELECT updated_at FROM app_settings WHERE key = 'sync.scheduling_enabled'
           UNION
           SELECT rebound_at as updated_at FROM wakatime_oauth_connection WHERE id = 1
           UNION
           SELECT created_at as updated_at FROM wakatime_oauth_connection WHERE id = 1
         ) WHERE updated_at IS NOT NULL`
      )
      .get() as { latest_updated: string | null } | undefined;
    if (row?.latest_updated) return row.latest_updated;
  } catch {}
  return '';
}

export function _createGetHandler(deps?: SyncSettingsRouteDeps): RequestHandler {
  return async ({ locals }) => {
    if (!locals.admin) {
      return json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
    }

    const db = deps?.runtime?.db ?? runtime.db;
    const repo = new SqliteSyncRepository(db);
    const settings = repo.getSyncSettings();

    return json({
      schedulingEnabled: settings.schedulingEnabled,
      connectionGeneration: settings.connectionGeneration,
      boundArchiveIdentity: settings.boundArchiveIdentity,
      updatedAt: getPersistedSettingsUpdatedAt(db)
    });
  };
}

export const GET = _createGetHandler();

export function _createPostHandler(deps?: SyncSettingsRouteDeps): RequestHandler {
  return async ({ locals, request }) => {
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
        return json(
          { error: err.status === 401 ? 'Unauthorized' : 'Forbidden', code: err.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' },
          { status: err.status }
        );
      }
      throw err;
    }

    const db = deps?.runtime?.db ?? runtime.db;
    const repo = new SqliteSyncRepository(db);

    if (body.schedulingEnabled !== undefined) {
      if (typeof body.schedulingEnabled !== 'boolean') {
        return json({ error: 'schedulingEnabled must be a boolean', code: 'INVALID_SETTINGS' }, { status: 400 });
      }
      repo.updateSyncSettings({ schedulingEnabled: body.schedulingEnabled });
    }

    if (body.bindCurrentConnection === true) {
      const conn = db
        .prepare(`SELECT bound_archive_identity FROM wakatime_oauth_connection WHERE id = 1`)
        .get() as { bound_archive_identity: string | null } | undefined;

      if (!conn || !conn.bound_archive_identity) {
        return json(
          { error: 'Archive identity unavailable', code: 'ARCHIVE_IDENTITY_UNAVAILABLE' },
          { status: 400 }
        );
      }

      const oauthRepo = new SqliteWakaTimeOAuthConnectionRepository(db);
      try {
        oauthRepo.rebind(conn.bound_archive_identity);
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
      updatedAt: getPersistedSettingsUpdatedAt(db)
    };

    return json(response);
  };
}

export const POST = _createPostHandler();
