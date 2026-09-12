import type Database from 'better-sqlite3';
import type { RuntimeConfig } from '../config.js';
import type { CapabilityPolicyState, CapabilityRecord, SyncCapability } from '../sync/capabilities.js';
import { formatDuration } from './overview.js';
import {
  allowlistedNullableValue,
  allowlistedValue,
  boundedCsvList,
  clampCount,
  clampSeconds,
  parseCapabilityPolicyState,
  truncateNullableText,
  truncateText,
  MAX_LABEL_LENGTH,
  MAX_DIAGNOSTIC_LENGTH,
  SYNC_STEP_STATUSES
} from './sanitize.js';
import {
  RECONCILE_CODES,
  evaluateDateFreshness,
  type SyncService,
  type LayerFreshnessRecord,
  type SummaryFidelity,
  type RunRequestMode,
  type RunTrigger,
  type RunStatus,
  type SyncDayStatus,
  type RunRequest
} from '../sync/contracts.js';
import { isValidDateString, getZonedDateString, getRecentIntentDates } from '../sync/calendar.js';
import type { SqliteSyncRepository } from '../db/repositories/sync.js';
import { runtime, type ServerRuntime, type RuntimeReadiness } from '../runtime.js';
import type { SyncScheduler, SchedulerScheduleState } from '../sync/scheduler.js';

export class AdminSyncReadError extends Error {
  readonly code = 'SYNC_STATE_UNAVAILABLE';
  readonly status = 503;
  constructor(message = 'Sync state unavailable') {
    super(message);
    this.name = 'AdminSyncReadError';
  }
}

/** Hard cap on sync run rows materialized for the sync page. */
export const MAX_SYNC_RUN_ROWS = 50;
/** Hard cap on per-day sync rows materialized for the sync page. */
export const MAX_SYNC_DAY_ROWS = 50;
/** Hard cap on degraded-capability / advisory codes surfaced per run. */
export const MAX_SYNC_RUN_CODES = 25;

export const RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'interrupted'
] as const;

export const DATE_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'partial',
  'failed',
  'skipped',
  'cancelled',
  'interrupted'
] as const;

export const RUN_MODES = [
  'recent',
  'backfill',
  'compare',
  'retry',
  'registry'
] as const;

export const RUN_TRIGGERS = [
  'manual',
  'scheduled',
  'startup',
  'catchup'
] as const;

export type QualityStatus =
  | 'verified'
  | 'degraded'
  | 'provisional'
  | 'stale'
  | 'failed'
  | 'empty'
  | 'missing'
  | 'restricted'
  | 'reconnect_required'
  | 'archived_detail_preserved'
  | 'checked_unchanged'
  | 'updated'
  | 'comparison_only'
  | 'current_day_provisional'
  | 'verified_zero';

export interface DateQualityProjection {
  date: string;
  qualityStatus: QualityStatus;
  isStale: boolean;
  isProvisional: boolean;
  disposition?: string;
  lastSyncedAt: string | null;
  degradedLayers: string[];
}

export interface AdminSyncReadinessDto extends RuntimeReadiness {
  oauthAppConfigured: boolean;
  oauthConnected: boolean;
  hasActiveGrant: boolean;
  isBlocked: boolean;
  reconnectRequired: boolean;
  discoveryReady: boolean;
  degradedCapabilities: string[];
  lastProbedAt: string | null;
}

export type AdminSyncScheduleDto = SchedulerScheduleState;

export interface AdminSyncDegradationDto {
  summariesDegraded: boolean;
  durationsDegraded: boolean;
  heartbeatsDegraded: boolean;
  activeAdvisoryCodes: string[];
  rateLimitedUntil: string | null;
  has401Blocked: boolean;
}

export interface AdminSyncActiveProgressDto {
  activeRun: AdminSyncRunSummaryDto | null;
  currentDate: string | null;
  lastProgressAt: string | null;
  queueDepth: number;
  isPaused: boolean;
}

export interface AdminSyncRegistryDto {
  lastRefreshedAt: string | null;
  totalEntries: number;
  distinctEditors: number;
  isRefreshing: boolean;
}

export interface AdminSyncRunSummaryDto {
  id: number;
  trigger: string;
  mode: string;
  status: string;
  rangeStartDate: string | null;
  rangeEndDate: string | null;
  dayCount: number;
  daysSynced: number;
  daysFailed: number;
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
  errorMessage: string | null;
  resumedFromRunId: number | null;
  degradedCapabilities: string[];
  advisoryCodes: string[];
}

export interface AdminSyncDateDetailDto {
  id: number;
  syncRunId: number | null;
  date: string;
  status: string;
  qualityStatus: QualityStatus;
  isStale: boolean;
  isProvisional: boolean;
  disposition: string;
  summariesStatus: string | null;
  durationsStatus: string | null;
  heartbeatsStatus: string | null;
  errorMessage: string | null;
  syncedAt: string;
}

export interface AdminSyncRunsCollectionDto {
  runs: AdminSyncRunSummaryDto[];
  totalCount: number;
  activeRun: AdminSyncRunSummaryDto | null;
  schedule: AdminSyncScheduleDto;
  readiness: AdminSyncReadinessDto;
}

export interface AdminSyncRunDetailDto {
  run: AdminSyncRunSummaryDto;
  days: AdminSyncDateDetailDto[];
  pagination: {
    page: number;
    pageSize: number;
    totalDays: number;
    totalPages: number;
  };
}

