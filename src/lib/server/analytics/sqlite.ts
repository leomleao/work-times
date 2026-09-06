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

export class SqliteWorkOnlyAnalytics implements WorkOnlyAnalytics {
  private readonly classificationService: SqliteClassificationService;

  constructor(
    private readonly db: Database.Database,
    classificationService?: SqliteClassificationService
  ) {
    this.classificationService = classificationService ?? new SqliteClassificationService(this.db);
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
      days
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
          projects: []
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
        ]
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
      projects
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
