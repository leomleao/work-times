import type { PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { getSyncAdminData, type AdminSyncRuntimeSurface } from '$lib/server/admin/sync';

export function _createLoadHandler(runtimeSurface: AdminSyncRuntimeSurface): PageServerLoad {
  return async (event) => {
    try {
      const sync = getSyncAdminData(runtimeSurface.db, { config: runtimeSurface.config, runtime: runtimeSurface });
      return {
        sync,
        unavailable: false,
        csrfToken: event?.locals?.csrfToken ?? null
      };
    } catch (err) {
      return {
        sync: null,
        unavailable: true,
        code: 'SYNC_STATE_UNAVAILABLE',
        csrfToken: event?.locals?.csrfToken ?? null
      };
    }
  };
}

export const load: PageServerLoad = _createLoadHandler(runtime);