export interface SyncRunItem {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  trigger: string;
  status: string;
  rangeStartDate: string | null;
  rangeEndDate: string | null;
  dayCount: number;
  daysSynced: number;
  daysFailed: number;
  degradedCapabilities: string[];
  advisoryCodes: string[];
  summary: string | null;
  errorMessage: string | null;
}

export interface SyncDayItem {
  id: number;
  syncRunId: number | null;
  date: string;
  status: string;
  summariesStatus: string | null;
  durationsStatus: string | null;
  heartbeatsStatus: string | null;
  totalSeconds: number;
  formattedDuration: string;
  heartbeatCount: number;
  errorMessage: string | null;
  syncedAt: string;
}

export interface SyncViewData {
  syncRuns: SyncRunItem[];
  syncDays: SyncDayItem[];
  capabilityState: CapabilityPolicyState | null;
  oauthAppConfigured: boolean;
  oauthConnected: boolean;
  discoveryReady: boolean;
  backgroundSyncDeferred: boolean;
  isEmpty: boolean;
}

export interface SyncAdminData extends SyncViewData {
  readiness: AdminSyncReadinessDto;
  schedule: AdminSyncScheduleDto;
  degradation: AdminSyncDegradationDto;
  activeProgress: AdminSyncActiveProgressDto;
  registry: AdminSyncRegistryDto;
  runs: AdminSyncRunSummaryDto[];
  dates: AdminSyncDateDetailDto[];
  sourceTimezone: string | null;
  lastAcceptedSuccessAt: string | null;
}

/**
 * Known allowlisted status/error/advisory codes.
 */
const ALLOWLISTED_ERROR_CODES = new Set([
  ...Object.values(RECONCILE_CODES),
  'AUTH_REVOKED',
  'OAUTH_REVOKED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'RESTRICTED',
  'RATE_LIMITED',
  'TIMEOUT',
  'NETWORK_ERROR',
  'UPSTREAM_ERROR',
  'IDEMPOTENCY_CONFLICT',
  'SYNC_QUEUE_FULL',
  'TIMEZONE_MISMATCH',
  'TIMEZONE_CHANGED',
  'DETAIL_DOWNGRADE',
  'NO_DATES_UPDATED',
  'CURRENT_DAY_PROVISIONAL'
]);

/**
 * Sanitizes an error message so it never exposes:
 * - Credentials, tokens, API keys, client secrets
 * - Raw upstream error prose / stack traces
 * - Account IDs or UUID identities
 * - Raw filesystem paths
 * Maps errors to structured allowlisted error codes.
 */
export function sanitizeErrorMessage(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;

  if (ALLOWLISTED_ERROR_CODES.has(text)) {
    return text;
  }

  const lower = text.toLowerCase();
  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    lower.includes('token expired') ||
    lower.includes('auth_revoked')
  ) {
    return 'AUTH_REVOKED';
  }
  if (
    lower.includes('402') ||
    lower.includes('403') ||
    lower.includes('forbidden') ||
    lower.includes('restricted') ||
    lower.includes('plan')
  ) {
    return 'RESTRICTED';
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('pacing')) {
    return 'RATE_LIMITED';
  }
  if (lower.includes('timeout') || lower.includes('abort') || lower.includes('deadline')) {
    return 'TIMEOUT';
  }
  if (
    lower.includes('network') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed')
  ) {
    return 'NETWORK_ERROR';
  }
  if (lower.includes('queue') || lower.includes('sync_queue_full')) {
    return 'SYNC_QUEUE_FULL';
  }
  if (lower.includes('idempotency')) {
    return 'IDEMPOTENCY_CONFLICT';
  }
  if (lower.includes('timezone')) {
    return 'TIMEZONE_MISMATCH';
  }
  if (lower.includes('downgrade')) {
    return 'DETAIL_DOWNGRADE';
  }
  if (
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('upstream') ||
    lower.includes('wakatime')
  ) {
    return 'UPSTREAM_ERROR';
  }

  return 'UPSTREAM_ERROR';
}

/**
 * Returns truthful source timezone from accepted database evidence, or null if unavailable.
 */
export function getVerifiedSourceTimezone(db: Database.Database): string | null {
  try {
    const layerRow = db
      .prepare(
        `SELECT verified_timezone FROM sync_layer_state WHERE verified_timezone IS NOT NULL AND verified_timezone != '' ORDER BY updated_at DESC LIMIT 1`
      )
      .get() as { verified_timezone: string } | undefined;
    if (layerRow?.verified_timezone) return layerRow.verified_timezone;

    const accountRow = db
      .prepare(`SELECT timezone FROM account_settings WHERE timezone IS NOT NULL AND timezone != '' LIMIT 1`)
      .get() as { timezone: string } | undefined;
    if (accountRow?.timezone) return accountRow.timezone;

    const dailyRow = db
      .prepare(`SELECT timezone FROM daily_totals WHERE timezone IS NOT NULL AND timezone != '' ORDER BY date DESC LIMIT 1`)
      .get() as { timezone: string } | undefined;
    if (dailyRow?.timezone) return dailyRow.timezone;
  } catch (err) {
    throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
  }
  return null;
}

/**
 * Returns today's ISO string (YYYY-MM-DD) in the specified timezone.
 */
function getTodayInTimezone(now: Date, timezone: string): string {
  return getZonedDateString(timezone, now);
}

/**
 * Compute the date quality projection for a single date.
 */
