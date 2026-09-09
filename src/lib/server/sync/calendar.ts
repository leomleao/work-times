/**
 * Pure source-timezone calendar arithmetic, date-range calculations,
 * and scheduling policies for the Work Times sync engine.
 *
 * Invariants enforced:
 * 1. Source-day boundaries use the account timezone, NEVER server OS timezone
 *    or naive UTC strings.
 * 2. Pure calendar arithmetic is used for date progression so DST transitions
 *    (e.g., London 23h and 25h days) never skew date keys.
 * 3. Dates are strictly YYYY-MM-DD validated including leap-year validity.
 * 4. Cadence schedules support hourly (recent), daily 03:00 (reconcile),
 *    and weekly Monday 04:00 (compare).
 * 5. Startup catch-up selection prioritizes today/yesterday, recent 7-day policy
 *    window gaps, then older eligible work up to a 31-day budget per run.
 */

export const DEFAULT_MAX_BACKFILL_DAYS = 366;
export const DEFAULT_MAX_CATCHUP_DAYS = 31;
export const DEFAULT_POLICY_WINDOW_DAYS = 7;
export const DEFAULT_RECONCILE_WINDOW_DAYS = 14;
export const DEFAULT_COMPARE_WINDOW_DAYS = 90;

export type ScheduleIntent = 'recent' | 'reconcile' | 'compare';

/**
 * Validates whether a string is a strictly formatted and valid calendar date in YYYY-MM-DD form.
 */
export function isValidDateString(dateStr: string | null | undefined): boolean {
  if (!dateStr || typeof dateStr !== 'string') {
    return false;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    return false;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);

  if (month < 1 || month > 12) {
    return false;
  }

  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return day >= 1 && day <= daysInMonth[month - 1];
}

/**
 * Parses a YYYY-MM-DD string into numeric components without timezone interpretation.
 */
export function parseDateParts(dateStr: string): { year: number; month: number; day: number } {
  if (!isValidDateString(dateStr)) {
    throw new RangeError(`Invalid calendar date string: "${dateStr}"`);
  }
  const parts = dateStr.split('-').map((p) => Number.parseInt(p, 10));
  return { year: parts[0], month: parts[1], day: parts[2] };
}

/**
 * Formats year, month, and day into a 0-padded YYYY-MM-DD string.
 */
