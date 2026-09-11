/**
 * Contract-only foundation for the Work Times sync engine.
 *
 * Implements and freezes the interfaces required by docs/NEXT-MILESTONE.md §2, 3, 4, 6:
 * - LayerResult and DayCandidate
 * - Normalized Summary & Heartbeat models (fidelity, entity presence, and scope completeness)
 * - ReconcileResult, dispositions, bounded limits, and advisory codes
 * - Run, Date, and Layer lifecycle states and transition validators
 * - Truthful Multi-date Run outcome aggregation
 * - RunRequest, idempotency hashing, and Admin API DTOs
 * - MCP data quality projection contract
 * - Shared limits, execution budgets, and numerical tolerances
 * - Truthful Cadence and per-layer freshness evaluation
 * - Forward migration schema specification (005–008 exact filenames and rebuild rules)
 * - Process lock and runtime lifecycle contract
 */

import { createHash } from 'node:crypto';
import { isValidDateString } from './calendar.js';

// ============================================================================
// 1. Shared Limits, Budgets, and Numerical Invariants
// ============================================================================

/** Duration comparison tolerance: 0.001 seconds (1 millisecond), matching SQL triggers. */
export const DURATION_COMPARISON_TOLERANCE_SECONDS = 0.001;

/** Max active concurrent sync runs: strictly one coordinator process/run at a time. */
export const MAX_ACTIVE_SYNC_RUNS = 1;

/** Max nonterminal runs queued in SQLite before returning 409 SYNC_QUEUE_FULL. */
export const MAX_SYNC_QUEUE_SIZE = 10;

/** Minimum time between start of upstream HTTP requests: 1000ms. */
export const MIN_UPSTREAM_REQUEST_SPACING_MS = 1000;

/** Maximum concurrent in-flight upstream HTTP requests: strictly 1. */
export const MAX_CONCURRENT_UPSTREAM_REQUESTS = 1;

/** Whole-request timeout including body consumption: 30 seconds. */
export const UPSTREAM_REQUEST_TIMEOUT_MS = 30_000;

/** Day execution budget: 5 minutes. */
export const MAX_DAY_EXECUTION_BUDGET_MS = 5 * 60 * 1000;

/** Maximum response payload size: 16 MiB. */
export const MAX_RESPONSE_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** Maximum staged single-day SQLite transaction size: 64 MiB. */
export const MAX_STAGED_DAY_BYTES = 64 * 1024 * 1024;

/** Maximum registry refresh pages, rows, and bytes. */
export const MAX_REGISTRY_PAGES = 100;
export const MAX_REGISTRY_ROWS = 10_000;
export const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;

/** Maximum inclusive calendar days permitted in a single manual backfill run. */
export const MAX_BACKFILL_RANGE_DAYS = 366;

/** Maximum dates selected in a single startup catch-up run. */
export const MAX_CATCHUP_RUN_DATES = 31;

/** Grace period for clean runtime shutdown on SIGTERM/SIGINT: 20 seconds. */
export const SHUTDOWN_GRACE_PERIOD_MS = 20_000;

/** Freshness age thresholds (hours or days). */
export const FRESHNESS_RECENT_HOURS = 2;
export const FRESHNESS_RECONCILE_HOURS = 26;
export const FRESHNESS_COMPARE_DAYS = 8;

// ============================================================================
// 2. Layer Result and Day Candidate
// ============================================================================

export type LayerResult<T> =
  | { kind: 'complete'; value: T; contentHash: string; observedAt: string }
  | { kind: 'restricted'; code: string; retryAt: string }
  | { kind: 'failed'; code: string; retryAt: string | null }
  | { kind: 'skipped'; reason: string };

export type DayCandidate = {
  date: string;
  timezone: string;
  connectionGeneration: number;
  summaries: LayerResult<NormalizedSummaryDay>;
  heartbeats: LayerResult<NormalizedHeartbeatDay>;
};

// ============================================================================
// 3. Normalized Summary and Heartbeat Models
// ============================================================================

export type SummaryFidelity = 'entity_detail' | 'coarse_project' | 'verified_zero';

/**
 * Per-project entity detail presence state:
 * - 'present': entities breakdown array was returned with entries.
 * - 'empty': entities breakdown array was explicitly returned as empty array [] (authoritative zero entities).
 * - 'absent': entities breakdown field was omitted / undefined in upstream response (flat summary, detail missing!).
 */
export type EntityDetailState = 'present' | 'empty' | 'absent';

export interface ProjectScopeCompleteness {
  projectName: string;
  totalSeconds: number;
  entityDetailState: EntityDetailState;
  entityCount: number;
}

export interface SummaryCompleteness {
  hasAccountTotals: boolean;
  hasProjectTotals: boolean;
  hasEntityDetail: boolean;
  isVerifiedZero: boolean;
  overallEntityDetailState: 'complete_detail' | 'coarse_only' | 'mixed' | 'empty';
  projectScopes: Record<string, ProjectScopeCompleteness>;
  missingFields: string[];
}

