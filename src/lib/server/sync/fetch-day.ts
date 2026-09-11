/**
 * Single-date fetcher for Work Times (Milestone P5).
 *
 * Implements docs/NEXT-MILESTONE.md §2.1-2.3, 3.2, 7:
 * - Fetches and normalizes exactly one requested calendar date outside SQLite transactions.
 * - Enforces whole-day budget (default 5 minutes), request bounds (30s timeout, 16 MiB payload).
 * - Validates requested date format, returned boundaries, and pinned account timezone.
 * - Baseline required summaries: distinguishes absence, malformed, oversize, timezone mismatch,
 *   revoked auth, and plan restrictions.
 * - Optional heartbeats and durations: preserves accepted data on restriction or failure;
 *   tracks date-specific 402/403 so old dates do not globally restrict recent endpoints.
 * - Honors deferred Retry-After without shortening the wait duration.
 * - Preserves byte-faithful rawSources lineage for batch and per-event JSON.
 * - Does NOT infer heartbeat duration or add a redundant pacing gate (delegates to P2 client gate).
 */

import type { WakaTimeClient } from '../wakatime/client.js';
import {
  WakaTimeAuthError,
  CapabilityRestrictedError,
  WakaTimeDeferredRetryError,
  WakaTimeRequestTimeoutError,
  WakaTimeBudgetTimeoutError,
  WakaTimeResponseSizeExceededError,
  WakaTimeThrottleError,
  WakaTimeServerError,
  WakaTimeNetworkError,
  WakaTimeParseError
} from '../wakatime/errors.js';
import {
  MAX_DAY_EXECUTION_BUDGET_MS,
  MAX_RESPONSE_PAYLOAD_BYTES,
  RECONCILE_CODES,
  type DayCandidate,
  type LayerResult,
  type LayerStatus,
  type NormalizedHeartbeatDay,
  type NormalizedHeartbeatEvent,
  type NormalizedSummaryDay
} from './contracts.js';
import { isValidDateString } from './calendar.js';
import { CapabilityPolicy } from './capabilities.js';
import { normalizeSummaryDay } from '../ingest/normalize-summary.js';
import { normalizeHeartbeatDay } from '../ingest/normalize-heartbeats.js';
import { canonicalHeartbeatPayload, stableStringify } from '../import/canonical.js';
import type {
  ReconcileRawSourcePayload,
  ReconcileHeartbeatSourcePayload,
  ReconcileRawHeartbeatEvent
} from '../ingest/reconcile.js';

export interface RecordingFetchResult {
  fetch: typeof fetch;
  getRawText(urlSubstr: string): string | undefined;
  getAllRecorded(): Map<string, string>;
}

export interface RecordingFetchOptions {
  maxBytes?: number;
}

/**
 * Creates a fetch wrapper that clones and records exact UTF-8 raw response text
 * without consuming the streaming body from the caller.
 * Bounded by maxBytes (default 16 MiB) to prevent unbounded memory usage.
 */
export function createRecordingFetch(
  baseFetch: typeof fetch = globalThis.fetch.bind(globalThis),
  options?: RecordingFetchOptions
): RecordingFetchResult {
  const maxBytes = options?.maxBytes ?? MAX_RESPONSE_PAYLOAD_BYTES;
  const history: Array<{ url: string; text: string }> = [];

  const wrappedFetch: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const response = await baseFetch(input, init);

    try {
      const contentLength = response.headers?.get('content-length');
      if (contentLength) {
        const cl = Number.parseInt(contentLength, 10);
        if (!Number.isNaN(cl) && cl > maxBytes) {
          return response;
        }
      }

      const cloned = response.clone();
      if (cloned.body && typeof cloned.body.getReader === 'function') {
        const reader = cloned.body.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        let exceeded = false;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              totalBytes += value.byteLength;
              if (totalBytes > maxBytes) {
                exceeded = true;
                await reader.cancel().catch(() => {});
                break;
              }
              chunks.push(value);
            }
          }
        } catch {
          // Stream read cancelled or error
        }

        if (!exceeded) {
          const merged = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const text = new TextDecoder('utf-8').decode(merged);
          history.push({ url, text });
        }
      } else {
        try {
          const text = await cloned.text();
          if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
            history.push({ url, text });
          }
        } catch {
          // Ignore
        }
      }
    } catch {
      // Ignore clone/read errors
    }

    return response;
  };

  return {
    fetch: wrappedFetch,
    getRawText(urlSubstr: string): string | undefined {
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].url.includes(urlSubstr)) {
          return history[i].text;
        }
      }
      return undefined;
    },
    getAllRecorded(): Map<string, string> {
      const map = new Map<string, string>();
      for (const item of history) {
        map.set(item.url, item.text);
      }
      return map;
    }
  };
}

