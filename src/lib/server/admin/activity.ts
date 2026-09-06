import type Database from 'better-sqlite3';
import type { SqliteClassificationService, EvaluatedSlice } from '../classification/sqlite.js';
import { formatDuration } from './overview.js';
import { boundedStringList, clampCount, clampSeconds, truncateText, MAX_LABEL_LENGTH } from './sanitize.js';

/** Distinct dates offered by the date picker. */
export const MAX_DISTINCT_DATES = 60;
/**
 * Hard cap on slices materialized for one activity view.
 *
 * The date-range validator already caps a query at 366 days, but a single busy
 * day can carry tens of thousands of slices, and every one of them is loaded,
 * classified and sorted in memory before pagination. The cap keeps one request
 * bounded regardless of how much history the database holds; when it bites,
 * `isTruncated` says so rather than letting the page imply the totals are
 * complete.
 */
export const MAX_ACTIVITY_SLICES = 20_000;
/** Identity selectors surfaced per slice row. */
export const MAX_SLICE_SELECTORS = 10;

export interface ActivityFilterQuery {
  date?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  classification?: string | null;
  q?: string | null;
  page?: number | string | null;
  pageSize?: number | string | null;
}

export interface ActivitySliceItem {
  id: number;
  date: string;
  projectId: number;
  projectName: string;
  entity: string;
  entityType: 'file' | 'app' | 'domain' | 'unattributed';
  totalSeconds: number;
  formattedDuration: string;
  isUnattributed: boolean;
  machineIds: string[];
  editors: string[];
  classification: 'work' | 'personal' | 'unclassified';
  decisionSource: 'rule' | 'override' | 'ambiguous' | 'default';
  winningRuleId: string | null;
  hasOverride: boolean;
  aiSessions: number;
  aiAdditions: number;
  aiDeletions: number;
  humanAdditions: number;
  humanDeletions: number;
}

export interface ActivityData {
  items: ActivitySliceItem[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
  filters: {
    selectedDate: string | null;
    startDate: string | null;
    endDate: string | null;
    classification: 'all' | 'work' | 'personal' | 'unclassified';
    q: string;
  };
  metrics: {
    totalDurationSeconds: number;
    formattedTotalDuration: string;
    workSeconds: number;
    personalSeconds: number;
    unclassifiedSeconds: number;
    totalSlices: number;
    aiSessions: number;
  };
  distinctDates: string[];
  latestDate: string | null;
  isEmpty: boolean;
  /**
   * True when `MAX_ACTIVITY_SLICES` capped the slices considered, so the totals
   * and counts describe only the capped set. The page must say so rather than
   * present them as the full picture.
   */
  isTruncated: boolean;
  /** The cap that produced `isTruncated`, so the UI can name the limit. */
  maxSlices: number;
}

export interface ValidatedActivityFilters {
  date: string | null;
  startDate: string | null;
  endDate: string | null;
  classification: 'all' | 'work' | 'personal' | 'unclassified';
  q: string;
  page: number;
  pageSize: number;
}

export type ActivityValidationResult =
  | { ok: true; filters: ValidatedActivityFilters }
  | { ok: false; error: string };

/**
 * Rejection of a user-supplied activity query.
 *
 * Carries the HTTP status the loader should surface: a malformed `?date=` or
 * `?page=` is a bad request, not a server fault, so it must not render as a
 * 500. The message is built from the validator's own text and never echoes an
 * unbounded slice of the raw query string.
 */
export class ActivityFilterError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ActivityFilterError';
  }
}

/**
 * Echo an offending query value back in an error message without letting the
 * caller choose how long that message is.
 */
function echoValue(value: unknown): string {
  return truncateText(value, 64);
}

export function parseStrictIsoDate(str: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [yStr, mStr, dStr] = str.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return str;
}

export function parseStrictPositiveInteger(val: unknown): number | null {
  if (typeof val === 'number') {
    if (Number.isSafeInteger(val) && val >= 1) return val;
    return null;
  }
  if (typeof val === 'string') {
    if (!/^[1-9]\d*$/.test(val)) return null;
    const n = Number(val);
    if (Number.isSafeInteger(n) && n >= 1) return n;
    return null;
  }
  return null;
}