/**
 * Validates whether an incoming summary candidate's project completeness covers
 * all scopes of a previously accepted day snapshot.
 */
export function coversRetainedScopes(
  incoming: SummaryCompleteness,
  accepted: SummaryCompleteness
): boolean {
  for (const [projectName, acceptedScope] of Object.entries(accepted.projectScopes)) {
    const incomingScope = incoming.projectScopes[projectName];
    if (!incomingScope) {
      return false; // Retained project missing entirely from incoming replacement
    }
    if (acceptedScope.entityDetailState !== 'absent' && incomingScope.entityDetailState === 'absent') {
      return false; // Project has suffered detail downgrade
    }
  }
  return true;
}

export type SliceKind = 'entity' | 'project_summary' | 'unattributed_residual';

export interface NormalizedSlice {
  projectName: string;
  entity: string;
  entityType: 'file' | 'app' | 'domain' | 'unattributed';
  totalSeconds: number;
  kind: SliceKind;
  isUnattributed: boolean;
  projectRootCount?: number | null;
  humanAdditions: number;
  humanDeletions: number;
  aiAdditions: number;
  aiDeletions: number;
  aiSessions: number;
}

export interface NormalizedProjectSummary {
  name: string;
  totalSeconds: number;
  percent: number;
  entityDetailState: EntityDetailState;
  hasEntityDetail: boolean;
  entities: Array<{
    name: string;
    type: 'file' | 'app' | 'domain';
    totalSeconds: number;
    percent?: number;
    projectRootCount?: number | null;
    humanAdditions?: number;
    humanDeletions?: number;
    aiAdditions?: number;
    aiDeletions?: number;
    aiSessions?: number;
  }>;
}

export interface NormalizedScopedDimension {
  scope: 'account' | 'project';
  projectName?: string | null;
  dimension:
    | 'project'
    | 'category'
    | 'dependency'
    | 'editor'
    | 'entity'
    | 'language'
    | 'machine'
    | 'operating_system'
    | 'branch';
  name: string;
  entityType?: 'file' | 'app' | 'domain' | null;
  machineNameId?: string | null;
  totalSeconds: number;
  percent?: number | null;
  rawJson?: string;
}

export interface NormalizedSummaryDay {
  date: string;
  timezone: string;
  totalSeconds: number;
  projectSumSeconds: number;
  projectSumDelta: number;
  fidelity: SummaryFidelity;
  completeness: SummaryCompleteness;
  grandTotal: {
    total_seconds: number;
    human_additions: number;
    human_deletions: number;
    ai_additions: number;
    ai_deletions: number;
    ai_sessions: number;
    ai_input_tokens?: number;
    ai_output_tokens?: number;
  };
  projects: NormalizedProjectSummary[];
  scopedDimensions: NormalizedScopedDimension[];
  slices: NormalizedSlice[];
}

export interface NormalizedHeartbeatEvent {
  id: string; // WakaTime external UUID
  occurredAtUs: number; // epoch microseconds
  occurredAt: string; // ISO 8601 UTC
  localDate: string; // YYYY-MM-DD enclosing date
  entity: string;
  entityType: 'file' | 'app' | 'domain';
  category: string;
  projectName: string | null;
  branch: string | null;
  language: string | null;
  dependencies: string[]; // canonicalized: sorted, unique, NFC
  machineNameId: string | null;
  userAgentId: string;
  isWrite: boolean;
  lines: number | null;
  lineno: number | null;
  cursorpos: number | null;
  canonicalHash: string; // SHA-256 of canonical payload
}

export interface HeartbeatCompleteness {
  isComplete: boolean;
  eventCount: number;
  hasCanonicalPayloads: boolean;
  unsupportedEventCount: number;
  conflictEventCount: number;
}

export interface NormalizedHeartbeatDay {
  date: string;
  timezone: string;
  heartbeats: NormalizedHeartbeatEvent[];
  completeness: HeartbeatCompleteness;
}

// ============================================================================
// 4. Reconciliation Contract & Advisory Codes
// ============================================================================

export type ReconcileDisposition = 'updated' | 'unchanged' | 'preserved' | 'rejected';
export type ReconcileDayStatus = 'succeeded' | 'partial' | 'failed' | 'skipped';

