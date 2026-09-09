import { describe, it, expect } from 'vitest';
import {
  isValidDateString,
  parseDateParts,
  formatDateParts,
  addDays,
  differenceInDays,
  getDateRange,
  getZonedDateParts,
  getZonedDateString,
  getYesterdayZoned,
  getRecentIntentDates,
  getReconciliationIntentDates,
  getComparisonIntentDates,
  isDateClosed,
  isCurrentDayProvisional,
  validateDateRange,
  selectStartupCatchupDates,
  getCurrentScheduleSlot,
  isCadenceDue,
  DEFAULT_MAX_BACKFILL_DAYS,
  DEFAULT_MAX_CATCHUP_DAYS,
  DEFAULT_RECONCILE_WINDOW_DAYS,
  DEFAULT_COMPARE_WINDOW_DAYS
} from './calendar.js';

describe('Sync Calendar & Scheduling Policies', () => {
  describe('Strict Date String Validation and Parsing', () => {
    it('validates canonical YYYY-MM-DD dates correctly', () => {
      expect(isValidDateString('2026-09-09')).toBe(true);
      expect(isValidDateString('2024-02-29')).toBe(true); // 2024 is leap year
      expect(isValidDateString('2000-02-29')).toBe(true); // 2000 is leap year
      expect(isValidDateString('2026-01-01')).toBe(true);
      expect(isValidDateString('2026-12-31')).toBe(true);

      // Rejections
      expect(isValidDateString('2025-02-29')).toBe(false); // 2025 is not leap year
      expect(isValidDateString('1900-02-29')).toBe(false); // 1900 is not leap year (century not divisible by 400)
      expect(isValidDateString('2026-04-31')).toBe(false); // April has 30 days
      expect(isValidDateString('2026-13-01')).toBe(false); // Month 13
      expect(isValidDateString('2026-00-10')).toBe(false); // Month 0
      expect(isValidDateString('2026-05-00')).toBe(false); // Day 0
      expect(isValidDateString('2026-05-32')).toBe(false); // Day 32
      expect(isValidDateString('2026/05/10')).toBe(false); // Wrong separator
      expect(isValidDateString('2026-5-10')).toBe(false); // Not padded
      expect(isValidDateString('')).toBe(false);
      expect(isValidDateString(null)).toBe(false);
      expect(isValidDateString(undefined)).toBe(false);
      expect(isValidDateString('garbage')).toBe(false);
    });

    it('parses valid date parts and rejects invalid formats', () => {
      expect(parseDateParts('2026-09-09')).toEqual({ year: 2026, month: 9, day: 9 });
      expect(parseDateParts('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
      expect(() => parseDateParts('2025-02-29')).toThrow(RangeError);
      expect(() => parseDateParts('invalid')).toThrow(RangeError);
    });

    it('formats date parts with zero padding', () => {
      expect(formatDateParts(2026, 9, 9)).toBe('2026-09-09');
      expect(formatDateParts(2026, 12, 31)).toBe('2026-12-31');
      expect(formatDateParts(999, 1, 5)).toBe('0999-01-05');
    });
  });

  describe('Pure Calendar Date Arithmetic', () => {
    it('adds and subtracts days across month and year boundaries without millisecond drift', () => {
      expect(addDays('2026-01-01', 1)).toBe('2026-01-02');
      expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
      expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
      expect(addDays('2026-02-28', 1)).toBe('2026-03-01'); // non-leap year
      expect(addDays('2024-02-28', 1)).toBe('2024-02-29'); // leap year
      expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
      expect(addDays('2026-09-09', 30)).toBe('2026-10-09');
      expect(addDays('2026-09-09', -10)).toBe('2026-08-30');
    });

    it('computes exact whole calendar days difference', () => {
      expect(differenceInDays('2026-09-01', '2026-09-01')).toBe(0);
      expect(differenceInDays('2026-09-01', '2026-09-05')).toBe(4);
      expect(differenceInDays('2026-09-05', '2026-09-01')).toBe(-4);
      expect(differenceInDays('2025-12-31', '2026-01-01')).toBe(1);
      expect(differenceInDays('2024-02-28', '2024-03-01')).toBe(2); // covers 02-29
      expect(differenceInDays('2025-02-28', '2025-03-01')).toBe(1); // no 02-29
    });

    it('generates inclusive date ranges and rejects inverted bounds', () => {
      expect(getDateRange('2026-09-01', '2026-09-03')).toEqual([
        '2026-09-01',
        '2026-09-02',
        '2026-09-03'
      ]);
      expect(getDateRange('2026-09-01', '2026-09-01')).toEqual(['2026-09-01']);
      expect(() => getDateRange('2026-09-05', '2026-09-01')).toThrow(RangeError);
      expect(() => getDateRange('invalid', '2026-09-01')).toThrow(RangeError);
    });
  });

  describe('Source Timezone and DST Handling', () => {
    it('accurately derives source date for London across Spring DST transition', () => {
      // 2026-03-29: London springs forward at 01:00 UTC to 02:00 BST
      const preDst = new Date('2026-03-29T00:30:00Z');
      const postDst = new Date('2026-03-29T01:30:00Z');

      expect(getZonedDateString('Europe/London', preDst)).toBe('2026-03-29');
      expect(getZonedDateString('Europe/London', postDst)).toBe('2026-03-29');

      const partsPre = getZonedDateParts('Europe/London', preDst);
      expect(partsPre.hour).toBe(0);

      const partsPost = getZonedDateParts('Europe/London', postDst);
      // 01:30 UTC is 02:30 BST
      expect(partsPost.hour).toBe(2);
      expect(partsPost.minute).toBe(30);
    });

    it('accurately derives source date for London across Autumn DST transition', () => {
      // 2026-10-25: London falls back at 02:00 BST (01:00 UTC) to 01:00 GMT
      const preFallback = new Date('2026-10-25T00:30:00Z'); // 01:30 BST
      const postFallback = new Date('2026-10-25T02:30:00Z'); // 02:30 GMT

      expect(getZonedDateString('Europe/London', preFallback)).toBe('2026-10-25');
      expect(getZonedDateString('Europe/London', postFallback)).toBe('2026-10-25');
    });

    it('distinguishes source dates across midnight UTC in different timezones', () => {
      // 2026-09-09 at 02:00:00 UTC
      const instant = new Date('2026-09-09T02:00:00Z');

      // UTC date is 2026-09-09
      expect(getZonedDateString('UTC', instant)).toBe('2026-09-09');

      // New York is UTC-4 in September: 2026-09-08 22:00:00 -> date is 2026-09-08
      expect(getZonedDateString('America/New_York', instant)).toBe('2026-09-08');

      // Tokyo is UTC+9: 2026-09-09 11:00:00 -> date is 2026-09-09
      expect(getZonedDateString('Asia/Tokyo', instant)).toBe('2026-09-09');
    });

    it('derives source timezone yesterday and recent intent dates', () => {
      const instant = new Date('2026-09-09T02:00:00Z');
      // For America/New_York, today is 2026-09-08
      expect(getZonedDateString('America/New_York', instant)).toBe('2026-09-08');
      expect(getYesterdayZoned('America/New_York', instant)).toBe('2026-09-07');
      expect(getRecentIntentDates('America/New_York', instant)).toEqual([
        '2026-09-07',
        '2026-09-08'
      ]);

      // For UTC, today is 2026-09-09
      expect(getRecentIntentDates('UTC', instant)).toEqual(['2026-09-08', '2026-09-09']);
    });
  });

  describe('Cadence Intent Date Windows', () => {
    const fixedNow = new Date('2026-09-09T10:00:00Z'); // UTC date 2026-09-09

    it('reconciliation intent returns 14 completed dates prior to today', () => {
      const dates = getReconciliationIntentDates('UTC', fixedNow);
      expect(dates).toHaveLength(DEFAULT_RECONCILE_WINDOW_DAYS);
      expect(dates[0]).toBe('2026-08-26'); // today - 14
      expect(dates[dates.length - 1]).toBe('2026-09-08'); // today - 1 (yesterday)
      expect(dates.includes('2026-09-09')).toBe(false); // excludes today
    });

    it('comparison intent returns 90 completed dates prior to today', () => {
      const dates = getComparisonIntentDates('UTC', fixedNow);
      expect(dates).toHaveLength(DEFAULT_COMPARE_WINDOW_DAYS);
      expect(dates[0]).toBe('2026-06-11'); // today - 90
      expect(dates[dates.length - 1]).toBe('2026-09-08'); // today - 1 (yesterday)
      expect(dates.includes('2026-09-09')).toBe(false); // excludes today
    });

    it('identifies closed versus provisional dates', () => {
      // For UTC now at 2026-09-09:
      expect(isCurrentDayProvisional('2026-09-09', 'UTC', fixedNow)).toBe(true);
      expect(isCurrentDayProvisional('2026-09-08', 'UTC', fixedNow)).toBe(false);

      expect(isDateClosed('2026-09-08', 'UTC', fixedNow)).toBe(true);
      expect(isDateClosed('2026-09-09', 'UTC', fixedNow)).toBe(false);
      expect(isDateClosed('2026-09-10', 'UTC', fixedNow)).toBe(false);
    });
  });

  describe('Date Range Validation', () => {
    const fixedNow = new Date('2026-09-09T10:00:00Z');

    it('accepts valid date ranges within max limits', () => {
      const res = validateDateRange('2026-01-01', '2026-01-10');
      expect(res.valid).toBe(true);
      expect(res.dates).toHaveLength(10);
      expect(res.dates![0]).toBe('2026-01-01');
      expect(res.dates![9]).toBe('2026-01-10');
    });

    it('rejects range exceeding maxRangeDays limit', () => {
      // 367 days
      const res = validateDateRange('2025-01-01', '2026-01-02', {
        maxRangeDays: DEFAULT_MAX_BACKFILL_DAYS // 366
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('exceeds maximum allowed 366 days');
    });

    it('rejects inverted or malformed ranges', () => {
      expect(validateDateRange('2026-05-10', '2026-05-01').valid).toBe(false);
      expect(validateDateRange('invalid', '2026-05-01').valid).toBe(false);
      expect(validateDateRange('2026-05-01', 'invalid').valid).toBe(false);
    });

    it('rejects future dates when allowFuture is false', () => {
      const res = validateDateRange('2026-09-01', '2026-09-15', {
        allowFuture: false,
        timezone: 'UTC',
        now: fixedNow // today is 2026-09-09
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('cannot be in the future');
    });
  });

  describe('Startup Catch-Up Selection', () => {
    const fixedNow = new Date('2026-09-09T10:00:00Z'); // UTC today = 2026-09-09

    it('seeds empty archive in exact priority order: today, yesterday, then oldest 7-day window dates', () => {
      const result = selectStartupCatchupDates({
        archiveDates: [],
        timezone: 'UTC',
        now: fixedNow
      });

      // Priority: today (09-09), yesterday (09-08), then 09-03, 09-04, 09-05, 09-06, 09-07
      expect(result.datesToSync).toEqual([
        '2026-09-09',
        '2026-09-08',
        '2026-09-03',
        '2026-09-04',
        '2026-09-05',
        '2026-09-06',
        '2026-09-07'
      ]);
      expect(result.remainingGapsCount).toBe(0);
      expect(result.nextCursor).toBeNull();
    });

    it('handles long downtime (e.g. 60 days of missing data) with 31-day cap and cursor', () => {
      // Archive stops at 2026-07-01 (69 days ago)
      const result = selectStartupCatchupDates({
        archiveDates: ['2026-07-01'],
        watermarkDate: '2026-07-01',
        timezone: 'UTC',
        now: fixedNow,
        maxDates: 31
      });

      expect(result.datesToSync).toHaveLength(DEFAULT_MAX_CATCHUP_DAYS); // exactly 31
      expect(result.datesToSync[0]).toBe('2026-09-09'); // today
      expect(result.datesToSync[1]).toBe('2026-09-08'); // yesterday
      // Next: policy window gaps (2026-09-03 to 2026-09-07, 5 dates)
      expect(result.datesToSync[2]).toBe('2026-09-03');
      expect(result.datesToSync[6]).toBe('2026-09-07');
      // Next: older gaps starting from 2026-07-02
      expect(result.datesToSync[7]).toBe('2026-07-02');
      expect(result.datesToSync[8]).toBe('2026-07-03');
      expect(result.remainingGapsCount).toBeGreaterThan(0);
      expect(result.nextCursor).not.toBeNull();
    });

    it('identifies internal missing coverage gaps within archive history', () => {
      // Archive has 2026-08-01 and 2026-08-05, but missing 08-02, 08-03, 08-04
      const archive = ['2026-08-01', '2026-08-05', '2026-09-08'];
      const result = selectStartupCatchupDates({
        archiveDates: archive,
        watermarkDate: '2026-08-01',
        timezone: 'UTC',
        now: fixedNow
      });

      expect(result.datesToSync).toContain('2026-08-02');
      expect(result.datesToSync).toContain('2026-08-03');
      expect(result.datesToSync).toContain('2026-08-04');
      // 2026-08-01 and 2026-08-05 already in archive, so should not be in older gaps
      expect(result.datesToSync.includes('2026-08-01')).toBe(false);
      expect(result.datesToSync.includes('2026-08-05')).toBe(false);
    });

    it('includes unfinished dates from interrupted runs', () => {
      const archive = ['2026-09-08'];
      const unfinished = ['2026-08-15'];
      const result = selectStartupCatchupDates({
        archiveDates: archive,
        unfinishedDates: unfinished,
        timezone: 'UTC',
        now: fixedNow
      });

      expect(result.datesToSync).toContain('2026-08-15');
    });

    it('honors retry deferral for failed dates', () => {
      // One failure with retry in the future (deferred)
      // One failure with retry in the past (eligible)
      const failed = [
        { date: '2026-08-10', nextRetryAt: '2026-09-09T14:00:00Z' }, // 4h in future -> deferred!
        { date: '2026-08-11', nextRetryAt: '2026-09-09T08:00:00Z' } // 2h in past -> eligible!
      ];

      const result = selectStartupCatchupDates({
        archiveDates: ['2026-09-08'],
        failedDates: failed,
        timezone: 'UTC',
        now: fixedNow
      });

      expect(result.datesToSync.includes('2026-08-10')).toBe(false); // deferred
      expect(result.datesToSync).toContain('2026-08-11'); // eligible
    });

    it('includes due failed dates and unfinished dates even when present in archiveDates', () => {
      // Archive already contains 2026-08-10 and 2026-08-15 (accepted daily summaries),
      // but they coexist with unfinished evidence or retryable comparison
      const result = selectStartupCatchupDates({
        archiveDates: ['2026-08-10', '2026-08-15', '2026-09-08'],
        unfinishedDates: ['2026-08-15'],
        failedDates: [{ date: '2026-08-10', nextRetryAt: '2026-09-09T08:00:00Z' }],
        timezone: 'UTC',
        now: fixedNow
      });

      // Both dates must be selected despite existing in archiveDates
      expect(result.datesToSync).toContain('2026-08-10');
      expect(result.datesToSync).toContain('2026-08-15');
    });

    it('bounds older gap scanning to coverageRange.end when supplied', () => {
      // coverageRange specifies 2026-07-01 to 2026-07-05
      // Archive only has 2026-07-01 and 2026-07-05
      // Gap scanning should only scan up to 2026-07-05, not up to policyStart - 1 (2026-09-02)
      const result = selectStartupCatchupDates({
        archiveDates: ['2026-07-01', '2026-07-05', '2026-09-08'],
        coverageRange: { start: '2026-07-01', end: '2026-07-05' },
        timezone: 'UTC',
        now: fixedNow
      });

      expect(result.datesToSync).toContain('2026-07-02');
      expect(result.datesToSync).toContain('2026-07-03');
      expect(result.datesToSync).toContain('2026-07-04');
      // Must NOT contain dates beyond coverageRange.end (e.g., 2026-07-06, 2026-08-01)
      expect(result.datesToSync.includes('2026-07-06')).toBe(false);
      expect(result.datesToSync.includes('2026-08-01')).toBe(false);
    });

    it('fails closed on invalid retry timestamps and ignores future work dates', () => {
      const failed = [
        { date: '2026-08-12', nextRetryAt: 'corrupted-timestamp' },
        { date: '2026-08-13', nextRetryAt: null },
        { date: '2026-09-10', nextRetryAt: null }
      ];

      const result = selectStartupCatchupDates({
        archiveDates: ['2026-09-08'],
        failedDates: failed,
        unfinishedDates: ['2026-09-11'],
        timezone: 'UTC',
        now: fixedNow
      });

      // Corrupt deferral metadata cannot prove eligibility and future source dates are invalid work.
      expect(result.datesToSync).not.toContain('2026-08-12');
      expect(result.datesToSync).toContain('2026-08-13');
      expect(result.datesToSync).not.toContain('2026-09-10');
      expect(result.datesToSync).not.toContain('2026-09-11');
    });

    it('deduplicates overlapping unfinished and failed dates and preserves chronological order', () => {
      const result = selectStartupCatchupDates({
        archiveDates: ['2026-09-08'],
        unfinishedDates: ['2026-08-20', '2026-08-15'],
        failedDates: [
          { date: '2026-08-15', nextRetryAt: null }, // overlaps with unfinishedDates
          { date: '2026-08-10', nextRetryAt: null }
        ],
        timezone: 'UTC',
        now: fixedNow
      });

      // Must only contain 2026-08-15 once
      const count15 = result.datesToSync.filter((d) => d === '2026-08-15').length;
      expect(count15).toBe(1);

      // Order of older work dates should be chronological: 08-10, 08-15, 08-20
      const idx10 = result.datesToSync.indexOf('2026-08-10');
      const idx15 = result.datesToSync.indexOf('2026-08-15');
      const idx20 = result.datesToSync.indexOf('2026-08-20');
      expect(idx10).toBeLessThan(idx15);
      expect(idx15).toBeLessThan(idx20);
    });
  });

  describe('Schedule Cadence Slots & Due Detection', () => {
    // 2026-09-09 is a Wednesday.
    // 10:15:00 UTC
    const wednesdayMorning = new Date('2026-09-09T10:15:00Z');
    // 02:30:00 UTC
    const wednesdayEarly = new Date('2026-09-09T02:30:00Z');
    // 03:05:00 UTC
    const wednesdayReconcileTime = new Date('2026-09-09T03:05:00Z');
    // 2026-09-07 is a Monday.
    // 04:30:00 UTC
    const mondayCompareTime = new Date('2026-09-07T04:30:00Z');

    it('generates deterministic schedule slot keys', () => {
      expect(getCurrentScheduleSlot('recent', 'UTC', wednesdayMorning)).toBe(
        '2026-09-09T10:00'
      );
      expect(getCurrentScheduleSlot('reconcile', 'UTC', wednesdayMorning)).toBe('2026-09-09');
      // For week containing Wednesday 2026-09-09, Monday was 2026-09-07:
      expect(getCurrentScheduleSlot('compare', 'UTC', wednesdayMorning)).toBe('WEEK_2026-09-07');
    });

    it('evaluates hourly recent sync due condition', () => {
      // Due if last handled slot is different from current slot
      expect(isCadenceDue('recent', 'UTC', null, wednesdayMorning)).toBe(true);
      expect(isCadenceDue('recent', 'UTC', '2026-09-09T09:00', wednesdayMorning)).toBe(true);
      // Not due if already handled for this hour
      expect(isCadenceDue('recent', 'UTC', '2026-09-09T10:00', wednesdayMorning)).toBe(false);
    });

    it('evaluates daily reconciliation due condition at or after 03:00 source time', () => {
      // Before 03:00 (02:30 UTC): not due
      expect(isCadenceDue('reconcile', 'UTC', null, wednesdayEarly)).toBe(false);

      // At or after 03:00 (03:05 UTC): due if today not yet handled
      expect(isCadenceDue('reconcile', 'UTC', null, wednesdayReconcileTime)).toBe(true);
      expect(isCadenceDue('reconcile', 'UTC', '2026-09-08', wednesdayReconcileTime)).toBe(true);

      // Not due if today already handled
      expect(isCadenceDue('reconcile', 'UTC', '2026-09-09', wednesdayReconcileTime)).toBe(false);
    });

    it('evaluates weekly comparison due condition on Monday at or after 04:00 source time', () => {
      // On Wednesday: not due
      expect(isCadenceDue('compare', 'UTC', null, wednesdayMorning)).toBe(false);

      // On Monday before 04:00 (03:59): not due
      const mondayEarly = new Date('2026-09-07T03:59:00Z');
      expect(isCadenceDue('compare', 'UTC', null, mondayEarly)).toBe(false);

      // On Monday at 04:30: due if week not yet handled
      expect(isCadenceDue('compare', 'UTC', null, mondayCompareTime)).toBe(true);
      expect(isCadenceDue('compare', 'UTC', 'WEEK_2026-08-31', mondayCompareTime)).toBe(true);

      // Not due if current week already handled
      expect(isCadenceDue('compare', 'UTC', 'WEEK_2026-09-07', mondayCompareTime)).toBe(false);
    });
  });
});
