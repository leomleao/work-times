import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runtime } from '$lib/server/runtime';
import { validateAdminMutationAuth, AdminAuthError } from '$lib/server/auth/admin-auth';
import {
  getAdminSyncService,
  getVerifiedSourceTimezone,
  RUN_MODES,
  type AdminSyncRunsCollectionDto
} from '$lib/server/admin/sync';
import {
  MAX_BACKFILL_RANGE_DAYS,
  type RunRequest,
  type RunRequestMode
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

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.admin) {
    return json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
  }

  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(50, Math.max(1, Number(limitParam) || 50)) : 50;

  const adminSync = getAdminSyncService();
  const collection: AdminSyncRunsCollectionDto = adminSync.getRunsCollection({ limit });

  return json(collection);
};

export const POST: RequestHandler = async ({ locals, request }) => {
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
      publicUrl: runtime.config.publicUrl,
      sessionSecret: runtime.sessionSecret,
      submittedCsrf
    });
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return json({ error: err.message, code: err.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' }, { status: err.status });
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
      { error: `Invalid mode '${rawMode}'. Allowed manual modes: recent, backfill, compare`, code: 'INVALID_MODE' },
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

  const sourceTimezone = getVerifiedSourceTimezone(runtime.db);
  const todayStr = getZonedDateString(sourceTimezone, new Date());

  let rangeStartDate: string | undefined = undefined;
  let rangeEndDate: string | undefined = undefined;

  if (mode === 'backfill' || mode === 'compare') {
    if (
      typeof body.rangeStartDate !== 'string' ||
      typeof body.rangeEndDate !== 'string'
    ) {
      return json(
        { error: `Mode '${mode}' requires both rangeStartDate and rangeEndDate`, code: 'MISSING_DATE_RANGE' },
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
        { error: `Requested range of ${diffDays} days exceeds maximum limit of ${MAX_BACKFILL_RANGE_DAYS} days`, code: 'RANGE_EXCEEDED' },
        { status: 400 }
      );
    }
  } else if (mode === 'recent') {
    if (typeof body.rangeStartDate === 'string') {
      const s = body.rangeStartDate.trim();
      if (!isValidDateString(s)) {
        return json({ error: 'rangeStartDate must be a valid YYYY-MM-DD date', code: 'INVALID_DATE' }, { status: 400 });
      }
      if (s > todayStr) {
        return json({ error: 'rangeStartDate cannot be in the future', code: 'FUTURE_DATE_REJECTED' }, { status: 400 });
      }
      rangeStartDate = s;
    }
    if (typeof body.rangeEndDate === 'string') {
      const e = body.rangeEndDate.trim();
      if (!isValidDateString(e)) {
        return json({ error: 'rangeEndDate must be a valid YYYY-MM-DD date', code: 'INVALID_DATE' }, { status: 400 });
      }
      if (e > todayStr) {
        return json({ error: 'rangeEndDate cannot be in the future', code: 'FUTURE_DATE_REJECTED' }, { status: 400 });
      }
      rangeEndDate = e;
    }
    if (rangeStartDate && rangeEndDate && rangeStartDate > rangeEndDate) {
      return json({ error: 'rangeStartDate must not be after rangeEndDate', code: 'INVALID_DATE_RANGE' }, { status: 400 });
    }
    if (!rangeStartDate && !rangeEndDate) {
      const [yesterday, today] = getRecentIntentDates(sourceTimezone, new Date());
      rangeStartDate = yesterday;
      rangeEndDate = today;
    }
  }

  const runRequest: RunRequest = {
    mode,
    trigger: 'manual',
    idempotencyKey,
    rangeStartDate,
    rangeEndDate
  };

  const adminSync = getAdminSyncService();
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
    if (
      err instanceof QueueFullError ||
      (err as any)?.code === 'SYNC_QUEUE_FULL' ||
      (err instanceof Error && err.message.includes('SYNC_QUEUE_FULL'))
    ) {
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
