import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runtime } from '$lib/server/runtime';
import { getSyncRunDetail, type AdminSyncRuntimeSurface } from '$lib/server/admin/sync';

export interface SyncRunDetailRouteDeps {
  runtime?: AdminSyncRuntimeSurface;
}

export function _createGetHandler(deps?: SyncRunDetailRouteDeps): RequestHandler {
  return async ({ locals, params, url }) => {
    if (!locals.admin) {
      return json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
    }

    const id = Number(params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return json({ error: 'Invalid run ID: must be a positive integer', code: 'INVALID_RUN_ID' }, { status: 400 });
    }

    const pageParam = url.searchParams.get('page');
    const pageSizeParam = url.searchParams.get('pageSize');

    const page = pageParam ? Math.max(1, Number(pageParam) || 1) : 1;
    const pageSize = pageSizeParam ? Math.min(50, Math.max(1, Number(pageSizeParam) || 50)) : 50;

    const db = deps?.runtime?.db ?? runtime.db;
    const detail = getSyncRunDetail(db, id, { page, pageSize });
    if (!detail) {
      return json({ error: `Sync run ${id} not found`, code: 'NOT_FOUND' }, { status: 404 });
    }

    return json(detail);
  };
}

export const GET = _createGetHandler();
