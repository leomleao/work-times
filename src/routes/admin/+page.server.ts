import type { PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { getOverviewData } from '$lib/server/admin/overview';

export const load: PageServerLoad = async () => {
  const overview = getOverviewData(runtime.db, runtime.classification);
  return {
    overview
  };
};