export const RECONCILE_CODES = {
  DETAIL_DOWNGRADE: 'DETAIL_DOWNGRADE',
  CURRENT_DAY_PROVISIONAL: 'CURRENT_DAY_PROVISIONAL',
  TIMEZONE_CHANGED: 'TIMEZONE_CHANGED',
  TIMEZONE_MISMATCH: 'TIMEZONE_MISMATCH',
  NEGATIVE_RESIDUAL: 'NEGATIVE_RESIDUAL',
  OVERCOUNT_TOLERANCE_EXCEEDED: 'OVERCOUNT_TOLERANCE_EXCEEDED',
  MATHEMATICAL_INVARIANT_VIOLATION: 'MATHEMATICAL_INVARIANT_VIOLATION',
  MISSING_REQUESTED_DATE: 'MISSING_REQUESTED_DATE',
  INCOMPLETE_BODY: 'INCOMPLETE_BODY',
  VERIFIED_ZERO_ACCEPTED: 'VERIFIED_ZERO_ACCEPTED',
  STALE_CONNECTION_GENERATION: 'STALE_CONNECTION_GENERATION',
  STALE_SNAPSHOT_VERSION: 'STALE_SNAPSHOT_VERSION',
  RUN_CANCELLED: 'RUN_CANCELLED',
  NO_DATES_UPDATED: 'NO_DATES_UPDATED',
  SYNC_QUEUE_FULL: 'SYNC_QUEUE_FULL',
  RESPONSE_SIZE_EXCEEDED: 'RESPONSE_SIZE_EXCEEDED',
  STAGED_DAY_SIZE_EXCEEDED: 'STAGED_DAY_SIZE_EXCEEDED',
  REGISTRY_PAGE_LIMIT_EXCEEDED: 'REGISTRY_PAGE_LIMIT_EXCEEDED',
  REGISTRY_ROW_LIMIT_EXCEEDED: 'REGISTRY_ROW_LIMIT_EXCEEDED',
  REGISTRY_BYTE_LIMIT_EXCEEDED: 'REGISTRY_BYTE_LIMIT_EXCEEDED',
  DAY_EXECUTION_TIMEOUT: 'DAY_EXECUTION_TIMEOUT',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  UPSTREAM_RETRY_AFTER_EXCEEDED: 'UPSTREAM_RETRY_AFTER_EXCEEDED',
  UNSUPPORTED_HEARTBEAT_ID: 'UNSUPPORTED_HEARTBEAT_ID',
  UNSUPPORTED_HEARTBEAT_ENVELOPE: 'UNSUPPORTED_HEARTBEAT_ENVELOPE',
  UNSUPPORTED_HEARTBEAT_DEPENDENCY: 'UNSUPPORTED_HEARTBEAT_DEPENDENCY',
  HEARTBEAT_PAYLOAD_CONFLICT: 'HEARTBEAT_PAYLOAD_CONFLICT',
  REGISTRY_PAGE_REPETITION: 'REGISTRY_PAGE_REPETITION',
  REGISTRY_CONFLICTING_ID: 'REGISTRY_CONFLICTING_ID',
  REGISTRY_INVALID_PAGINATION: 'REGISTRY_INVALID_PAGINATION'
} as const;

export type ReconcileCode = (typeof RECONCILE_CODES)[keyof typeof RECONCILE_CODES];

export type ReconcileResult = {
  disposition: ReconcileDisposition;
  dayStatus: ReconcileDayStatus;
  codes: string[];
};

// ============================================================================
// 5. Lifecycle States and Transition Helpers
// ============================================================================

export const RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'interrupted'
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const SYNC_DAY_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'partial',
  'failed',
  'skipped',
  'cancelled',
  'interrupted'
] as const;
export type SyncDayStatus = (typeof SYNC_DAY_STATUSES)[number];

export const LAYER_STATUSES = ['succeeded', 'failed', 'restricted', 'skipped'] as const;
export type LayerStatus = (typeof LAYER_STATUSES)[number];

export const RUN_REQUEST_MODES = ['recent', 'backfill', 'compare', 'retry', 'registry'] as const;
export type RunRequestMode = (typeof RUN_REQUEST_MODES)[number];

export const RUN_TRIGGERS = ['manual', 'scheduled', 'startup', 'catchup'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/**
 * Validates transitions between run statuses according to docs/NEXT-MILESTONE.md §3.1:
 * queued -> running -> succeeded / partial / failed / cancelled / interrupted
 * Terminal states (succeeded, partial, failed, cancelled, interrupted) cannot transition.
 */
export function isValidRunTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true; // idempotent self-transition

  switch (from) {
    case 'queued':
      return to === 'running' || to === 'cancelled' || to === 'interrupted';
    case 'running':
      return (
        to === 'succeeded' ||
        to === 'partial' ||
        to === 'failed' ||
        to === 'cancelled' ||
        to === 'interrupted'
      );
    case 'succeeded':
    case 'partial':
    case 'failed':
    case 'cancelled':
    case 'interrupted':
      return false; // terminal
    default:
      return false;
  }
}

export function assertValidRunTransition(from: RunStatus, to: RunStatus): void {
  if (!isValidRunTransition(from, to)) {
    throw new Error(`Invalid sync run status transition: cannot change from "${from}" to "${to}"`);
  }
}

/**
 * Validates transitions between per-date sync statuses according to docs/NEXT-MILESTONE.md §3.1:
 * pending -> running -> succeeded / partial / failed / skipped / cancelled / interrupted
 */
