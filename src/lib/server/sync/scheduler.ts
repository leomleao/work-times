/**
 * Sync scheduler for Work Times (Milestone P7).
 *
 * Enforces docs/NEXT-MILESTONE.md §3.3-3.4:
 * - Pure source-timezone calendar arithmetic; never uses OS timezone or UTC string slicing.
 * - Cadence intents:
 *     * Hourly recent: today + yesterday in source timezone.
 *     * Daily 03:00: previous 14 completed dates in source timezone.
 *     * Weekly Monday 04:00: previous 90 completed dates in source timezone (comparison only).
 *     * Startup catch-up: recent coverage gaps, retryable dates, and dump dates up to 31 dates/run with durable cursor.
 * - First enable seeds seven days in policy window order.
 * - Coalesces missed intervals into current due intent instead of replaying backlogs.
 * - Persists handled slots and computed next-due timestamps in app_settings.
 * - Honors next_retry_at on restricted/failed dates to avoid hot-looping history.
 * - Pauses automatic scheduling on source-timezone mismatch or connection replacement.
 * - Clean lifecycle without import-time timers or background side effects.
 */

import type Database from 'better-sqlite3';
import {
  DEFAULT_MAX_CATCHUP_DAYS,
  DEFAULT_POLICY_WINDOW_DAYS,
  DEFAULT_RECONCILE_WINDOW_DAYS,
  DEFAULT_COMPARE_WINDOW_DAYS,
  getRecentIntentDates,
  getReconciliationIntentDates,
  getComparisonIntentDates,
  getCurrentScheduleSlot,
  isCadenceDue,
  selectStartupCatchupDates,
  getZonedDateParts,
  getZonedDateString,
  addDays,
  isValidDateString,
  type FailedDateCandidate
} from './calendar.js';
import {
  RECONCILE_CODES,
  type RunRequest,
  type SyncService
} from './contracts.js';
import {
  SqliteSyncRepository,
  type SyncRepository
} from './repository.js';
import type { SyncCoordinator } from './coordinator.js';

export const SETTINGS_KEYS = {
  SCHEDULING_ENABLED: 'sync.scheduling_enabled',
  LAST_SLOT_RECENT: 'sync.schedule.last_slot.recent',
  LAST_SLOT_RECONCILE: 'sync.schedule.last_slot.reconcile',
  LAST_SLOT_COMPARE: 'sync.schedule.last_slot.compare',
  NEXT_DUE_RECENT: 'sync.schedule.next_due.recent',
  NEXT_DUE_RECONCILE: 'sync.schedule.next_due.reconcile',
  NEXT_DUE_COMPARE: 'sync.schedule.next_due.compare',
  CATCHUP_CURSOR: 'sync.schedule.catchup_cursor',
  SEEDED: 'sync.schedule.seeded'
} as const;

export interface SyncSchedulerOptions {
  /** SQLite database instance. */
  db: Database.Database;
  /** Sync coordinator or SyncService implementation. */
  coordinator: SyncService | SyncCoordinator;
  /** Optional sync repository instance. */
  repository?: SyncRepository;
  /** Pinned/verified source timezone. */
  pinnedTimezone?: string;
  /** Clock provider for deterministic time testing (defaults to system clock). */
  now?: () => Date;
  /** Tick evaluation interval in milliseconds (defaults to 60,000ms). */
  tickIntervalMs?: number;
}

export interface SchedulerPauseStatus {
  paused: boolean;
  reason?: 'disabled' | 'connection_replaced' | 'timezone_mismatch' | 'no_connection';
}

export interface SchedulerTickResult {
  ran: boolean;
  pauseReason?: string;
  enqueuedIntents: Array<{
    intent: 'recent' | 'reconcile' | 'compare' | 'startup' | 'catchup';
    runId: number;
    dates: string[];
    reused: boolean;
  }>;
}

export interface SchedulerScheduleState {
  schedulingEnabled: boolean;
  paused: boolean;
  pauseReason?: string;
  timezone: string | null;
  lastHandledSlots: {
    recent: string | null;
    reconcile: string | null;
    compare: string | null;
  };
  nextDue: {
    recent: string | null;
    reconcile: string | null;
    compare: string | null;
  };
  catchupCursor: string | null;
  seeded: boolean;
}

