import type Database from 'better-sqlite3';
import type { SqliteClassificationService, EvaluatedSlice } from '../classification/sqlite.js';
import {
  allowlistedValue,
  clampCount,
  clampSeconds,
  truncateText,
  MAX_LABEL_LENGTH,
  SOURCE_IMPORT_STATUSES,
  SOURCE_IMPORT_TYPES
} from './sanitize.js';

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
  classification: 'work' | 'personal' | 'mixed' | 'unclassified';
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
  // 1. Date span and active days from positive/slice-bearing days
  const activeDatesRow = db
    .prepare(
      `SELECT
        MIN(date) AS min_date,
        MAX(date) AS max_date,
        COUNT(DISTINCT date) AS active_days
       FROM (
         SELECT date FROM daily_totals WHERE total_seconds > 0
         UNION
         SELECT date FROM day_project_entity_slices WHERE total_seconds > 0
       )`
    )
    .get() as {
      min_date: string | null;
      max_date: string | null;
      active_days: number;
    } | undefined;

  const totalsRow = db
    .prepare(
      `SELECT
        COALESCE(SUM(total_seconds), 0) AS total_seconds,
        COALESCE(SUM(ai_sessions), 0) AS total_ai_sessions,
        COALESCE(SUM(ai_input_tokens + ai_cached_input_tokens + ai_output_tokens), 0) AS total_ai_tokens,
        COALESCE(SUM(ai_additions), 0) AS total_ai_additions
      FROM daily_totals`
    )
    .get() as {
      total_seconds: number;
      total_ai_sessions: number;
      total_ai_tokens: number;
      total_ai_additions: number;
    } | undefined;

  let totalSeconds = totalsRow?.total_seconds ?? 0;
  let totalAiSessions = totalsRow?.total_ai_sessions ?? 0;
  let totalAiTokens = totalsRow?.total_ai_tokens ?? 0;
  let totalAiAdditions = totalsRow?.total_ai_additions ?? 0;

  // Fallback to day_project_entity_slices if daily_totals has 0 seconds but slices exist
  if (totalSeconds === 0 && (activeDatesRow?.active_days ?? 0) > 0) {
    const sliceTotals = db
      .prepare(
        `SELECT
          COALESCE(SUM(total_seconds), 0) AS total_seconds,
          COALESCE(SUM(ai_sessions), 0) AS total_ai_sessions,
          0 AS total_ai_tokens,
          COALESCE(SUM(ai_additions), 0) AS total_ai_additions
        FROM day_project_entity_slices`
      )
      .get() as {
        total_seconds: number;
        total_ai_sessions: number;
        total_ai_tokens: number;
        total_ai_additions: number;
      } | undefined;

    if (sliceTotals) {
      totalSeconds = sliceTotals.total_seconds;
      totalAiSessions = sliceTotals.total_ai_sessions;
      totalAiTokens = sliceTotals.total_ai_tokens;
      totalAiAdditions = sliceTotals.total_ai_additions;
    }
  }

  const dateSpan: OverviewDateSpan = {
    minDate: activeDatesRow?.min_date ?? null,
    maxDate: activeDatesRow?.max_date ?? null,
    activeDays: clampCount(activeDatesRow?.active_days),
    totalSeconds: clampSeconds(totalSeconds),
    totalAiSessions: clampCount(totalAiSessions),
    totalAiTokens: clampCount(totalAiTokens),
    totalAiAdditions: clampCount(totalAiAdditions)
  };

  // 2. Heartbeat count
  const hbRow = db.prepare('SELECT COUNT(*) AS count FROM heartbeats').get() as { count: number };
  const heartbeatCount = clampCount(hbRow?.count);

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
    totalImports: clampCount(totalImportsRow?.count),
    latestImport: latestImportRow
      ? {
          id: latestImportRow.id,
          sourceType: allowlistedValue(latestImportRow.source_type, SOURCE_IMPORT_TYPES),
          status: allowlistedValue(latestImportRow.status, SOURCE_IMPORT_STATUSES),
          startedAt: truncateText(latestImportRow.started_at, MAX_LABEL_LENGTH),
          finishedAt: latestImportRow.finished_at
            ? truncateText(latestImportRow.finished_at, MAX_LABEL_LENGTH)
            : null,
          dayCount: clampCount(latestImportRow.day_count),
          recordCount: clampCount(latestImportRow.record_count),
          duplicateCount: clampCount(latestImportRow.duplicate_count),
          conflictCount: clampCount(latestImportRow.conflict_count)
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
        name: truncateText(
          slice.projectName ??
            (slice.isUnattributed ? '__unattributed__' : `Project #${slice.projectId}`),
          MAX_LABEL_LENGTH
        ),
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
      let classification: 'work' | 'personal' | 'mixed' | 'unclassified' = 'unclassified';
      if (p.workSeconds > 0 && p.personalSeconds === 0 && p.unclassifiedSeconds === 0) {
        classification = 'work';
      } else if (p.personalSeconds > 0 && p.workSeconds === 0 && p.unclassifiedSeconds === 0) {
        classification = 'personal';
      } else if (p.unclassifiedSeconds > 0 && p.workSeconds === 0 && p.personalSeconds === 0) {
        classification = 'unclassified';
      } else if (p.totalSeconds > 0) {
        classification = 'mixed';
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

  // Editor names arrive from WakaTime dimension payloads, so they are bounded
  // before they reach the page.
  const totalEditorSeconds = editorRows.reduce((sum, r) => sum + clampSeconds(r.total_seconds), 0);
  const topEditors: OverviewTopEditor[] = editorRows.map((r) => {
    const totalSeconds = clampSeconds(r.total_seconds);
    return {
      name: truncateText(r.name, MAX_LABEL_LENGTH),
      totalSeconds,
      formattedTime: formatDuration(totalSeconds),
      sharePercent:
        totalEditorSeconds > 0 ? Math.round((totalSeconds / totalEditorSeconds) * 100) : 0
    };
  });

  // 7. Recent activity from positive/slice-bearing dates
  const recentDays = db
    .prepare(
      `SELECT
        d.date,
        COALESCE(dt.total_seconds, ds.total_seconds, 0) AS total_seconds,
        COALESCE(dt.ai_sessions, ds.ai_sessions, 0) AS ai_sessions,
        COALESCE(dt.human_additions, ds.human_additions, 0) AS human_additions,
        COALESCE(dt.human_deletions, ds.human_deletions, 0) AS human_deletions,
        COALESCE(dt.ai_additions, ds.ai_additions, 0) AS ai_additions,
        COALESCE(dt.ai_deletions, ds.ai_deletions, 0) AS ai_deletions
       FROM (
         SELECT date FROM daily_totals WHERE total_seconds > 0
         UNION
         SELECT date FROM day_project_entity_slices WHERE total_seconds > 0
       ) d
       LEFT JOIN daily_totals dt ON dt.date = d.date AND dt.total_seconds > 0
       LEFT JOIN (
         SELECT date,
                SUM(total_seconds) AS total_seconds,
                SUM(ai_sessions) AS ai_sessions,
                SUM(human_additions) AS human_additions,
                SUM(human_deletions) AS human_deletions,
                SUM(ai_additions) AS ai_additions,
                SUM(ai_deletions) AS ai_deletions
         FROM day_project_entity_slices
         GROUP BY date
       ) ds ON ds.date = d.date
       ORDER BY d.date DESC
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
