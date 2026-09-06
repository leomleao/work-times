import type Database from 'better-sqlite3';
import type { SqliteClassificationService, EvaluatedSlice } from '../classification/sqlite.js';

export interface OverviewDateSpan {
  minDate: string | null;
  maxDate: string | null;
  activeDays: number;
  totalSeconds: number;
  totalAiSessions: number;
  totalAiTokens: number;
  totalAiAdditions: number;
}

export interface OverviewSourceImportState {
  latestImport: {
    id: number;
    sourceType: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    dayCount: number;
    recordCount: number;
    duplicateCount: number;
    conflictCount: number;
  } | null;
  totalImports: number;
}

export interface OverviewTopProject {
  name: string;
  projectId: number;
  totalSeconds: number;
  formattedTime: string;
  sliceCount: number;
  aiSessions: number;
  classification: 'work' | 'personal' | 'unclassified';
  workSeconds: number;
  personalSeconds: number;
  unclassifiedSeconds: number;
}

export interface OverviewTopEditor {
  name: string;
  totalSeconds: number;
  formattedTime: string;
  sharePercent: number;
}

export interface OverviewRecentDay {
  date: string;
  totalSeconds: number;
  formattedTime: string;
  aiSessions: number;
  humanAdditions: number;
  humanDeletions: number;
  aiAdditions: number;
  aiDeletions: number;
}

export interface OverviewHourlySlot {
  hour: number;
  minutes: number;
  label: string;
}

export interface OverviewData {
  dateSpan: OverviewDateSpan;
  heartbeatCount: number;
  sourceImportState: OverviewSourceImportState;
  coverage: {
    totalSeconds: number;
    classifiedSeconds: number;
    workSeconds: number;
    personalSeconds: number;
    unclassifiedSeconds: number;
    coverageRatio: number;
    coveragePercentage: number;
    workPercent: number;
    personalPercent: number;
    unclassifiedPercent: number;
    totalSlices: number;
    workSlices: number;
    personalSlices: number;
    unclassifiedSlices: number;
    daysCovered: number;
  };
  topProjects: OverviewTopProject[];
  topEditors: OverviewTopEditor[];
  recentActivity: OverviewRecentDay[];
  hourlyActivity: OverviewHourlySlot[] | null;
  isEmpty: boolean;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0m';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return remainingSeconds > 0 && minutes < 5 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  return `${remainingSeconds}s`;
}