export interface FetchDayOptions {
  /** Target calendar date in strict YYYY-MM-DD format. */
  date: string;
  /** Accepted P2 WakaTimeClient instance with request gate and OAuth lifecycle. */
  client: WakaTimeClient;
  /** Pinned/verified account timezone (e.g. 'Europe/London'). */
  pinnedTimezone?: string;
  /** Expected connection generation for CAS check. */
  connectionGeneration: number;
  /** Optional capability policy tracking endpoint degradation. */
  policy?: CapabilityPolicy;
  /** Cancellation signal for the whole-day operation. */
  signal?: AbortSignal;
  /** Whole-day execution budget in milliseconds (default 5 minutes). */
  budgetMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Optional recording fetch to extract raw wire responses. */
  recordingFetch?: RecordingFetchResult;
  /** Explicit rawSources override if already buffered. */
  rawSources?: {
    summaries?: ReconcileRawSourcePayload;
    heartbeats?: ReconcileHeartbeatSourcePayload;
  };
  /** Whether to probe or fetch durations as well. */
  attemptDurations?: boolean;
}

export interface FetchDayResult {
  candidate: DayCandidate;
  rawSources: {
    summaries?: ReconcileRawSourcePayload;
    heartbeats?: ReconcileHeartbeatSourcePayload;
  };
  policy: CapabilityPolicy;
  durationsResult: {
    attempted: boolean;
    success: boolean;
    status: LayerStatus;
    code?: string;
    retryAt?: string | null;
  };
  advisoryCodes: string[];
  errorMessage?: string | null;
}

function serializeCanonicalHeartbeat(beat: NormalizedHeartbeatEvent): string {
  const payload = canonicalHeartbeatPayload({
    id: beat.id,
    time: beat.occurredAtUs / 1_000_000,
    entity: beat.entity,
    type: beat.entityType,
    category: beat.category,
    project: beat.projectName,
    branch: beat.branch,
    language: beat.language,
    dependencies: beat.dependencies,
    machine_name_id: beat.machineNameId,
    user_agent_id: beat.userAgentId,
    is_write: beat.isWrite,
    lines: beat.lines,
    lineno: beat.lineno,
    cursorpos: beat.cursorpos
  });
  return stableStringify(payload);
}

/**
 * Executes network fetch and pure normalization for a single calendar date.
 * Strictly runs outside of SQLite transactions.
 */