export function validateActivityFilterQuery(
  rawFilters: ActivityFilterQuery
): ActivityValidationResult {
  // 1. Validate date
  let selectedDate: string | null = null;
  if (rawFilters.date !== undefined && rawFilters.date !== null && rawFilters.date !== '') {
    if (typeof rawFilters.date !== 'string') {
      return { ok: false, error: 'date must be a valid ISO date string (YYYY-MM-DD).' };
    }
    const parsed = parseStrictIsoDate(rawFilters.date);
    if (!parsed) {
      return { ok: false, error: `Invalid date '${echoValue(rawFilters.date)}': must be a valid ISO calendar date (YYYY-MM-DD).` };
    }
    selectedDate = parsed;
  }

  // 2. Validate startDate and endDate
  let startDate: string | null = null;
  if (rawFilters.startDate !== undefined && rawFilters.startDate !== null && rawFilters.startDate !== '') {
    if (typeof rawFilters.startDate !== 'string') {
      return { ok: false, error: 'startDate must be a valid ISO date string (YYYY-MM-DD).' };
    }
    const parsed = parseStrictIsoDate(rawFilters.startDate);
    if (!parsed) {
      return { ok: false, error: `Invalid startDate '${echoValue(rawFilters.startDate)}': must be a valid ISO calendar date (YYYY-MM-DD).` };
    }
    startDate = parsed;
  }

  let endDate: string | null = null;
  if (rawFilters.endDate !== undefined && rawFilters.endDate !== null && rawFilters.endDate !== '') {
    if (typeof rawFilters.endDate !== 'string') {
      return { ok: false, error: 'endDate must be a valid ISO date string (YYYY-MM-DD).' };
    }
    const parsed = parseStrictIsoDate(rawFilters.endDate);
    if (!parsed) {
      return { ok: false, error: `Invalid endDate '${echoValue(rawFilters.endDate)}': must be a valid ISO calendar date (YYYY-MM-DD).` };
    }
    endDate = parsed;
  }

  // Selected date mutually exclusive with range
  if (selectedDate && (startDate || endDate)) {
    return { ok: false, error: 'Selected date cannot be combined with startDate or endDate range filters.' };
  }

  // Both range bounds required
  if ((startDate && !endDate) || (!startDate && endDate)) {
    return { ok: false, error: 'Both startDate and endDate are required when querying a date range.' };
  }

  // start <= end and hard maximum 366-day range
  if (startDate && endDate) {
    if (startDate > endDate) {
      return { ok: false, error: `startDate (${startDate}) must be less than or equal to endDate (${endDate}).` };
    }
    const startMs = Date.parse(`${startDate}T00:00:00Z`);
    const endMs = Date.parse(`${endDate}T00:00:00Z`);
    const diffDays = Math.round((endMs - startMs) / 86_400_000) + 1;
    if (diffDays > 366) {
      return { ok: false, error: `Date range of ${diffDays} days exceeds the maximum allowed 366-day range.` };
    }
  }

  // 3. Page bounds
  let page = 1;
  if (rawFilters.page !== undefined && rawFilters.page !== null && rawFilters.page !== '') {
    const parsedPage = parseStrictPositiveInteger(rawFilters.page);
    if (parsedPage === null || parsedPage > 100_000) {
      return { ok: false, error: 'page must be a safe positive integer (1 to 100,000).' };
    }
    page = parsedPage;
  }

  // 4. PageSize bounds
  let pageSize = 50;
  if (rawFilters.pageSize !== undefined && rawFilters.pageSize !== null && rawFilters.pageSize !== '') {
    const parsedPageSize = parseStrictPositiveInteger(rawFilters.pageSize);
    if (parsedPageSize === null || parsedPageSize > 100) {
      return { ok: false, error: 'pageSize must be a safe integer between 1 and 100.' };
    }
    pageSize = parsedPageSize;
  }

  // 5. Classification allowlist
  let classification: 'all' | 'work' | 'personal' | 'unclassified' = 'all';
  if (rawFilters.classification !== undefined && rawFilters.classification !== null && rawFilters.classification !== '') {
    if (
      rawFilters.classification !== 'all' &&
      rawFilters.classification !== 'work' &&
      rawFilters.classification !== 'personal' &&
      rawFilters.classification !== 'unclassified'
    ) {
      return { ok: false, error: `Invalid classification '${echoValue(rawFilters.classification)}': must be 'all', 'work', 'personal', or 'unclassified'.` };
    }
    classification = rawFilters.classification;
  }

  // 6. Query text
  let q = '';
  if (rawFilters.q !== undefined && rawFilters.q !== null) {
    if (typeof rawFilters.q !== 'string') {
      return { ok: false, error: 'Query parameter q must be a string.' };
    }
    if (rawFilters.q.length > 200) {
      return { ok: false, error: 'Query parameter q cannot exceed 200 characters.' };
    }
    q = rawFilters.q.trim();
  }

  return {
    ok: true,
    filters: {
      date: selectedDate,
      startDate,
      endDate,
      classification,
      q,
      page,
      pageSize
    }
  };
}

