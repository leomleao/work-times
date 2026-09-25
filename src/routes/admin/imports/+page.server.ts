import type { PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { getImportsData } from '$lib/server/admin/imports';

export const load: PageServerLoad = async (event) => ({
  imports: getImportsData(runtime.db),
  csrfToken: event?.locals?.csrfToken ?? null,
  maxImportBytes: runtime.config.maxDirectImportBytes,
  maxImportMiB: Math.floor(runtime.config.maxDirectImportBytes / (1024 * 1024))
});
