import type { PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { getSyncAdminData } from '$lib/server/admin/sync';

export const load: PageServerLoad = async (event) => {
  const sync = getSyncAdminData(runtime.db, { config: runtime.config });
  return {
    sync,
    csrfToken: event?.locals?.csrfToken ?? null
  };
};