/**
 * The single pagination shape for a result with no rows.
 *
 * Both empty paths -- an empty database and a filter that matches nothing --
 * route through this so a caller can never see `totalPages: 0` alongside a
 * `hasNextPage: true`, or a page number that differs between the two.
 */
function emptyPagination(page: number, pageSize: number): ActivityData['pagination'] {
  return {
    page,
    pageSize,
    totalItems: 0,
    totalPages: 0,
    hasNextPage: false,
    hasPrevPage: false
  };
}

export function getActivityData(
  db: Database.Database,
  classification: SqliteClassificationService,
  rawFilters: ActivityFilterQuery
): ActivityData {
  const validation = validateActivityFilterQuery(rawFilters);
  if (!validation.ok) {
    throw new ActivityFilterError(validation.error);
  }
  const validated = validation.filters;

  // 1. Discover latest slice-bearing date and available distinct dates
  const latestDateRow = db
    .prepare('SELECT MAX(date) AS max_date FROM day_project_entity_slices')
    .get() as { max_date: string | null } | undefined;
  const latestDate = latestDateRow?.max_date ?? null;

  const distinctDateRows = db
    .prepare('SELECT DISTINCT date FROM day_project_entity_slices ORDER BY date DESC LIMIT ?')
    .all(MAX_DISTINCT_DATES) as Array<{ date: string }>;
  const distinctDates = distinctDateRows.map((r) => r.date);

  // If the database has no slices at all
  if (!latestDate || distinctDates.length === 0) {
    return {
      items: [],
      // Same pagination shape an in-range query with no matches produces, so
      // the empty database and the empty filter render identically.
      pagination: emptyPagination(validated.page, validated.pageSize),
      // The requested filters are echoed rather than blanked: the page shows
      // the query the operator actually ran, not a query nobody made.
      filters: {
        selectedDate: validated.date,
        startDate: validated.startDate,
        endDate: validated.endDate,
        classification: validated.classification,
        q: validated.q
      },
      metrics: {
        totalDurationSeconds: 0,
        formattedTotalDuration: '0m',
        workSeconds: 0,
        personalSeconds: 0,
        unclassifiedSeconds: 0,
        totalSlices: 0,
        aiSessions: 0
      },
      distinctDates: [],
      latestDate: null,
      isEmpty: true,
      isTruncated: false,
      maxSlices: MAX_ACTIVITY_SLICES
    };
  }

  // 2. Resolve date filter
  let selectedDate = validated.date;
  const startDate = validated.startDate;
  const endDate = validated.endDate;

  // "Default to the latest slice-bearing date/range"
  if (!selectedDate && !startDate && !endDate) {
    selectedDate = latestDate;
  }

  const classificationFilter = validated.classification;
  const q = validated.q;
  const page = validated.page;
  const pageSize = validated.pageSize;

  // 3. Load classified slices for the bounded date or range
  const sliceFilter: { date?: string; startDate?: string; endDate?: string } = {};
  if (selectedDate) {
    sliceFilter.date = selectedDate;
  } else {
    if (startDate) sliceFilter.startDate = startDate;
    if (endDate) sliceFilter.endDate = endDate;
  }

  const loadedSlices: EvaluatedSlice[] = classification.classifySlices(sliceFilter);
  const isTruncated = loadedSlices.length > MAX_ACTIVITY_SLICES;
  const classifiedSlices = isTruncated
    ? loadedSlices.slice(0, MAX_ACTIVITY_SLICES)
    : loadedSlices;

  // Load telemetry metrics (ai_sessions, additions, deletions) for these slices
  const sliceIds = classifiedSlices.map((s) => s.id);
  const telemetryMap = new Map<
    number,
    {
      ai_sessions: number;
      ai_additions: number;
      ai_deletions: number;
      human_additions: number;
      human_deletions: number;
    }
  >();

  if (sliceIds.length > 0) {
    // Query in batches if needed
    const batchSize = 500;
    for (let i = 0; i < sliceIds.length; i += batchSize) {
      const batch = sliceIds.slice(i, i + batchSize);
      const placeholders = batch.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT id, ai_sessions, ai_additions, ai_deletions, human_additions, human_deletions
           FROM day_project_entity_slices
           WHERE id IN (${placeholders})`
        )
        .all(...batch) as Array<{
          id: number;
          ai_sessions: number;
          ai_additions: number;
          ai_deletions: number;
          human_additions: number;
          human_deletions: number;
        }>;

      for (const r of rows) {
        telemetryMap.set(r.id, r);
      }
    }
  }

  // 4. Apply in-memory classification and query text filters
  const lowerQ = q.toLowerCase();
  const filteredSlices = classifiedSlices.filter((s) => {
    if (classificationFilter !== 'all' && s.decision.classification !== classificationFilter) {
      return false;
    }

    if (lowerQ) {
      const entityMatch = s.entity.toLowerCase().includes(lowerQ);
      const projMatch = (s.projectName ?? '').toLowerCase().includes(lowerQ);
      const machineMatch = s.machineIds.some((m) => m.toLowerCase().includes(lowerQ));
      const editorMatch = s.editors.some((e) => e.toLowerCase().includes(lowerQ));
      if (!entityMatch && !projMatch && !machineMatch && !editorMatch) {
        return false;
      }
    }

    return true;
  });

  // Sort slices: newest date first, then largest duration
  filteredSlices.sort((a, b) => {
    const cmp = b.date.localeCompare(a.date);
    if (cmp !== 0) return cmp;
    return b.totalSeconds - a.totalSeconds;
  });

  // 5. Compute aggregate metrics for the filtered view
  let totalDurationSeconds = 0;
  let workSeconds = 0;
  let personalSeconds = 0;
  let unclassifiedSeconds = 0;
  let totalAiSessions = 0;

  for (const s of filteredSlices) {
    const seconds = clampSeconds(s.totalSeconds);
    totalDurationSeconds += seconds;
    const telem = telemetryMap.get(s.id);
    if (telem) {
      totalAiSessions += clampCount(telem.ai_sessions);
    }

    switch (s.decision.classification) {
      case 'work':
        workSeconds += seconds;
        break;
      case 'personal':
        personalSeconds += seconds;
        break;
      default:
        unclassifiedSeconds += seconds;
        break;
    }
  }

  // 6. Paginate results
  const totalItems = filteredSlices.length;
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);
  const startIndex = (page - 1) * pageSize;
  const pageSlices =
    totalItems === 0 || page > totalPages
      ? []
      : filteredSlices.slice(startIndex, startIndex + pageSize);

  // Entity paths, project names and identity selectors all originate in
  // WakaTime payloads, so each row is bounded before it reaches the page.
  const items: ActivitySliceItem[] = pageSlices.map((s) => {
    const telem = telemetryMap.get(s.id);
    const totalSeconds = clampSeconds(s.totalSeconds);
    return {
      id: s.id,
      date: s.date,
      projectId: s.projectId,
      projectName: truncateText(
        s.projectName ?? (s.isUnattributed ? '__unattributed__' : `Project #${s.projectId}`),
        MAX_LABEL_LENGTH
      ),
      entity: truncateText(s.entity, MAX_LABEL_LENGTH),
      entityType: s.entityType,
      totalSeconds,
      formattedDuration: formatDuration(totalSeconds),
      isUnattributed: s.isUnattributed,
      machineIds: boundedStringList(s.machineIds, MAX_SLICE_SELECTORS),
      editors: boundedStringList(s.editors, MAX_SLICE_SELECTORS),
      classification: s.decision.classification,
      decisionSource: s.decision.source,
      winningRuleId: s.decision.winningRuleId,
      hasOverride: Boolean(s.allocation),
      aiSessions: clampCount(telem?.ai_sessions),
      aiAdditions: clampCount(telem?.ai_additions),
      aiDeletions: clampCount(telem?.ai_deletions),
      humanAdditions: clampCount(telem?.human_additions),
      humanDeletions: clampCount(telem?.human_deletions)
    };
  });

  return {
    items,
    pagination:
      totalItems === 0
        ? emptyPagination(page, pageSize)
        : {
            page,
            pageSize,
            totalItems,
            totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1
          },
    filters: {
      selectedDate,
      startDate,
      endDate,
      classification: classificationFilter,
      q
    },
    metrics: {
      totalDurationSeconds,
      formattedTotalDuration: formatDuration(totalDurationSeconds),
      workSeconds,
      personalSeconds,
      unclassifiedSeconds,
      totalSlices: totalItems,
      aiSessions: totalAiSessions
    },
    distinctDates,
    latestDate,
    isEmpty: false,
    isTruncated,
    maxSlices: MAX_ACTIVITY_SLICES
  };
}
