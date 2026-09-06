import type { PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { getSettingsData } from '$lib/server/admin/settings';

export const load: PageServerLoad = async () => {
  const settings = getSettingsData(runtime.db, runtime.config);
  return {
    settings
  };
};