export function isValidDateTransition(from: SyncDayStatus, to: SyncDayStatus): boolean {
  if (from === to) return true;

  switch (from) {
    case 'pending':
      return to === 'running' || to === 'cancelled' || to === 'interrupted' || to === 'skipped';
    case 'running':
      return (
        to === 'succeeded' ||
        to === 'partial' ||
        to === 'failed' ||
        to === 'skipped' ||
        to === 'cancelled' ||
        to === 'interrupted'
      );
    case 'succeeded':
    case 'partial':
    case 'failed':
    case 'skipped':
    case 'cancelled':
    case 'interrupted':
      return false;
    default:
      return false;
  }
}

export function assertValidDateTransition(from: SyncDayStatus, to: SyncDayStatus): void {
  if (!isValidDateTransition(from, to)) {
    throw new Error(`Invalid sync day status transition: cannot change from "${from}" to "${to}"`);
  }
}

/**
 * Helper to determine if an advisory code represents capability degradation,
 * detail downgrade, restriction, or error.
 */
function isDegradedOrWarningCode(code: string): boolean {
  if (code === RECONCILE_CODES.CURRENT_DAY_PROVISIONAL) {
    return false; // Informational advisory only, not degradation
  }
  if (code === RECONCILE_CODES.VERIFIED_ZERO_ACCEPTED) {
    return false; // Legitimate full success
  }
  return (
    code === RECONCILE_CODES.DETAIL_DOWNGRADE ||
    code === RECONCILE_CODES.NO_DATES_UPDATED ||
    code.endsWith('_RESTRICTED') ||
    code.endsWith('_ERROR') ||
    code.startsWith('UNSUPPORTED_') ||
    code.startsWith('OVERCOUNT_') ||
    code.startsWith('NEGATIVE_') ||
    code.startsWith('MATHEMATICAL_') ||
    code.startsWith('TIMEZONE_') ||
    code.startsWith('MISSING_') ||
    code.startsWith('INCOMPLETE_') ||
    code.startsWith('REGISTRY_') ||
    code.startsWith('STALE_')
  );
}

/**
 * Computes the aggregate outcome of a sync run across ALL date records.
 *
 * Enforces (docs/NEXT-MILESTONE.md §3.1 & supervisor findings):
 * 1. Rejects nonterminal date input (pending/running) with an explicit error.
 * 2. Explicit cancellation or interruption wins for the run lifecycle.
 * 3. Never reports 'succeeded' if ANY date has a preserved or rejected disposition,
 *    or any degraded capability / detail warning code.
 * 4. All dates accepted or checked unchanged, with required detail/evidence met: succeeded.
 * 5. Some useful acceptance/comparison, but any failure, restriction, fidelity
 *    preservation, or optional-layer degradation: partial.
 * 6. All dates intentionally restricted/skipped: partial with NO_DATES_UPDATED (never succeeded).
 * 7. No useful result and an operational or baseline validation/auth failure: failed.
 */
