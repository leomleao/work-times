/**
 * Sync coordinator for Work Times (Milestone P6).
 *
 * Implements docs/NEXT-MILESTONE.md §3.1-3.4, 7:
 * - Frozen SyncService interface: enqueue, cancel, start, stop.
 * - Single-date execution serialization: exactly one date across the application executes at a time.
 * - Prioritized transactional claim: manual runs before scheduled/automatic runs.
 * - Bounded queue (max 10 nonterminal runs) and idempotency enforcement.
 * - Non-preemptive cancellation: queued cancels immediately, active persists cancel request and
 *   aborts async reads/waits via P5 signal without preempting synchronous SQLite transactions.
 * - Crash and shutdown recovery before intake: interrupts stale runs/dates, preserves accepted data,
 *   creates deterministic linked retry only for unfinished dates; never retries cancelled work.
 * - Disabled scheduling handling: manual queued runs survive; automatic recovery is deferred.
 * - Truthful aggregate outcomes across all durable dates: cancellation/interruption wins,
 *   all-restricted is partial with NO_DATES_UPDATED, useful acceptance succeeds.
 * - Persistent/revoked auth stops further date dispatch and surfaces reconnect.
 * - Reusable isolated service factory for P7/P8.
 * - Strictly no import-time timers or build side effects.
 */

import type Database from 'better-sqlite3';
import {
  MAX_BACKFILL_RANGE_DAYS,
  RECONCILE_CODES,
  SHUTDOWN_GRACE_PERIOD_MS,
  aggregateRunOutcome,
  type RunRequest,
  type RunStatus,
  type SyncDayStatus,
  type SyncService
} from './contracts.js';
import {
  isValidDateString,
  validateDateRange,
  getRecentIntentDates
} from './calendar.js';
import {
  SqliteSyncRepository,
  type SyncRepository,
  type SyncRunRecord,
  type SyncDayRecord
} from './repository.js';
import {
  syncDayWorker,
  type SyncDayWorkerOptions,
  type SyncDayWorkerResult
} from './worker.js';
import {
  refreshUserAgentRegistry,
  type RegistryRefreshOptions,
  type RegistryRefreshResult
} from './user-agent-registry.js';
import {
  WakaTimeAuthError,
  WakaTimeOAuthRevokedError
} from '../wakatime/errors.js';
import type { WakaTimeClient } from '../wakatime/client.js';
import { CapabilityPolicy } from './capabilities.js';

export interface SyncCoordinatorOptions {
  /** BetterSQLite3 database instance. */
  db: Database.Database;
  /** Optional sync repository instance (defaults to SqliteSyncRepository(db)). */
  repository?: SyncRepository;
  /** Optional accepted P2 WakaTimeClient instance. */
  client?: WakaTimeClient;
  /** Injected single-day worker executor (defaults to syncDayWorker). */
  executeDayWorker?: (options: SyncDayWorkerOptions) => Promise<SyncDayWorkerResult>;
  /** Injected user-agent registry refresh executor (defaults to refreshUserAgentRegistry). */
  executeRegistryRefresh?: (options: RegistryRefreshOptions) => Promise<RegistryRefreshResult>;
  /** Clock provider for deterministic testing (defaults to system clock). */
  now?: () => Date;
  /** Pinned source timezone (defaults to Europe/London). */
  pinnedTimezone?: string;
  /** Shared capability policy instance. */
  policy?: CapabilityPolicy;
  /** Classification cache invalidation service. */
  classification?: { invalidateIdentityCaches(): void; clearCaches(): void };
  /** Whole-day execution budget in milliseconds. */
  dayBudgetMs?: number;
}

export class SyncCoordinator implements SyncService {
  private readonly db: Database.Database;
  private readonly repository: SyncRepository;
  private readonly client?: WakaTimeClient;
  private readonly executeDayWorker: (options: SyncDayWorkerOptions) => Promise<SyncDayWorkerResult>;
  private readonly executeRegistryRefresh: (options: RegistryRefreshOptions) => Promise<RegistryRefreshResult>;
  private readonly getNow: () => Date;
  private readonly pinnedTimezone: string;
  private readonly policy: CapabilityPolicy;
  private readonly classification?: { invalidateIdentityCaches(): void; clearCaches(): void };
  private readonly dayBudgetMs?: number;

  private running = false;
  private stopping = false;
  private stopped = false;

  private isPumping = false;
  private pendingWork = false;