function isTableMissing(err: unknown): boolean {
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = String((err as { message: unknown }).message);
    return msg.includes('no such table');
  }
  return false;
}

export class SyncScheduler {
  private readonly db: Database.Database;
  private readonly coordinator: SyncService | SyncCoordinator;
  private readonly repository: SyncRepository;
  private readonly pinnedTimezone?: string;
  private readonly getNow: () => Date;
  private readonly tickIntervalMs: number;

  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: SyncSchedulerOptions) {
    this.db = options.db;
    this.coordinator = options.coordinator;
    this.repository = options.repository ?? new SqliteSyncRepository(options.db);
    this.pinnedTimezone = options.pinnedTimezone;
    this.getNow = options.now ?? (() => new Date());
    this.tickIntervalMs = options.tickIntervalMs ?? 60_000;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Run initial startup catch-up and cadence evaluation if not paused
    const pause = this.checkPauseStatus();
    if (!pause.paused) {
      try {
        const timezone = this.getEffectiveTimezone();
        const now = this.getNow();
        if (timezone) {
          const isSeeded = this.getAppSetting(SETTINGS_KEYS.SEEDED) === 'true';
          if (!isSeeded) {
            await this.seedSevenDays(timezone, now);
          } else {
            // Evaluate startup catch-up on every enabled unpaused boot (even when no existing cursor)
            await this.runStartupCatchup(now);
          }
        }
        // Evaluate cadence slots for initial tick, yielding catchup continuation to subsequent ticks
        await this.tick(now, true);
      } catch (err) {
        console.error('[SyncScheduler] Initial startup evaluation error:', err);
      }
    }

    // Schedule periodic timer
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[SyncScheduler] Periodic tick error:', err);
      });
    }, this.tickIntervalMs);

    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  // ==========================================================================
  // Timezone & Pause State
  // ==========================================================================

  /**
   * Resolves the effective source timezone:
   * 1. explicit pinnedTimezone if supplied
   * 2. account_settings.timezone if present in SQLite
   * 3. returns null if unknown. Never invents a fallback timezone like 'Europe/London' or 'UTC'.
   */
  getEffectiveTimezone(): string | null {
    if (this.pinnedTimezone && typeof this.pinnedTimezone === 'string' && this.pinnedTimezone.trim() !== '') {
      return this.pinnedTimezone.trim();
    }

    try {
      const row = this.db
        .prepare('SELECT timezone FROM account_settings LIMIT 1')
        .get() as { timezone: string } | undefined;
      if (row?.timezone && typeof row.timezone === 'string' && row.timezone.trim() !== '') {
        return row.timezone.trim();
      }
    } catch (err) {
      if (!isTableMissing(err)) {
        console.error('[SyncScheduler] Error reading account_settings timezone:', err);
        throw err;
      }
    }

    return null;
  }

  /**
   * Evaluates whether scheduling is paused due to:
   * 1. scheduling_enabled = false
   * 2. unknown source timezone
   * 3. missing OAuth connection
   * 4. connection replacement (unbound or generation mismatch on populated archive)
   * 5. source-timezone mismatch
   */
  checkPauseStatus(): SchedulerPauseStatus {
    const settings = this.repository.getSyncSettings();
    if (!settings.schedulingEnabled) {
      return { paused: true, reason: 'disabled' };
    }

    const effectiveTimezone = this.getEffectiveTimezone();
    if (!effectiveTimezone) {
      return { paused: true, reason: 'timezone_mismatch' };
    }

    // Check OAuth connection
    let connRow: { id: number; generation: number; bound_archive_identity: string | null } | undefined;
    try {
      connRow = this.db
        .prepare('SELECT id, generation, bound_archive_identity FROM wakatime_oauth_connection WHERE id = 1')
        .get() as typeof connRow;
    } catch (err) {
      if (!isTableMissing(err)) {
        console.error('[SyncScheduler] Error checking wakatime_oauth_connection:', err);
        throw err;
      }
    }

    if (!connRow) {
      return { paused: true, reason: 'no_connection' };
    }

    // Check connection replacement against archive identity
    let accountRow: { wakatime_user_id: string; timezone: string } | undefined;
    try {
      accountRow = this.db
        .prepare('SELECT wakatime_user_id, timezone FROM account_settings LIMIT 1')
        .get() as typeof accountRow;
    } catch (err) {
      if (!isTableMissing(err)) {
        console.error('[SyncScheduler] Error checking account_settings:', err);
        throw err;
      }
    }

    // If archive has existing account data, connection must be explicitly bound
    if (accountRow?.wakatime_user_id) {
      if (
        !connRow.bound_archive_identity ||
        connRow.bound_archive_identity !== accountRow.wakatime_user_id
      ) {
        return { paused: true, reason: 'connection_replaced' };
      }
    }

    // Check timezone mismatch:
    // If pinnedTimezone is configured and differs from account_settings.timezone
    if (
      this.pinnedTimezone &&
      accountRow?.timezone &&
      accountRow.timezone !== this.pinnedTimezone
    ) {
      return { paused: true, reason: 'timezone_mismatch' };
    }

    // Check if recent sync run or layer reported timezone mismatch
    try {
      const recentMismatched = this.db
        .prepare(`
          SELECT 1 FROM sync_layer_state
          WHERE status_code IN ('TIMEZONE_MISMATCH', 'TIMEZONE_CHANGED')
          LIMIT 1
        `)
        .get();
      if (recentMismatched) {
        return { paused: true, reason: 'timezone_mismatch' };
      }
    } catch (err) {
      if (!isTableMissing(err)) {
        console.error('[SyncScheduler] Error checking sync_layer_state timezone mismatch:', err);
        throw err;
      }
    }

    return { paused: false };
  }

  // ==========================================================================
  // Core Tick Evaluation
  // ==========================================================================

  /**
   * Evaluates due schedule intents for the current instant.
   * Supports deterministic testing with fake clocks.
   */
  async tick(overrideNow?: Date, skipCatchup = false): Promise<SchedulerTickResult> {
    const now = overrideNow ?? this.getNow();
    const pause = this.checkPauseStatus();

    if (pause.paused) {
      return { ran: false, pauseReason: pause.reason, enqueuedIntents: [] };
    }

    const timezone = this.getEffectiveTimezone();
    if (!timezone) {
      return { ran: false, pauseReason: 'timezone_mismatch', enqueuedIntents: [] };
    }

    const enqueuedIntents: SchedulerTickResult['enqueuedIntents'] = [];

    if (!skipCatchup) {
      // 1. First enable: seed seven days if not already seeded
      const isSeeded = this.getAppSetting(SETTINGS_KEYS.SEEDED) === 'true';
      if (!isSeeded) {
        const seedResult = await this.seedSevenDays(timezone, now);
        if (seedResult) {
          enqueuedIntents.push(seedResult);
        }
      }

      // 2. Catch-up cursor continuation (if active cursor exists)
      const cursor = this.getAppSetting(SETTINGS_KEYS.CATCHUP_CURSOR);
      if (cursor) {
        const catchupResult = await this.runCatchupBatch(timezone, now, cursor);
        if (catchupResult) {
          enqueuedIntents.push(catchupResult);
        }
      }
    }

    // 3. Hourly recent intent: [yesterday, today] in source timezone
    const lastRecentSlot = this.getAppSetting(SETTINGS_KEYS.LAST_SLOT_RECENT);
    if (isCadenceDue('recent', timezone, lastRecentSlot, now)) {
      const currentSlot = getCurrentScheduleSlot('recent', timezone, now);
      const [yesterday, today] = getRecentIntentDates(timezone, now);
      const req: RunRequest = {
        mode: 'recent',
        trigger: 'scheduled',
        idempotencyKey: `scheduled-recent-${currentSlot}`,
        rangeStartDate: yesterday,
        rangeEndDate: today
      };

      try {
        const { runId, reused } = await this.coordinator.enqueue(req);
        this.setAppSetting(SETTINGS_KEYS.LAST_SLOT_RECENT, currentSlot);
        this.updateNextDueTimestamps(timezone, now);
        enqueuedIntents.push({
          intent: 'recent',
          runId,
          dates: [yesterday, today],
          reused
        });
      } catch (err) {
        console.error('[SyncScheduler] Failed to enqueue recent intent:', err);
      }
    }

    // 4. Daily 03:00 reconciliation intent: 14 completed calendar dates [today - 14 ... today - 1]
    const lastReconcileSlot = this.getAppSetting(SETTINGS_KEYS.LAST_SLOT_RECONCILE);
    if (isCadenceDue('reconcile', timezone, lastReconcileSlot, now)) {
      const currentSlot = getCurrentScheduleSlot('reconcile', timezone, now);
      const dates = getReconciliationIntentDates(timezone, now, DEFAULT_RECONCILE_WINDOW_DAYS);
      if (dates.length > 0) {
        const req: RunRequest = {
          mode: 'backfill',
          trigger: 'scheduled',
          idempotencyKey: `scheduled-reconcile-${currentSlot}`,
          rangeStartDate: dates[0],
          rangeEndDate: dates[dates.length - 1]
        };

        try {
          const { runId, reused } = await this.coordinator.enqueue(req);
          this.setAppSetting(SETTINGS_KEYS.LAST_SLOT_RECONCILE, currentSlot);
          this.updateNextDueTimestamps(timezone, now);
          enqueuedIntents.push({
            intent: 'reconcile',
            runId,
            dates,
            reused
          });
        } catch (err) {
          console.error('[SyncScheduler] Failed to enqueue reconcile intent:', err);
        }
      }
    }

    // 5. Monday 04:00 weekly comparison intent: 90 completed dates [today - 90 ... today - 1]
    const lastCompareSlot = this.getAppSetting(SETTINGS_KEYS.LAST_SLOT_COMPARE);
    if (isCadenceDue('compare', timezone, lastCompareSlot, now)) {
      const currentSlot = getCurrentScheduleSlot('compare', timezone, now);
      const dates = getComparisonIntentDates(timezone, now, DEFAULT_COMPARE_WINDOW_DAYS);
      if (dates.length > 0) {
        const req: RunRequest = {
          mode: 'compare',
          trigger: 'scheduled',
          idempotencyKey: `scheduled-compare-${currentSlot}`,
          rangeStartDate: dates[0],
          rangeEndDate: dates[dates.length - 1]
        };

        try {
          const { runId, reused } = await this.coordinator.enqueue(req);
          this.setAppSetting(SETTINGS_KEYS.LAST_SLOT_COMPARE, currentSlot);
          this.updateNextDueTimestamps(timezone, now);
          enqueuedIntents.push({
            intent: 'compare',
            runId,
            dates,
            reused
          });
        } catch (err) {
          console.error('[SyncScheduler] Failed to enqueue compare intent:', err);
        }
      }
    }

    // Always update next due timestamps after evaluation
    this.updateNextDueTimestamps(timezone, now);

    return {
      ran: true,
      enqueuedIntents
    };
  }

  // ==========================================================================
  // First Enable Seeding & Catch-Up Selection
  // ==========================================================================

  /**
   * Seeds the 7-day policy window on first enable.
   */
  private async seedSevenDays(
    timezone: string,
    now: Date
  ): Promise<SchedulerTickResult['enqueuedIntents'][0] | null> {
    const today = getZonedDateString(timezone, now);
    const candidateSelection = selectStartupCatchupDates({
      archiveDates: [],
      timezone,
      now,
      policyWindowDays: DEFAULT_POLICY_WINDOW_DAYS,
      maxDates: DEFAULT_POLICY_WINDOW_DAYS
    });

    const dates = candidateSelection.datesToSync;
    if (dates.length === 0) return null;

    const req: RunRequest = {
      mode: 'retry',
      trigger: 'startup',
      idempotencyKey: `seed-seven-days-${today}`,
      retryDates: dates
    };

    try {
      const { runId, reused } = await this.coordinator.enqueue(req);
      this.setAppSetting(SETTINGS_KEYS.SEEDED, 'true');
      return {
        intent: 'startup',
        runId,
        dates,
        reused
      };
    } catch (err) {
      console.error('[SyncScheduler] Failed to enqueue first-enable seed run:', err);
      return null;
    }
  }

  /**
   * Runs startup catch-up:
   * 1. Inspects daily_totals (including accepted dump dates) and sync_days.
   * 2. Inspects unfinished dates (pending, running, interrupted).
   * 3. Inspects retryable failure records, honoring next_retry_at.
   * 4. Enqueues up to 31 dates per run in priority order.
   * 5. Saves durable continuation cursor if remaining gaps exist.
   */
  async runStartupCatchup(overrideNow?: Date): Promise<SchedulerTickResult['enqueuedIntents'][0] | null> {
    const now = overrideNow ?? this.getNow();
    const pause = this.checkPauseStatus();
    if (pause.paused) return null;

    const timezone = this.getEffectiveTimezone();
    if (!timezone) return null;

    const existingCursor = this.getAppSetting(SETTINGS_KEYS.CATCHUP_CURSOR);
    return this.runCatchupBatch(timezone, now, existingCursor);
  }

  private async runCatchupBatch(
    timezone: string,
    now: Date,
    cursorStart: string | null
  ): Promise<SchedulerTickResult['enqueuedIntents'][0] | null> {
    // 1. Gather archive dates (daily_totals includes dump imports, sync_days includes accepted syncs)
    const archiveDates = new Set<string>();
    try {
      const dtRows = this.db.prepare('SELECT DISTINCT date FROM daily_totals').all() as Array<{ date: string }>;
      for (const r of dtRows) {
        if (isValidDateString(r.date)) archiveDates.add(r.date);
      }
      const sdRows = this.db
        .prepare("SELECT DISTINCT date FROM sync_days WHERE status IN ('succeeded', 'partial')")
        .all() as Array<{ date: string }>;
      for (const r of sdRows) {
        if (isValidDateString(r.date)) archiveDates.add(r.date);
      }
    } catch (err) {
      if (!isTableMissing(err)) {
        console.error('[SyncScheduler] Error querying archive dates:', err);
        throw err;
      }
    }

    // 2. Gather unfinished dates (pending, running, interrupted)
    const unfinishedDates: string[] = [];
    try {
      const uRows = this.db
        .prepare("SELECT DISTINCT date FROM sync_days WHERE status IN ('pending', 'running', 'interrupted')")
        .all() as Array<{ date: string }>;
      for (const r of uRows) {
        if (isValidDateString(r.date)) unfinishedDates.push(r.date);
      }
    } catch (err) {
      if (!isTableMissing(err)) {
        console.error('[SyncScheduler] Error querying unfinished sync_days:', err);
        throw err;
      }
    }

    // 3. Gather failed / retryable dates with next_retry_at
    const failedDates: FailedDateCandidate[] = [];
    try {
      const layerRows = this.db
        .prepare(`
          SELECT date, next_retry_at FROM sync_layer_state
          WHERE next_retry_at IS NOT NULL OR has_failure = 1 OR has_restriction = 1
        `)
        .all() as Array<{ date: string; next_retry_at: string | null }>;
      for (const r of layerRows) {
        if (isValidDateString(r.date)) {
          failedDates.push({ date: r.date, nextRetryAt: r.next_retry_at });
        }
      }

      const dayFailedRows = this.db
        .prepare("SELECT DISTINCT date FROM sync_days WHERE status = 'failed'")
        .all() as Array<{ date: string }>;
      for (const r of dayFailedRows) {
        if (isValidDateString(r.date) && !failedDates.some((f) => f.date === r.date)) {
          failedDates.push({ date: r.date, nextRetryAt: null });
        }
      }
    } catch (err) {
      if (!isTableMissing(err)) {
        console.error('[SyncScheduler] Error querying failed dates:', err);
        throw err;
      }
    }

    // 4. Earliest date / watermark across all daily_totals and sync_days
    let watermarkDate: string | null = null;
    if (cursorStart && isValidDateString(cursorStart)) {
      watermarkDate = cursorStart;
    } else {
      try {
        const minDtRow = this.db
          .prepare('SELECT MIN(date) as min_date FROM daily_totals')
          .get() as { min_date: string | null } | undefined;
        const minSdRow = this.db
          .prepare('SELECT MIN(date) as min_date FROM sync_days')
          .get() as { min_date: string | null } | undefined;

        const candidates: string[] = [];
        if (minDtRow?.min_date && isValidDateString(minDtRow.min_date)) candidates.push(minDtRow.min_date);
        if (minSdRow?.min_date && isValidDateString(minSdRow.min_date)) candidates.push(minSdRow.min_date);
        if (candidates.length > 0) {
          candidates.sort();
          watermarkDate = candidates[0];
        }
      } catch (err) {
        if (!isTableMissing(err)) {
          console.error('[SyncScheduler] Error querying minimum date:', err);
          throw err;
        }
      }
    }

    const selection = selectStartupCatchupDates({
      archiveDates: Array.from(archiveDates),
      watermarkDate,
      failedDates,
      unfinishedDates,
      timezone,
      now,
      maxDates: DEFAULT_MAX_CATCHUP_DAYS
    });

    if (selection.datesToSync.length === 0) {
      this.deleteAppSetting(SETTINGS_KEYS.CATCHUP_CURSOR);
      return null;
    }

    const today = getZonedDateString(timezone, now);
    const req: RunRequest = {
      mode: 'retry',
      trigger: 'catchup',
      idempotencyKey: `catchup-${today}-${selection.datesToSync[0]}-${selection.datesToSync.length}`,
      retryDates: selection.datesToSync
    };

    try {
      const { runId, reused } = await this.coordinator.enqueue(req);

      // Persist continuation cursor ONLY AFTER durable enqueue succeeds!
      if (selection.nextCursor) {
        this.setAppSetting(SETTINGS_KEYS.CATCHUP_CURSOR, selection.nextCursor);
      } else {
        this.deleteAppSetting(SETTINGS_KEYS.CATCHUP_CURSOR);
      }

      return {
        intent: 'catchup',
        runId,
        dates: selection.datesToSync,
        reused
      };
    } catch (err) {
      console.error('[SyncScheduler] Failed to enqueue catchup run:', err);
      // DO NOT update or advance cursor on enqueue failure!
      return null;
    }
  }

  // ==========================================================================
  // Schedule State & Next Due Timestamps
  // ==========================================================================

  getScheduleState(): SchedulerScheduleState {
    const pause = this.checkPauseStatus();
    const timezone = this.getEffectiveTimezone();
    const settings = this.repository.getSyncSettings();

    return {
      schedulingEnabled: settings.schedulingEnabled,
      paused: pause.paused,
      pauseReason: pause.reason,
      timezone,
      lastHandledSlots: {
        recent: this.getAppSetting(SETTINGS_KEYS.LAST_SLOT_RECENT),
        reconcile: this.getAppSetting(SETTINGS_KEYS.LAST_SLOT_RECONCILE),
        compare: this.getAppSetting(SETTINGS_KEYS.LAST_SLOT_COMPARE)
      },
      nextDue: {
        recent: this.getAppSetting(SETTINGS_KEYS.NEXT_DUE_RECENT),
        reconcile: this.getAppSetting(SETTINGS_KEYS.NEXT_DUE_RECONCILE),
        compare: this.getAppSetting(SETTINGS_KEYS.NEXT_DUE_COMPARE)
      },
      catchupCursor: this.getAppSetting(SETTINGS_KEYS.CATCHUP_CURSOR),
      seeded: this.getAppSetting(SETTINGS_KEYS.SEEDED) === 'true'
    };
  }

  private updateNextDueTimestamps(timezone: string, now: Date): void {
    const parts = getZonedDateParts(timezone, now);
    const todayStr = getZonedDateString(timezone, now);

    // 1. Next recent due: start of the next hour
    const secondsSinceHourStart = parts.minute * 60 + parts.second;
    const msToNextHour = (3600 - secondsSinceHourStart) * 1000 - now.getMilliseconds();
    const nextRecentDate = new Date(now.getTime() + Math.max(1000, msToNextHour));
    this.setAppSetting(SETTINGS_KEYS.NEXT_DUE_RECENT, nextRecentDate.toISOString());

    // 2. Next reconcile due: 03:00 source time daily
    const nextReconcileDateStr = parts.hour < 3 ? todayStr : addDays(todayStr, 1);
    const nextReconcileInstant = this.getZonedTimestamp(nextReconcileDateStr, 3, 0, 0, timezone);
    this.setAppSetting(SETTINGS_KEYS.NEXT_DUE_RECONCILE, nextReconcileInstant.toISOString());

    // 3. Next compare due: Monday 04:00 source time weekly
    const [dYear, dMonth, dDay] = todayStr.split('-').map((v) => Number.parseInt(v, 10));
    const utcDate = new Date(Date.UTC(dYear, dMonth - 1, dDay));
    const dayOfWeek = utcDate.getUTCDay(); // 0 is Sunday, 1 is Monday ...

    let daysToMonday = 0;
    if (dayOfWeek === 1 && parts.hour < 4) {
      daysToMonday = 0;
    } else if (dayOfWeek === 1) {
      daysToMonday = 7;
    } else if (dayOfWeek === 0) {
      daysToMonday = 1;
    } else {
      daysToMonday = 8 - dayOfWeek;
    }

    const nextCompareDateStr = addDays(todayStr, daysToMonday);
    const nextCompareInstant = this.getZonedTimestamp(nextCompareDateStr, 4, 0, 0, timezone);
    this.setAppSetting(SETTINGS_KEYS.NEXT_DUE_COMPARE, nextCompareInstant.toISOString());
  }

  /**
   * Pure calendar converter from zoned (YYYY-MM-DD, HH, MM, SS) to UTC Date instant.
   * Handles DST jumps iteratively without UTC string slicing.
   */
  private getZonedTimestamp(
    dateStr: string,
    hour: number,
    minute: number,
    second: number,
    timezone: string
  ): Date {
    const [y, m, d] = dateStr.split('-').map(Number);
    let guess = new Date(Date.UTC(y, m - 1, d, hour, minute, second));
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

    for (let i = 0; i < 4; i++) {
      const parts = formatter.formatToParts(guess);
      let pYear = 0, pMonth = 0, pDay = 0, pHour = 0, pMinute = 0, pSecond = 0;
      for (const part of parts) {
        if (part.type === 'year') pYear = Number(part.value);
        else if (part.type === 'month') pMonth = Number(part.value);
        else if (part.type === 'day') pDay = Number(part.value);
        else if (part.type === 'hour') pHour = Number(part.value);
        else if (part.type === 'minute') pMinute = Number(part.value);
        else if (part.type === 'second') pSecond = Number(part.value);
      }
      const zonedUtc = Date.UTC(pYear, pMonth - 1, pDay, pHour, pMinute, pSecond);
      const targetUtc = Date.UTC(y, m - 1, d, hour, minute, second);
      const diff = targetUtc - zonedUtc;
      if (diff === 0) break;
      guess = new Date(guess.getTime() + diff);
    }
    return guess;
  }

  // ==========================================================================
  // Settings Storage Helpers
  // ==========================================================================

  private getAppSetting(key: string): string | null {
    try {
      const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? null;
    } catch (err) {
      if (!isTableMissing(err)) {
        console.error(`[SyncScheduler] Error getting app setting '${key}':`, err);
        throw err;
      }
      return null;
    }
  }

  private setAppSetting(key: string, value: string): void {
    try {
      this.db
        .prepare(`
          INSERT INTO app_settings (key, value, updated_at)
          VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `)
        .run(key, value);
    } catch (err) {
      if (!isTableMissing(err)) {
        console.error(`[SyncScheduler] Error setting app setting '${key}':`, err);
        throw err;
      }
    }
  }

  private deleteAppSetting(key: string): void {
    try {
      this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    } catch (err) {
      if (!isTableMissing(err)) {
        console.error(`[SyncScheduler] Error deleting app setting '${key}':`, err);
        throw err;
      }
    }
  }
}

export function createSyncScheduler(options: SyncSchedulerOptions): SyncScheduler {
  return new SyncScheduler(options);
}
