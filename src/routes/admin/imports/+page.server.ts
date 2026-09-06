import type { PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { getImportsData } from '$lib/server/admin/imports';

export const load: PageServerLoad = async () => {
  const imports = getImportsData(runtime.db);
  return {
    imports
  };
};
