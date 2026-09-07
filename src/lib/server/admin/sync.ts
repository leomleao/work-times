import type Database from 'better-sqlite3';
import type { RuntimeConfig } from '../config.js';
import type { CapabilityPolicyState } from '../sync/capabilities.js';
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
  SYNC_DAY_STATUSES,
  SYNC_RUN_STATUSES,
  SYNC_RUN_TRIGGERS,
  SYNC_STEP_STATUSES
} from './sanitize.js';

/** Hard cap on sync run rows materialized for the sync page. */
export const MAX_SYNC_RUN_ROWS = 50;
/** Hard cap on per-day sync rows materialized for the sync page. */
export const MAX_SYNC_DAY_ROWS = 50;
/** Hard cap on degraded-capability / advisory codes surfaced per run. */
export const MAX_SYNC_RUN_CODES = 25;

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

export function getSyncData(db: Database.Database, config: RuntimeConfig): SyncViewData {
  const oauthAppConfigured = Boolean(
    config.wakatimeOAuthClientId && config.wakatimeOAuthClientSecret && config.sessionSecret
  );
  const oauthConnected = Boolean(
    db.prepare('SELECT 1 AS present FROM wakatime_oauth_connection WHERE id = 1').get()
  );
  const discoveryReady = oauthAppConfigured && oauthConnected;
  const backgroundSyncDeferred = true;

  // 1. Fetch real sync_runs
  const rawRuns = db
    .prepare(
      `SELECT id, started_at, finished_at, trigger, status,
              range_start_date, range_end_date, day_count, days_synced, days_failed,
              degraded_capabilities, advisory_codes, summary, error_message, policy_state_json
       FROM sync_runs
       ORDER BY id DESC LIMIT ?`
    )
    .all(MAX_SYNC_RUN_ROWS) as Array<{
      id: number;
      started_at: string;
      finished_at: string | null;
      trigger: string;
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
    }>;

  // The policy state is opaque JSON on both of its persistence sites, so it is
  // re-validated field by field rather than cast: an unrecognized shape yields
  // null, which the page renders truthfully as "Not Probed Yet".
  const appCapRow = db
    .prepare("SELECT value FROM app_settings WHERE key = 'capability_policy_state'")
    .get() as { value: string } | undefined;

  let capabilityState: CapabilityPolicyState | null = parseCapabilityPolicyState(appCapRow?.value);
  if (!capabilityState) {
    for (const run of rawRuns) {
      capabilityState = parseCapabilityPolicyState(run.policy_state_json);
      if (capabilityState) break;
    }
  }

  const syncRuns: SyncRunItem[] = rawRuns.map((r) => ({
    id: r.id,
    startedAt: truncateText(r.started_at, MAX_LABEL_LENGTH),
    finishedAt: truncateNullableText(r.finished_at, MAX_LABEL_LENGTH),
    trigger: allowlistedValue(r.trigger, SYNC_RUN_TRIGGERS),
    status: allowlistedValue(r.status, SYNC_RUN_STATUSES),
    rangeStartDate: truncateNullableText(r.range_start_date, MAX_LABEL_LENGTH),
    rangeEndDate: truncateNullableText(r.range_end_date, MAX_LABEL_LENGTH),
    dayCount: clampCount(r.day_count),
    daysSynced: clampCount(r.days_synced),
    daysFailed: clampCount(r.days_failed),
    degradedCapabilities: boundedCsvList(r.degraded_capabilities, MAX_SYNC_RUN_CODES),
    advisoryCodes: boundedCsvList(r.advisory_codes, MAX_SYNC_RUN_CODES),
    summary: truncateNullableText(r.summary),
    errorMessage: truncateNullableText(r.error_message)
  }));

  // 2. Fetch real sync_days
  const rawDays = db
    .prepare(
      `SELECT id, sync_run_id, date, status, summaries_status, durations_status, heartbeats_status,
              total_seconds, heartbeat_count, error_message, synced_at
       FROM sync_days
       ORDER BY date DESC, id DESC LIMIT ?`
    )
    .all(MAX_SYNC_DAY_ROWS) as Array<{
      id: number;
      sync_run_id: number | null;
      date: string;
      status: string;
      summaries_status: string | null;
      durations_status: string | null;
      heartbeats_status: string | null;
      total_seconds: number;
      heartbeat_count: number;
      error_message: string | null;
      synced_at: string;
    }>;

  const syncDays: SyncDayItem[] = rawDays.map((d) => {
    const totalSeconds = clampSeconds(d.total_seconds);
    return {
      id: d.id,
      syncRunId: d.sync_run_id,
      date: truncateText(d.date, MAX_LABEL_LENGTH),
      status: allowlistedValue(d.status, SYNC_DAY_STATUSES),
      summariesStatus: allowlistedNullableValue(d.summaries_status, SYNC_STEP_STATUSES),
      durationsStatus: allowlistedNullableValue(d.durations_status, SYNC_STEP_STATUSES),
      heartbeatsStatus: allowlistedNullableValue(d.heartbeats_status, SYNC_STEP_STATUSES),
      totalSeconds,
      formattedDuration: formatDuration(totalSeconds),
      heartbeatCount: clampCount(d.heartbeat_count),
      errorMessage: truncateNullableText(d.error_message),
      syncedAt: truncateText(d.synced_at, MAX_LABEL_LENGTH)
    };
  });

  const isEmpty = syncRuns.length === 0 && syncDays.length === 0;

  return {
    syncRuns,
    syncDays,
    capabilityState,
    oauthAppConfigured,
    oauthConnected,
    discoveryReady,
    backgroundSyncDeferred,
    isEmpty
  };
}