export function aggregateRunOutcome(
  dateResults: Array<{
    date?: string;
    status: SyncDayStatus;
    codes?: string[];
    disposition?: ReconcileDisposition;
  }>,
  options?: {
    isCancelled?: boolean;
    isInterrupted?: boolean;
    isRegistryRun?: boolean;
    registrySuccess?: boolean;
  }
): {
  status: RunStatus;
  advisoryCodes: string[];
  summary: string;
} {
  if (options?.isCancelled) {
    return {
      status: 'cancelled',
      advisoryCodes: [RECONCILE_CODES.RUN_CANCELLED],
      summary: 'Sync run was cancelled by operator request'
    };
  }

  if (options?.isInterrupted) {
    return {
      status: 'interrupted',
      advisoryCodes: [],
      summary: 'Sync run was interrupted by server shutdown or restart'
    };
  }

  if (options?.isRegistryRun) {
    if (options.registrySuccess) {
      return {
        status: 'succeeded',
        advisoryCodes: [],
        summary: 'User-agent registry refreshed and published successfully'
      };
    }
    return {
      status: 'failed',
      advisoryCodes: [],
      summary: 'User-agent registry refresh failed; existing registry retained'
    };
  }

  if (dateResults.length === 0) {
    return {
      status: 'failed',
      advisoryCodes: [],
      summary: 'Sync run contained zero date records'
    };
  }

  // Enforce terminal date inputs
  for (const dr of dateResults) {
    if (dr.status === 'pending' || dr.status === 'running') {
      throw new Error(
        `Cannot aggregate terminal outcome of run containing nonterminal date status "${dr.status}" on date ${dr.date || 'unknown'}`
      );
    }
  }

  const advisorySet = new Set<string>();
  let countSucceeded = 0;
  let countPartial = 0;
  let countFailed = 0;
  let countSkipped = 0;
  let countCancelled = 0;
  let countInterrupted = 0;
  let hasUpdatedOrUnchanged = false;
  let hasPreservedOrRejected = false;
  let hasDegradedOrDetailWarning = false;
  let allSucceededProvedDisposition = true;

  for (const dr of dateResults) {
    if (dr.codes) {
      for (const c of dr.codes) {
        advisorySet.add(c);
        if (isDegradedOrWarningCode(c)) {
          hasDegradedOrDetailWarning = true;
        }
      }
    }
    if (dr.disposition === 'updated' || dr.disposition === 'unchanged') {
      hasUpdatedOrUnchanged = true;
    }
    if (dr.disposition === 'preserved' || dr.disposition === 'rejected') {
      hasPreservedOrRejected = true;
    }

    switch (dr.status) {
      case 'succeeded':
        countSucceeded++;
        if (dr.disposition !== 'updated' && dr.disposition !== 'unchanged') {
          allSucceededProvedDisposition = false;
        }
        break;
      case 'partial':
        countPartial++;
        break;
      case 'failed':
        countFailed++;
        break;
      case 'skipped':
        countSkipped++;
        break;
      case 'cancelled':
        countCancelled++;
        break;
      case 'interrupted':
        countInterrupted++;
        break;
      default:
        break;
    }
  }

  if (countCancelled > 0) {
    return {
      status: 'cancelled',
      advisoryCodes: [...advisorySet],
      summary: 'Sync run ended with cancelled dates'
    };
  }

  if (countInterrupted > 0) {
    return {
      status: 'interrupted',
      advisoryCodes: [...advisorySet],
      summary: 'Sync run ended with interrupted dates'
    };
  }

  // All dates skipped/restricted
  if (countSkipped === dateResults.length) {
    advisorySet.add(RECONCILE_CODES.NO_DATES_UPDATED);
    return {
      status: 'partial',
      advisoryCodes: [...advisorySet],
      summary: 'All dates in sync run were restricted or skipped; no archive data updated'
    };
  }

  // Strict check for 'succeeded':
  // Must have 100% succeeded dates, zero failures/partials/skips, NO preserved/rejected disposition,
  // NO degraded or detail warning codes, AND every succeeded date must explicitly prove disposition
  // 'updated' or 'unchanged'. Missing disposition is not proof of success.
  if (
    countSucceeded === dateResults.length &&
    countFailed === 0 &&
    countPartial === 0 &&
    countSkipped === 0 &&
    !hasPreservedOrRejected &&
    !hasDegradedOrDetailWarning &&
    allSucceededProvedDisposition
  ) {
    return {
      status: 'succeeded',
      advisoryCodes: [...advisorySet],
      summary: `Successfully synced ${countSucceeded} date(s)`
    };
  }

  // Complete failure: no useful acceptance or comparison, and failures present
  if (!hasUpdatedOrUnchanged && countFailed > 0 && countSucceeded === 0 && !hasPreservedOrRejected) {
    return {
      status: 'failed',
      advisoryCodes: [...advisorySet],
      summary: `Sync run failed across all ${dateResults.length} date(s)`
    };
  }

  // Otherwise partial: some successes/comparisons, but with failures, restrictions, downgrades, or preserved detail
  return {
    status: 'partial',
    advisoryCodes: [...advisorySet],
    summary: `Sync run partially completed (${countSucceeded} succeeded, ${countPartial} partial, ${countFailed} failed, ${countSkipped} skipped)`
  };
}

// ============================================================================
// 6. RunRequest, Idempotency, and Admin API DTOs
// ============================================================================

export interface RunRequest {
  mode: RunRequestMode;
  trigger: RunTrigger;
  idempotencyKey: string;
  rangeStartDate?: string; // YYYY-MM-DD
  rangeEndDate?: string; // YYYY-MM-DD
  retryDates?: string[]; // explicit YYYY-MM-DD dates for mode='retry'
  resumedFromRunId?: number; // for recovery
}

/**
 * Computes a deterministic SHA-256 hash of the semantic payload of a RunRequest,
 * used to verify idempotency (same key + same payload = replay; same key + different payload = 409).
 */
export function computeRunRequestPayloadHash(req: RunRequest): string {
  const semantic = {
    mode: req.mode,
    trigger: req.trigger,
    rangeStartDate: req.rangeStartDate ?? null,
    rangeEndDate: req.rangeEndDate ?? null,
    retryDates: req.retryDates ? [...req.retryDates].sort() : null,
    resumedFromRunId: req.resumedFromRunId ?? null
  };
  return createHash('sha256').update(JSON.stringify(semantic), 'utf8').digest('hex');
}

export interface CreateSyncRunRequestBody {
  mode: RunRequestMode;
  idempotencyKey: string;
  rangeStartDate?: string;
  rangeEndDate?: string;
  retryDates?: string[];
}

export interface CreateSyncRunResponseBody {
  runId: number;
  statusUrl: string;
  reused: boolean;
}

export interface SyncRunDetailDateItem {
  date: string;
  status: SyncDayStatus;
  disposition: ReconcileDisposition | null;
  summariesStatus: LayerStatus | null;
  heartbeatsStatus: LayerStatus | null;
  totalSeconds: number;
  codes: string[];
  errorMessage: string | null;
  syncedAt: string;
}

