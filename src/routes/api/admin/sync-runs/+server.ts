import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runtime } from '$lib/server/runtime';
import { validateAdminMutationAuth, AdminAuthError } from '$lib/server/auth/admin-auth';
import {
  getAdminSyncService,
  getVerifiedSourceTimezone,
  type AdminSyncRuntimeSurface,
  type AdminSyncRunsCollectionDto
} from '$lib/server/admin/sync';
import {
  MAX_BACKFILL_RANGE_DAYS,
  type RunRequest,
  type RunRequestMode,
  type SyncService
} from '$lib/server/sync/contracts';
import {
  IdempotencyConflictError,
  QueueFullError
} from '$lib/server/db/repositories/sync';
import {
  isValidDateString,
  differenceInDays,
  getZonedDateString,
  getRecentIntentDates
} from '$lib/server/sync/calendar';

export function _createGetHandler(runtimeSurface: AdminSyncRuntimeSurface): RequestHandler {
  return async ({ locals, url }) => {
    if (!locals.admin) {
      return json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
    }

    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Math.min(50, Math.max(1, Number(limitParam) || 50)) : 50;

    const rt = runtimeSurface;
    try {
      const adminSync = getAdminSyncService(rt);
      const collection: AdminSyncRunsCollectionDto = adminSync.getRunsCollection({ limit });
      return json(collection);
    } catch (err) {
      return json({ error: 'Sync state unavailable', code: 'SYNC_STATE_UNAVAILABLE' }, { status: 503 });
    }
  };
}

