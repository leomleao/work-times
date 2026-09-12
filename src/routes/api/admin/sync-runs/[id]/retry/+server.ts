import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runtime } from '$lib/server/runtime';
import { validateAdminMutationAuth, AdminAuthError } from '$lib/server/auth/admin-auth';
import { getAdminSyncService, type AdminSyncRuntimeSurface } from '$lib/server/admin/sync';
import type { RetrySyncRunRequestBody, RetrySyncRunResponseBody, RunRequest, SyncService } from '$lib/server/sync/contracts';
import { isValidDateString } from '$lib/server/sync/calendar';
import { IdempotencyConflictError, QueueFullError } from '$lib/server/db/repositories/sync';

export interface SyncRunRetryRouteDeps {
  runtime?: AdminSyncRuntimeSurface;
  sync?: SyncService;
}

export function _createPostHandler(deps?: SyncRunRetryRouteDeps): RequestHandler {
  return async ({ locals, params, request }) => {
    let body: RetrySyncRunRequestBody & { csrfToken?: string; idempotencyKey?: string } = {};
    try {
      const text = await request.text();
      if (text.trim().length > 0) {
        body = JSON.parse(text);
      }
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
        return json(
          { error: err.status === 401 ? 'Unauthorized' : 'Forbidden', code: err.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' },
          { status: err.status }
        );
      }
      throw err;
    }

    const id = Number(params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return json({ error: 'Invalid run ID: must be a positive integer', code: 'INVALID_RUN_ID' }, { status: 400 });
    }

    const rt = deps?.runtime ?? (deps?.sync ? { ...(runtime as unknown as AdminSyncRuntimeSurface), sync: deps.sync } : undefined);
    const db = rt?.db ?? runtime.db;

    const parentRun = db
      .prepare(`SELECT id, status, mode, started_at FROM sync_runs WHERE id = ?`)
      .get(id) as { id: number; status: string; mode: string; started_at: string } | undefined;

    if (!parentRun) {
      return json({ error: `Sync run ${id} not found`, code: 'NOT_FOUND' }, { status: 404 });
    }

    const targetDate = typeof body.targetDate === 'string' ? body.targetDate.trim() : undefined;
    if (targetDate && !isValidDateString(targetDate)) {
      return json({ error: `targetDate '${targetDate}' is not a valid YYYY-MM-DD date`, code: 'INVALID_TARGET_DATE' }, { status: 400 });
    }

    const parentDays = db
      .prepare(
        `SELECT date, status, summaries_status, durations_status, heartbeats_status
         FROM sync_days
         WHERE sync_run_id = ?`
      )
      .all(id) as Array<{
        date: string;
        status: string;
        summaries_status: string | null;
        durations_status: string | null;
        heartbeats_status: string | null;
      }>;

    type ConnectionRow = { generation: number; rebound_at: string | null };
    let connectionRow: ConnectionRow | undefined = undefined;
    try {
      connectionRow = db
        .prepare(`SELECT generation, rebound_at FROM wakatime_oauth_connection WHERE id = 1`)
        .get() as ConnectionRow | undefined;
    } catch {}

    const isPostReconnect = Boolean(
      connectionRow?.rebound_at &&
      connectionRow.rebound_at > parentRun.started_at
    );

    let eligibleDates: string[] = [];

    if (targetDate) {
      const matchingDay = parentDays.find((d) => d.date === targetDate);
      if (!matchingDay) {
        return json(
          { error: `targetDate '${targetDate}' was not part of parent sync run ${id}`, code: 'TARGET_DATE_NOT_IN_RUN' },
          { status: 400 }
        );
      }

      const isFailedOrInterrupted =
        matchingDay.status === 'failed' || matchingDay.status === 'interrupted';

      const isRestricted =
        matchingDay.status === 'skipped' ||
        matchingDay.summaries_status === 'restricted' ||
        matchingDay.durations_status === 'restricted' ||
        matchingDay.heartbeats_status === 'restricted';

      if (isFailedOrInterrupted) {
        eligibleDates = [targetDate];
      } else if (isRestricted) {
        if (isPostReconnect) {
          // Durably verify restricted date has not already been retried under this reconnect generation
          const priorRetry = db
            .prepare(
              `SELECT r.id FROM sync_runs r
               JOIN sync_days d ON d.sync_run_id = r.id
               WHERE r.resumed_from_run_id = ?
                 AND d.date = ?
                 AND r.started_at >= ?
               LIMIT 1`
            )
            .get(parentRun.id, targetDate, connectionRow!.rebound_at) as { id: number } | undefined;

          if (priorRetry) {
            return json(
              { error: 'Restricted date has already been retried for this connection generation', code: 'ALREADY_RETRIED' },
              { status: 409 }
            );
          }
          eligibleDates = [targetDate];
        } else {
          return json(
            { error: 'Restricted date cannot be retried without post-reconnect authorization', code: 'RECONNECT_REQUIRED' },
            { status: 400 }
          );
        }
      } else {
        return json(
          { error: `Date '${targetDate}' is not eligible for retry`, code: 'DATE_NOT_ELIGIBLE' },
          { status: 400 }
        );
      }
    } else {
      // Dedicated retry allows only failed or interrupted parent dates
      eligibleDates = parentDays
        .filter((d) => d.status === 'failed' || d.status === 'interrupted')
        .map((d) => d.date);

      if (eligibleDates.length === 0) {
        return json(
          { error: `No failed or interrupted dates eligible for retry in sync run ${id}`, code: 'NO_ELIGIBLE_DATES' },
          { status: 400 }
        );
      }
    }

    eligibleDates.sort();

    const gen = connectionRow?.generation ?? 0;
    const defaultKey = `retry-${id}-gen${gen}-${eligibleDates.join(',')}`;
    const idempotencyKey =
      typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim().length > 0
        ? body.idempotencyKey.trim()
        : defaultKey;

    const runRequest: RunRequest = {
      mode: 'retry',
      trigger: 'manual',
      idempotencyKey,
      resumedFromRunId: id,
      retryDates: eligibleDates
    };

    const adminSync = getAdminSyncService(rt);
    try {
      const result = await adminSync.enqueue(runRequest);
      const response: RetrySyncRunResponseBody = {
        newRunId: result.runId,
        parentRunId: id,
        statusUrl: `/api/admin/sync-runs/${result.runId}`,
        scheduledDates: eligibleDates
      };
      return json(response, { status: 202 });
    } catch (err) {
      if (err instanceof IdempotencyConflictError || (err as any)?.code === 'IDEMPOTENCY_CONFLICT') {
        return json(
          { error: 'Idempotency conflict', code: 'IDEMPOTENCY_CONFLICT' },
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
        { error: 'Failed to enqueue retry run', code: 'INTERNAL_ERROR' },
        { status: 500 }
      );
    }
  };
}

export const POST = _createPostHandler();