export interface SyncRunDetailResponseBody {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  mode: RunRequestMode;
  rangeStartDate: string | null;
  rangeEndDate: string | null;
  dayCount: number;
  daysCompleted: number;
  daysFailed: number;
  advisoryCodes: string[];
  summary: string | null;
  errorMessage: string | null;
  dates: SyncRunDetailDateItem[];
}

export interface CancelSyncRunResponseBody {
  runId: number;
  status: RunStatus;
  cancelledAt: string;
}

export interface RetrySyncRunRequestBody {
  targetDate?: string; // optional single-date retry
}

export interface RetrySyncRunResponseBody {
  newRunId: number;
  parentRunId: number;
  statusUrl: string;
  scheduledDates: string[];
}

export interface UpdateSyncSettingsRequestBody {
  schedulingEnabled?: boolean;
  bindCurrentConnection?: boolean;
}

export interface UpdateSyncSettingsResponseBody {
  schedulingEnabled: boolean;
  connectionGeneration: number;
  boundArchiveIdentity: string | null;
  updatedAt: string;
}

export interface RefreshRegistryResponseBody {
  queued: boolean;
  status: 'published' | 'retained';
  lastRefreshAt: string;
}

// ============================================================================
// 7. MCP Data Quality Projection Contract
// ============================================================================

export interface McpDataQuality {
  asOf: string | null; // oldest required summary verification timestamp, or null if missing days
  hasMissingDays: boolean;
  hasStaleDays: boolean;
  hasLimitedDetail: boolean;
  advisoryCodes: string[];
}

/**
 * Bounds MCP quality metadata to the requested range and scrubs non-work identities,
 * personal seconds, raw upstream errors, and internal registry state.
 */
export function sanitizeMcpDataQuality(quality: McpDataQuality): McpDataQuality {
  const allowedCodePrefixes = [
    'DETAIL_',
    'CURRENT_DAY_',
    'TIMEZONE_',
    'NO_DATES_',
    'RESIDUAL_',
    'STALE_'
  ];

  const filteredCodes = quality.advisoryCodes.filter((code) =>
    allowedCodePrefixes.some((prefix) => code.startsWith(prefix))
  );

  return {
    asOf: quality.hasMissingDays ? null : quality.asOf,
    hasMissingDays: quality.hasMissingDays,
    hasStaleDays: quality.hasStaleDays,
    hasLimitedDetail: quality.hasLimitedDetail,
    advisoryCodes: [...new Set(filteredCodes)]
  };
}

// ============================================================================
// 8. Truthful Cadence and Freshness Policies
// ============================================================================

export interface LayerFreshnessRecord {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastAcceptedChangeAt: string | null;
  acceptedSourceReference: string | null;
  acceptedSnapshotVersion: number | null;
  acceptedFidelity: SummaryFidelity | null;
  acceptedContentHash: string | null;
  verifiedTimezone: string | null;
  evidenceMatchesSummary: boolean | null;
  statusCode: string | null;
  nextRetryAt: string | null;
  isStale: boolean;
  unresolvedMismatch?: boolean;
  hasDetailDowngrade?: boolean;
  hasRestriction?: boolean;
  hasFailure?: boolean;
}

export interface FreshnessEvaluation {
  isStale: boolean;
  reasons: string[];
  isProvisional: boolean;
}

/**
 * Evaluates whether an archive date's layer freshness is truthful.
 *
 * Rules (docs/NEXT-MILESTONE.md §2.5 & supervisor findings):
 * 1. Unresolved restriction, failure, mismatch, or detail downgrade remains STALE regardless of age.
 * 2. A record explicitly marked isStale remains STALE.
 * 3. Invalid timestamps, missing success timestamps, and future dates fail closed as STALE.
 * 4. Disagreement between evidence and summary, or verified timezone and current timezone, is STALE.
 * 5. Today returns CURRENT_DAY_PROVISIONAL until a successful check after its source-calendar day closes.
 * 6. Standard age thresholds: 2 hours (today/yesterday), 26 hours (14-day window), 8 days (90-day comparison).
 */