export function formatDateParts(year: number, month: number, day: number): string {
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Pure calendar date addition/subtraction. Immune to DST jumps because it operates
 * strictly in UTC day units.
 */
export function addDays(dateStr: string, days: number): string {
  const { year, month, day } = parseDateParts(dateStr);
  const utcDate = new Date(Date.UTC(year, month - 1, day + days));
  return formatDateParts(
    utcDate.getUTCFullYear(),
    utcDate.getUTCMonth() + 1,
    utcDate.getUTCDate()
  );
}

/**
 * Returns the signed difference in whole calendar days (to - from).
 */
export function differenceInDays(from: string, to: string): number {
  const pFrom = parseDateParts(from);
  const pTo = parseDateParts(to);

  const utcFrom = Date.UTC(pFrom.year, pFrom.month - 1, pFrom.day);
  const utcTo = Date.UTC(pTo.year, pTo.month - 1, pTo.day);

  return Math.round((utcTo - utcFrom) / 86_400_000);
}

/**
 * Returns an inclusive array of YYYY-MM-DD date strings from start to end.
 * Throws RangeError if start > end or if either date is invalid.
 */
export function getDateRange(start: string, end: string): string[] {
  if (!isValidDateString(start)) {
    throw new RangeError(`Invalid start date: "${start}"`);
  }
  if (!isValidDateString(end)) {
    throw new RangeError(`Invalid end date: "${end}"`);
  }

  const diff = differenceInDays(start, end);
  if (diff < 0) {
    throw new RangeError(`Range start "${start}" cannot be after end "${end}"`);
  }

  const dates: string[] = [];
  let current = start;
  for (let i = 0; i <= diff; i++) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

/**
 * Extracts zoned date and time parts for an instant in the specified IANA timezone.
 */
export function getZonedDateParts(
  timezone: string,
  now: Date = new Date()
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  const parts = formatter.formatToParts(now);
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;

  for (const part of parts) {
    if (part.type === 'year') year = Number.parseInt(part.value, 10);
    else if (part.type === 'month') month = Number.parseInt(part.value, 10);
    else if (part.type === 'day') day = Number.parseInt(part.value, 10);
    else if (part.type === 'hour') hour = Number.parseInt(part.value, 10);
    else if (part.type === 'minute') minute = Number.parseInt(part.value, 10);
    else if (part.type === 'second') second = Number.parseInt(part.value, 10);
  }

  return { year, month, day, hour, minute, second };
}

/**
 * Returns the current date in YYYY-MM-DD representation in the given IANA timezone.
 */
export function getZonedDateString(timezone: string, now: Date = new Date()): string {
  const { year, month, day } = getZonedDateParts(timezone, now);
  return formatDateParts(year, month, day);
}

/**
 * Returns yesterday's date in YYYY-MM-DD representation in the given IANA timezone.
 */
export function getYesterdayZoned(timezone: string, now: Date = new Date()): string {
  const today = getZonedDateString(timezone, now);
  return addDays(today, -1);
}

/**
 * Intent 1: Recent sync.
 * Returns [yesterday, today] in source timezone.
 */
export function getRecentIntentDates(timezone: string, now: Date = new Date()): [string, string] {
  const today = getZonedDateString(timezone, now);
  const yesterday = addDays(today, -1);
  return [yesterday, today];
}

/**
 * Intent 2: Daily reconciliation sync.
 * Returns the previous 14 completed calendar dates prior to today in source timezone:
 * [today - 14, ..., today - 1].
 */
export function getReconciliationIntentDates(
  timezone: string,
  now: Date = new Date(),
  count: number = DEFAULT_RECONCILE_WINDOW_DAYS
): string[] {
  if (count <= 0) return [];
  const today = getZonedDateString(timezone, now);
  const start = addDays(today, -count);
  const end = addDays(today, -1);
  return getDateRange(start, end);
}

/**
 * Intent 3: Weekly comparison sync.
 * Returns the previous 90 completed calendar dates prior to today in source timezone:
 * [today - 90, ..., today - 1].
 */
export function getComparisonIntentDates(
  timezone: string,
  now: Date = new Date(),
  count: number = DEFAULT_COMPARE_WINDOW_DAYS
): string[] {
  if (count <= 0) return [];
  const today = getZonedDateString(timezone, now);
  const start = addDays(today, -count);
  const end = addDays(today, -1);
  return getDateRange(start, end);
}

/**
 * Checks whether a calendar date is closed in the source timezone (i.e. strictly before today).
 */
export function isDateClosed(dateStr: string, timezone: string, now: Date = new Date()): boolean {
  const today = getZonedDateString(timezone, now);
  return differenceInDays(dateStr, today) > 0;
}

/**
 * Checks whether a calendar date is the current active (provisional) day in the source timezone.
 */
export function isCurrentDayProvisional(
  dateStr: string,
  timezone: string,
  now: Date = new Date()
): boolean {
  const today = getZonedDateString(timezone, now);
  return dateStr === today;
}

/**
 * Validates a requested date range for manual backfill or queries.
 */
export function validateDateRange(
  start: string,
  end: string,
  options?: {
    maxRangeDays?: number;
    allowFuture?: boolean;
    timezone?: string;
    now?: Date;
  }
): { valid: boolean; error?: string; dates?: string[] } {
  if (!isValidDateString(start)) {
    return { valid: false, error: `Invalid start date: "${start}"` };
  }
  if (!isValidDateString(end)) {
    return { valid: false, error: `Invalid end date: "${end}"` };
  }

  const diff = differenceInDays(start, end);
  if (diff < 0) {
    return { valid: false, error: `Start date "${start}" must be on or before end date "${end}"` };
  }

  const maxRange = options?.maxRangeDays ?? DEFAULT_MAX_BACKFILL_DAYS;
  const count = diff + 1;
  if (count > maxRange) {
    return {
      valid: false,
      error: `Requested range of ${count} days exceeds maximum allowed ${maxRange} days`
    };
  }

  if (options?.allowFuture === false && options?.timezone) {
    const today = getZonedDateString(options.timezone, options.now ?? new Date());
    if (differenceInDays(today, end) > 0) {
      return {
        valid: false,
        error: `End date "${end}" cannot be in the future (today is "${today}" in ${options.timezone})`
      };
    }
  }

  const dates = getDateRange(start, end);
  return { valid: true, dates };
}

export interface FailedDateCandidate {
  date: string;
  nextRetryAt?: string | null;
  retryAt?: string | null;
}

export interface StartupCatchupOptions {
  archiveDates: Iterable<string>;
  watermarkDate?: string | null;
  coverageRange?: { start: string; end?: string };
  failedDates?: FailedDateCandidate[];
  unfinishedDates?: string[];
  policyWindowDays?: number;
  maxDates?: number;
  timezone: string;
  now?: Date;
}

/**
 * Startup catch-up date selector.
 *
 * Rules (docs/NEXT-MILESTONE.md §3.3 & supervisor findings):
 * 1. Represents internal missing coverage, eligible retryable failures, and unfinished dates.
 * 2. Honors retry deferral: dates with future next_retry_at are skipped until due.
 * 3. Exact priority ordering:
 *    a. Today and yesterday (source timezone).
 *    b. Oldest uncovered dates in the recent 7-day policy window [today - 6, ..., today - 2].
 *       (An empty archive is seeded in this exact same order).
 *    c. Older eligible work: internal missing coverage gaps, unfinished dates,
 *       and due retryable failures (oldest first).
 * 4. Bounded to maxDates (default 31) per run.
 * 5. Retains a durable continuation cursor pointing to the next date that could not fit.
 */
export function selectStartupCatchupDates(options: StartupCatchupOptions): {
  datesToSync: string[];
  remainingGapsCount: number;
  nextCursor: string | null;
} {
  const now = options.now ?? new Date();
  const timezone = options.timezone;
  const maxDates = options.maxDates ?? DEFAULT_MAX_CATCHUP_DAYS;
  const policyDays = options.policyWindowDays ?? DEFAULT_POLICY_WINDOW_DAYS;

  const today = getZonedDateString(timezone, now);
  const yesterday = addDays(today, -1);
  const archiveSet = new Set(options.archiveDates);

  const candidatesOrdered: string[] = [];
  const added = new Set<string>();

  const pushCandidate = (d: string) => {
    if (isValidDateString(d) && !added.has(d)) {
      added.add(d);
      candidatesOrdered.push(d);
    }
  };

  // Step 1: Today and yesterday (source timezone)
  pushCandidate(today);
  pushCandidate(yesterday);

  // Step 2: Oldest uncovered dates in the recent policy window [today - (policyDays - 1) to today - 2]
  // Oldest first
  for (let i = policyDays - 1; i >= 2; i--) {
    const d = addDays(today, -i);
    if (!archiveSet.has(d)) {
      pushCandidate(d);
    }
  }

  // Step 3: Older eligible work
  // Find earliest date in scope: explicit coverageRange.start, watermarkDate, or MIN of existing archive / dates
  let earliestDate: string | null = null;
  if (options.coverageRange?.start && isValidDateString(options.coverageRange.start)) {
    earliestDate = options.coverageRange.start;
  } else if (options.watermarkDate && isValidDateString(options.watermarkDate)) {
    earliestDate = options.watermarkDate;
  }
  if (!earliestDate && archiveSet.size > 0) {
    for (const d of archiveSet) {
      if (isValidDateString(d)) {
        if (!earliestDate || d < earliestDate) {
          earliestDate = d;
        }
      }
    }
  }

  const policyStart = addDays(today, -(policyDays - 1));

  // 3a. Internal missing coverage gaps between earliestDate and olderEnd.
  // When coverageRange.end is supplied and valid, bound gap scanning so it does not scan beyond coverageRange.end.
  let olderEnd = addDays(policyStart, -1);
  if (options.coverageRange?.end && isValidDateString(options.coverageRange.end)) {
    if (options.coverageRange.end < olderEnd) {
      olderEnd = options.coverageRange.end;
    }
  }

  if (earliestDate && differenceInDays(earliestDate, olderEnd) >= 0) {
    let cur = earliestDate;
    while (differenceInDays(cur, olderEnd) >= 0) {
      if (!archiveSet.has(cur)) {
        pushCandidate(cur);
      }
      cur = addDays(cur, 1);
    }
  }

  // 3b & 3c: Older eligible work (unfinished dates and due retryable failures)
  // Even when archiveDates contains accepted daily data, a date may still require catch-up
  // for unfinished optional evidence (e.g. heartbeats) or retryable comparison.
  const olderWorkSet = new Set<string>();

  // 3b. Unfinished dates (pending, running, interrupted from previous runs)
  if (options.unfinishedDates) {
    for (const d of options.unfinishedDates) {
      if (isValidDateString(d) && d <= today && !added.has(d)) {
        olderWorkSet.add(d);
      }
    }
  }

  // 3c. Eligible retryable failures (honoring retry deferral)
  if (options.failedDates) {
    for (const f of options.failedDates) {
      if (!isValidDateString(f.date) || f.date > today || added.has(f.date)) {
        continue;
      }
      const retryDue = f.nextRetryAt ?? f.retryAt;
      if (retryDue) {
        const retryTime = typeof retryDue === 'string' ? Date.parse(retryDue) : Number.NaN;
        if (Number.isNaN(retryTime)) {
          // Corrupt retry metadata cannot prove that a restricted date is eligible.
          continue;
        }
        if (retryTime > now.getTime()) {
          // Future retry: deferred until due
          continue;
        }
      }
      olderWorkSet.add(f.date);
    }
  }

  // Sort remaining older work dates chronologically (oldest first) and push
  const sortedOlderWork = Array.from(olderWorkSet).sort();
  for (const d of sortedOlderWork) {
    pushCandidate(d);
  }

  const selected = candidatesOrdered.slice(0, maxDates);
  const remainingGapsCount = Math.max(0, candidatesOrdered.length - selected.length);
  const nextCursor = remainingGapsCount > 0 ? candidatesOrdered[maxDates] : null;

  return {
    datesToSync: selected,
    remainingGapsCount,
    nextCursor
  };
}

/**
 * Returns a deterministic slot key for scheduling deduplication.
 * - 'recent': "YYYY-MM-DDTHH:00" in source timezone
 * - 'reconcile': "YYYY-MM-DD" in source timezone
 * - 'compare': "WEEK_YYYY-MM-DD" referencing the Monday of that week
 */
export function getCurrentScheduleSlot(
  intent: ScheduleIntent,
  timezone: string,
  now: Date = new Date()
): string {
  const parts = getZonedDateParts(timezone, now);
  const dateStr = formatDateParts(parts.year, parts.month, parts.day);

  if (intent === 'recent') {
    const hourStr = String(parts.hour).padStart(2, '0');
    return `${dateStr}T${hourStr}:00`;
  }

  if (intent === 'reconcile') {
    return dateStr;
  }

  // 'compare': Weekly slot based on Monday of the current week
  const utcDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const dayOfWeek = utcDate.getUTCDay(); // 0 is Sunday, 1 is Monday
  const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const mondayDate = addDays(dateStr, daysToMonday);
  return `WEEK_${mondayDate}`;
}

/**
 * Evaluates whether a scheduled cadence intent is due based on wall-clock time
 * and the last handled slot key.
 *
 * Rules:
 * - 'recent': due every hour (when current hour slot != lastHandledSlot)
 * - 'reconcile': due at or after 03:00 source time daily, if today's slot != lastHandledSlot
 * - 'compare': due on Mondays at or after 04:00 source time, if week's slot != lastHandledSlot
 */
export function isCadenceDue(
  intent: ScheduleIntent,
  timezone: string,
  lastHandledSlot: string | null,
  now: Date = new Date()
): boolean {
  const currentSlot = getCurrentScheduleSlot(intent, timezone, now);
  if (lastHandledSlot === currentSlot) {
    return false;
  }

  const parts = getZonedDateParts(timezone, now);

  if (intent === 'recent') {
    return true;
  }

  if (intent === 'reconcile') {
    return parts.hour >= 3;
  }

  if (intent === 'compare') {
    const utcDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const dayOfWeek = utcDate.getUTCDay(); // 1 = Monday
    return dayOfWeek === 1 && parts.hour >= 4;
  }

  return false;
}