export function _createPostHandler(runtimeSurface: AdminSyncRuntimeSurface): RequestHandler {
  return async ({ locals, request }) => {
    const rt = runtimeSurface;
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Malformed JSON payload', code: 'MALFORMED_JSON' }, { status: 400 });
    }

    const submittedCsrf =
      (typeof body.csrfToken === 'string' ? body.csrfToken : null) ??
      request.headers.get('x-csrf-token');

    try {
      validateAdminMutationAuth({
        locals,
        request,
        publicUrl: rt.config.publicUrl,
        sessionSecret: rt.sessionSecret,
        submittedCsrf
      });
    } catch (err) {
      if (err instanceof AdminAuthError) {
        return json(
          { error: err.status === 401 ? 'Unauthorized' : 'Forbidden', code: err.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' },
          { status: err.status }
        );
      }
      throw err;
    }

    const rawMode = typeof body.mode === 'string' ? body.mode.trim() : 'recent';

    // Exclude registry and retry from general manual modes
    if (rawMode === 'registry') {
      return json(
        { error: 'Registry refresh must be initiated via /api/admin/sync-registry/refresh', code: 'INVALID_MODE' },
        { status: 400 }
      );
    }
    if (rawMode === 'retry') {
      return json(
        { error: 'Retry must be initiated via /api/admin/sync-runs/:id/retry', code: 'INVALID_MODE' },
        { status: 400 }
      );
    }
    if (rawMode !== 'recent' && rawMode !== 'backfill' && rawMode !== 'compare') {
      return json(
        { error: 'Invalid mode. Allowed manual modes: recent, backfill, compare', code: 'INVALID_MODE' },
        { status: 400 }
      );
    }
    const mode = rawMode as RunRequestMode;

    // Reject arbitrary caller retry lists
    if (body.retryDates !== undefined) {
      return json(
        { error: 'Arbitrary caller retry lists are rejected', code: 'RETRY_LIST_REJECTED' },
        { status: 400 }
      );
    }

    const idempotencyKey =
      typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
    if (!idempotencyKey || idempotencyKey.length > 128) {
      return json(
        { error: 'A valid idempotencyKey (1-128 characters) is required', code: 'INVALID_IDEMPOTENCY_KEY' },
        { status: 400 }
      );
    }

    // Capture "now" once per request
    const now = new Date();
    const db = rt.db;

    let sourceTimezone: string | null = null;
    try {
      sourceTimezone = getVerifiedSourceTimezone(db);
    } catch (err) {
      return json({ error: 'Sync state unavailable', code: 'SYNC_STATE_UNAVAILABLE' }, { status: 503 });
    }
    if (!sourceTimezone) {
      return json(
        { error: 'Verified source timezone unavailable', code: 'TIMEZONE_UNAVAILABLE' },
        { status: 422 }
      );
    }

    const todayStr = getZonedDateString(sourceTimezone, now);

    let rangeStartDate: string | undefined = undefined;
    let rangeEndDate: string | undefined = undefined;

    if (mode === 'backfill' || mode === 'compare') {
      if (
        typeof body.rangeStartDate !== 'string' ||
        typeof body.rangeEndDate !== 'string'
      ) {
        return json(
          { error: 'Both rangeStartDate and rangeEndDate are required', code: 'MISSING_DATE_RANGE' },
          { status: 400 }
        );
      }
      rangeStartDate = body.rangeStartDate.trim();
      rangeEndDate = body.rangeEndDate.trim();

      if (!isValidDateString(rangeStartDate) || !isValidDateString(rangeEndDate)) {
        return json(
          { error: 'rangeStartDate and rangeEndDate must be valid YYYY-MM-DD dates', code: 'INVALID_DATE' },
          { status: 400 }
        );
      }

      if (rangeStartDate > rangeEndDate) {
        return json(
          { error: 'rangeStartDate must not be after rangeEndDate', code: 'INVALID_DATE_RANGE' },
          { status: 400 }
        );
      }

      if (rangeEndDate > todayStr) {
        return json(
          { error: 'rangeEndDate cannot be in the future', code: 'FUTURE_DATE_REJECTED' },
          { status: 400 }
        );
      }

      const diffDays = differenceInDays(rangeStartDate, rangeEndDate) + 1;
      if (diffDays > MAX_BACKFILL_RANGE_DAYS) {
        return json(
          { error: 'Requested range exceeds maximum limit of 366 days', code: 'RANGE_EXCEEDED' },
          { status: 400 }
        );
      }
    } else if (mode === 'recent') {
      if (body.rangeStartDate !== undefined || body.rangeEndDate !== undefined) {
        return json(
          { error: 'Date range parameters are not permitted for recent mode', code: 'RANGE_FIELDS_REJECTED_FOR_RECENT' },
          { status: 400 }
        );
      }
      const [yesterday, today] = getRecentIntentDates(sourceTimezone, now);
      rangeStartDate = yesterday;
      rangeEndDate = today;
    }

    const runRequest: RunRequest = {
      mode,
      trigger: 'manual',
      idempotencyKey,
      rangeStartDate,
      rangeEndDate
    };

    const adminSync = getAdminSyncService(rt);
    try {
      const result = await adminSync.enqueue(runRequest);
      return json(
        {
          runId: result.runId,
          statusUrl: `/api/admin/sync-runs/${result.runId}`,
          reused: result.reused
        },
        { status: 202 }
      );
    } catch (err) {
      if (err instanceof IdempotencyConflictError || (err as any)?.code === 'IDEMPOTENCY_CONFLICT') {
        return json(
          { error: 'Idempotency conflict: run request already exists with different payload', code: 'IDEMPOTENCY_CONFLICT' },
          { status: 409 }
        );
      }
      if (err instanceof QueueFullError || (err as any)?.code === 'SYNC_QUEUE_FULL') {
        return json(
          { error: 'Sync run queue is full (max 10 nonterminal runs)', code: 'SYNC_QUEUE_FULL' },
          { status: 409 }
        );
      }
      return json(
        { error: 'Failed to enqueue sync run', code: 'INTERNAL_ERROR' },
        { status: 500 }
      );
    }
  };
}

export const GET = _createGetHandler(runtime);
export const POST = _createPostHandler(runtime);
