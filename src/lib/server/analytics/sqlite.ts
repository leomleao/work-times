import type Database from 'better-sqlite3';
import type {
  WorkDaySummary,
  WorkEvidence,
  WorkOnlyAnalytics,
  WorkProjectSummary,
  WorkRangeSummary
} from './work-only.js';
import {
  SqliteClassificationService,
  type EvaluatedSlice
} from '../classification/sqlite.js';
import {
  evaluateDateFreshness,
  sanitizeMcpDataQuality,
  type LayerFreshnessRecord,
  type McpDataQuality,
  type SummaryFidelity,
  RECONCILE_CODES
} from '../sync/contracts.js';

export const MAX_ANALYTICS_RANGE_DAYS = 366;

function roundSeconds(seconds: number): number {
  return Math.round((seconds + Number.EPSILON) * 10_000) / 10_000;
}

function isValidIsoDate(dateStr: string): boolean {
  if (typeof dateStr !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return false;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

function validateDateString(dateStr: string, fieldName: string): void {
  if (!isValidIsoDate(dateStr)) {
    throw new Error(
      `Invalid date for ${fieldName}: '${dateStr}', expected valid calendar date (YYYY-MM-DD)`
    );
  }
}

function getDatesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const current = new Date(Date.UTC(sy, sm - 1, sd));
  const finish = new Date(Date.UTC(ey, em - 1, ed));

  while (current <= finish) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export interface WorkOnlyAnalyticsOptions {
  now?: () => Date;
  timezone?: string;
}

export class SqliteWorkOnlyAnalytics implements WorkOnlyAnalytics {
  private readonly classificationService: SqliteClassificationService;
  private readonly getNow: () => Date;
  private readonly configuredTimezone?: string;

  constructor(
    private readonly db: Database.Database,
    classificationService?: SqliteClassificationService,
    options?: WorkOnlyAnalyticsOptions
  ) {
    this.classificationService = classificationService ?? new SqliteClassificationService(this.db);
    this.getNow = options?.now ?? (() => new Date());
    this.configuredTimezone = options?.timezone;
  }

  private getSourceTimezone(): string | null {
    if (this.configuredTimezone) return this.configuredTimezone;
    try {
      const layerRow = this.db
        .prepare(
          `SELECT verified_timezone FROM sync_layer_state WHERE verified_timezone IS NOT NULL AND verified_timezone != '' ORDER BY updated_at DESC LIMIT 1`
        )
        .get() as { verified_timezone: string } | undefined;
      if (layerRow?.verified_timezone) return layerRow.verified_timezone;

      const acct = this.db
        .prepare(`SELECT timezone FROM account_settings WHERE timezone IS NOT NULL AND timezone != '' LIMIT 1`)
        .get() as { timezone: string } | undefined;
      if (acct?.timezone) return acct.timezone;

      const daily = this.db
        .prepare(`SELECT timezone FROM daily_totals WHERE timezone IS NOT NULL AND timezone != '' ORDER BY date DESC LIMIT 1`)
        .get() as { timezone: string } | undefined;
      if (daily?.timezone) return daily.timezone;
    } catch {}
    return null;
  }

  private fetchProjectBreakdown(
    date: string,
    projectId: number
  ): {
    categories: Array<{ name: string; seconds: number }>;
    languages: Array<{ name: string; seconds: number }>;
  } {
    const rows = this.db
      .prepare(
        `SELECT dimension, name, total_seconds
         FROM daily_dimension_totals
         WHERE date = ? AND scope = 'project' AND project_id = ? AND dimension IN ('category', 'language')
         ORDER BY total_seconds DESC, name ASC`
      )
      .all(date, projectId) as Array<{
      dimension: 'category' | 'language';
      name: string;
      total_seconds: number;
    }>;

    const categories = rows
      .filter((r) => r.dimension === 'category')
      .map((r) => ({ name: r.name, seconds: roundSeconds(r.total_seconds) }));

    const languages = rows
      .filter((r) => r.dimension === 'language')
      .map((r) => ({ name: r.name, seconds: roundSeconds(r.total_seconds) }));

    return { categories, languages };
  }

  private computeDataQuality(dates: string[]): McpDataQuality {
    if (dates.length === 0) {
      return {
        asOf: null,
        hasMissingDays: false,
        hasStaleDays: false,
        hasLimitedDetail: false,
        advisoryCodes: []
      };
    }

    let rows: Array<Record<string, unknown>> = [];
    let dailyTotalsRows: Array<{ date: string; total_seconds: number }> = [];
    let queryError = false;
    try {
      const placeholders = dates.map(() => '?').join(',');
      rows = this.db
        .prepare(
          `SELECT date, last_attempt_at, last_success_at, last_accepted_change_at,
                  accepted_source_reference, accepted_snapshot_version, accepted_fidelity,
                  accepted_content_hash, verified_timezone, evidence_matches_summary,
                  status_code, next_retry_at, is_stale, unresolved_mismatch,
                  has_detail_downgrade, has_restriction, has_failure
           FROM sync_layer_state
           WHERE layer = 'summaries' AND date IN (${placeholders})`
        )
        .all(...dates) as Array<Record<string, unknown>>;

      dailyTotalsRows = this.db
        .prepare(`SELECT date, total_seconds FROM daily_totals WHERE date IN (${placeholders})`)
        .all(...dates) as typeof dailyTotalsRows;
    } catch {
      queryError = true;
    }

    if (queryError) {
      return {
        asOf: null,
        hasMissingDays: true,
        hasStaleDays: true,
        hasLimitedDetail: false,
        advisoryCodes: ['DATA_UNAVAILABLE']
      };
    }

    const dailyTotalsMap = new Map<string, number>();
    for (const d of dailyTotalsRows) {
      dailyTotalsMap.set(d.date, d.total_seconds);
    }

    const rowMap = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      rowMap.set(String(r.date), r);
    }

    let hasMissingDays = false;
    let hasStaleDays = false;
    let hasLimitedDetail = false;
    let hasIncompleteSummary = false;
    const advisories = new Set<string>();
    const verificationTimestamps: string[] = [];
    const now = this.getNow();
    const timezone = this.getSourceTimezone();

    if (!timezone) {
      return {
        asOf: null,
        hasMissingDays: true,
        hasStaleDays: true,
        hasLimitedDetail: false,
        advisoryCodes: ['TIMEZONE_UNAVAILABLE']
      };
    }

    for (const date of dates) {
      if (!dailyTotalsMap.has(date)) {
        hasMissingDays = true;
        hasStaleDays = true;
        hasIncompleteSummary = true;
        advisories.add('STALE_MISSING_COVERAGE');
      }

      const row = rowMap.get(date);
      if (!row || !row.last_success_at) {
        hasMissingDays = true;
        hasStaleDays = true;
        hasIncompleteSummary = true;
        advisories.add('STALE_MISSING_COVERAGE');
        continue;
      }

      if (
        row.has_failure ||
        (row.status_code as string)?.startsWith('HTTP_5') ||
        row.status_code === 'FAILED'
      ) {
        hasIncompleteSummary = true;
      }

      if (
        row.has_restriction ||
        (row.status_code as string)?.startsWith('HTTP_402') ||
        (row.status_code as string)?.startsWith('HTTP_403') ||
        row.status_code === 'RESTRICTED'
      ) {
        hasLimitedDetail = true;
        hasIncompleteSummary = true;
        advisories.add('RESTRICTED');
      }

      if (Boolean(row.unresolved_mismatch)) {
        hasIncompleteSummary = true;
        advisories.add('UNRESOLVED_MISMATCH');
      }

      if (
        row.accepted_fidelity === 'coarse_project' ||
        Boolean(row.has_detail_downgrade) ||
        row.status_code === RECONCILE_CODES.DETAIL_DOWNGRADE
      ) {
        hasLimitedDetail = true;
        advisories.add(RECONCILE_CODES.DETAIL_DOWNGRADE);
      }

      const hasRequiredSummaryEvidence = Boolean(
        row.accepted_source_reference &&
        row.accepted_content_hash &&
        row.accepted_fidelity &&
        row.verified_timezone &&
        typeof row.accepted_snapshot_version === 'number' &&
        row.accepted_snapshot_version > 0 &&
        !row.has_failure &&
        !row.has_restriction &&
        !row.unresolved_mismatch
      );
      if (!hasRequiredSummaryEvidence) {
        hasIncompleteSummary = true;
      }

      const dayTotalSeconds = dailyTotalsMap.get(date);
      if (dayTotalSeconds === 0) {
        if (row.accepted_fidelity !== 'verified_zero' || !hasRequiredSummaryEvidence) {
          hasIncompleteSummary = true;
          advisories.add('UNVERIFIED_ZERO');
        }
      }

      if (row.evidence_matches_summary === 0) {
        hasIncompleteSummary = true;
        advisories.add('EVIDENCE_SUMMARY_MISMATCH');
      }

      const freshnessRecord: LayerFreshnessRecord = {
        lastAttemptAt: (row.last_attempt_at as string) ?? null,
        lastSuccessAt: (row.last_success_at as string) ?? null,
        lastAcceptedChangeAt: (row.last_accepted_change_at as string) ?? null,
        acceptedSourceReference: (row.accepted_source_reference as string) ?? null,
        acceptedSnapshotVersion:
          typeof row.accepted_snapshot_version === 'number' ? row.accepted_snapshot_version : null,
        acceptedFidelity: (row.accepted_fidelity as SummaryFidelity) ?? null,
        acceptedContentHash: (row.accepted_content_hash as string) ?? null,
        verifiedTimezone: (row.verified_timezone as string) ?? null,
        evidenceMatchesSummary:
          row.evidence_matches_summary !== null && row.evidence_matches_summary !== undefined
            ? Boolean(row.evidence_matches_summary)
            : null,
        statusCode: (row.status_code as string) ?? null,
        nextRetryAt: (row.next_retry_at as string) ?? null,
        isStale: Boolean(row.is_stale),
        unresolvedMismatch: Boolean(row.unresolved_mismatch),
        hasDetailDowngrade: Boolean(row.has_detail_downgrade),
        hasRestriction: Boolean(row.has_restriction),
        hasFailure: Boolean(row.has_failure)
      };

      const evalResult = evaluateDateFreshness(date, freshnessRecord, now, timezone);
      const isAgeOrUnresolvedStale = evalResult.reasons.some(
        (r) =>
          r !== RECONCILE_CODES.CURRENT_DAY_PROVISIONAL &&
          r !== 'DETAIL_DOWNGRADE_PRESERVED'
      );
      if (isAgeOrUnresolvedStale) {
        hasStaleDays = true;
        hasIncompleteSummary = true;
        advisories.add('STALE_DATA');
      }
      for (const reason of evalResult.reasons) {
        if (
          reason.startsWith('CURRENT_DAY_') ||
          reason.startsWith('TIMEZONE_') ||
          reason.startsWith('DETAIL_') ||
          reason.startsWith('STALE_')
        ) {
          advisories.add(reason);
        } else if (
          reason.startsWith('RECENT_EXCEEDED') ||
          reason.startsWith('RECONCILE_EXCEEDED') ||
          reason.startsWith('COMPARE_EXCEEDED')
        ) {
          advisories.add(`STALE_${reason}`);
        }
      }

      if (typeof row.last_success_at === 'string') {
        verificationTimestamps.push(row.last_success_at);
      }
    }

    let asOf: string | null = null;
    if (
      !hasMissingDays &&
      !hasIncompleteSummary &&
      !hasStaleDays &&
      verificationTimestamps.length === dates.length
    ) {
      verificationTimestamps.sort((a, b) => Date.parse(a) - Date.parse(b));
      asOf = verificationTimestamps[0];
    }

    const sanitized = sanitizeMcpDataQuality({
      asOf,
      hasMissingDays,
      hasStaleDays,
      hasLimitedDetail,
      advisoryCodes: Array.from(advisories)
    });
    const extraCodes = Array.from(advisories).filter((c) => c === 'UNVERIFIED_ZERO' || c === 'DATA_UNAVAILABLE');
    return {
      ...sanitized,
      advisoryCodes: [...new Set([...sanitized.advisoryCodes, ...extraCodes])]
    };
  }

  async getRangeSummary(input: { start: string; end: string }): Promise<WorkRangeSummary> {
    validateDateString(input.start, 'start');
    validateDateString(input.end, 'end');

    if (input.start > input.end) {
      throw new Error('start must be on or before end');
    }

    const [sy, sm, sd] = input.start.split('-').map(Number);
    const [ey, em, ed] = input.end.split('-').map(Number);
    const startDate = new Date(Date.UTC(sy, sm - 1, sd));
    const endDate = new Date(Date.UTC(ey, em - 1, ed));
    const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

    if (diffDays > MAX_ANALYTICS_RANGE_DAYS) {
      throw new Error(
        `Requested range of ${diffDays} days exceeds maximum allowed range of ${MAX_ANALYTICS_RANGE_DAYS} days`
      );
    }

    const dates = getDatesInRange(input.start, input.end);
    const slices = this.classificationService.classifySlices({
      startDate: input.start,
      endDate: input.end
    });

    const slicesByDate = new Map<string, EvaluatedSlice[]>();
    for (const s of slices) {
      let list = slicesByDate.get(s.date);
      if (!list) {
        list = [];
        slicesByDate.set(s.date, list);
      }
      list.push(s);
    }

    const days: WorkDaySummary[] = [];
    let rangeWorkSeconds = 0;
    let rangeUnclassifiedSeconds = 0;

    for (const date of dates) {
      const daySlices = slicesByDate.get(date) ?? [];

      let dayWorkSeconds = 0;
      let dayUnclassifiedSeconds = 0;

      const projectMap = new Map<
        number,
        {
          name: string;
          workSeconds: number;
          hasNonWork: boolean;
        }
      >();

      for (const s of daySlices) {
        const isWork = s.decision.classification === 'work';
        const isUnclassified = s.decision.classification === 'unclassified';

        if (isWork) {
          dayWorkSeconds += s.totalSeconds;
        } else if (isUnclassified) {
          dayUnclassifiedSeconds += s.totalSeconds;
        }

        if (s.projectName && !s.isUnattributed) {
          let pEntry = projectMap.get(s.projectId);
          if (!pEntry) {
            pEntry = {
              name: s.projectName,
              workSeconds: 0,
              hasNonWork: false
            };
            projectMap.set(s.projectId, pEntry);
          }

          if (isWork) {
            pEntry.workSeconds += s.totalSeconds;
          } else {
            pEntry.hasNonWork = true;
          }
        }
      }

      const projects: WorkProjectSummary[] = [];

      for (const [projectId, p] of projectMap.entries()) {
        if (p.workSeconds <= 0) continue;

        let categories: Array<{ name: string; seconds: number }> = [];
        let languages: Array<{ name: string; seconds: number }> = [];

        if (!p.hasNonWork) {
          const breakdown = this.fetchProjectBreakdown(date, projectId);
          categories = breakdown.categories;
          languages = breakdown.languages;
        }

        projects.push({
          project: p.name,
          seconds: roundSeconds(p.workSeconds),
          categories,
          languages
        });
      }

      projects.sort((a, b) => {
        if (b.seconds !== a.seconds) return b.seconds - a.seconds;
        return a.project.localeCompare(b.project);
      });

      const roundedDayWork = roundSeconds(dayWorkSeconds);
      const roundedDayUnclassified = roundSeconds(dayUnclassifiedSeconds);

      rangeWorkSeconds += roundedDayWork;
      rangeUnclassifiedSeconds += roundedDayUnclassified;

      days.push({
        date,
        workSeconds: roundedDayWork,
        projects
      });
    }

    const finalRangeWork = roundSeconds(rangeWorkSeconds);
    const finalRangeUnclassified = roundSeconds(rangeUnclassifiedSeconds);

    return {
      start: input.start,
      end: input.end,
      workSeconds: finalRangeWork,
      unclassifiedSeconds: finalRangeUnclassified,
      hasUnclassified: finalRangeUnclassified > 0,
      days,
      dataQuality: this.computeDataQuality(dates)
    };
  }

  async getDayEvidence(input: { date: string; project?: string }): Promise<WorkEvidence> {
    validateDateString(input.date, 'date');

    const daySlices = this.classificationService.classifySlices({ date: input.date });

    if (input.project !== undefined) {
      const targetProjectName = input.project.trim();
      const projectSlices = daySlices.filter(
        (s) => s.projectName === targetProjectName && !s.isUnattributed
      );

      let projectWorkSeconds = 0;
      let projectUnclassifiedSeconds = 0;
      let hasNonWork = false;
      let projectId: number | null = null;

      for (const s of projectSlices) {
        projectId = s.projectId;
        if (s.decision.classification === 'work') {
          projectWorkSeconds += s.totalSeconds;
        } else {
          hasNonWork = true;
          if (s.decision.classification === 'unclassified') {
            projectUnclassifiedSeconds += s.totalSeconds;
          }
        }
      }

      if (projectWorkSeconds <= 0) {
        return {
          date: input.date,
          workSeconds: 0,
          unclassifiedSeconds: 0,
          hasUnclassified: false,
          projects: [],
          dataQuality: this.computeDataQuality([input.date])
        };
      }

      let categories: Array<{ name: string; seconds: number }> = [];
      let languages: Array<{ name: string; seconds: number }> = [];

      if (!hasNonWork && projectId !== null) {
        const breakdown = this.fetchProjectBreakdown(input.date, projectId);
        categories = breakdown.categories;
        languages = breakdown.languages;
      }

      const roundedWork = roundSeconds(projectWorkSeconds);
      const roundedUnclass = roundSeconds(projectUnclassifiedSeconds);

      return {
        date: input.date,
        workSeconds: roundedWork,
        unclassifiedSeconds: roundedUnclass,
        hasUnclassified: roundedUnclass > 0,
        projects: [
          {
            project: targetProjectName,
            seconds: roundedWork,
            categories,
            languages
          }
        ],
        dataQuality: this.computeDataQuality([input.date])
      };
    }

    let dayWorkSeconds = 0;
    let dayUnclassifiedSeconds = 0;

    const projectMap = new Map<
      number,
      {
        name: string;
        workSeconds: number;
        hasNonWork: boolean;
      }
    >();

    for (const s of daySlices) {
      const isWork = s.decision.classification === 'work';
      const isUnclassified = s.decision.classification === 'unclassified';

      if (isWork) {
        dayWorkSeconds += s.totalSeconds;
      } else if (isUnclassified) {
        dayUnclassifiedSeconds += s.totalSeconds;
      }

      if (s.projectName && !s.isUnattributed) {
        let pEntry = projectMap.get(s.projectId);
        if (!pEntry) {
          pEntry = {
            name: s.projectName,
            workSeconds: 0,
            hasNonWork: false
          };
          projectMap.set(s.projectId, pEntry);
        }

        if (isWork) {
          pEntry.workSeconds += s.totalSeconds;
        } else {
          pEntry.hasNonWork = true;
        }
      }
    }

    const projects: WorkProjectSummary[] = [];

    for (const [projectId, p] of projectMap.entries()) {
      if (p.workSeconds <= 0) continue;

      let categories: Array<{ name: string; seconds: number }> = [];
      let languages: Array<{ name: string; seconds: number }> = [];

      if (!p.hasNonWork) {
        const breakdown = this.fetchProjectBreakdown(input.date, projectId);
        categories = breakdown.categories;
        languages = breakdown.languages;
      }

      projects.push({
        project: p.name,
        seconds: roundSeconds(p.workSeconds),
        categories,
        languages
      });
    }

    projects.sort((a, b) => {
      if (b.seconds !== a.seconds) return b.seconds - a.seconds;
      return a.project.localeCompare(b.project);
    });

    const roundedDayWork = roundSeconds(dayWorkSeconds);
    const roundedDayUnclassified = roundSeconds(dayUnclassifiedSeconds);

    return {
      date: input.date,
      workSeconds: roundedDayWork,
      unclassifiedSeconds: roundedDayUnclassified,
      hasUnclassified: roundedDayUnclassified > 0,
      projects,
      dataQuality: this.computeDataQuality([input.date])
    };
  }

  getDailyClassificationTotal(date: string): {
    date: string;
    workSeconds: number;
    personalSeconds: number;
    unclassifiedSeconds: number;
    totalSliceSeconds: number;
    dailyTotalSeconds: number | null;
    diff: number | null;
    isEqual: boolean;
  } {
    validateDateString(date, 'date');

    const slices = this.classificationService.classifySlices({ date });

    let workSeconds = 0;
    let personalSeconds = 0;
    let unclassifiedSeconds = 0;

    for (const s of slices) {
      switch (s.decision.classification) {
        case 'work':
          workSeconds += s.totalSeconds;
          break;
        case 'personal':
          personalSeconds += s.totalSeconds;
          break;
        case 'unclassified':
          unclassifiedSeconds += s.totalSeconds;
          break;
      }
    }

    const roundedWork = roundSeconds(workSeconds);
    const roundedPersonal = roundSeconds(personalSeconds);
    const roundedUnclassified = roundSeconds(unclassifiedSeconds);
    const totalSliceSeconds = roundSeconds(roundedWork + roundedPersonal + roundedUnclassified);

    const row = this.db
      .prepare('SELECT total_seconds FROM daily_totals WHERE date = ?')
      .get(date) as { total_seconds: number } | undefined;

    const dailyTotalSeconds = row ? roundSeconds(row.total_seconds) : null;
    const diff =
      dailyTotalSeconds !== null ? Math.abs(totalSliceSeconds - dailyTotalSeconds) : null;
    const isEqual = diff !== null ? diff < 0.001 : false;

    return {
      date,
      workSeconds: roundedWork,
      personalSeconds: roundedPersonal,
      unclassifiedSeconds: roundedUnclassified,
      totalSliceSeconds,
      dailyTotalSeconds,
      diff,
      isEqual
    };
  }
}