export function getOverviewData(
  db: Database.Database,
  classification: SqliteClassificationService
): OverviewData {
  // 1. Date span and totals from daily_totals
  let dailyRow = db
    .prepare(
      `SELECT
        MIN(date) AS min_date,
        MAX(date) AS max_date,
        COUNT(DISTINCT date) AS active_days,
        COALESCE(SUM(total_seconds), 0) AS total_seconds,
        COALESCE(SUM(ai_sessions), 0) AS total_ai_sessions,
        COALESCE(SUM(ai_input_tokens + ai_cached_input_tokens + ai_output_tokens), 0) AS total_ai_tokens,
        COALESCE(SUM(ai_additions), 0) AS total_ai_additions
      FROM daily_totals`
    )
    .get() as {
      min_date: string | null;
      max_date: string | null;
      active_days: number;
      total_seconds: number;
      total_ai_sessions: number;
      total_ai_tokens: number;
      total_ai_additions: number;
    } | undefined;

  // Fallback to day_project_entity_slices if daily_totals is empty but slices exist
  if (!dailyRow || dailyRow.active_days === 0) {
    const sliceSpan = db
      .prepare(
        `SELECT
          MIN(date) AS min_date,
          MAX(date) AS max_date,
          COUNT(DISTINCT date) AS active_days,
          COALESCE(SUM(total_seconds), 0) AS total_seconds,
          COALESCE(SUM(ai_sessions), 0) AS total_ai_sessions,
          0 AS total_ai_tokens,
          COALESCE(SUM(ai_additions), 0) AS total_ai_additions
        FROM day_project_entity_slices`
      )
      .get() as {
        min_date: string | null;
        max_date: string | null;
        active_days: number;
        total_seconds: number;
        total_ai_sessions: number;
        total_ai_tokens: number;
        total_ai_additions: number;
      } | undefined;

    if (sliceSpan && sliceSpan.active_days > 0) {
      dailyRow = sliceSpan;
    }
  }

  const dateSpan: OverviewDateSpan = {
    minDate: dailyRow?.min_date ?? null,
    maxDate: dailyRow?.max_date ?? null,
    activeDays: dailyRow?.active_days ?? 0,
    totalSeconds: dailyRow?.total_seconds ?? 0,
    totalAiSessions: dailyRow?.total_ai_sessions ?? 0,
    totalAiTokens: dailyRow?.total_ai_tokens ?? 0,
    totalAiAdditions: dailyRow?.total_ai_additions ?? 0
  };

  // 2. Heartbeat count
  const hbRow = db.prepare('SELECT COUNT(*) AS count FROM heartbeats').get() as { count: number };
  const heartbeatCount = hbRow?.count ?? 0;

  // 3. Source import state
  const totalImportsRow = db
    .prepare('SELECT COUNT(*) AS count FROM source_imports')
    .get() as { count: number };
  const latestImportRow = db
    .prepare(
      `SELECT id, source_type, status, started_at, finished_at,
              day_count, record_count, duplicate_count, conflict_count
       FROM source_imports
       ORDER BY id DESC LIMIT 1`
    )
    .get() as {
      id: number;
      source_type: string;
      status: string;
      started_at: string;
      finished_at: string | null;
      day_count: number;
      record_count: number;
      duplicate_count: number;
      conflict_count: number;
    } | undefined;

  const sourceImportState: OverviewSourceImportState = {
    totalImports: totalImportsRow?.count ?? 0,
    latestImport: latestImportRow
      ? {
          id: latestImportRow.id,
          sourceType: latestImportRow.source_type,
          status: latestImportRow.status,
          startedAt: latestImportRow.started_at,
          finishedAt: latestImportRow.finished_at,
          dayCount: latestImportRow.day_count,
          recordCount: latestImportRow.record_count,
          duplicateCount: latestImportRow.duplicate_count,
          conflictCount: latestImportRow.conflict_count
        }
      : null
  };

  // 4. Classification coverage from real immutable overlay
  const rawCoverage = classification.getCoverage();
  const totSec = rawCoverage.totalSeconds;
  const workPct = totSec > 0 ? Math.round((rawCoverage.workSeconds / totSec) * 100) : 0;
  const persPct = totSec > 0 ? Math.round((rawCoverage.personalSeconds / totSec) * 100) : 0;
  const unclassPct = totSec > 0 ? Math.max(0, 100 - workPct - persPct) : 0;

  const coverage = {
    ...rawCoverage,
    workPercent: workPct,
    personalPercent: persPct,
    unclassifiedPercent: unclassPct
  };

  // 5. Top projects using classified slices from immutable overlay
  const allSlices: EvaluatedSlice[] = classification.classifySlices();
  const projectMap = new Map<
    number,
    {
      name: string;
      projectId: number;
      totalSeconds: number;
      sliceCount: number;
      aiSessions: number;
      workSeconds: number;
      personalSeconds: number;
      unclassifiedSeconds: number;
    }
  >();

  for (const slice of allSlices) {
    let entry = projectMap.get(slice.projectId);
    if (!entry) {
      entry = {
        name: slice.projectName ?? (slice.isUnattributed ? '__unattributed__' : `Project #${slice.projectId}`),
        projectId: slice.projectId,
        totalSeconds: 0,
        sliceCount: 0,
        aiSessions: 0,
        workSeconds: 0,
        personalSeconds: 0,
        unclassifiedSeconds: 0
      };
      projectMap.set(slice.projectId, entry);
    }
    entry.totalSeconds += slice.totalSeconds;
    entry.sliceCount += 1;

    switch (slice.decision.classification) {
      case 'work':
        entry.workSeconds += slice.totalSeconds;
        break;
      case 'personal':
        entry.personalSeconds += slice.totalSeconds;
        break;
      default:
        entry.unclassifiedSeconds += slice.totalSeconds;
        break;
    }
  }

  // Also accumulate ai_sessions from day_project_entity_slices
  if (projectMap.size > 0) {
    const aiRows = db
      .prepare(
        `SELECT project_id, COALESCE(SUM(ai_sessions), 0) AS ai_sessions
         FROM day_project_entity_slices
         GROUP BY project_id`
      )
      .all() as Array<{ project_id: number; ai_sessions: number }>;
    for (const r of aiRows) {
      const p = projectMap.get(r.project_id);
      if (p) {
        p.aiSessions = r.ai_sessions;
      }
    }
  }

  const topProjects: OverviewTopProject[] = Array.from(projectMap.values())
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .slice(0, 5)
    .map((p) => {
      let classification: 'work' | 'personal' | 'unclassified' = 'unclassified';
      if (p.workSeconds >= p.personalSeconds && p.workSeconds >= p.unclassifiedSeconds && p.workSeconds > 0) {
        classification = 'work';
      } else if (p.personalSeconds >= p.workSeconds && p.personalSeconds >= p.unclassifiedSeconds && p.personalSeconds > 0) {
        classification = 'personal';
      }

      return {
        name: p.name,
        projectId: p.projectId,
        totalSeconds: p.totalSeconds,
        formattedTime: formatDuration(p.totalSeconds),
        sliceCount: p.sliceCount,
        aiSessions: p.aiSessions,
        classification,
        workSeconds: p.workSeconds,
        personalSeconds: p.personalSeconds,
        unclassifiedSeconds: p.unclassifiedSeconds
      };
    });

  // 6. Top editors with explicit scope='account' guard
  const editorRows = db
    .prepare(
      `SELECT name, SUM(total_seconds) AS total_seconds
       FROM daily_dimension_totals
       WHERE scope = 'account' AND dimension = 'editor'
       GROUP BY name
       ORDER BY total_seconds DESC
       LIMIT 5`
    )
    .all() as Array<{ name: string; total_seconds: number }>;

  const totalEditorSeconds = editorRows.reduce((sum, r) => sum + r.total_seconds, 0);
  const topEditors: OverviewTopEditor[] = editorRows.map((r) => ({
    name: r.name,
    totalSeconds: r.total_seconds,
    formattedTime: formatDuration(r.total_seconds),
    sharePercent: totalEditorSeconds > 0 ? Math.round((r.total_seconds / totalEditorSeconds) * 100) : 0
  }));

  // 7. Recent activity from daily_totals
  const recentDays = db
    .prepare(
      `SELECT date, total_seconds, ai_sessions, human_additions, human_deletions, ai_additions, ai_deletions
       FROM daily_totals
       ORDER BY date DESC
       LIMIT 14`
    )
    .all() as Array<{
      date: string;
      total_seconds: number;
      ai_sessions: number;
      human_additions: number;
      human_deletions: number;
      ai_additions: number;
      ai_deletions: number;
    }>;

  const recentActivity: OverviewRecentDay[] = recentDays.map((d) => ({
    date: d.date,
    totalSeconds: d.total_seconds,
    formattedTime: formatDuration(d.total_seconds),
    aiSessions: d.ai_sessions,
    humanAdditions: d.human_additions,
    humanDeletions: d.human_deletions,
    aiAdditions: d.ai_additions,
    aiDeletions: d.ai_deletions
  }));

  // 8. Hourly distribution from heartbeats if present
  let hourlyActivity: OverviewHourlySlot[] | null = null;
  if (heartbeatCount > 0) {
    const hourlyRows = db
      .prepare(
        `SELECT CAST(strftime('%H', occurred_at) AS INTEGER) AS hour, COUNT(*) AS count
         FROM heartbeats
         GROUP BY hour
         ORDER BY hour ASC`
      )
      .all() as Array<{ hour: number; count: number }>;

    const hourMap = new Map<number, number>();
    for (const r of hourlyRows) {
      hourMap.set(r.hour, r.count);
    }
    const maxCount = Math.max(...Array.from(hourMap.values()), 1);

    hourlyActivity = Array.from({ length: 24 }, (_, h) => {
      const count = hourMap.get(h) ?? 0;
      const minutes = Math.round((count / maxCount) * 60);
      return {
        hour: h,
        minutes,
        label: `${String(h).padStart(2, '0')}:00`
      };
    });
  }

  const isEmpty =
    dateSpan.activeDays === 0 &&
    dateSpan.totalSeconds === 0 &&
    heartbeatCount === 0 &&
    sourceImportState.totalImports === 0 &&
    topProjects.length === 0;

  return {
    dateSpan,
    heartbeatCount,
    sourceImportState,
    coverage,
    topProjects,
    topEditors,
    recentActivity,
    hourlyActivity,
    isEmpty
  };
}
