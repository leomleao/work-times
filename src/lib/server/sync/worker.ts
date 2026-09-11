/**
 * Single-date worker for Work Times (Milestone P5).
 *
 * Implements docs/NEXT-MILESTONE.md §2.1-2.5, 3.1-3.3, 7:
 * - Orchestrates single-date sync: fetch outside transactions -> validate bounds/CAS -> atomic reconcile.
 * - Enforces whole-day budget (5 minutes max), request bounds, and staged day ceiling (64 MiB).
 * - Enforces pre-commit cancellation recheck and connection generation CAS.
 * - Preserves accepted data on required summary failure, oversize, timezone mismatch, or cancellation.
 * - Truthful single-date outcome: succeeded, partial, failed, skipped, cancelled, or interrupted.
 * - Idempotent unchanged replay: identical normalized content produces disposition 'unchanged'
 *   without snapshot inflation or slice ID renumbering.
 * - Distinguishes verified zero from missing data.
 */

import type Database from 'better-sqlite3';
import type { WakaTimeClient } from '../wakatime/client.js';
import {
  MAX_DAY_EXECUTION_BUDGET_MS,
  MAX_STAGED_DAY_BYTES,
  RECONCILE_CODES,
  type DayCandidate,
  type LayerStatus,
  type ReconcileDisposition,
  type ReconcileResult,
  type SyncDayStatus
} from './contracts.js';
import { isValidDateString } from './calendar.js';
import { CapabilityPolicy } from './capabilities.js';
import { fetchDay, type FetchDayResult, type RecordingFetchResult } from './fetch-day.js';
import {
  reconcileDay,
  type ReconcileHeartbeatSourcePayload,
  type ReconcileRawSourcePayload
} from '../ingest/reconcile.js';
import { SqliteSyncRepository, type SyncRepository } from './repository.js';

export interface SyncDayWorkerOptions {
  /** BetterSQLite3 database instance. */
  db: Database.Database;
  /** Calendar date in strict YYYY-MM-DD format. */
  date: string;
  /** Accepted P2 WakaTimeClient instance with request gate and OAuth token provider. */
  client: WakaTimeClient;
  /** Optional sync run ID to track durable lifecycle progress in sync_days. */
  runId?: number;
  /** Pinned/verified account timezone. */
  pinnedTimezone?: string;
  /** Expected connection generation for CAS protection. */
  connectionGeneration?: number;
  /** Expected snapshot version to guard against concurrent writes. */
  expectedSnapshotVersion?: number;
  /** Optional capability policy tracking degraded endpoints. */
  policy?: CapabilityPolicy;
  /** Cancellation signal for the worker operation. */
  signal?: AbortSignal;
  /** Whole-day execution budget in milliseconds (default 5 minutes). */
  budgetMs?: number;
  /** Maximum staged single-day bytes before rejecting (default 64 MiB). */
  maxStagedDayBytes?: number;
  /** Injectable clock for deterministic testing. */
  now?: () => Date;
  /** Pre-instantiated sync repository (optional, instantiated from db if omitted). */
  syncRepo?: SyncRepository;
  /** Optional classification service for post-commit cache invalidation. */
  classification?: { invalidateIdentityCaches(): void; clearCaches(): void };
  /** Whether to probe or fetch durations. */
  attemptDurations?: boolean;
  /** Optional recording fetch to extract byte-exact raw payloads. */
  recordingFetch?: RecordingFetchResult;
  /** Explicit rawSources override if already buffered. */
  rawSources?: {
    summaries?: ReconcileRawSourcePayload;
    heartbeats?: ReconcileHeartbeatSourcePayload;
  };
}

export interface SyncDayWorkerResult {
  date: string;
  status: SyncDayStatus;
  disposition: ReconcileDisposition;
  advisoryCodes: string[];
  candidate: DayCandidate;
  rawSources?: FetchDayResult['rawSources'];
  reconcileResult?: ReconcileResult;
  summariesStatus: LayerStatus;
  heartbeatsStatus: LayerStatus;
  durationsStatus: LayerStatus;
  totalSeconds?: number;
  heartbeatCount?: number;
  sourceImportId?: number | null;
  errorMessage?: string | null;
  retryAt?: string | null;
}

