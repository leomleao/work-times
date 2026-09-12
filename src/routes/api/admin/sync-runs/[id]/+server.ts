import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runtime } from '$lib/server/runtime';
import { getSyncRunDetail } from '$lib/server/admin/sync';

export const GET: RequestHandler = async ({ locals, params, url }) => {
  if (!locals.admin) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return json({ error: 'Invalid run ID: must be a positive integer' }, { status: 400 });
  }

  const pageParam = url.searchParams.get('page');
  const pageSizeParam = url.searchParams.get('pageSize');

  const page = pageParam ? Math.max(1, Number(pageParam) || 1) : 1;
  const pageSize = pageSizeParam ? Math.min(50, Math.max(1, Number(pageSizeParam) || 50)) : 50;

  const detail = getSyncRunDetail(runtime.db, id, { page, pageSize });
  if (!detail) {
    return json({ error: `Sync run ${id} not found` }, { status: 404 });
  }

  return json(detail);
};