export function evaluateDateFreshness(
  date: string,
  record: LayerFreshnessRecord,
  now: Date = new Date(),
  timezone: string = 'UTC'
): FreshnessEvaluation {
  const reasons: string[] = [];

  // Strict date validation: fail closed on invalid calendar date format
  if (!isValidDateString(date)) {
    return {
      isStale: true,
      reasons: ['INVALID_DATE_STRING'],
      isProvisional: false
    };
  }

  // Check provisional state for today in source timezone
  const nowParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);

  let year = 0;
  let month = 0;
  let day = 0;
  for (const p of nowParts) {
    if (p.type === 'year') year = Number.parseInt(p.value, 10);
    if (p.type === 'month') month = Number.parseInt(p.value, 10);
    if (p.type === 'day') day = Number.parseInt(p.value, 10);
  }
  const todayStr = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const isProvisional = date === todayStr;

  if (isProvisional) {
    reasons.push(RECONCILE_CODES.CURRENT_DAY_PROVISIONAL);
  }

  // Future requested dates fail closed as stale instead of being treated as recent
  if (date > todayStr) {
    reasons.push('FUTURE_REQUESTED_DATE');
  }

  // 1. Explicitly marked stale
  if (record.isStale) {
    reasons.push('EXPLICITLY_MARKED_STALE');
  }

  // 2. Unresolved failure, restriction, mismatch, or detail downgrade
  if (
    record.unresolvedMismatch ||
    record.statusCode === RECONCILE_CODES.TIMEZONE_MISMATCH ||
    record.statusCode === RECONCILE_CODES.TIMEZONE_CHANGED
  ) {
    reasons.push('UNRESOLVED_MISMATCH');
  }

  // Only mark stale if an actual downgrade/preservation signal occurred, NOT merely because accepted fidelity is coarse_project
  if (
    record.hasDetailDowngrade ||
    record.statusCode === RECONCILE_CODES.DETAIL_DOWNGRADE
  ) {
    reasons.push('DETAIL_DOWNGRADE_PRESERVED');
  }

  if (
    record.hasRestriction ||
    record.statusCode?.startsWith('HTTP_402') ||
    record.statusCode?.startsWith('HTTP_403') ||
    Boolean(record.nextRetryAt)
  ) {
    reasons.push('UNRESOLVED_RESTRICTION');
  }

  if (
    record.hasFailure ||
    record.statusCode?.startsWith('HTTP_5') ||
    record.statusCode === 'FAILED'
  ) {
    reasons.push('UNRESOLVED_FAILURE');
  }

  // 3. Evidence matches summary check
  if (record.evidenceMatchesSummary === false) {
    reasons.push('EVIDENCE_SUMMARY_MISMATCH');
  }

  // 4. Timezone verification
  if (record.verifiedTimezone && record.verifiedTimezone !== timezone) {
    reasons.push('TIMEZONE_MISMATCH');
  }

  // 5. Success timestamp validation (fail closed on null, unparseable, or future dates)
  if (!record.lastSuccessAt) {
    reasons.push('NEVER_SUCCESSFULLY_SYNCED');
    return { isStale: true, reasons, isProvisional };
  }

  const successTime = Date.parse(record.lastSuccessAt);
  if (Number.isNaN(successTime)) {
    reasons.push('INVALID_LAST_SUCCESS_TIMESTAMP');
    return { isStale: true, reasons, isProvisional };
  }

  if (successTime > now.getTime()) {
    reasons.push('FUTURE_LAST_SUCCESS_TIMESTAMP');
    return { isStale: true, reasons, isProvisional };
  }

  // 6. Age threshold validation
  const ageHours = (now.getTime() - successTime) / (1000 * 60 * 60);

  const todayUtc = Date.UTC(year, month - 1, day);
  const [dY, dM, dD] = date.split('-').map((v) => Number.parseInt(v, 10));
  const dateUtc = Date.UTC(dY, dM - 1, dD);
  const daysDiff = Math.round((todayUtc - dateUtc) / 86_400_000);

  if (daysDiff < 0) {
    // Future date: already marked as FUTURE_REQUESTED_DATE above; not treated as recent
  } else if (daysDiff <= 1) {
    // Today or yesterday: 2-hour threshold
    if (ageHours > FRESHNESS_RECENT_HOURS) {
      reasons.push(`RECENT_EXCEEDED_${FRESHNESS_RECENT_HOURS}H`);
    }
  } else if (daysDiff <= 14) {
    // Remaining dates in 14-day reconciliation window: 26-hour threshold
    if (ageHours > FRESHNESS_RECONCILE_HOURS) {
      reasons.push(`RECONCILE_EXCEEDED_${FRESHNESS_RECONCILE_HOURS}H`);
    }
  } else if (daysDiff <= 90) {
    // Comparison window (preceding 90 days): 8-day threshold
    const ageDays = ageHours / 24;
    if (ageDays > FRESHNESS_COMPARE_DAYS) {
      reasons.push(`COMPARE_EXCEEDED_${FRESHNESS_COMPARE_DAYS}D`);
    }
  }

  // If reasons contain anything other than CURRENT_DAY_PROVISIONAL, it is stale
  const hasStalenessReason = reasons.some((r) => r !== RECONCILE_CODES.CURRENT_DAY_PROVISIONAL);

  return {
    isStale: hasStalenessReason,
    reasons,
    isProvisional
  };
}

// ============================================================================
// 9. Forward Migration Specification (P1)
// ============================================================================

export interface MigrationSpec {
  number: string;
  filename: string;
  name: string;
  purpose: string;
  tables: string[];
  rebuildRules: string[];
}

/**
 * Exact orchestrator-frozen migration sequence for Package P1.
 *
 * Invariants:
 * - Versioned forward migrations only; migrations 001–004 are never modified.
 * - Table rebuilds must be wrapped in transactions with foreign keys enabled.
 * - Rebuilds must preserve existing IDs, child rows, indexes, triggers, and append-only audit history.
 */
