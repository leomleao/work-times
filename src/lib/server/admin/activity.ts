import type Database from 'better-sqlite3';
import type { SqliteClassificationService, EvaluatedSlice } from '../classification/sqlite.js';
import { formatDuration } from './overview.js';

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
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(str: string): boolean {
  if (!DATE_REGEX.test(str)) return false;
  const t = Date.parse(str + 'T00:00:00Z');
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === str;
}

export function getActivityData(
  db: Database.Database,
  classification: SqliteClassificationService,
  rawFilters: ActivityFilterQuery
): ActivityData {
  // 1. Discover latest slice-bearing date and available distinct dates
  const latestDateRow = db
    .prepare('SELECT MAX(date) AS max_date FROM day_project_entity_slices')
    .get() as { max_date: string | null } | undefined;
  const latestDate = latestDateRow?.max_date ?? null;

  const distinctDateRows = db
    .prepare('SELECT DISTINCT date FROM day_project_entity_slices ORDER BY date DESC LIMIT 60')
    .all() as Array<{ date: string }>;
  const distinctDates = distinctDateRows.map((r) => r.date);

  // If the database has no slices at all
  if (!latestDate || distinctDates.length === 0) {
    return {
      items: [],
      pagination: {
        page: 1,
        pageSize: 50,
        totalItems: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPrevPage: false
      },
      filters: {
        selectedDate: null,
        startDate: null,
        endDate: null,
        classification: 'all',
        q: ''
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
      isEmpty: true
    };
  }

  // 2. Validate and normalize filter inputs
  let selectedDate: string | null = null;
  let startDate: string | null = null;
  let endDate: string | null = null;

  if (rawFilters.date && isValidDateString(rawFilters.date.trim())) {
    selectedDate = rawFilters.date.trim();
  }

  if (rawFilters.startDate && isValidDateString(rawFilters.startDate.trim())) {
    startDate = rawFilters.startDate.trim();
  }

  if (rawFilters.endDate && isValidDateString(rawFilters.endDate.trim())) {
    endDate = rawFilters.endDate.trim();
  }

  // "Default to the latest slice-bearing date/range"
  if (!selectedDate && !startDate && !endDate) {
    selectedDate = latestDate;
  }

  let classificationFilter: 'all' | 'work' | 'personal' | 'unclassified' = 'all';
  if (
    rawFilters.classification === 'work' ||
    rawFilters.classification === 'personal' ||
    rawFilters.classification === 'unclassified'
  ) {
    classificationFilter = rawFilters.classification;
  }

  const q = typeof rawFilters.q === 'string' ? rawFilters.q.trim().slice(0, 100) : '';

  // Pagination validation
  let page = 1;
  if (rawFilters.page !== undefined && rawFilters.page !== null) {
    const parsedPage = Number.parseInt(String(rawFilters.page), 10);
    if (Number.isSafeInteger(parsedPage) && parsedPage >= 1) {
      page = parsedPage;
    }
  }

  let pageSize = 50;
  if (rawFilters.pageSize !== undefined && rawFilters.pageSize !== null) {
    const parsedSize = Number.parseInt(String(rawFilters.pageSize), 10);
    if (Number.isSafeInteger(parsedSize) && parsedSize >= 1 && parsedSize <= 100) {
      pageSize = parsedSize;
    }
  }

  // 3. Load classified slices for the bounded date or range
  const sliceFilter: { date?: string; startDate?: string; endDate?: string } = {};
  if (selectedDate) {
    sliceFilter.date = selectedDate;
  } else {
    if (startDate) sliceFilter.startDate = startDate;
    if (endDate) sliceFilter.endDate = endDate;
  }

  const classifiedSlices: EvaluatedSlice[] = classification.classifySlices(sliceFilter);

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
    totalDurationSeconds += s.totalSeconds;
    const telem = telemetryMap.get(s.id);
    if (telem) {
      totalAiSessions += telem.ai_sessions;
    }

    switch (s.decision.classification) {
      case 'work':
        workSeconds += s.totalSeconds;
        break;
      case 'personal':
        personalSeconds += s.totalSeconds;
        break;
      default:
        unclassifiedSeconds += s.totalSeconds;
        break;
    }
  }

  // 6. Paginate results
  const totalItems = filteredSlices.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const pageSlices = filteredSlices.slice(startIndex, startIndex + pageSize);

  const items: ActivitySliceItem[] = pageSlices.map((s) => {
    const telem = telemetryMap.get(s.id);
    return {
      id: s.id,
      date: s.date,
      projectId: s.projectId,
      projectName: s.projectName ?? (s.isUnattributed ? '__unattributed__' : `Project #${s.projectId}`),
      entity: s.entity,
      entityType: s.entityType,
      totalSeconds: s.totalSeconds,
      formattedDuration: formatDuration(s.totalSeconds),
      isUnattributed: s.isUnattributed,
      machineIds: s.machineIds,
      editors: s.editors,
      classification: s.decision.classification,
      decisionSource: s.decision.source,
      winningRuleId: s.decision.winningRuleId,
      hasOverride: Boolean(s.allocation),
      aiSessions: telem?.ai_sessions ?? 0,
      aiAdditions: telem?.ai_additions ?? 0,
      aiDeletions: telem?.ai_deletions ?? 0,
      humanAdditions: telem?.human_additions ?? 0,
      humanDeletions: telem?.human_deletions ?? 0
    };
  });

  return {
    items,
    pagination: {
      page: safePage,
      pageSize,
      totalItems,
      totalPages,
      hasNextPage: safePage < totalPages,
      hasPrevPage: safePage > 1
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
    isEmpty: false
  };
}