export function getDateQualityProjection(
  db: Database.Database,
  date: string,
  now: Date = new Date(),
  timezone?: string | null
): DateQualityProjection {
  let tz: string | null = null;
  try {
    tz = timezone ?? getVerifiedSourceTimezone(db);
  } catch {
    return {
      date,
      qualityStatus: 'missing',
      isStale: true,
      isProvisional: false,
      disposition: 'DATA_UNAVAILABLE',
      lastSyncedAt: null,
      degradedLayers: []
    };
  }

  if (!tz) {
    return {
      date,
      qualityStatus: 'missing',
      isStale: true,
      isProvisional: false,
      disposition: 'TIMEZONE_UNAVAILABLE',
      lastSyncedAt: null,
      degradedLayers: []
    };
  }

  if (!isValidDateString(date)) {
    return {
      date,
      qualityStatus: 'stale',
      isStale: true,
      isProvisional: false,
      lastSyncedAt: null,
      degradedLayers: []
    };
  }

  const todayStr = getTodayInTimezone(now, tz);
  const isProvisional = date === todayStr;

  type DayRowRecord = {
    id: number;
    sync_run_id: number | null;
    status: string;
    disposition: string | null;
    summaries_status: string | null;
    durations_status: string | null;
    heartbeats_status: string | null;
    total_seconds: number;
    heartbeat_count: number;
    advisory_codes_json: string | null;
    error_message: string | null;
    synced_at: string;
  };

  type LayerRowRecord = {
    layer: string;
    last_attempt_at: string | null;
    last_success_at: string | null;
    last_accepted_change_at: string | null;
    accepted_source_reference: string | null;
    accepted_snapshot_version: number | null;
    accepted_fidelity: SummaryFidelity | null;
    accepted_content_hash: string | null;
    verified_timezone: string | null;
    evidence_matches_summary: number | null;
    status_code: string | null;
    next_retry_at: string | null;
    is_stale: number;
    unresolved_mismatch: number;
    has_detail_downgrade: number;
    has_restriction: number;
    has_failure: number;
  };

  let dayRow: DayRowRecord | undefined = undefined;
  let layerRows: LayerRowRecord[] = [];
  let dailyTotalsRow: { total_seconds: number } | undefined = undefined;
  let runMode: string | null = null;

  try {
    dayRow = db
      .prepare(
        `SELECT id, sync_run_id, status, disposition, summaries_status, durations_status, heartbeats_status,
                total_seconds, heartbeat_count, advisory_codes_json, error_message, synced_at
         FROM sync_days
         WHERE date = ?
         ORDER BY id DESC LIMIT 1`
      )
      .get(date) as DayRowRecord | undefined;

    layerRows = db
      .prepare(
        `SELECT layer, last_attempt_at, last_success_at, last_accepted_change_at,
                accepted_source_reference, accepted_snapshot_version, accepted_fidelity,
                accepted_content_hash, verified_timezone, evidence_matches_summary,
                status_code, next_retry_at, is_stale, unresolved_mismatch,
                has_detail_downgrade, has_restriction, has_failure
         FROM sync_layer_state
         WHERE date = ?`
      )
      .all(date) as LayerRowRecord[];

    dailyTotalsRow = db
      .prepare(`SELECT total_seconds FROM daily_totals WHERE date = ?`)
      .get(date) as { total_seconds: number } | undefined;

    if (dayRow?.sync_run_id) {
      const r = db.prepare(`SELECT mode FROM sync_runs WHERE id = ?`).get(dayRow.sync_run_id) as
        | { mode: string }
        | undefined;
      runMode = r?.mode ?? null;
    }
  } catch (err) {
    return {
      date,
      qualityStatus: 'missing',
      isStale: true,
      isProvisional: false,
      disposition: 'DATA_UNAVAILABLE',
      lastSyncedAt: null,
      degradedLayers: []
    };
  }

  const degradedLayers: string[] = [];
  if (dayRow?.summaries_status === 'restricted') degradedLayers.push('summaries');
  if (dayRow?.durations_status === 'restricted') degradedLayers.push('durations');
  if (dayRow?.heartbeats_status === 'restricted') degradedLayers.push('heartbeats');

  for (const l of layerRows) {
    if ((l.has_restriction || l.status_code?.includes('RESTRICTED')) && !degradedLayers.includes(l.layer)) {
      degradedLayers.push(l.layer);
    }
  }

  let advisoryCodes: string[] = [];
  if (dayRow?.advisory_codes_json) {
    try {
      advisoryCodes = JSON.parse(dayRow.advisory_codes_json);
    } catch {}
  }

  let isStale = false;
  const summaryLayer = layerRows.find((r) => r.layer === 'summaries');

  for (const l of layerRows) {
    const freshnessRecord: LayerFreshnessRecord = {
      lastAttemptAt: l.last_attempt_at,
      lastSuccessAt: l.last_success_at,
      lastAcceptedChangeAt: l.last_accepted_change_at,
      acceptedSourceReference: l.accepted_source_reference,
      acceptedSnapshotVersion: l.accepted_snapshot_version,
      acceptedFidelity: l.accepted_fidelity,
      acceptedContentHash: l.accepted_content_hash,
      verifiedTimezone: l.verified_timezone,
      evidenceMatchesSummary:
        l.evidence_matches_summary !== null ? Boolean(l.evidence_matches_summary) : null,
      statusCode: l.status_code,
      nextRetryAt: l.next_retry_at,
      isStale: Boolean(l.is_stale),
      unresolvedMismatch: Boolean(l.unresolved_mismatch),
      hasDetailDowngrade: Boolean(l.has_detail_downgrade),
      hasRestriction: Boolean(l.has_restriction),
      hasFailure: Boolean(l.has_failure)
    };
    const evaluation = evaluateDateFreshness(date, freshnessRecord, now, tz);
    if (evaluation.isStale) {
      isStale = true;
    }
  }

  if (!dayRow && layerRows.length === 0 && !dailyTotalsRow) {
    isStale = true;
  }
  if (!dailyTotalsRow) {
    isStale = true;
  }

  const hasCompleteSummaryEvidence = Boolean(
    summaryLayer &&
    summaryLayer.accepted_source_reference &&
    summaryLayer.accepted_content_hash &&
    summaryLayer.accepted_fidelity &&
    summaryLayer.verified_timezone &&
    typeof summaryLayer.accepted_snapshot_version === 'number' &&
    summaryLayer.accepted_snapshot_version > 0 &&
    !summaryLayer.has_failure &&
    !summaryLayer.has_restriction &&
    !summaryLayer.unresolved_mismatch
  );

  const isVerifiedZero = Boolean(
    dailyTotalsRow !== undefined &&
    dailyTotalsRow.total_seconds === 0 &&
    (summaryLayer?.accepted_fidelity === 'verified_zero' ||
      advisoryCodes.includes(RECONCILE_CODES.VERIFIED_ZERO_ACCEPTED)) &&
    summaryLayer?.last_success_at &&
    hasCompleteSummaryEvidence
  );

  let qualityStatus: QualityStatus;

  if (!dayRow && layerRows.length === 0 && !dailyTotalsRow) {
    qualityStatus = isProvisional ? 'current_day_provisional' : 'missing';
  } else if (
    layerRows.some((l) => l.status_code === 'AUTH_REVOKED' || l.status_code === 'HTTP_401') ||
    advisoryCodes.includes('AUTH_REVOKED') ||
    advisoryCodes.includes('OAUTH_REVOKED')
  ) {
    qualityStatus = 'reconnect_required';
    isStale = true;
  } else if (
    dayRow?.status === 'failed' ||
    dayRow?.status === 'interrupted' ||
    dayRow?.status === 'cancelled' ||
    summaryLayer?.has_failure === 1 ||
    summaryLayer?.status_code?.startsWith('HTTP_5')
  ) {
    qualityStatus = 'failed';
    isStale = true;
  } else if (
    degradedLayers.length > 0 ||
    layerRows.some(
      (l) =>
        l.has_restriction ||
        l.status_code?.startsWith('HTTP_402') ||
        l.status_code?.startsWith('HTTP_403')
    ) ||
    dayRow?.summaries_status === 'restricted'
  ) {
    qualityStatus = 'restricted';
  } else if (
    dayRow?.disposition === 'preserved' ||
    layerRows.some((l) => l.has_detail_downgrade || l.status_code === RECONCILE_CODES.DETAIL_DOWNGRADE) ||
    advisoryCodes.includes(RECONCILE_CODES.DETAIL_DOWNGRADE)
  ) {
    qualityStatus = 'archived_detail_preserved';
    isStale = true;
  } else if (isVerifiedZero) {
    qualityStatus = 'verified_zero';
  } else if (runMode === 'compare' || dayRow?.disposition === 'comparison_only') {
    qualityStatus = 'comparison_only';
  } else if (isStale) {
    qualityStatus = 'stale';
  } else if (isProvisional) {
    qualityStatus = 'current_day_provisional';
  } else if (dayRow?.disposition === 'unchanged') {
    qualityStatus = 'checked_unchanged';
  } else if (dayRow?.disposition === 'updated') {
    qualityStatus = 'updated';
  } else if (dayRow?.status === 'succeeded' || summaryLayer?.last_success_at) {
    qualityStatus = 'updated';
  } else {
    qualityStatus = 'missing';
  }

  return {
    date,
    qualityStatus,
    isStale,
    isProvisional,
    disposition: dayRow?.disposition ?? undefined,
    lastSyncedAt: dayRow?.synced_at ?? summaryLayer?.last_success_at ?? null,
    degradedLayers
  };
}

