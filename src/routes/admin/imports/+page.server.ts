import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { getImportsData } from '$lib/server/admin/imports';
import { verifyCsrfToken } from '$lib/server/security/http';
import { HeartbeatConflictError } from '$lib/server/import/importer';
import { DumpTooLargeError, DumpValidationError } from '$lib/server/import/parse';
import { importUploadedDumps, UploadValidationError } from '$lib/server/import/upload';

export const load: PageServerLoad = async (event) => {
  const imports = getImportsData(runtime.db);
  return {
    imports,
    csrfToken: event?.locals?.csrfToken ?? null,
    maxImportMiB: Math.floor(runtime.config.maxDirectImportBytes / (1024 * 1024))
  };
};

export const actions: Actions = {
  upload: async ({ locals, request }) => {
    if (!locals.admin || !locals.sessionToken) {
      return fail(401, { error: 'Administrator sign-in required.' });
    }

    const contentLength = Number(request.headers.get('content-length'));
    const maxRequestBytes = runtime.config.maxDirectImportBytes * 2 + 1024 * 1024;
    if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
      return fail(413, { error: 'The combined upload exceeds the configured size limit.' });
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return fail(400, { error: 'Could not read the upload. Select both JSON files and try again.' });
    }

    const submittedCsrf = formData.get('csrfToken');
    if (!verifyCsrfToken(
      typeof submittedCsrf === 'string' ? submittedCsrf : null,
      locals.sessionToken,
      runtime.sessionSecret
    )) {
      return fail(403, { error: 'Invalid or missing CSRF token.' });
    }

    const daily = formData.get('daily');
    const heartbeats = formData.get('heartbeats');
    if (!(daily instanceof File) || !(heartbeats instanceof File)) {
      return fail(400, { error: 'Select both the daily and heartbeat WakaTime JSON files.' });
    }

    const mode = formData.get('mode');
    if (mode !== 'validate' && mode !== 'import') {
      return fail(400, { error: 'Choose Validate or Import.' });
    }

    try {
      const report = await importUploadedDumps(runtime.db, daily, heartbeats, {
        maxBytes: runtime.config.maxDirectImportBytes,
        dryRun: mode === 'validate'
      });
      return {
        upload: {
          dryRun: mode === 'validate',
          alreadyImported: report.alreadyImported,
          rangeStartDate: report.rangeStartDate,
          rangeEndDate: report.rangeEndDate,
          dayCount: report.dayCount,
          heartbeatCount: report.heartbeatCount,
          warningCount: report.warnings.length
        }
      };
    } catch (error) {
      if (error instanceof UploadValidationError) {
        return fail(error.status, { error: error.message });
      }
      if (error instanceof DumpTooLargeError) {
        return fail(413, { error: error.message });
      }
      if (error instanceof HeartbeatConflictError) {
        return fail(422, { error: 'Conflicting heartbeats were found. Nothing was imported.' });
      }
      if (error instanceof DumpValidationError) {
        return fail(422, { error: 'These are not matching WakaTime daily and heartbeat exports. Nothing was imported.' });
      }
      console.error('[import-upload] failed', error instanceof Error ? error.name : 'unknown');
      return fail(500, { error: 'The import failed. Nothing was imported; check the server logs.' });
    }
  }
};