export const RECOMMENDED_MIGRATION_SEQUENCE: MigrationSpec[] = [
  {
    number: '005',
    filename: '005-sync-lifecycle.sql',
    name: 'sync-lifecycle',
    purpose:
      'Extend sync_runs and sync_days with queued/interrupted/cancelled states, request modes (recent/backfill/compare/retry/registry), idempotency hash, recovery links, queue limit triggers, and per-layer accepted vs observed state tracking.',
    tables: ['sync_runs', 'sync_days', 'sync_layer_state'],
    rebuildRules: [
      'Wrap in runner transaction with foreign keys enabled.',
      'Rebuild sync_runs to expand CHECK constraint to 7 states (queued, running, succeeded, partial, failed, cancelled, interrupted).',
      'Rebuild sync_days to expand CHECK constraint to 8 states and add disposition.',
      'Preserve existing run and day IDs and foreign key integrity.'
    ]
  },
  {
    number: '006',
    filename: '006-reconciliation-overlay.sql',
    name: 'reconciliation-overlay',
    purpose:
      'Migrate daily_time_allocations from ON DELETE CASCADE to detached state with the transitional legacy allocation identity (date, project_id, entity) and append-only reconciliation revisions; add slice kind/identity constraints for project_summary and unattributed residual slices; introduce active heartbeat membership relation seeded from existing heartbeats; preserve foreign keys under transactional SQLite table rebuilds.',
    tables: [
      'day_project_entity_slices',
      'daily_time_allocations',
      'heartbeat_memberships',
      'classification_revisions'
    ],
    rebuildRules: [
      'Remove ON DELETE CASCADE from daily_time_allocations without deleting user decisions.',
      'Add state (active, detached), detached_at, and reattached_at to daily_time_allocations.',
      'Update allocation duration triggers to permit detached rows without matching slices.',
      'Add kind (entity, project_summary, unattributed_residual) to day_project_entity_slices.',
      'Seed heartbeat_memberships from all existing heartbeats as active (active = 1).'
    ]
  },
  {
    number: '007',
    filename: '007-user-agent-registry.sql',
    name: 'user-agent-registry',
    purpose:
      'Durable allowlisted user-agent registry with atomic publication staging, historical mapping retention, and refresh generation metadata.',
    tables: ['user_agent_registry', 'user_agent_registry_staging'],
    rebuildRules: [
      'Create allowlisted user_agent_registry table with primary key UUID.',
      'Create user_agent_registry_staging table with identical schema for whole-refresh staging.',
      'Ensure historical mappings absent from newer responses remain available with is_historical = 1.'
    ]
  },
  {
    number: '008',
    filename: '008-connection-lifecycle.sql',
    name: 'connection-lifecycle',
    purpose:
      'Add connection generation integer and archive identity binding to wakatime_oauth_connection with CAS guard on credential update.',
    tables: ['wakatime_oauth_connection'],
    rebuildRules: [
      'Add generation (INTEGER DEFAULT 1), bound_archive_identity, and rebound_at columns.',
      'Add trigger enforcing CAS comparison (WHERE generation = NEW.generation) on update.'
    ]
  },
  {
    number: '009',
    filename: '009-slice-semantic-identity.sql',
    name: 'slice-semantic-identity',
    purpose:
      'Complete collision-proof slice and allocation identity as (date, project_id, entity, entity_type, kind), preserving stable IDs, detached decisions, and append-only revision history without guessing across semantic boundaries.',
    tables: ['day_project_entity_slices', 'daily_time_allocations', 'slice_identities', 'classification_revisions'],
    rebuildRules: [
      'Run as a forward-only runner transaction with foreign keys enabled.',
      'Rebuild slice and allocation uniqueness around (date, project_id, entity, entity_type, kind).',
      'Populate each legacy allocation only from exactly one matching current slice; fail and roll back missing or ambiguous mappings.',
      'Preserve slice and allocation IDs, source references, child identities, foreign keys, detached state, user decisions, and revision history.',
      'Match allocation validation triggers on the complete semantic key so coarse and entity decisions cannot steal each other.'
    ]
  }
];

// ============================================================================
// 10. Process Lock and Runtime Lifecycle Contract
// ============================================================================

/** Symbol for process-local runtime lifecycle registry. */
export const LIFECYCLE_SYMBOL = Symbol.for('work-times.lifecycle');

export interface RuntimeReadiness {
  ready: boolean;
  migrationsComplete: boolean;
  recoveryComplete: boolean;
  serviceRegistered: boolean;
  ownershipLockHeld: boolean;
}

export interface LifecycleHandle {
  start(): Promise<void>;
  stop(reason: 'shutdown', deadlineMs: number): Promise<void>;
  getReadiness(): RuntimeReadiness;
}

export interface ProcessLock {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
  isHeld(): boolean;
}

export interface SyncService {
  enqueue(input: RunRequest): Promise<{ runId: number; reused: boolean }>;
  cancel(runId: number): Promise<RunStatus>;
  start(): Promise<void>;
  stop(reason: 'shutdown', deadlineMs: number): Promise<void>;
}