export async function fetchDay(options: FetchDayOptions): Promise<FetchDayResult> {
  const getNow = options.now ?? (() => new Date());
  const now = getNow();
  const policy = options.policy ?? new CapabilityPolicy();
  const advisoryCodes: string[] = [];
  const budgetMs = options.budgetMs ?? MAX_DAY_EXECUTION_BUDGET_MS;
  const startTime = now.getTime();

  // 1. Date format validation
  if (!isValidDateString(options.date)) {
    return {
      candidate: {
        date: options.date,
        timezone: options.pinnedTimezone ?? 'UTC',
        connectionGeneration: options.connectionGeneration,
        summaries: {
          kind: 'failed',
          code: RECONCILE_CODES.MISSING_REQUESTED_DATE,
          retryAt: null
        },
        heartbeats: {
          kind: 'skipped',
          reason: 'invalid_date'
        }
      },
      rawSources: {},
      policy,
      durationsResult: { attempted: false, success: false, status: 'skipped' },
      advisoryCodes: [RECONCILE_CODES.MISSING_REQUESTED_DATE],
      errorMessage: `Invalid calendar date string: "${options.date}"`
    };
  }

  // 2. Cancellation check before starting network calls
  if (options.signal?.aborted) {
    return {
      candidate: {
        date: options.date,
        timezone: options.pinnedTimezone ?? 'UTC',
        connectionGeneration: options.connectionGeneration,
        summaries: {
          kind: 'failed',
          code: RECONCILE_CODES.RUN_CANCELLED,
          retryAt: null
        },
        heartbeats: {
          kind: 'skipped',
          reason: 'cancelled'
        }
      },
      rawSources: {},
      policy,
      durationsResult: { attempted: false, success: false, status: 'skipped' },
      advisoryCodes: [RECONCILE_CODES.RUN_CANCELLED],
      errorMessage: 'Day execution cancelled before start'
    };
  }

  // 3. Setup day-level abort controller enforcing the whole-day execution budget
  const dayController = new AbortController();
  const onCallerAbort = () => {
    dayController.abort(options.signal?.reason ?? new Error('Sync run cancelled'));
  };

  if (options.signal) {
    options.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const budgetTimer = setTimeout(() => {
    if (!dayController.signal.aborted) {
      dayController.abort(new WakaTimeBudgetTimeoutError(budgetMs, 'day_execution_budget'));
    }
  }, budgetMs);

  const getRemainingBudget = (): number => {
    const elapsed = getNow().getTime() - startTime;
    return Math.max(0, budgetMs - elapsed);
  };

  try {
    let summariesResult: LayerResult<NormalizedSummaryDay>;
    let heartbeatsResult: LayerResult<NormalizedHeartbeatDay> = {
      kind: 'skipped',
      reason: 'not_attempted'
    };
    let durationsResult: FetchDayResult['durationsResult'] = {
      attempted: false,
      success: false,
      status: 'skipped'
    };

    let exactSummariesRawJson: string | undefined = options.rawSources?.summaries?.rawJson;
    let exactHeartbeatsRawJson: string | undefined = options.rawSources?.heartbeats?.rawJson;
    let exactHeartbeatEvents: ReconcileRawHeartbeatEvent[] = [
      ...(options.rawSources?.heartbeats?.events ?? [])
    ];

    // ========================================================================
    // Step A: Fetch Summaries (Required Baseline)
    // ========================================================================
    if (!policy.shouldAttempt('summaries', options.date, getNow())) {
      const hold = policy.getHoldReason('summaries', options.date, getNow());
      if (hold?.type === 'date_restriction' || hold?.type === 'global_restriction') {
        const code = `HTTP_${hold.statusCode}`;
        summariesResult = {
          kind: 'restricted',
          code,
          retryAt: hold.nextReprobeAt
        };
        advisoryCodes.push('SUMMARIES_PLAN_RESTRICTED');
      } else if (hold?.type === 'throttle') {
        summariesResult = {
          kind: 'restricted',
          code: RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED,
          retryAt: hold.retryAt
        };
        advisoryCodes.push(RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED);
      } else if (hold?.type === 'error') {
        summariesResult = {
          kind: 'failed',
          code: 'SUMMARIES_FAILED',
          retryAt: hold.nextReprobeAt
        };
        advisoryCodes.push('SUMMARIES_FAILED');
      } else {
        summariesResult = {
          kind: 'failed',
          code: 'SUMMARIES_FAILED',
          retryAt: null
        };
        advisoryCodes.push('SUMMARIES_FAILED');
      }
    } else {
      try {
        const summariesRemaining = getRemainingBudget();
        if (summariesRemaining <= 0 || dayController.signal.aborted) {
          throw new WakaTimeBudgetTimeoutError(budgetMs, 'summaries');
        }

        const summariesWire = await options.client.getSummaries({
          start: options.date,
          end: options.date,
          timezone: options.pinnedTimezone,
          signal: dayController.signal,
          budgetMs: summariesRemaining
        });

        // Capture raw JSON text if recorded
        if (!exactSummariesRawJson && options.recordingFetch) {
          exactSummariesRawJson = options.recordingFetch.getRawText('/summaries');
        }
        if (!exactSummariesRawJson) {
          exactSummariesRawJson = stableStringify(summariesWire);
        }

        // Validate returned date boundaries
        const wireDays = Array.isArray(summariesWire?.data) ? summariesWire.data : [];
        const matchingDay = wireDays.find(
          (d) => d && (d.date === options.date || d.range?.date === options.date)
        );

        if (!matchingDay) {
          summariesResult = {
            kind: 'failed',
            code: RECONCILE_CODES.MISSING_REQUESTED_DATE,
            retryAt: null
          };
          advisoryCodes.push(RECONCILE_CODES.MISSING_REQUESTED_DATE);
        } else if (
          options.pinnedTimezone &&
          matchingDay.range?.timezone &&
          matchingDay.range.timezone !== options.pinnedTimezone
        ) {
          // Timezone mismatch against pinned account timezone
          summariesResult = {
            kind: 'failed',
            code: RECONCILE_CODES.TIMEZONE_MISMATCH,
            retryAt: null
          };
          advisoryCodes.push(RECONCILE_CODES.TIMEZONE_MISMATCH);
        } else {
          // Normalize summary day using the actual completion timestamp
          const summariesObservedAt = getNow().toISOString();
          const norm = normalizeSummaryDay(exactSummariesRawJson ?? summariesWire, {
            date: options.date,
            accountTimezone: options.pinnedTimezone,
            observedAt: summariesObservedAt,
            maxBytes: MAX_RESPONSE_PAYLOAD_BYTES
          });

          if (norm.kind === 'complete') {
            policy.recordSuccess('summaries', options.date, getNow());
            summariesResult = norm;
          } else {
            summariesResult = norm;
            if (norm.kind === 'restricted') {
              policy.recordRestriction('summaries', 402, options.date, getNow());
              advisoryCodes.push(norm.code);
            } else if (norm.kind === 'failed') {
              advisoryCodes.push(norm.code);
            }
          }
        }
      } catch (err) {
        if (dayController.signal.aborted && options.signal?.aborted) {
          summariesResult = {
            kind: 'failed',
            code: RECONCILE_CODES.RUN_CANCELLED,
            retryAt: null
          };
          advisoryCodes.push(RECONCILE_CODES.RUN_CANCELLED);
        } else if (err instanceof CapabilityRestrictedError) {
          policy.recordRestriction('summaries', err.statusCode, options.date, getNow());
          summariesResult = {
            kind: 'restricted',
            code: `HTTP_${err.statusCode}`,
            retryAt: ''
          };
          advisoryCodes.push('SUMMARIES_PLAN_RESTRICTED');
        } else if (err instanceof WakaTimeDeferredRetryError) {
          policy.recordDeferredRetry('summaries', err.retryAt, options.date, getNow());
          summariesResult = {
            kind: 'restricted',
            code: RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED,
            retryAt: err.retryAt
          };
          advisoryCodes.push(RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED);
        } else if (err instanceof WakaTimeAuthError) {
          policy.recordError('summaries', err, options.date, getNow());
          summariesResult = {
            kind: 'failed',
            code: 'AUTH_FAILED',
            retryAt: null
          };
          advisoryCodes.push('AUTH_FAILED');
        } else if (err instanceof WakaTimeResponseSizeExceededError) {
          summariesResult = {
            kind: 'failed',
            code: RECONCILE_CODES.RESPONSE_SIZE_EXCEEDED,
            retryAt: null
          };
          advisoryCodes.push(RECONCILE_CODES.RESPONSE_SIZE_EXCEEDED);
        } else if (err instanceof WakaTimeBudgetTimeoutError) {
          summariesResult = {
            kind: 'failed',
            code: RECONCILE_CODES.DAY_EXECUTION_TIMEOUT,
            retryAt: null
          };
          advisoryCodes.push(RECONCILE_CODES.DAY_EXECUTION_TIMEOUT);
        } else if (err instanceof WakaTimeRequestTimeoutError) {
          summariesResult = {
            kind: 'failed',
            code: RECONCILE_CODES.REQUEST_TIMEOUT,
            retryAt: null
          };
          advisoryCodes.push(RECONCILE_CODES.REQUEST_TIMEOUT);
        } else {
          policy.recordError('summaries', err as Error, options.date, getNow());
          summariesResult = {
            kind: 'failed',
            code: 'SUMMARIES_FAILED',
            retryAt: null
          };
          advisoryCodes.push('SUMMARIES_FAILED');
        }
      }
    }

    // ========================================================================
    // Step B: Optional Heartbeats Fetch
    // ========================================================================
    const isSummariesComplete = summariesResult.kind === 'complete';
    const isVerifiedZero =
      summariesResult.kind === 'complete' && summariesResult.value.completeness.isVerifiedZero;

    if (summariesResult.kind !== 'complete') {
      heartbeatsResult = {
        kind: 'skipped',
        reason: 'summaries_incomplete'
      };
    } else if (isVerifiedZero) {
      // Authoritative zero day: heartbeats are skipped without network request
      heartbeatsResult = {
        kind: 'skipped',
        reason: 'verified_zero'
      };
      // Do NOT set exactHeartbeatsRawJson! Do NOT fabricate synthetic raw source!
    } else if (!policy.shouldAttempt('heartbeats', options.date, getNow())) {
      const hold = policy.getHoldReason('heartbeats', options.date, getNow());
      if (hold?.type === 'date_restriction' || hold?.type === 'global_restriction') {
        const code = `HTTP_${hold.statusCode}`;
        heartbeatsResult = {
          kind: 'restricted',
          code,
          retryAt: hold.nextReprobeAt
        };
        advisoryCodes.push('HEARTBEATS_PLAN_RESTRICTED');
      } else if (hold?.type === 'throttle') {
        heartbeatsResult = {
          kind: 'restricted',
          code: RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED,
          retryAt: hold.retryAt
        };
        advisoryCodes.push(RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED);
      } else if (hold?.type === 'error') {
        heartbeatsResult = {
          kind: 'failed',
          code: 'HEARTBEATS_FAILED',
          retryAt: hold.nextReprobeAt
        };
        advisoryCodes.push('HEARTBEATS_FAILED');
      } else {
        heartbeatsResult = {
          kind: 'failed',
          code: 'HEARTBEATS_FAILED',
          retryAt: null
        };
        advisoryCodes.push('HEARTBEATS_FAILED');
      }
    } else {
      try {
        const hbRemaining = getRemainingBudget();
        if (hbRemaining <= 0 || dayController.signal.aborted) {
          throw new WakaTimeBudgetTimeoutError(budgetMs, 'heartbeats');
        }

        const heartbeatsWire = await options.client.getHeartbeats({
          date: options.date,
          timezone: options.pinnedTimezone,
          signal: dayController.signal,
          budgetMs: hbRemaining
        });

        if (!exactHeartbeatsRawJson && options.recordingFetch) {
          exactHeartbeatsRawJson = options.recordingFetch.getRawText('/heartbeats');
        }
        if (!exactHeartbeatsRawJson) {
          exactHeartbeatsRawJson = stableStringify(heartbeatsWire);
        }

        const heartbeatsObservedAt = getNow().toISOString();
        const hbNorm = normalizeHeartbeatDay(exactHeartbeatsRawJson ?? heartbeatsWire, {
          date: options.date,
          timezone: options.pinnedTimezone,
          observedAt: heartbeatsObservedAt,
          maxBytes: MAX_RESPONSE_PAYLOAD_BYTES
        });

        if (hbNorm.kind === 'complete') {
          policy.recordSuccess('heartbeats', options.date, getNow());
          heartbeatsResult = hbNorm;

          // Build exact per-event JSON lineage
          const wireItems = Array.isArray(heartbeatsWire?.data) ? heartbeatsWire.data : [];
          for (const beat of hbNorm.value.heartbeats) {
            const rawWireItem = wireItems.find((w) => w && w.id === beat.id);
            const eventRaw = rawWireItem ? stableStringify(rawWireItem) : serializeCanonicalHeartbeat(beat);
            exactHeartbeatEvents.push({
              externalId: beat.id,
              canonicalHash: beat.canonicalHash,
              rawJson: eventRaw
            });
          }
        } else {
          heartbeatsResult = hbNorm;
          if (hbNorm.kind === 'restricted') {
            policy.recordRestriction('heartbeats', 403, options.date, getNow());
            advisoryCodes.push(hbNorm.code);
          } else if (hbNorm.kind === 'failed') {
            advisoryCodes.push(hbNorm.code);
          }
        }
      } catch (err) {
        if (dayController.signal.aborted && options.signal?.aborted) {
          heartbeatsResult = {
            kind: 'failed',
            code: RECONCILE_CODES.RUN_CANCELLED,
            retryAt: null
          };
        } else if (err instanceof CapabilityRestrictedError) {
          policy.recordRestriction('heartbeats', err.statusCode, options.date, getNow());
          heartbeatsResult = {
            kind: 'restricted',
            code: `HTTP_${err.statusCode}`,
            retryAt: ''
          };
          advisoryCodes.push('HEARTBEATS_PLAN_RESTRICTED');
        } else if (err instanceof WakaTimeDeferredRetryError) {
          policy.recordDeferredRetry('heartbeats', err.retryAt, options.date, getNow());
          heartbeatsResult = {
            kind: 'restricted',
            code: RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED,
            retryAt: err.retryAt
          };
          advisoryCodes.push(RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED);
        } else if (err instanceof WakaTimeResponseSizeExceededError) {
          heartbeatsResult = {
            kind: 'failed',
            code: RECONCILE_CODES.RESPONSE_SIZE_EXCEEDED,
            retryAt: null
          };
          advisoryCodes.push(RECONCILE_CODES.RESPONSE_SIZE_EXCEEDED);
        } else if (err instanceof WakaTimeBudgetTimeoutError) {
          heartbeatsResult = {
            kind: 'failed',
            code: RECONCILE_CODES.DAY_EXECUTION_TIMEOUT,
            retryAt: null
          };
          advisoryCodes.push(RECONCILE_CODES.DAY_EXECUTION_TIMEOUT);
        } else if (err instanceof WakaTimeRequestTimeoutError) {
          heartbeatsResult = {
            kind: 'failed',
            code: RECONCILE_CODES.REQUEST_TIMEOUT,
            retryAt: null
          };
          advisoryCodes.push(RECONCILE_CODES.REQUEST_TIMEOUT);
        } else {
          policy.recordError('heartbeats', err as Error, options.date, getNow());
          heartbeatsResult = {
            kind: 'failed',
            code: 'HEARTBEATS_FAILED',
            retryAt: null
          };
          advisoryCodes.push('HEARTBEATS_FAILED');
        }
      }
    }

    // ========================================================================
    // Step C: Optional Durations Fetch
    // ========================================================================
    if (options.attemptDurations && isSummariesComplete && !isVerifiedZero) {
      if (!policy.shouldAttempt('durations', options.date, getNow())) {
        const hold = policy.getHoldReason('durations', options.date, getNow());
        if (hold?.type === 'date_restriction' || hold?.type === 'global_restriction') {
          durationsResult = {
            attempted: false,
            success: false,
            status: 'restricted',
            code: `HTTP_${hold.statusCode}`,
            retryAt: hold.nextReprobeAt
          };
          advisoryCodes.push('DURATIONS_PLAN_RESTRICTED');
        } else if (hold?.type === 'throttle') {
          durationsResult = {
            attempted: false,
            success: false,
            status: 'restricted',
            code: RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED,
            retryAt: hold.retryAt
          };
          advisoryCodes.push(RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED);
        } else {
          durationsResult = {
            attempted: false,
            success: false,
            status: 'failed',
            code: 'DURATIONS_FAILED',
            retryAt: hold?.nextReprobeAt
          };
          advisoryCodes.push('DURATIONS_FAILED');
        }
      } else {
        try {
          const durRemaining = getRemainingBudget();
          if (durRemaining > 0 && !dayController.signal.aborted) {
            await options.client.getDurations({
              date: options.date,
              timezone: options.pinnedTimezone,
              signal: dayController.signal,
              budgetMs: durRemaining
            });
            policy.recordSuccess('durations', options.date, getNow());
            durationsResult = {
              attempted: true,
              success: true,
              status: 'succeeded'
            };
          }
        } catch (err) {
          if (err instanceof CapabilityRestrictedError) {
            policy.recordRestriction('durations', err.statusCode, options.date, getNow());
            durationsResult = {
              attempted: true,
              success: false,
              status: 'restricted',
              code: `HTTP_${err.statusCode}`
            };
            advisoryCodes.push('DURATIONS_PLAN_RESTRICTED');
          } else if (err instanceof WakaTimeDeferredRetryError) {
            policy.recordDeferredRetry('durations', err.retryAt, options.date, getNow());
            durationsResult = {
              attempted: true,
              success: false,
              status: 'restricted',
              code: RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED,
              retryAt: err.retryAt
            };
            advisoryCodes.push(RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED);
          } else {
            policy.recordError('durations', err as Error, options.date, getNow());
            durationsResult = {
              attempted: true,
              success: false,
              status: 'failed',
              code: 'DURATIONS_FAILED'
            };
            advisoryCodes.push('DURATIONS_FAILED');
          }
        }
      }
    }

    // Build rawSources structure
    const rawSources: FetchDayResult['rawSources'] = {};
    if (exactSummariesRawJson) {
      rawSources.summaries = { rawJson: exactSummariesRawJson };
    }
    if (exactHeartbeatsRawJson) {
      rawSources.heartbeats = {
        rawJson: exactHeartbeatsRawJson,
        events: exactHeartbeatEvents
      };
    }

    const resolvedTimezone =
      options.pinnedTimezone ??
      (summariesResult.kind === 'complete' ? summariesResult.value.timezone : 'UTC');

    const candidate: DayCandidate = {
      date: options.date,
      timezone: resolvedTimezone,
      connectionGeneration: options.connectionGeneration,
      summaries: summariesResult,
      heartbeats: heartbeatsResult
    };

    return {
      candidate,
      rawSources,
      policy,
      durationsResult,
      advisoryCodes: [...new Set(advisoryCodes)]
    };
  } finally {
    clearTimeout(budgetTimer);
    if (options.signal) {
      options.signal.removeEventListener('abort', onCallerAbort);
    }
  }
}