/**
 * Maps Candidate and LayerResult to durable LayerStatus.
 */
function resolveLayerStatus(layer: { kind: string }): LayerStatus {
  switch (layer.kind) {
    case 'complete':
      return 'succeeded';
    case 'restricted':
      return 'restricted';
    case 'failed':
      return 'failed';
    case 'skipped':
    default:
      return 'skipped';
  }
}

/**
 * Processes exactly one source-calendar date:
 * 1. Checks pre-conditions (date format, cancellation, connection generation).
 * 2. Fetches and normalizes candidate outside SQLite transaction.
 * 3. Enforces staged day size ceiling (64 MiB).
 * 4. Rechecks cancellation immediately before opening commit transaction.
 * 5. Commits atomically via reconcileDay with exact rawSources.
 * 6. Returns truthful single-date outcome.
 */
export async function syncDayWorker(options: SyncDayWorkerOptions): Promise<SyncDayWorkerResult> {
  const getNow = options.now ?? (() => new Date());
  const syncRepo = options.syncRepo ?? new SqliteSyncRepository(options.db);
  const runId = options.runId;
  const advisoryCodes: string[] = [];

  // ==========================================================================
  // Phase 1: Pre-execution validation & Early Guards
  // ==========================================================================

  // 1. Validate requested calendar date
  if (!isValidDateString(options.date)) {
    const errorMsg = `Invalid calendar date string: "${options.date}"`;
    if (runId) {
      syncRepo.updateSyncDay(
        runId,
        options.date,
        {
          status: 'failed',
          disposition: 'rejected',
          summariesStatus: 'failed',
          advisoryCodes: [RECONCILE_CODES.MISSING_REQUESTED_DATE],
          errorMessage: errorMsg
        },
        getNow().toISOString()
      );
    }
    return {
      date: options.date,
      status: 'failed',
      disposition: 'rejected',
      advisoryCodes: [RECONCILE_CODES.MISSING_REQUESTED_DATE],
      candidate: {
        date: options.date,
        timezone: options.pinnedTimezone ?? 'UTC',
        connectionGeneration: options.connectionGeneration ?? 1,
        summaries: {
          kind: 'failed',
          code: RECONCILE_CODES.MISSING_REQUESTED_DATE,
          retryAt: null
        },
        heartbeats: { kind: 'skipped', reason: 'invalid_date' }
      },
      summariesStatus: 'failed',
      heartbeatsStatus: 'skipped',
      durationsStatus: 'skipped',
      errorMessage: errorMsg
    };
  }

  // 2. Validate connection generation from settings
  const settings = syncRepo.getSyncSettings();
  const expectedGen = options.connectionGeneration ?? settings.connectionGeneration;
  if (settings.connectionGeneration !== expectedGen) {
    const errorMsg = `Stale connection generation: expected ${expectedGen}, current is ${settings.connectionGeneration}`;
    if (runId) {
      syncRepo.updateSyncDay(
        runId,
        options.date,
        {
          status: 'failed',
          disposition: 'rejected',
          advisoryCodes: [RECONCILE_CODES.STALE_CONNECTION_GENERATION],
          errorMessage: errorMsg
        },
        getNow().toISOString()
      );
    }
    return {
      date: options.date,
      status: 'failed',
      disposition: 'rejected',
      advisoryCodes: [RECONCILE_CODES.STALE_CONNECTION_GENERATION],
      candidate: {
        date: options.date,
        timezone: options.pinnedTimezone ?? 'UTC',
        connectionGeneration: expectedGen,
        summaries: {
          kind: 'failed',
          code: RECONCILE_CODES.STALE_CONNECTION_GENERATION,
          retryAt: null
        },
        heartbeats: { kind: 'skipped', reason: 'stale_connection' }
      },
      summariesStatus: 'failed',
      heartbeatsStatus: 'skipped',
      durationsStatus: 'skipped',
      errorMessage: errorMsg
    };
  }

  // 3. Early cancellation check
  const isCancelledNow =
    Boolean(options.signal?.aborted) || Boolean(runId && syncRepo.isRunCancelRequested(runId));
  if (isCancelledNow) {
    if (runId) {
      syncRepo.updateSyncDay(
        runId,
        options.date,
        {
          status: 'cancelled',
          disposition: null,
          advisoryCodes: [RECONCILE_CODES.RUN_CANCELLED]
        },
        getNow().toISOString()
      );
    }
    return {
      date: options.date,
      status: 'cancelled',
      disposition: 'rejected',
      advisoryCodes: [RECONCILE_CODES.RUN_CANCELLED],
      candidate: {
        date: options.date,
        timezone: options.pinnedTimezone ?? 'UTC',
        connectionGeneration: expectedGen,
        summaries: {
          kind: 'failed',
          code: RECONCILE_CODES.RUN_CANCELLED,
          retryAt: null
        },
        heartbeats: { kind: 'skipped', reason: 'cancelled' }
      },
      summariesStatus: 'failed',
      heartbeatsStatus: 'skipped',
      durationsStatus: 'skipped',
      errorMessage: 'Day execution cancelled before start'
    };
  }

  // 4. Mark sync_days record as running
  if (runId) {
    syncRepo.updateSyncDay(
      runId,
      options.date,
      {
        status: 'running'
      },
      getNow().toISOString()
    );
  }

  // ==========================================================================
  // Phase 2: Fetch Outside SQLite Transaction
  // ==========================================================================
  const fetchResult = await fetchDay({
    date: options.date,
    client: options.client,
    pinnedTimezone: options.pinnedTimezone,
    connectionGeneration: expectedGen,
    policy: options.policy,
    signal: options.signal,
    budgetMs: options.budgetMs ?? MAX_DAY_EXECUTION_BUDGET_MS,
    now: options.now,
    recordingFetch: options.recordingFetch,
    rawSources: options.rawSources,
    attemptDurations: options.attemptDurations
  });

  // Track advisory codes from fetch
  advisoryCodes.push(...fetchResult.advisoryCodes);

  // Record layer attempts in sync repository using the completion timestamp
  const postFetchTime = getNow().toISOString();
  syncRepo.recordLayerAttempt(
    options.date,
    'summaries',
    {
      statusCode:
        fetchResult.candidate.summaries.kind === 'restricted'
          ? fetchResult.candidate.summaries.code
          : null,
      retryAt:
        fetchResult.candidate.summaries.kind === 'restricted'
          ? fetchResult.candidate.summaries.retryAt
          : null,
      hasRestriction: fetchResult.candidate.summaries.kind === 'restricted',
      hasFailure: fetchResult.candidate.summaries.kind === 'failed'
    },
    postFetchTime
  );

  if (fetchResult.candidate.heartbeats.kind !== 'skipped') {
    syncRepo.recordLayerAttempt(
      options.date,
      'heartbeats',
      {
        statusCode:
          fetchResult.candidate.heartbeats.kind === 'restricted'
            ? fetchResult.candidate.heartbeats.code
            : null,
        retryAt:
          fetchResult.candidate.heartbeats.kind === 'restricted'
            ? fetchResult.candidate.heartbeats.retryAt
            : null,
        hasRestriction: fetchResult.candidate.heartbeats.kind === 'restricted',
        hasFailure: fetchResult.candidate.heartbeats.kind === 'failed'
      },
      postFetchTime
    );
  }

  if (fetchResult.durationsResult.attempted) {
    syncRepo.recordLayerAttempt(
      options.date,
      'durations',
      {
        statusCode: fetchResult.durationsResult.code ?? null,
        retryAt: fetchResult.durationsResult.retryAt ?? null,
        hasRestriction: fetchResult.durationsResult.status === 'restricted',
        hasFailure: fetchResult.durationsResult.status === 'failed'
      },
      postFetchTime
    );
  }

  // ==========================================================================
  // Phase 3: Staged Day Size Ceiling Check (64 MiB max)
  // Counts every raw payload staged for reconciliation, including per-event raw JSON
  // ==========================================================================
  let totalStagedBytes = 0;
  if (fetchResult.rawSources.summaries?.rawJson) {
    totalStagedBytes += Buffer.byteLength(fetchResult.rawSources.summaries.rawJson, 'utf8');
  }
  if (fetchResult.rawSources.heartbeats?.rawJson) {
    totalStagedBytes += Buffer.byteLength(fetchResult.rawSources.heartbeats.rawJson, 'utf8');
  }
  if (fetchResult.rawSources.heartbeats?.events) {
    for (const evt of fetchResult.rawSources.heartbeats.events) {
      if (evt.rawJson) {
        totalStagedBytes += Buffer.byteLength(evt.rawJson, 'utf8');
      }
    }
  }
  const maxStagedBytes = options.maxStagedDayBytes ?? MAX_STAGED_DAY_BYTES;

  if (totalStagedBytes > maxStagedBytes) {
    const errorMsg = `Staged day size (${totalStagedBytes} bytes) exceeds limit of ${maxStagedBytes} bytes`;
    advisoryCodes.push(RECONCILE_CODES.STAGED_DAY_SIZE_EXCEEDED);
    if (runId) {
      syncRepo.updateSyncDay(
        runId,
        options.date,
        {
          status: 'failed',
          disposition: 'rejected',
          summariesStatus: 'failed',
          advisoryCodes,
          errorMessage: errorMsg
        },
        getNow().toISOString()
      );
    }
    return {
      date: options.date,
      status: 'failed',
      disposition: 'rejected',
      advisoryCodes: [...new Set(advisoryCodes)],
      candidate: fetchResult.candidate,
      summariesStatus: 'failed',
      heartbeatsStatus: resolveLayerStatus(fetchResult.candidate.heartbeats),
      durationsStatus: fetchResult.durationsResult.status,
      errorMessage: errorMsg
    };
  }

  // ==========================================================================
  // Phase 4: Pre-Commit Cancellation & CAS Recheck
  // ==========================================================================
  const isCancelledBeforeCommit =
    Boolean(options.signal?.aborted) || Boolean(runId && syncRepo.isRunCancelRequested(runId));
  if (isCancelledBeforeCommit) {
    advisoryCodes.push(RECONCILE_CODES.RUN_CANCELLED);
    if (runId) {
      syncRepo.updateSyncDay(
        runId,
        options.date,
        {
          status: 'cancelled',
          disposition: null,
          advisoryCodes: [...new Set(advisoryCodes)]
        },
        getNow().toISOString()
      );
    }
    return {
      date: options.date,
      status: 'cancelled',
      disposition: 'rejected',
      advisoryCodes: [...new Set(advisoryCodes)],
      candidate: fetchResult.candidate,
      summariesStatus: resolveLayerStatus(fetchResult.candidate.summaries),
      heartbeatsStatus: resolveLayerStatus(fetchResult.candidate.heartbeats),
      durationsStatus: fetchResult.durationsResult.status,
      errorMessage: 'Sync run cancelled before reconcile commit'
    };
  }

  // Verify connection generation immediately before commit
  const freshSettings = syncRepo.getSyncSettings();
  if (freshSettings.connectionGeneration !== expectedGen) {
    const errorMsg = `Stale connection generation before commit: expected ${expectedGen}, current is ${freshSettings.connectionGeneration}`;
    advisoryCodes.push(RECONCILE_CODES.STALE_CONNECTION_GENERATION);
    if (runId) {
      syncRepo.updateSyncDay(
        runId,
        options.date,
        {
          status: 'failed',
          disposition: 'rejected',
          advisoryCodes: [...new Set(advisoryCodes)],
          errorMessage: errorMsg
        },
        getNow().toISOString()
      );
    }
    return {
      date: options.date,
      status: 'failed',
      disposition: 'rejected',
      advisoryCodes: [...new Set(advisoryCodes)],
      candidate: fetchResult.candidate,
      summariesStatus: resolveLayerStatus(fetchResult.candidate.summaries),
      heartbeatsStatus: resolveLayerStatus(fetchResult.candidate.heartbeats),
      durationsStatus: fetchResult.durationsResult.status,
      errorMessage: errorMsg
    };
  }

  // ==========================================================================
  // Phase 5: Atomic Reconcile Commit
  // ==========================================================================
  const cancelChecker = () =>
    Boolean(options.signal?.aborted) || Boolean(runId && syncRepo.isRunCancelRequested(runId));

  const commitNow = getNow().toISOString();
  const reconcileResult = reconcileDay(options.db, fetchResult.candidate, {
    runId,
    sourceReference: `api:${options.date}`,
    rawSources: fetchResult.rawSources,
    expectedSnapshotVersion: options.expectedSnapshotVersion,
    isCancelled: cancelChecker,
    pinnedTimezone: options.pinnedTimezone,
    now: commitNow,
    syncRepo,
    classification: options.classification
  });

  advisoryCodes.push(...reconcileResult.codes);

  // ==========================================================================
  // Phase 6: Truthful Single-Date Outcome Determination
  // ==========================================================================
  let dayStatus: SyncDayStatus = reconcileResult.dayStatus;
  const summariesStatus = resolveLayerStatus(fetchResult.candidate.summaries);
  const heartbeatsStatus = resolveLayerStatus(fetchResult.candidate.heartbeats);
  const durationsStatus = fetchResult.durationsResult.status;

  const isSummariesComplete = fetchResult.candidate.summaries.kind === 'complete';
  const isVerifiedZero =
    fetchResult.candidate.summaries.kind === 'complete' &&
    fetchResult.candidate.summaries.value.completeness.isVerifiedZero;

  // For verified zero day, heartbeats remain skipped (truthful, no synthetic data)
  if (runId && isVerifiedZero) {
    syncRepo.updateSyncDay(
      runId,
      options.date,
      {
        status: dayStatus,
        disposition: reconcileResult.disposition,
        heartbeatsStatus: 'skipped'
      },
      getNow().toISOString()
    );
  }

  // Optional endpoint restriction/failure degrades a nonzero day to partial
  if (dayStatus === 'succeeded' && !isVerifiedZero) {
    if (
      heartbeatsStatus === 'restricted' ||
      heartbeatsStatus === 'failed' ||
      heartbeatsStatus === 'skipped' ||
      durationsStatus === 'restricted' ||
      durationsStatus === 'failed'
    ) {
      dayStatus = 'partial';
      if (runId) {
        syncRepo.updateSyncDay(
          runId,
          options.date,
          {
            status: 'partial',
            durationsStatus
          },
          getNow().toISOString()
        );
      }
    }
  }

  // Extract totals and counts
  let totalSeconds: number | undefined;
  let heartbeatCount: number | undefined;
  if (fetchResult.candidate.summaries.kind === 'complete') {
    totalSeconds = fetchResult.candidate.summaries.value.totalSeconds;
  }
  if (fetchResult.candidate.heartbeats.kind === 'complete') {
    heartbeatCount = fetchResult.candidate.heartbeats.value.completeness.eventCount;
  }

  // Extract retryAt if restricted
  let retryAt: string | null = null;
  if (fetchResult.candidate.summaries.kind === 'restricted') {
    retryAt = fetchResult.candidate.summaries.retryAt || null;
  } else if (fetchResult.candidate.heartbeats.kind === 'restricted') {
    retryAt = fetchResult.candidate.heartbeats.retryAt || null;
  } else if (fetchResult.durationsResult.retryAt) {
    retryAt = fetchResult.durationsResult.retryAt;
  }

  return {
    date: options.date,
    status: dayStatus,
    disposition: reconcileResult.disposition,
    advisoryCodes: [...new Set(advisoryCodes)],
    candidate: fetchResult.candidate,
    rawSources: fetchResult.rawSources,
    reconcileResult,
    summariesStatus,
    heartbeatsStatus,
    durationsStatus,
    totalSeconds,
    heartbeatCount,
    errorMessage: fetchResult.errorMessage,
    retryAt
  };
}
