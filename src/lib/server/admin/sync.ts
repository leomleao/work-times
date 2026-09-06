import type Database from 'better-sqlite3';
import type { RuntimeConfig } from '../config.js';
import type { CapabilityPolicyState } from '../sync/capabilities.js';
import { formatDuration } from './overview.js';

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
  apiKeyConfigured: boolean;
  discoveryReady: boolean;
  backgroundSyncDeferred: boolean;
  isEmpty: boolean;
}

export function getSyncData(db: Database.Database, config: RuntimeConfig): SyncViewData {
  const apiKeyConfigured = Boolean(config.wakatimeApiKey);
  const discoveryReady = apiKeyConfigured;
  const backgroundSyncDeferred = true;

  // 1. Fetch real sync_runs
  const rawRuns = db
    .prepare(
      `SELECT id, started_at, finished_at, trigger, status,
              range_start_date, range_end_date, day_count, days_synced, days_failed,
              degraded_capabilities, advisory_codes, summary, error_message, policy_state_json
       FROM sync_runs
       ORDER BY id DESC LIMIT 50`
    )
    .all() as Array<{
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

  let capabilityState: CapabilityPolicyState | null = null;

  // Check app_settings for capability_policy_state
  const appCapRow = db
    .prepare("SELECT value FROM app_settings WHERE key = 'capability_policy_state'")
    .get() as { value: string } | undefined;

  if (appCapRow?.value) {
    try {
      capabilityState = JSON.parse(appCapRow.value);
    } catch {}
  }

  const syncRuns: SyncRunItem[] = rawRuns.map((r) => {
    // If not found in app_settings, fallback to latest run's policy_state_json
    if (!capabilityState && r.policy_state_json) {
      try {
        capabilityState = JSON.parse(r.policy_state_json);
      } catch {}
    }

    let degraded: string[] = [];
    if (r.degraded_capabilities) {
      degraded = r.degraded_capabilities
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    let advisories: string[] = [];
    if (r.advisory_codes) {
      advisories = r.advisory_codes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    return {
      id: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      trigger: r.trigger,
      status: r.status,
      rangeStartDate: r.range_start_date,
      rangeEndDate: r.range_end_date,
      dayCount: r.day_count,
      daysSynced: r.days_synced,
      daysFailed: r.days_failed,
      degradedCapabilities: degraded,
      advisoryCodes: advisories,
      summary: r.summary,
      errorMessage: r.error_message
    };
  });

  // 2. Fetch real sync_days
  const rawDays = db
    .prepare(
      `SELECT id, sync_run_id, date, status, summaries_status, durations_status, heartbeats_status,
              total_seconds, heartbeat_count, error_message, synced_at
       FROM sync_days
       ORDER BY date DESC, id DESC LIMIT 50`
    )
    .all() as Array<{
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

  const syncDays: SyncDayItem[] = rawDays.map((d) => ({
    id: d.id,
    syncRunId: d.sync_run_id,
    date: d.date,
    status: d.status,
    summariesStatus: d.summaries_status,
    durationsStatus: d.durations_status,
    heartbeatsStatus: d.heartbeats_status,
    totalSeconds: d.total_seconds,
    formattedDuration: formatDuration(d.total_seconds),
    heartbeatCount: d.heartbeat_count,
    errorMessage: d.error_message,
    syncedAt: d.synced_at
  }));

  const isEmpty = syncRuns.length === 0 && syncDays.length === 0;

  return {
    syncRuns,
    syncDays,
    capabilityState,
    apiKeyConfigured,
    discoveryReady,
    backgroundSyncDeferred,
    isEmpty
  };
}