  private currentActiveRunId: number | null = null;
  private currentActiveDate: string | null = null;
  private currentAbortController: AbortController | null = null;
  private currentRunPromise: Promise<void> | null = null;

  private readonly runListeners = new Map<number, Set<() => void>>();
  private readonly idleListeners = new Set<() => void>();

  constructor(options: SyncCoordinatorOptions) {
    this.db = options.db;
    this.repository = options.repository ?? new SqliteSyncRepository(options.db);
    this.client = options.client;
    this.executeDayWorker = options.executeDayWorker ?? syncDayWorker;
    this.executeRegistryRefresh = options.executeRegistryRefresh ?? refreshUserAgentRegistry;
    this.getNow = options.now ?? (() => new Date());
    this.pinnedTimezone = options.pinnedTimezone ?? 'Europe/London';
    this.policy = options.policy ?? new CapabilityPolicy();
    this.classification = options.classification;
    this.dayBudgetMs = options.dayBudgetMs;
  }

  // ==========================================================================
  // Lifecycle: start & stop
  // ==========================================================================

  /**
   * Starts the sync coordinator:
   * 1. Runs crash/interruption recovery before accepting new intake or claiming work.
   * 2. Starts the queue pump loop.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.stopping = false;

    // Run recovery before intake
    await this.runRecovery();

    // Trigger pump
    this.triggerPump();
  }

  /**
   * Graceful stop:
   * 1. Rejects intake immediately.
   * 2. Aborts active async work (HTTP reads, sleeps, gate waits) via signal.
   * 3. Awaits active work up to deadlineMs.
   * 4. If active run didn't finish, marks active run and dates interrupted.
   * 5. Preserves queued work in SQLite.
   * 6. Meets deadline and creates no lingering timers.
   */
  async stop(
    reason: 'shutdown' = 'shutdown',
    deadlineMs: number = SHUTDOWN_GRACE_PERIOD_MS
  ): Promise<void> {
    if (this.stopped) return;
    this.stopping = true;

    // Abort active async work
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }

    // Await active run with deadline
    if (this.currentRunPromise) {
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, deadlineMs);
      });

      try {
        await Promise.race([this.currentRunPromise, timeoutPromise]);
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    // If active run is still running in DB, mark it and its unfinished dates interrupted
    if (this.currentActiveRunId !== null) {
      const activeRun = this.repository.getRun(this.currentActiveRunId);
      if (activeRun && activeRun.status === 'running') {
        const nowStr = this.getNow().toISOString();
        const days = this.repository.getSyncDaysForRun(this.currentActiveRunId);
        for (const d of days) {
          if (d.status === 'pending' || d.status === 'running') {
            this.repository.updateSyncDay(
              this.currentActiveRunId,
              d.date,
              {
                status: 'interrupted',
                disposition: null
              },
              nowStr
            );
          }
        }
        this.repository.completeRun(
          this.currentActiveRunId,
          {
            status: 'interrupted',
            summary: 'Sync run was interrupted by server shutdown'
          },
          nowStr
        );
      }
      this.currentActiveRunId = null;
      this.currentActiveDate = null;
      this.currentAbortController = null;
      this.currentRunPromise = null;
    }

    this.stopped = true;
    this.running = false;
    this.isPumping = false;

    // Notify any waiting idle listeners
    this.notifyIdle();
  }

  // ==========================================================================
  // Intake: enqueue & cancel
  // ==========================================================================

  /**
   * Enqueues a sync run request:
   * 1. Validates mode, dates/range, and idempotency key.
   * 2. Rejects intake if service is stopped.
   * 3. Persists run and date rows atomically before returning.
   * 4. Replays identical key + payload, conflicts on same key + different payload.
   * 5. Returns 409 QueueFullError if queue is full (>= 10 nonterminal runs).
   */
  async enqueue(input: RunRequest): Promise<{ runId: number; reused: boolean }> {
    if (this.stopping || this.stopped) {
      throw new Error('Intake rejected: sync service is stopped');
    }

    if (
      !input.idempotencyKey ||
      typeof input.idempotencyKey !== 'string' ||
      input.idempotencyKey.trim() === ''
    ) {
      throw new Error('Idempotency key is required');
    }

    const req: RunRequest = {
      mode: input.mode,
      trigger: input.trigger,
      idempotencyKey: input.idempotencyKey.trim(),
      rangeStartDate: input.rangeStartDate,
      rangeEndDate: input.rangeEndDate,
      retryDates: input.retryDates,
      resumedFromRunId: input.resumedFromRunId
    };

    let dates: string[] = [];
    const timezone = this.pinnedTimezone;
    const now = this.getNow();

    switch (input.mode) {
      case 'registry': {
        // Registry runs have no date rows
        dates = [];
        req.rangeStartDate = undefined;
        req.rangeEndDate = undefined;
        req.retryDates = undefined;
        break;
      }
      case 'recent': {
        if (input.rangeStartDate && input.rangeEndDate) {
          const rangeResult = validateDateRange(input.rangeStartDate, input.rangeEndDate, {
            maxRangeDays: MAX_BACKFILL_RANGE_DAYS,
            timezone,
            now
          });
          if (!rangeResult.valid || !rangeResult.dates) {
            throw new Error(rangeResult.error ?? 'Invalid date range');
          }
          dates = rangeResult.dates;
        } else {
          const [yesterday, today] = getRecentIntentDates(timezone, now);
          dates = [yesterday, today];
          req.rangeStartDate = yesterday;
          req.rangeEndDate = today;
        }
        break;
      }
      case 'backfill':
      case 'compare': {
        if (!input.rangeStartDate || !input.rangeEndDate) {
          throw new Error(`Mode "${input.mode}" requires rangeStartDate and rangeEndDate`);
        }
        const rangeResult = validateDateRange(input.rangeStartDate, input.rangeEndDate, {
          maxRangeDays: MAX_BACKFILL_RANGE_DAYS,
          timezone,
          now
        });
        if (!rangeResult.valid || !rangeResult.dates) {
          throw new Error(rangeResult.error ?? 'Invalid date range');
        }
        dates = rangeResult.dates;
        break;
      }
      case 'retry': {
        if (!input.retryDates || !Array.isArray(input.retryDates) || input.retryDates.length === 0) {
          throw new Error('Retry run requires non-empty retryDates');
        }
        for (const d of input.retryDates) {
          if (!isValidDateString(d)) {
            throw new Error(`Invalid retry date: "${d}"`);
          }
        }
        dates = [...new Set(input.retryDates)].sort();
        req.retryDates = dates;
        if (!req.rangeStartDate) req.rangeStartDate = dates[0];
        if (!req.rangeEndDate) req.rangeEndDate = dates[dates.length - 1];
        break;
      }
      default:
        throw new Error(`Unknown run mode: "${(input as { mode: string }).mode}"`);
    }

    // Persist run plus date rows before returning
    const result = this.repository.enqueueRun(req, dates);

    // Trigger pump if active
    if (this.running && !this.stopping) {
      this.triggerPump();
    }

    return result;
  }

  /**
   * Idempotent cancellation:
   * - Terminal runs: returns current terminal state unchanged.
   * - Queued runs: cancels immediately in SQLite and marks all pending dates cancelled.
   * - Active runs: persists cancel_requested_at, fires abort signal on active date worker,
   *   awaits run completion, and returns cancelled state.
   */
  async cancel(runId: number): Promise<RunStatus> {
    const run = this.repository.getRun(runId);
    if (!run) {
      throw new Error(`Sync run ${runId} not found`);
    }

    // Terminal state: idempotent return
    if (
      run.status === 'succeeded' ||
      run.status === 'partial' ||
      run.status === 'failed' ||
      run.status === 'cancelled' ||
      run.status === 'interrupted'
    ) {
      return run.status;
    }

    // Queued run: cancel immediately in SQLite
    if (run.status === 'queued') {
      const { run: cancelledRun } = this.repository.cancelRun(runId, this.getNow().toISOString());
      return cancelledRun.status;
    }

    // Active (running) run:
    // 1. Record cancel_requested_at in SQLite
    this.repository.cancelRun(runId, this.getNow().toISOString());

    // 2. Abort active async operations via controller
    if (this.currentActiveRunId === runId && this.currentAbortController) {
      this.currentAbortController.abort();
    }

    // 3. Await run execution to complete cancellation
    if (this.currentRunPromise && this.currentActiveRunId === runId) {
      try {
        await this.currentRunPromise;
      } catch {
        // Ignore internal execution errors; inspect terminal status below
      }
    }

    const updated = this.repository.getRun(runId);
    return updated?.status ?? 'cancelled';
  }

  // ==========================================================================
  // Recovery
  // ==========================================================================

  /**
   * Recovery procedure:
   * 1. Marks stale running runs and their pending/running dates as interrupted.
   * 2. Preserves already accepted data.
   * 3. Creates deterministic linked retry only for unfinished eligible dates.
   * 4. Never retries cancelled runs.
   * 5. Manual queued runs survive; automatic recovery is deferred while scheduling is disabled.
   */
  async runRecovery(): Promise<{
    interruptedRunIds: number[];
    recoveredRunIds: number[];
  }> {
    const nowStr = this.getNow().toISOString();
    const settings = this.repository.getSyncSettings();
    const schedulingEnabled = settings.schedulingEnabled;

    const { interruptedRunIds } = this.repository.recoverInterruptedRuns(nowStr);
    const recoveredRunIds: number[] = [];

    // Create linked retries for newly interrupted runs
    for (const runId of interruptedRunIds) {
      const retryRunId = this.maybeCreateLinkedRetry(runId, schedulingEnabled);
      if (retryRunId !== null) {
        recoveredRunIds.push(retryRunId);
      }
    }

    // If scheduling is enabled, recover any previously deferred interrupted automatic runs
    if (schedulingEnabled) {
      const deferredIds = this.recoverDeferredRuns();
      recoveredRunIds.push(...deferredIds);
    }

    return { interruptedRunIds, recoveredRunIds };
  }

  private maybeCreateLinkedRetry(runId: number, schedulingEnabled: boolean): number | null {
    const run = this.repository.getRun(runId);
    if (!run) return null;

    // Never retry cancelled work
    if (run.cancelRequestedAt !== null || run.status === 'cancelled') {
      return null;
    }
    if (run.advisoryCodes && run.advisoryCodes.includes(RECONCILE_CODES.RUN_CANCELLED)) {
      return null;
    }

    // Never duplicate retry if already linked
    if (this.hasLinkedRetry(run.id)) {
      return null;
    }

    // Automatic recovery waits while scheduling is disabled
    if (run.trigger !== 'manual' && !schedulingEnabled) {
      return null;
    }

    // For registry runs, no date rows exist
    if (run.mode === 'registry') {
      const retryReq: RunRequest = {
        mode: 'registry',
        trigger: run.trigger,
        idempotencyKey: `recovery-run-${run.id}`,
        resumedFromRunId: run.id
      };
      const { runId: newRunId } = this.repository.enqueueRun(retryReq, []);
      return newRunId;
    }

    // Date-based runs: find unfinished eligible dates
    const days = this.repository.getSyncDaysForRun(run.id);
    const unfinishedDates = days
      .filter((d) => d.status === 'interrupted' || d.status === 'pending')
      .map((d) => d.date);

    if (unfinishedDates.length === 0) {
      return null;
    }

    unfinishedDates.sort();

    const retryReq: RunRequest = {
      mode: 'retry',
      trigger: run.trigger,
      idempotencyKey: `recovery-run-${run.id}`,
      retryDates: unfinishedDates,
      rangeStartDate: unfinishedDates[0],
      rangeEndDate: unfinishedDates[unfinishedDates.length - 1],
      resumedFromRunId: run.id
    };

    const { runId: newRunId } = this.repository.enqueueRun(retryReq, unfinishedDates);
    return newRunId;
  }

  private hasLinkedRetry(runId: number): boolean {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM sync_runs WHERE resumed_from_run_id = ?`)
      .get(runId) as { count: number };
    return row.count > 0;
  }

  private recoverDeferredRuns(): number[] {
    const retries: number[] = [];
    const candidateRuns = this.db
      .prepare(
        `SELECT id FROM sync_runs
         WHERE status = 'interrupted'
           AND cancel_requested_at IS NULL
           AND id NOT IN (SELECT resumed_from_run_id FROM sync_runs WHERE resumed_from_run_id IS NOT NULL)`
      )
      .all() as Array<{ id: number }>;

    for (const candidate of candidateRuns) {
      const retryId = this.maybeCreateLinkedRetry(candidate.id, true);
      if (retryId !== null) {
        retries.push(retryId);
      }
    }

    return retries;
  }

  // ==========================================================================
  // Execution Loop & Pump
  // ==========================================================================

  public triggerPump(): void {
    if (this.stopping || this.stopped || !this.running) return;

    if (this.isPumping) {
      this.pendingWork = true;
      return;
    }

    this.isPumping = true;
    this.pumpLoop().catch((err) => {
      console.error('[SyncCoordinator] Unhandled pumpLoop error:', err);
    });
  }

  private hasQueuedManualRuns(): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM sync_runs WHERE status = 'queued' AND trigger = 'manual'`
      )
      .get() as { count: number };
    return row.count > 0;
  }

  private async pumpLoop(): Promise<void> {
    try {
      while (this.running && !this.stopping) {
        const settings = this.repository.getSyncSettings();
        const schedulingEnabled = settings.schedulingEnabled;

        // If scheduling enabled, process any deferred automatic recovery runs
        if (schedulingEnabled) {
          const deferredIds = this.recoverDeferredRuns();
          if (deferredIds.length > 0) {
            // New retries enqueued, continue loop
          }
        }

        // If scheduling disabled, only process manual runs
        if (!schedulingEnabled) {
          const hasManual = this.hasQueuedManualRuns();
          if (!hasManual) {
            // Defer non-manual runs while scheduling is disabled
            break;
          }
        }

        // Atomically claim next run (manual priority before automatic)
        const nowStr = this.getNow().toISOString();
        const run = this.repository.claimNextRun(nowStr);
        if (!run) {
          // No claimable queued run or another run is running
          break;
        }

        // Strictly one active run at a time
        this.currentActiveRunId = run.id;
        this.currentAbortController = new AbortController();

        try {
          this.currentRunPromise = this.executeRun(run, this.currentAbortController.signal);
          await this.currentRunPromise;
        } catch (error) {
          // Guard against unhandled errors in executeRun
          const postNowStr = this.getNow().toISOString();
          const outcome = aggregateRunOutcome([], {
            isInterrupted: this.stopping,
            isCancelled: this.repository.isRunCancelRequested(run.id)
          });
          this.repository.completeRun(
            run.id,
            {
              ...outcome,
              errorMessage: error instanceof Error ? error.message : String(error)
            },
            postNowStr
          );
        } finally {
          const completedRunId = this.currentActiveRunId;
          this.currentActiveRunId = null;
          this.currentActiveDate = null;
          this.currentAbortController = null;
          this.currentRunPromise = null;

          if (completedRunId !== null) {
            this.notifyRunCompleted(completedRunId);
          }
        }
      }
    } finally {
      this.isPumping = false;
      this.notifyIdle();

      // Check if more work arrived while pump was finishing
      if (this.pendingWork && this.running && !this.stopping) {
        this.pendingWork = false;
        this.triggerPump();
      }
    }
  }

  /**
   * Executes a single claimed run.
   */
  private async executeRun(run: SyncRunRecord, signal: AbortSignal): Promise<void> {
    const nowStr = this.getNow().toISOString();

    // 1. Check if run was cancelled or interrupted before start
    const isExplicitCancelBeforeStart = this.repository.isRunCancelRequested(run.id);
    const isInterruptedBeforeStart =
      !isExplicitCancelBeforeStart && (this.stopping || signal.aborted);

    if (isExplicitCancelBeforeStart || isInterruptedBeforeStart) {
      if (run.mode === 'registry') {
        const outcome = aggregateRunOutcome([], {
          isCancelled: isExplicitCancelBeforeStart,
          isInterrupted: isInterruptedBeforeStart
        });
        this.repository.completeRun(run.id, outcome, nowStr);
        return;
      }
      const days = this.repository.getSyncDaysForRun(run.id);
      for (const d of days) {
        this.repository.updateSyncDay(
          run.id,
          d.date,
          {
            status: isExplicitCancelBeforeStart ? 'cancelled' : 'interrupted',
            disposition: null,
            advisoryCodes: isExplicitCancelBeforeStart ? [RECONCILE_CODES.RUN_CANCELLED] : []
          },
          nowStr
        );
      }
      const outcome = aggregateRunOutcome([], {
        isCancelled: isExplicitCancelBeforeStart,
        isInterrupted: isInterruptedBeforeStart
      });
      this.repository.completeRun(run.id, outcome, nowStr);
      return;
    }

    // 2. Registry Mode (no date records)
    if (run.mode === 'registry') {
      if (!this.client) {
        const outcome = aggregateRunOutcome([], { isRegistryRun: true, registrySuccess: false });
        this.repository.completeRun(
          run.id,
          {
            ...outcome,
            errorMessage: 'Cannot refresh registry: WakaTimeClient not provided'
          },
          this.getNow().toISOString()
        );
        return;
      }

      const settings = this.repository.getSyncSettings();
      try {
        await this.executeRegistryRefresh({
          client: this.client,
          repository: this.repository,
          classificationService: this.classification,
          expectedConnectionGeneration: settings.connectionGeneration,
          signal,
          now: () => this.getNow().toISOString()
        });

        const outcome = aggregateRunOutcome([], { isRegistryRun: true, registrySuccess: true });
        this.repository.completeRun(run.id, outcome, this.getNow().toISOString());
      } catch (err) {
        const isExplicitCancel = this.repository.isRunCancelRequested(run.id);
        const isAbortOrStop =
          this.stopping ||
          signal.aborted ||
          (err instanceof Error && err.name === 'AbortError');

        if (isExplicitCancel) {
          const outcome = aggregateRunOutcome([], { isCancelled: true });
          this.repository.completeRun(run.id, outcome, this.getNow().toISOString());
        } else if (isAbortOrStop) {
          const outcome = aggregateRunOutcome([], { isInterrupted: true });
          this.repository.completeRun(
            run.id,
            {
              ...outcome,
              errorMessage: err instanceof Error ? err.message : String(err)
            },
            this.getNow().toISOString()
          );
        } else {
          const outcome = aggregateRunOutcome([], { isRegistryRun: true, registrySuccess: false });
          this.repository.completeRun(
            run.id,
            {
              ...outcome,
              errorMessage: err instanceof Error ? err.message : String(err)
            },
            this.getNow().toISOString()
          );
        }
      }
      return;
    }

    // 3. Date-based Run Mode (recent, backfill, compare, retry)
    const days = this.repository.getSyncDaysForRun(run.id);
    if (days.length === 0) {
      const outcome = aggregateRunOutcome([], {});
      this.repository.completeRun(run.id, outcome, this.getNow().toISOString());
      return;
    }

    const settings = this.repository.getSyncSettings();

    for (let i = 0; i < days.length; i++) {
      const day = days[i];

      // Restart skips terminal dates so commit-before-loop-crash cannot double count
      const isTerminal =
        day.status === 'succeeded' ||
        day.status === 'partial' ||
        day.status === 'failed' ||
        day.status === 'skipped' ||
        day.status === 'cancelled' ||
        day.status === 'interrupted';

      if (isTerminal) {
        continue;
      }

      // Check cancellation vs stop before dispatching date
      const isExplicitCancelBeforeDate = this.repository.isRunCancelRequested(run.id);
      if (isExplicitCancelBeforeDate) {
        this.markRemainingDates(days.slice(i), run.id, 'cancelled', [RECONCILE_CODES.RUN_CANCELLED]);
        break;
      }

      if (this.stopping || signal.aborted) {
        this.markRemainingDates(days.slice(i), run.id, 'interrupted');
        break;
      }

      // Execute exactly one date
      this.currentActiveDate = day.date;
      let dayResult: SyncDayWorkerResult | null = null;
      let errorOccurred: unknown = null;

      try {
        dayResult = await this.executeDayWorker({
          db: this.db,
          date: day.date,
          client: this.client!,
          runId: run.id,
          pinnedTimezone: this.pinnedTimezone,
          connectionGeneration: settings.connectionGeneration,
          policy: this.policy,
          signal,
          budgetMs: this.dayBudgetMs,
          now: () => this.getNow(),
          syncRepo: this.repository,
          classification: this.classification,
          attemptDurations: run.mode !== 'compare'
        });
      } catch (err) {
        errorOccurred = err;
      } finally {
        this.currentActiveDate = null;
      }

      // Handle worker errors
      if (errorOccurred) {
        const isExplicitCancel = this.repository.isRunCancelRequested(run.id);
        const isAbort =
          this.stopping ||
          signal.aborted ||
          (errorOccurred instanceof Error && errorOccurred.name === 'AbortError');

        if (isExplicitCancel) {
          this.repository.updateSyncDay(
            run.id,
            day.date,
            {
              status: 'cancelled',
              disposition: null,
              advisoryCodes: [RECONCILE_CODES.RUN_CANCELLED],
              errorMessage: 'Cancelled'
            },
            this.getNow().toISOString()
          );
          this.markRemainingDates(days.slice(i + 1), run.id, 'cancelled', [RECONCILE_CODES.RUN_CANCELLED]);
          break;
        }

        if (isAbort) {
          this.repository.updateSyncDay(
            run.id,
            day.date,
            {
              status: 'interrupted',
              disposition: null,
              errorMessage:
                errorOccurred instanceof Error ? errorOccurred.message : 'Interrupted during shutdown'
            },
            this.getNow().toISOString()
          );
          this.markRemainingDates(days.slice(i + 1), run.id, 'interrupted');
          break;
        }

        const isAuthError =
          errorOccurred instanceof WakaTimeOAuthRevokedError ||
          errorOccurred instanceof WakaTimeAuthError ||
          (errorOccurred instanceof Error &&
            (errorOccurred.name === 'WakaTimeOAuthRevokedError' ||
              errorOccurred.name === 'WakaTimeAuthError'));

        if (isAuthError) {
          // Persistent/revoked auth stops further date dispatch and surfaces reconnect
          this.repository.updateSyncDay(
            run.id,
            day.date,
            {
              status: 'failed',
              disposition: null,
              advisoryCodes: ['AUTH_FAILED'],
              errorMessage:
                errorOccurred instanceof Error ? errorOccurred.message : String(errorOccurred)
            },
            this.getNow().toISOString()
          );

          this.markRemainingDates(
            days.slice(i + 1),
            run.id,
            'skipped',
            ['AUTH_FAILED'],
            'Skipped: reconnect required after persistent auth failure'
          );
          break;
        }

        // Non-auth error: mark current date failed
        this.repository.updateSyncDay(
          run.id,
          day.date,
          {
            status: 'failed',
            disposition: null,
            advisoryCodes: ['OPERATION_ERROR'],
            errorMessage:
              errorOccurred instanceof Error ? errorOccurred.message : String(errorOccurred)
          },
          this.getNow().toISOString()
        );
        continue;
      }

      // Handle worker result
      if (dayResult) {
        const isExplicitCancel = this.repository.isRunCancelRequested(run.id);

        if (dayResult.status === 'cancelled') {
          if (isExplicitCancel) {
            this.repository.updateSyncDay(
              run.id,
              day.date,
              {
                status: 'cancelled',
                disposition: null,
                advisoryCodes:
                  dayResult.advisoryCodes.length > 0
                    ? dayResult.advisoryCodes
                    : [RECONCILE_CODES.RUN_CANCELLED],
                errorMessage: dayResult.errorMessage ?? 'Cancelled'
              },
              this.getNow().toISOString()
            );
            this.markRemainingDates(
              days.slice(i + 1),
              run.id,
              'cancelled',
              [RECONCILE_CODES.RUN_CANCELLED]
            );
            break;
          } else if (this.stopping || signal.aborted) {
            // Coordinator stop/abort caused worker to return cancelled, so mark active date and remaining dates interrupted!
            this.repository.updateSyncDay(
              run.id,
              day.date,
              {
                status: 'interrupted',
                disposition: null,
                errorMessage: dayResult.errorMessage ?? 'Interrupted during shutdown'
              },
              this.getNow().toISOString()
            );
            this.markRemainingDates(days.slice(i + 1), run.id, 'interrupted');
            break;
          }
        }

        if (dayResult.status === 'interrupted') {
          this.repository.updateSyncDay(
            run.id,
            day.date,
            {
              status: 'interrupted',
              disposition: null,
              advisoryCodes: dayResult.advisoryCodes,
              errorMessage: dayResult.errorMessage
            },
            this.getNow().toISOString()
          );
          this.markRemainingDates(days.slice(i + 1), run.id, 'interrupted');
          break;
        }

        const disposition =
          dayResult.status === 'failed' ? null : dayResult.disposition;

        this.repository.updateSyncDay(
          run.id,
          day.date,
          {
            status: dayResult.status,
            disposition,
            summariesStatus: dayResult.summariesStatus,
            heartbeatsStatus: dayResult.heartbeatsStatus,
            durationsStatus: dayResult.durationsStatus,
            totalSeconds: dayResult.totalSeconds,
            heartbeatCount: dayResult.heartbeatCount,
            sourceImportId: dayResult.sourceImportId,
            advisoryCodes: dayResult.advisoryCodes,
            errorMessage: dayResult.errorMessage
          },
          this.getNow().toISOString()
        );

        const isAuthFailed = dayResult.advisoryCodes.includes('AUTH_FAILED');

        if (isAuthFailed) {
          // Persistent/revoked auth stops further date dispatch and surfaces reconnect
          this.markRemainingDates(
            days.slice(i + 1),
            run.id,
            'skipped',
            ['AUTH_FAILED'],
            'Skipped: reconnect required after persistent auth failure'
          );
          break;
        }
      }
    }

    // 4. Complete run by aggregating all durable date records
    const updatedDays = this.repository.getSyncDaysForRun(run.id);

    // Make sure no date record remains nonterminal
    for (const d of updatedDays) {
      if (d.status === 'pending' || d.status === 'running') {
        const isExplicitCancel = this.repository.isRunCancelRequested(run.id);
        const fallbackStatus: SyncDayStatus = isExplicitCancel
          ? 'cancelled'
          : this.stopping || signal.aborted
            ? 'interrupted'
            : 'skipped';
        this.repository.updateSyncDay(
          run.id,
          d.date,
          {
            status: fallbackStatus,
            disposition: null
          },
          this.getNow().toISOString()
        );
      }
    }

    const finalDays = this.repository.getSyncDaysForRun(run.id);

    const isExplicitCancel = this.repository.isRunCancelRequested(run.id);
    const hasCancelledDay = finalDays.some((d) => d.status === 'cancelled');
    const isCancelled = isExplicitCancel || (hasCancelledDay && !this.stopping && !signal.aborted);

    const isInterrupted =
      !isCancelled &&
      (this.stopping || signal.aborted || finalDays.some((d) => d.status === 'interrupted'));

    const outcome = aggregateRunOutcome(
      finalDays.map((d) => ({
        date: d.date,
        status: d.status,
        codes: d.advisoryCodes,
        disposition: d.disposition ?? undefined
      })),
      {
        isCancelled,
        isInterrupted
      }
    );

    this.repository.completeRun(run.id, outcome, this.getNow().toISOString());
  }

  private markRemainingDates(
    dates: SyncDayRecord[],
    runId: number,
    status: SyncDayStatus,
    advisoryCodes: string[] = [],
    errorMessage: string | null = null
  ): void {
    const nowStr = this.getNow().toISOString();
    for (const d of dates) {
      if (d.status === 'pending' || d.status === 'running') {
        this.repository.updateSyncDay(
          runId,
          d.date,
          {
            status,
            disposition: null,
            advisoryCodes,
            errorMessage
          },
          nowStr
        );
      }
    }
  }

  // ==========================================================================
  // Progress & Observation API
  // ==========================================================================

  getCurrentActiveRunId(): number | null {
    return this.currentActiveRunId;
  }

  getCurrentActiveDate(): string | null {
    return this.currentActiveDate;
  }

  isRunning(): boolean {
    return this.running;
  }

  isStopping(): boolean {
    return this.stopping;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Waits for a specific run ID to reach a terminal status.
   */
  async waitForRun(runId: number, timeoutMs = 10_000): Promise<SyncRunRecord> {
    const run = this.repository.getRun(runId);
    if (run && run.status !== 'queued' && run.status !== 'running') {
      return run;
    }

    return new Promise<SyncRunRecord>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const check = () => {
        const current = this.repository.getRun(runId);
        if (current && current.status !== 'queued' && current.status !== 'running') {
          cleanup();
          resolve(current);
        }
      };

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        const listeners = this.runListeners.get(runId);
        if (listeners) {
          listeners.delete(check);
          if (listeners.size === 0) {
            this.runListeners.delete(runId);
          }
        }
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for run ${runId} to complete after ${timeoutMs}ms`));
      }, timeoutMs);

      if (!this.runListeners.has(runId)) {
        this.runListeners.set(runId, new Set());
      }
      this.runListeners.get(runId)!.add(check);

      // Check immediately
      check();
    });
  }

  /**
   * Waits until the coordinator is idle (no active runs and no pending pump loops).
   */
  async waitForIdle(timeoutMs = 10_000): Promise<void> {
    if (!this.isPumping && this.currentActiveRunId === null) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const check = () => {
        if (!this.isPumping && this.currentActiveRunId === null) {
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.idleListeners.delete(check);
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for coordinator idle after ${timeoutMs}ms`));
      }, timeoutMs);

      this.idleListeners.add(check);

      // Check immediately
      check();
    });
  }

  private notifyRunCompleted(runId: number): void {
    const listeners = this.runListeners.get(runId);
    if (listeners) {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (err) {
          console.error('[SyncCoordinator] Listener error:', err);
        }
      }
    }
  }

  private notifyIdle(): void {
    if (!this.isPumping && this.currentActiveRunId === null) {
      for (const listener of [...this.idleListeners]) {
        try {
          listener();
        } catch (err) {
          console.error('[SyncCoordinator] Idle listener error:', err);
        }
      }
    }
  }
}

/**
 * Factory helper to construct a SyncCoordinator instance.
 */
export function createSyncCoordinator(options: SyncCoordinatorOptions): SyncCoordinator {
  return new SyncCoordinator(options);
}
