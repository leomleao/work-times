import type { PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { getSyncData } from '$lib/server/admin/sync';

export const load: PageServerLoad = async () => {
  const sync = getSyncData(runtime.db, runtime.config);
  return {
    sync
  };
};
