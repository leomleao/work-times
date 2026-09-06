import type Database from 'better-sqlite3';
import { basename } from 'node:path';
import type { RuntimeConfig } from '../config.js';

export interface SqliteStatus {
  journalMode: string;
  pageSize: number;
  pageCount: number;
  estimatedSizeBytes: number;
  formattedSize: string;
  tableCounts: {
    sourceImports: number;
    dailyTotals: number;
    dayProjectEntitySlices: number;
    heartbeats: number;
    classificationRules: number;
    dailyTimeAllocations: number;
    classificationRevisions: number;
    syncRuns: number;
    syncDays: number;
    apiKeys: number;
    oauthClients: number;
  };
}

export interface AccountCalculationPreferences {
  timezone: string;
  weekdayStart: number;
  weekdayStartLabel: string;
  keystrokeTimeoutSeconds: number;
  writesOnly: boolean;
  plan: string;
  hasPremiumFeatures: boolean;
  updatedAt: string;
}

export interface SettingsViewData {
  publicOrigin: string;
  abbreviatedDbPath: string;
  cookieSecure: boolean;
  adminUsername: string;
  wakatimeApiKeyConfigured: boolean;
  adminPasswordConfigured: boolean;
  sessionSecretConfigured: boolean;
  sqliteStatus: SqliteStatus;
  accountPreferences: AccountCalculationPreferences | null;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function abbreviateDatabasePath(path: string): string {
  if (!path || path === ':memory:') return ':memory:';
  // If path contains data/, show ./data/...
  const dataIdx = path.lastIndexOf('/data/');
  if (dataIdx !== -1) {
    return `.${path.slice(dataIdx)}`;
  }
  const file = basename(path);
  return `.../${file}`;
}

function getTableCount(db: Database.Database, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

export function getSettingsData(db: Database.Database, config: RuntimeConfig): SettingsViewData {
  const publicOrigin = config.publicUrl.origin;
  const abbreviatedDbPath = abbreviateDatabasePath(config.databasePath);
  const cookieSecure = config.cookieSecure;
  const adminUsername = config.adminUsername;
  const wakatimeApiKeyConfigured = Boolean(config.wakatimeApiKey);
  const adminPasswordConfigured = Boolean(config.adminPasswordHash);
  const sessionSecretConfigured = Boolean(config.sessionSecret);

  // SQLite stats via PRAGMA
  let journalMode = 'unknown';
  let pageSize = 4096;
  let pageCount = 0;

  try {
    const jm = db.pragma('journal_mode', { simple: true });
    if (typeof jm === 'string') journalMode = jm.toUpperCase();

    const ps = db.pragma('page_size', { simple: true });
    if (typeof ps === 'number') pageSize = ps;

    const pc = db.pragma('page_count', { simple: true });
    if (typeof pc === 'number') pageCount = pc;
  } catch {}

  const estimatedSizeBytes = pageSize * pageCount;

  const tableCounts = {
    sourceImports: getTableCount(db, 'source_imports'),
    dailyTotals: getTableCount(db, 'daily_totals'),
    dayProjectEntitySlices: getTableCount(db, 'day_project_entity_slices'),
    heartbeats: getTableCount(db, 'heartbeats'),
    classificationRules: getTableCount(db, 'classification_rules'),
    dailyTimeAllocations: getTableCount(db, 'daily_time_allocations'),
    classificationRevisions: getTableCount(db, 'classification_revisions'),
    syncRuns: getTableCount(db, 'sync_runs'),
    syncDays: getTableCount(db, 'sync_days'),
    apiKeys: getTableCount(db, 'api_keys'),
    oauthClients: getTableCount(db, 'oauth_clients')
  };

  const sqliteStatus: SqliteStatus = {
    journalMode,
    pageSize,
    pageCount,
    estimatedSizeBytes,
    formattedSize: formatBytes(estimatedSizeBytes),
    tableCounts
  };

  // Account calculation preferences
  let accountPreferences: AccountCalculationPreferences | null = null;
  const accRow = db
    .prepare(
      `SELECT timezone, weekday_start, keystroke_timeout_seconds,
              writes_only, plan, has_premium_features, updated_at
       FROM account_settings
       LIMIT 1`
    )
    .get() as {
      timezone: string;
      weekday_start: number;
      keystroke_timeout_seconds: number;
      writes_only: number;
      plan: string;
      has_premium_features: number;
      updated_at: string;
    } | undefined;

  if (accRow) {
    accountPreferences = {
      timezone: accRow.timezone,
      weekdayStart: accRow.weekday_start,
      weekdayStartLabel: accRow.weekday_start === 1 ? 'Monday (ISO)' : 'Sunday',
      keystrokeTimeoutSeconds: accRow.keystroke_timeout_seconds,
      writesOnly: Boolean(accRow.writes_only),
      plan: accRow.plan,
      hasPremiumFeatures: Boolean(accRow.has_premium_features),
      updatedAt: accRow.updated_at
    };
  }

  return {
    publicOrigin,
    abbreviatedDbPath,
    cookieSecure,
    adminUsername,
    wakatimeApiKeyConfigured,
    adminPasswordConfigured,
    sessionSecretConfigured,
    sqliteStatus,
    accountPreferences
  };
}
