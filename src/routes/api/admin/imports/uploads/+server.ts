import { json, type RequestHandler } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';
import { verifyCsrfToken } from '$lib/server/security/http';
import { HeartbeatConflictError } from '$lib/server/import/importer';
import { DumpTooLargeError, DumpValidationError } from '$lib/server/import/parse';
import { StagedUploadError, StagedUploadManager, type UploadKind } from '$lib/server/import/staged-upload';

const uploads = new StagedUploadManager(runtime.db, runtime.config.maxDirectImportBytes);
const noStore = { 'Cache-Control': 'no-store' };

function authorize(locals: App.Locals, request: Request): string | Response {
  if (!locals.admin || !locals.sessionToken) {
    return json({ error: 'Administrator sign-in required.' }, { status: 401, headers: noStore });
  }
  if (!verifyCsrfToken(request.headers.get('x-csrf-token'), locals.sessionToken, runtime.sessionSecret)) {
    return json({ error: 'Invalid or missing CSRF token.' }, { status: 403, headers: noStore });
  }
  return locals.sessionToken;
}

function errorResponse(error: unknown): Response {
  if (error instanceof StagedUploadError || error instanceof DumpTooLargeError) {
    return json({ error: error.message }, {
      status: error instanceof StagedUploadError ? error.status : 413,
      headers: noStore
    });
  }
  if (error instanceof HeartbeatConflictError) {
    return json({ error: 'Conflicting heartbeats were found. Nothing was imported.' }, { status: 422, headers: noStore });
  }
  if (error instanceof DumpValidationError) {
    return json({ error: 'These are not matching WakaTime daily and heartbeat exports. Nothing was imported.' }, {
      status: 422,
      headers: noStore
    });
  }
  console.error('[staged-import] failed', error instanceof Error ? error.name : 'unknown');
  return json({ error: 'The upload failed. Nothing was imported; check the server logs.' }, {
    status: 500,
    headers: noStore
  });
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const owner = authorize(locals, request);
  if (owner instanceof Response) return owner;
  const length = request.headers.get('content-length');
  if (length !== null && Number(length) > 4096) {
    return json({ error: 'Upload request is too large.' }, { status: 413, headers: noStore });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid upload request.' }, { status: 400, headers: noStore });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid upload request.' }, { status: 400, headers: noStore });
  }

  try {
    if (body.action === 'start') {
      const started = await uploads.start(owner, body.dailySize as number, body.heartbeatSize as number);
      return json(started, { headers: noStore });
    }
    if (body.action === 'finish' && typeof body.id === 'string' &&
      (body.mode === 'validate' || body.mode === 'import')) {
      const report = await uploads.finish(owner, body.id, body.mode === 'validate');
      return json({
        upload: {
          dryRun: body.mode === 'validate',
          alreadyImported: report.alreadyImported,
          rangeStartDate: report.rangeStartDate,
          rangeEndDate: report.rangeEndDate,
          dayCount: report.dayCount,
          heartbeatCount: report.heartbeatCount,
          warningCount: report.warnings.length
        }
      }, { headers: noStore });
    }
    return json({ error: 'Invalid upload request.' }, { status: 400, headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
};

export const PUT: RequestHandler = async ({ locals, request, url }) => {
  const owner = authorize(locals, request);
  if (owner instanceof Response) return owner;
  const id = url.searchParams.get('id');
  const kind = url.searchParams.get('kind');
  const offsetText = url.searchParams.get('offset');
  if (!id || (kind !== 'daily' && kind !== 'heartbeats') || !offsetText || !/^(0|[1-9]\d*)$/.test(offsetText)) {
    return json({ error: 'Invalid upload chunk request.' }, { status: 400, headers: noStore });
  }
  const lengthText = request.headers.get('content-length');
  const length = lengthText === null ? null : Number(lengthText);

  try {
    const progress = await uploads.append(
      owner,
      id,
      kind as UploadKind,
      Number(offsetText),
      request.body,
      length
    );
    return json(progress, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
};

export const DELETE: RequestHandler = async ({ locals, request, url }) => {
  const owner = authorize(locals, request);
  if (owner instanceof Response) return owner;
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'Missing upload session.' }, { status: 400, headers: noStore });
  try {
    await uploads.cancel(owner, id);
    return new Response(null, { status: 204, headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
};