/**
 * Compute the date quality projection for multiple dates in batch.
 */
export function getDatesQualityProjection(
  db: Database.Database,
  dates: string[],
  now: Date = new Date(),
  timezone?: string | null
): Map<string, DateQualityProjection> {
  const result = new Map<string, DateQualityProjection>();
  const tz = timezone ?? getVerifiedSourceTimezone(db);
  for (const d of dates) {
    result.set(d, getDateQualityProjection(db, d, now, tz));
  }
  return result;
}

export interface AdminSyncDataOptions {
  config?: RuntimeConfig;
  limit?: number;
  now?: Date;
  runtime?: AdminSyncRuntimeSurface;
  timezone?: string;
}

/**
 * Primary loader function producing the full SyncAdminData DTO.
 */
export function getSyncAdminData(
  db: Database.Database,
  options?: AdminSyncDataOptions
): SyncAdminData {
  const rt = options?.runtime ?? (runtime);
  const config = options?.config ?? rt.config;
  const limit = options?.limit ?? MAX_SYNC_RUN_ROWS;
  const now = options?.now ?? new Date();
  const sourceTimezone = options?.timezone ?? getVerifiedSourceTimezone(db);

  const oauthAppConfigured = Boolean(
    config?.wakatimeOAuthClientId && config?.wakatimeOAuthClientSecret && config?.sessionSecret
  );

  type ConnectionRow = {
    access_token_sealed: string | null;
    generation: number;
    bound_archive_identity: string | null;
    rebound_at: string | null;
  };
  let connectionRow: ConnectionRow | undefined = undefined;

  try {
    connectionRow = db
      .prepare(
        'SELECT access_token_sealed, generation, bound_archive_identity, rebound_at FROM wakatime_oauth_connection WHERE id = 1'
      )
      .get() as ConnectionRow | undefined;
  } catch (err) {
    throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
  }

  const oauthConnected = Boolean(connectionRow);
  const hasActiveGrant = Boolean(connectionRow?.access_token_sealed);

  let appCapRow: { value: string } | undefined = undefined;
  let schedulingSettingRow: { value: string } | undefined = undefined;
  try {
    appCapRow = db
      .prepare("SELECT value FROM app_settings WHERE key = 'capability_policy_state'")
      .get() as { value: string } | undefined;
    schedulingSettingRow = db
      .prepare("SELECT value FROM app_settings WHERE key = 'sync.scheduling_enabled'")
      .get() as { value: string } | undefined;
  } catch (err) {
    throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
  }

  const schedulingEnabled = schedulingSettingRow?.value === 'true';

  let rawRuns: Array<{
    id: number;
    started_at: string;
    finished_at: string | null;
    trigger: string;
    mode: string;
    status: string;
    range_start_date: string | null;
    range_end_date: string | null;
    day_count: number;
    days_synced: number;
    days_failed: number;
    degraded_capabilities: string | null;
    advisory_codes: string | null;
    summary: string | null;
    error_message: string | null;
    policy_state_json: string | null;
    resumed_from_run_id: number | null;
  }> = [];

  try {
    rawRuns = db
      .prepare(
        `SELECT id, started_at, finished_at, trigger, mode, status,
                range_start_date, range_end_date, day_count, days_synced, days_failed,
                degraded_capabilities, advisory_codes, summary, error_message,
                policy_state_json, resumed_from_run_id
         FROM sync_runs
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit) as typeof rawRuns;
  } catch (err) {
    throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
  }

  let capabilityState: CapabilityPolicyState | null = parseCapabilityPolicyState(appCapRow?.value);
  if (!capabilityState) {
    for (const run of rawRuns) {
      capabilityState = parseCapabilityPolicyState(run.policy_state_json);
      if (capabilityState) break;
    }
  }

  const degradedCapabilities: string[] = [];
  if (capabilityState?.capabilities) {
    for (const [cap, rec] of Object.entries(capabilityState.capabilities)) {
      if (rec.status === 'restricted' || rec.status === 'error') {
        degradedCapabilities.push(cap);
      }
    }
  }

  const latestRun = rawRuns[0];
  const activeRunRow = rawRuns.find((r) => r.status === 'running');

  let nonterminalRunsCount = 0;
  try {
    nonterminalRunsCount = (
      db.prepare(`SELECT COUNT(*) as c FROM sync_runs WHERE status IN ('queued', 'running')`).get() as {
        c: number;
      }
    ).c;
  } catch (err) {
    throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
  }

  // Never infer auth failure from error text!
  let has401Blocked = false;
  try {
    has401Blocked = Boolean(
      latestRun?.advisory_codes?.includes('AUTH_REVOKED') ||
      latestRun?.advisory_codes?.includes('OAUTH_REVOKED') ||
      db.prepare(`SELECT 1 FROM sync_layer_state WHERE status_code IN ('AUTH_REVOKED', 'HTTP_401') LIMIT 1`).get()
    );
  } catch (err) {
    throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
  }

  const reconnectRequired = has401Blocked;
  const isBlocked = has401Blocked;
  const discoveryReady = oauthAppConfigured && oauthConnected && !reconnectRequired;

  if (!rt?.scheduler?.getScheduleState || !rt?.getReadiness) {
    throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
  }

  let schedule: AdminSyncScheduleDto;
  try {
    schedule = rt.scheduler.getScheduleState();
  } catch (err) {
    throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
  }

  let readinessData: RuntimeReadiness;
  try {
    readinessData = rt.getReadiness();
  } catch (err) {
    throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
  }

  const readiness: AdminSyncReadinessDto = {
    ...readinessData,
    oauthAppConfigured,
    oauthConnected,
    hasActiveGrant,
    isBlocked,
    reconnectRequired,
    discoveryReady,
    degradedCapabilities,
    lastProbedAt: capabilityState?.updatedAt ?? latestRun?.started_at ?? null
  };

  let rateLimitedUntil: string | null = null;
  try {
    const retryWaitRow = db
      .prepare(
        `SELECT MIN(next_retry_at) as retry_at FROM sync_layer_state WHERE next_retry_at IS NOT NULL AND next_retry_at > ?`
      )
      .get(now.toISOString()) as { retry_at: string | null } | undefined;
    rateLimitedUntil = retryWaitRow?.retry_at ?? null;
  } catch (err) {
    throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
  }

  const degradation: AdminSyncDegradationDto = {
    summariesDegraded: capabilityState?.capabilities?.summaries?.status === 'restricted',
    durationsDegraded: capabilityState?.capabilities?.durations?.status === 'restricted',
    heartbeatsDegraded: capabilityState?.capabilities?.heartbeats?.status === 'restricted',
    activeAdvisoryCodes: latestRun ? boundedCsvList(latestRun.advisory_codes, MAX_SYNC_RUN_CODES) : [],
    rateLimitedUntil,
    has401Blocked
  };

  const mapToRunSummary = (r: typeof rawRuns[number]): AdminSyncRunSummaryDto => ({
    id: r.id,
    trigger: allowlistedValue(r.trigger, RUN_TRIGGERS),
    mode: allowlistedValue(r.mode, RUN_MODES),
    status: allowlistedValue(r.status, RUN_STATUSES),
    rangeStartDate: truncateNullableText(r.range_start_date, MAX_LABEL_LENGTH),
    rangeEndDate: truncateNullableText(r.range_end_date, MAX_LABEL_LENGTH),
    dayCount: clampCount(r.day_count),
    daysSynced: clampCount(r.days_synced),
    daysFailed: clampCount(r.days_failed),
    startedAt: truncateText(r.started_at, MAX_LABEL_LENGTH),
    finishedAt: truncateNullableText(r.finished_at, MAX_LABEL_LENGTH),
    summary: null,
    errorMessage: sanitizeErrorMessage(r.error_message),
    resumedFromRunId: r.resumed_from_run_id,
    degradedCapabilities: boundedCsvList(r.degraded_capabilities, MAX_SYNC_RUN_CODES),
    advisoryCodes: boundedCsvList(r.advisory_codes, MAX_SYNC_RUN_CODES)
  });

  const runs: AdminSyncRunSummaryDto[] = rawRuns.map(mapToRunSummary);
  const activeRun = activeRunRow ? mapToRunSummary(activeRunRow) : null;

  let runningDayDate: string | null = null;
  let lastProgressAt: string | null = null;
  if (activeRunRow) {
    try {
      const runningDay = db
        .prepare(`SELECT date FROM sync_days WHERE sync_run_id = ? AND status = 'running' LIMIT 1`)
        .get(activeRunRow.id) as { date: string } | undefined;
      runningDayDate = runningDay?.date ?? null;

      const progressRow = db
        .prepare(
          `SELECT MAX(synced_at) as last_p FROM sync_days WHERE sync_run_id = ? AND status != 'pending'`
        )
        .get(activeRunRow.id) as { last_p: string | null } | undefined;
      lastProgressAt = progressRow?.last_p ?? activeRunRow.started_at;
    } catch (err) {
      throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
    }
  }

  const activeProgress: AdminSyncActiveProgressDto = {
    activeRun,
    currentDate: runningDayDate,
    lastProgressAt,
    queueDepth: nonterminalRunsCount,
    isPaused: !schedulingEnabled
  };

  type RegCountRow = { total_entries: number; total_editors: number };
  type RegRefreshRow = { last_refreshed: string | null };
  let regCountRow: RegCountRow | undefined = undefined;
  let regRefreshRow: RegRefreshRow | undefined = undefined;
  let isRegistryRefreshing = false;
  try {
    regCountRow = db
      .prepare(
        `SELECT COUNT(*) as total_entries, COUNT(DISTINCT editor) as total_editors FROM user_agent_registry`
      )
      .get() as RegCountRow | undefined;
    regRefreshRow = db
      .prepare(`SELECT MAX(refreshed_at) as last_refreshed FROM user_agent_registry`)
      .get() as RegRefreshRow | undefined;
    isRegistryRefreshing = Boolean(
      db
        .prepare(`SELECT 1 FROM sync_runs WHERE mode = 'registry' AND status IN ('queued', 'running') LIMIT 1`)
        .get()
    );
  } catch (err) {
    throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
  }

  const registry: AdminSyncRegistryDto = {
    lastRefreshedAt: regRefreshRow?.last_refreshed ?? null,
    totalEntries: regCountRow?.total_entries ?? 0,
    distinctEditors: regCountRow?.total_editors ?? 0,
    isRefreshing: isRegistryRefreshing
  };

  let rawDays: Array<{
    id: number;
    sync_run_id: number | null;
    date: string;
    status: string;
    disposition: string | null;
    summaries_status: string | null;
    durations_status: string | null;
    heartbeats_status: string | null;
    total_seconds: number;
    heartbeat_count: number;
    advisory_codes_json: string | null;
    error_message: string | null;
    synced_at: string;
  }> = [];

  try {
    rawDays = db
      .prepare(
        `SELECT id, sync_run_id, date, status, disposition, summaries_status, durations_status, heartbeats_status,
                total_seconds, heartbeat_count, advisory_codes_json, error_message, synced_at
         FROM sync_days
         ORDER BY date DESC, id DESC LIMIT ?`
      )
      .all(MAX_SYNC_DAY_ROWS) as typeof rawDays;
  } catch (err) {
    throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
  }

  const dates: AdminSyncDateDetailDto[] = rawDays.map((d) => {
    const quality = getDateQualityProjection(db, d.date, now, sourceTimezone);
    return {
      id: d.id,
      syncRunId: d.sync_run_id,
      date: truncateText(d.date, MAX_LABEL_LENGTH),
      status: allowlistedValue(d.status, DATE_STATUSES),
      qualityStatus: quality.qualityStatus,
      isStale: quality.isStale,
      isProvisional: quality.isProvisional,
      disposition: d.disposition ?? quality.disposition ?? 'unchanged',
      summariesStatus: allowlistedNullableValue(d.summaries_status, SYNC_STEP_STATUSES),
      durationsStatus: allowlistedNullableValue(d.durations_status, SYNC_STEP_STATUSES),
      heartbeatsStatus: allowlistedNullableValue(d.heartbeats_status, SYNC_STEP_STATUSES),
      errorMessage: sanitizeErrorMessage(d.error_message),
      syncedAt: truncateText(d.synced_at, MAX_LABEL_LENGTH)
    };
  });

  // Backward compatibility fields for Svelte page
  const syncRuns: SyncRunItem[] = rawRuns.map((r) => ({
    id: r.id,
    startedAt: truncateText(r.started_at, MAX_LABEL_LENGTH),
    finishedAt: truncateNullableText(r.finished_at, MAX_LABEL_LENGTH),
    trigger: allowlistedValue(r.trigger, RUN_TRIGGERS),
    status: allowlistedValue(r.status, RUN_STATUSES),
    rangeStartDate: truncateNullableText(r.range_start_date, MAX_LABEL_LENGTH),
    rangeEndDate: truncateNullableText(r.range_end_date, MAX_LABEL_LENGTH),
    dayCount: clampCount(r.day_count),
    daysSynced: clampCount(r.days_synced),
    daysFailed: clampCount(r.days_failed),
    degradedCapabilities: boundedCsvList(r.degraded_capabilities, MAX_SYNC_RUN_CODES),
    advisoryCodes: boundedCsvList(r.advisory_codes, MAX_SYNC_RUN_CODES),
    summary: null,
    errorMessage: sanitizeErrorMessage(r.error_message)
  }));

  const syncDays: SyncDayItem[] = rawDays.map((d) => {
    const totalSeconds = clampSeconds(d.total_seconds);
    return {
      id: d.id,
      syncRunId: d.sync_run_id,
      date: d.date,
      status: allowlistedValue(d.status, DATE_STATUSES),
      summariesStatus: allowlistedNullableValue(d.summaries_status, SYNC_STEP_STATUSES),
      durationsStatus: allowlistedNullableValue(d.durations_status, SYNC_STEP_STATUSES),
      heartbeatsStatus: allowlistedNullableValue(d.heartbeats_status, SYNC_STEP_STATUSES),
      totalSeconds,
      formattedDuration: formatDuration(totalSeconds),
      heartbeatCount: clampCount(d.heartbeat_count),
      errorMessage: sanitizeErrorMessage(d.error_message),
      syncedAt: d.synced_at
    };
  });

  let lastAcceptedSuccessAt: string | null = null;
  try {
    const lastSuccessRow = db
      .prepare(
        `SELECT MAX(last_success_at) as last_success FROM sync_layer_state WHERE layer = 'summaries' AND has_failure = 0 AND has_restriction = 0`
      )
      .get() as { last_success: string | null } | undefined;
    lastAcceptedSuccessAt = lastSuccessRow?.last_success ?? null;
  } catch (err) {
    throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
  }

  const isEmpty = runs.length === 0 && dates.length === 0;

  return {
    readiness,
    schedule,
    degradation,
    activeProgress,
    registry,
    runs,
    dates,
    syncRuns,
    syncDays,
    capabilityState,
    oauthAppConfigured,
    oauthConnected,
    discoveryReady,
    backgroundSyncDeferred: true,
    isEmpty,
    sourceTimezone,
    lastAcceptedSuccessAt
  };
}

/**
 * Returns collection DTO for GET /api/admin/sync-runs with repository total count.
 */
export function getSyncRunsCollection(
  runtimeSurface: AdminSyncRuntimeSurface,
  options?: { limit?: number; now?: Date }
): AdminSyncRunsCollectionDto {
  const db = runtimeSurface.db;
  const limit = Math.min(MAX_SYNC_RUN_ROWS, Math.max(1, options?.limit ?? MAX_SYNC_RUN_ROWS));
  const adminData = getSyncAdminData(db, {
    limit,
    now: options?.now,
    runtime: runtimeSurface
  });

  let totalCount = adminData.runs.length;
  try {
    const countRow = db.prepare(`SELECT COUNT(*) as c FROM sync_runs`).get() as { c: number };
    totalCount = countRow?.c ?? totalCount;
  } catch (err) {
    throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
  }

  return {
    runs: adminData.runs,
    totalCount,
    activeRun: adminData.activeProgress.activeRun,
    schedule: adminData.schedule,
    readiness: adminData.readiness
  };
}

/**
 * Returns detail for a specific sync run including paginated day records.
 */
export function getSyncRunDetail(
  db: Database.Database,
  runId: number,
  options?: { page?: number; pageSize?: number; now?: Date; timezone?: string }
): AdminSyncRunDetailDto | null {
  const page = Math.max(1, options?.page ?? 1);
  const pageSize = Math.min(MAX_SYNC_DAY_ROWS, Math.max(1, options?.pageSize ?? MAX_SYNC_DAY_ROWS));
  const offset = (page - 1) * pageSize;
  const tz = options?.timezone ?? getVerifiedSourceTimezone(db);

  let runRow: any;
  let totalDays = 0;
  let dayRows: any[] = [];
  try {
    runRow = db
      .prepare(
        `SELECT id, started_at, finished_at, trigger, mode, status,
                range_start_date, range_end_date, day_count, days_synced, days_failed,
                degraded_capabilities, advisory_codes, summary, error_message,
                policy_state_json, resumed_from_run_id
         FROM sync_runs
         WHERE id = ?`
      )
      .get(runId);

    if (!runRow) return null;

    const totalDaysRow = db
      .prepare(`SELECT COUNT(*) as c FROM sync_days WHERE sync_run_id = ?`)
      .get(runId) as { c: number } | undefined;
    totalDays = totalDaysRow?.c ?? 0;

    dayRows = db
      .prepare(
        `SELECT id, sync_run_id, date, status, disposition, summaries_status, durations_status, heartbeats_status,
                total_seconds, heartbeat_count, advisory_codes_json, error_message, synced_at
         FROM sync_days
         WHERE sync_run_id = ?
         ORDER BY date ASC
         LIMIT ? OFFSET ?`
      )
      .all(runId, pageSize, offset) as any[];
  } catch (err) {
    throw new AdminSyncReadError('SYNC_STATE_UNAVAILABLE');
  }

  const totalPages = totalDays === 0 ? 1 : Math.ceil(totalDays / pageSize);
  const now = options?.now ?? new Date();
  const days: AdminSyncDateDetailDto[] = dayRows.map((d) => {
    const quality = getDateQualityProjection(db, d.date, now, tz);
    return {
      id: d.id,
      syncRunId: d.sync_run_id,
      date: truncateText(d.date, MAX_LABEL_LENGTH),
      status: allowlistedValue(d.status, DATE_STATUSES),
      qualityStatus: quality.qualityStatus,
      isStale: quality.isStale,
      isProvisional: quality.isProvisional,
      disposition: d.disposition ?? quality.disposition ?? 'unchanged',
      summariesStatus: allowlistedNullableValue(d.summaries_status, SYNC_STEP_STATUSES),
      durationsStatus: allowlistedNullableValue(d.durations_status, SYNC_STEP_STATUSES),
      heartbeatsStatus: allowlistedNullableValue(d.heartbeats_status, SYNC_STEP_STATUSES),
      errorMessage: sanitizeErrorMessage(d.error_message),
      syncedAt: truncateText(d.synced_at, MAX_LABEL_LENGTH)
    };
  });

  const run: AdminSyncRunSummaryDto = {
    id: runRow.id,
    trigger: allowlistedValue(runRow.trigger, RUN_TRIGGERS),
    mode: allowlistedValue(runRow.mode, RUN_MODES),
    status: allowlistedValue(runRow.status, RUN_STATUSES),
    rangeStartDate: truncateNullableText(runRow.range_start_date, MAX_LABEL_LENGTH),
    rangeEndDate: truncateNullableText(runRow.range_end_date, MAX_LABEL_LENGTH),
    dayCount: clampCount(runRow.day_count),
    daysSynced: clampCount(runRow.days_synced),
    daysFailed: clampCount(runRow.days_failed),
    startedAt: truncateText(runRow.started_at, MAX_LABEL_LENGTH),
    finishedAt: truncateNullableText(runRow.finished_at, MAX_LABEL_LENGTH),
    summary: null,
    errorMessage: sanitizeErrorMessage(runRow.error_message),
    resumedFromRunId: runRow.resumed_from_run_id,
    degradedCapabilities: boundedCsvList(runRow.degraded_capabilities, MAX_SYNC_RUN_CODES),
    advisoryCodes: boundedCsvList(runRow.advisory_codes, MAX_SYNC_RUN_CODES)
  };

  return {
    run,
    days,
    pagination: {
      page,
      pageSize,
      totalDays,
      totalPages
    }
  };
}

/**
 * Backward compatibility loader function matching existing signature.
 */
export function getSyncData(
  db: Database.Database,
  config: RuntimeConfig,
  rt: AdminSyncRuntimeSurface = runtime
): SyncViewData {
  const adminData = getSyncAdminData(db, { config, runtime: rt });
  return adminData;
}

// ============================================================================
// Runtime Surface and AdminSyncService
// ============================================================================

export type AdminSyncRuntimeSurface = Pick<
  ServerRuntime,
  'db' | 'config' | 'sessionSecret' | 'scheduler' | 'lifecycle' | 'getReadiness'
> & { readonly sync: SyncService };

export class AdminSyncService {
  constructor(private readonly runtimeSurface: AdminSyncRuntimeSurface) {}

  get db(): Database.Database {
    return this.runtimeSurface.db;
  }

  get config(): RuntimeConfig {
    return this.runtimeSurface.config;
  }

  get sessionSecret(): string {
    return this.runtimeSurface.sessionSecret;
  }

  get sync(): SyncService {
    return this.runtimeSurface.sync;
  }

  get scheduler(): SyncScheduler {
    return this.runtimeSurface.scheduler;
  }

  getAdminData(options?: { limit?: number; now?: Date; timezone?: string }): SyncAdminData {
    return getSyncAdminData(this.runtimeSurface.db, {
      config: this.runtimeSurface.config,
      limit: options?.limit,
      now: options?.now,
      runtime: this.runtimeSurface,
      timezone: options?.timezone
    });
  }

  getRunsCollection(options?: { limit?: number; now?: Date }): AdminSyncRunsCollectionDto {
    return getSyncRunsCollection(this.runtimeSurface, options);
  }

  getRunDetail(
    runId: number,
    options?: { page?: number; pageSize?: number; now?: Date; timezone?: string }
  ): AdminSyncRunDetailDto | null {
    return getSyncRunDetail(this.runtimeSurface.db, runId, options);
  }

  async enqueue(request: RunRequest): Promise<{ runId: number; reused: boolean }> {
    return this.runtimeSurface.sync.enqueue(request);
  }

  async cancel(runId: number): Promise<RunStatus> {
    return this.runtimeSurface.sync.cancel(runId);
  }

  async getReadiness(): Promise<AdminSyncReadinessDto> {
    const adminData = this.getAdminData();
    return adminData.readiness;
  }
}

export function getAdminSyncService(customRuntime: AdminSyncRuntimeSurface): AdminSyncService {
  return new AdminSyncService(customRuntime);
}
