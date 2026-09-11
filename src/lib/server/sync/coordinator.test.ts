import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDatabase } from '../db/connection.js';
import {
  SyncCoordinator,
  createSyncCoordinator
} from './coordinator.js';
import {
  SqliteSyncRepository,
  IdempotencyConflictError,
  QueueFullError
} from './repository.js';
import {
  RECONCILE_CODES,
  type RunRequest,
  type SyncDayStatus,
  type ReconcileDisposition
} from './contracts.js';
import type { SyncDayWorkerOptions, SyncDayWorkerResult } from './worker.js';
import { WakaTimeOAuthRevokedError, WakaTimeAuthError } from '../wakatime/errors.js';

describe('SyncCoordinator (Milestone P6)', () => {
  let db: Database.Database;
  let syncRepo: SqliteSyncRepository;
  const fixedNow = new Date('2026-09-10T12:00:00.000Z');

  beforeEach(() => {
    db = openTestDatabase();
    syncRepo = new SqliteSyncRepository(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Ignore if already closed
    }
  });

  function createMockDayWorker(
    handler?: (options: SyncDayWorkerOptions) => Promise<SyncDayWorkerResult>
  ) {
    return (
      handler ??
      (async (options: SyncDayWorkerOptions): Promise<SyncDayWorkerResult> => {
        return {
          date: options.date,
          status: 'succeeded',
          disposition: 'updated',
          advisoryCodes: [],
          candidate: {} as never,
          summariesStatus: 'succeeded',
          heartbeatsStatus: 'skipped',
          durationsStatus: 'skipped'
        };
      })
    );
  }

  // ==========================================================================
  // Test 1: Concurrent / Idempotent Enqueue & Conflict
  // ==========================================================================
  describe('1. Idempotency & Conflict', () => {
    it('replays identical idempotency key and payload with reused: true', async () => {
      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow
      });

      const req: RunRequest = {
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'idem-key-1',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-02'
      };

      const first = await coordinator.enqueue(req);
      expect(first.reused).toBe(false);

      const second = await coordinator.enqueue(req);
      expect(second.reused).toBe(true);
      expect(second.runId).toBe(first.runId);
    });

    it('rejects same idempotency key with conflicting payload', async () => {
      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow
      });

      const req1: RunRequest = {
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'conflict-key-1',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-02'
      };

      const req2: RunRequest = {
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'conflict-key-1',
        rangeStartDate: '2026-09-03', // Different payload!
        rangeEndDate: '2026-09-04'
      };

      await coordinator.enqueue(req1);
      await expect(coordinator.enqueue(req2)).rejects.toThrow(IdempotencyConflictError);
    });
  });

  // ==========================================================================
  // Test 2: Queue Full (10 Nonterminal Runs)
  // ==========================================================================
  describe('2. Bounded Queue', () => {
    it('enforces maximum 10 queued/running runs and returns QueueFullError on 11th', async () => {
      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow
      });

      // Enqueue 10 runs without starting coordinator (they stay queued)
      for (let i = 1; i <= 10; i++) {
        await coordinator.enqueue({
          mode: 'backfill',
          trigger: 'scheduled',
          idempotencyKey: `queue-run-${i}`,
          rangeStartDate: '2026-09-01',
          rangeEndDate: '2026-09-01'
        });
      }

      // 11th run must throw QueueFullError
      await expect(
        coordinator.enqueue({
          mode: 'backfill',
          trigger: 'manual',
          idempotencyKey: 'queue-run-11',
          rangeStartDate: '2026-09-01',
          rangeEndDate: '2026-09-01'
        })
      ).rejects.toThrow(QueueFullError);
    });
  });

  // ==========================================================================
  // Test 3: Manual Priority Claim
  // ==========================================================================
  describe('3. Manual Priority', () => {
    it('claims and executes manual runs before older scheduled runs', async () => {
      const executionOrder: number[] = [];
      syncRepo.updateSyncSettings({ schedulingEnabled: true });

      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => {
          if (options.runId) executionOrder.push(options.runId);
          return {
            date: options.date,
            status: 'succeeded',
            disposition: 'updated',
            advisoryCodes: [],
            candidate: {} as never,
            summariesStatus: 'succeeded',
            heartbeatsStatus: 'skipped',
            durationsStatus: 'skipped'
          };
        }
      });

      // Enqueue scheduled run 1, then scheduled run 2, then manual run 3
      const run1 = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'scheduled',
        idempotencyKey: 'prio-sched-1',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-01'
      });

      const run2 = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'scheduled',
        idempotencyKey: 'prio-sched-2',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-01'
      });

      const run3 = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'prio-manual-3',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-01'
      });

      // Start coordinator and wait for all runs to complete
      await coordinator.start();
      await coordinator.waitForRun(run1.runId);
      await coordinator.waitForRun(run2.runId);
      await coordinator.waitForRun(run3.runId);
      await coordinator.stop();

      // Manual run 3 MUST have executed before scheduled runs 1 and 2!
      expect(executionOrder[0]).toBe(run3.runId);
      expect(executionOrder[1]).toBe(run1.runId);
      expect(executionOrder[2]).toBe(run2.runId);
    });
  });

  // ==========================================================================
  // Test 4: Single-Date Serialization
  // ==========================================================================
  describe('4. Single-Date Serialization', () => {
    it('executes exactly one date across the application at a time', async () => {
      let activeDates = 0;
      let maxActiveDates = 0;

      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => {
          activeDates++;
          if (activeDates > maxActiveDates) {
            maxActiveDates = activeDates;
          }

          // Small yield to detect any concurrent execution interleaving
          await new Promise((resolve) => setTimeout(resolve, 10));

          activeDates--;
          return {
            date: options.date,
            status: 'succeeded',
            disposition: 'updated',
            advisoryCodes: [],
            candidate: {} as never,
            summariesStatus: 'succeeded',
            heartbeatsStatus: 'skipped',
            durationsStatus: 'skipped'
          };
        }
      });

      await coordinator.start();

      const { runId } = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'serial-run-1',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-03' // 3 dates
      });

      const finishedRun = await coordinator.waitForRun(runId);
      await coordinator.stop();

      expect(finishedRun.status).toBe('succeeded');
      expect(maxActiveDates).toBe(1);
    });
  });

  // ==========================================================================
  // Test 5: Aggregate Outcomes
  // ==========================================================================
  describe('5. Aggregate Outcomes', () => {
    it('reports succeeded when all dates are updated or unchanged', async () => {
      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => ({
          date: options.date,
          status: 'succeeded',
          disposition: options.date === '2026-09-01' ? 'updated' : 'unchanged',
          advisoryCodes: [],
          candidate: {} as never,
          summariesStatus: 'succeeded',
          heartbeatsStatus: 'skipped',
          durationsStatus: 'skipped'
        })
      });

      await coordinator.start();
      const { runId } = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'agg-succ-1',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-02'
      });

      const run = await coordinator.waitForRun(runId);
      await coordinator.stop();

      expect(run.status).toBe('succeeded');
      expect(run.daysSynced).toBe(2);
      expect(run.daysFailed).toBe(0);
    });

    it('reports partial with DETAIL_DOWNGRADE when a date suffers detail downgrade', async () => {
      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => {
          if (options.date === '2026-09-02') {
            return {
              date: options.date,
              status: 'partial',
              disposition: 'preserved',
              advisoryCodes: [RECONCILE_CODES.DETAIL_DOWNGRADE],
              candidate: {} as never,
              summariesStatus: 'succeeded',
              heartbeatsStatus: 'skipped',
              durationsStatus: 'skipped'
            };
          }
          return {
            date: options.date,
            status: 'succeeded',
            disposition: 'updated',
            advisoryCodes: [],
            candidate: {} as never,
            summariesStatus: 'succeeded',
            heartbeatsStatus: 'skipped',
            durationsStatus: 'skipped'
          };
        }
      });

      await coordinator.start();
      const { runId } = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'agg-downgrade-1',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-02'
      });

      const run = await coordinator.waitForRun(runId);
      await coordinator.stop();

      expect(run.status).toBe('partial');
      expect(run.advisoryCodes).toContain(RECONCILE_CODES.DETAIL_DOWNGRADE);
    });

    it('reports failed when no dates succeed and failures occur', async () => {
      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => ({
          date: options.date,
          status: 'failed',
          disposition: 'rejected',
          advisoryCodes: ['OPERATION_ERROR'],
          candidate: {} as never,
          summariesStatus: 'failed',
          heartbeatsStatus: 'skipped',
          durationsStatus: 'skipped',
          errorMessage: 'Synthetic network error'
        })
      });

      await coordinator.start();
      const { runId } = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'agg-fail-1',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-02'
      });

      const run = await coordinator.waitForRun(runId);
      await coordinator.stop();

      expect(run.status).toBe('failed');
      expect(run.daysSynced).toBe(0);
      expect(run.daysFailed).toBe(2);
    });
  });

  // ==========================================================================
  // Test 6: All Restricted is Partial with NO_DATES_UPDATED
  // ==========================================================================
  describe('6. All Restricted Handling', () => {
    it('aggregates all restricted/skipped dates as partial with NO_DATES_UPDATED', async () => {
      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => ({
          date: options.date,
          status: 'skipped',
          disposition: 'rejected',
          advisoryCodes: ['SUMMARIES_PLAN_RESTRICTED'],
          candidate: {} as never,
          summariesStatus: 'restricted',
          heartbeatsStatus: 'skipped',
          durationsStatus: 'skipped'
        })
      });

      await coordinator.start();
      const { runId } = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'all-restricted-1',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-02'
      });

      const run = await coordinator.waitForRun(runId);
      await coordinator.stop();

      expect(run.status).toBe('partial');
      expect(run.advisoryCodes).toContain(RECONCILE_CODES.NO_DATES_UPDATED);
      expect(run.advisoryCodes).toContain('SUMMARIES_PLAN_RESTRICTED');
    });
  });

  // ==========================================================================
  // Test 7: Queued & Active Cancellation
  // ==========================================================================
  describe('7. Cancellation', () => {
    it('cancels a queued run immediately and marks pending dates cancelled', async () => {
      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow
      });

      // Do not start coordinator; run remains queued
      const { runId } = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'cancel-queued-1',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-02'
      });

      const status = await coordinator.cancel(runId);
      expect(status).toBe('cancelled');

      const run = syncRepo.getRun(runId);
      expect(run?.status).toBe('cancelled');

      const days = syncRepo.getSyncDaysForRun(runId);
      expect(days.every((d) => d.status === 'cancelled')).toBe(true);

      // Repeat cancel on terminal run is idempotent
      const repeatStatus = await coordinator.cancel(runId);
      expect(repeatStatus).toBe('cancelled');
    });

    it('cancels an active run, aborts signal, and marks unstarted dates cancelled', async () => {
      let abortedSignalReceived = false;

      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => {
          // If first date, simulate in-flight work and wait for cancel
          if (options.date === '2026-09-01') {
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener('abort', () => {
                abortedSignalReceived = true;
                resolve();
              });
            });
            return {
              date: options.date,
              status: 'cancelled',
              disposition: 'rejected',
              advisoryCodes: [RECONCILE_CODES.RUN_CANCELLED],
              candidate: {} as never,
              summariesStatus: 'failed',
              heartbeatsStatus: 'skipped',
              durationsStatus: 'skipped'
            };
          }
          return {
            date: options.date,
            status: 'succeeded',
            disposition: 'updated',
            advisoryCodes: [],
            candidate: {} as never,
            summariesStatus: 'succeeded',
            heartbeatsStatus: 'skipped',
            durationsStatus: 'skipped'
          };
        }
      });

      await coordinator.start();

      const { runId } = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'cancel-active-1',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-03' // 3 dates
      });

      // Wait a moment for run to start executing date 1
      await new Promise((r) => setTimeout(r, 20));

      const status = await coordinator.cancel(runId);
      expect(status).toBe('cancelled');
      expect(abortedSignalReceived).toBe(true);

      await coordinator.stop();

      const run = syncRepo.getRun(runId);
      expect(run?.status).toBe('cancelled');

      const days = syncRepo.getSyncDaysForRun(runId);
      expect(days.length).toBe(3);
      // All dates must be cancelled
      expect(days.every((d) => d.status === 'cancelled')).toBe(true);
    });
  });

  // ==========================================================================
  // Test 8: Stop
  // ==========================================================================
  describe('8. Stop', () => {
    it('rejects new intake, aborts active async work, marks active run interrupted, and preserves queued work', async () => {
      let abortedWork = false;

      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => {
          await new Promise<void>((resolve) => {
            options.signal?.addEventListener('abort', () => {
              abortedWork = true;
              resolve();
            });
          });
          return {
            date: options.date,
            status: 'interrupted',
            disposition: 'rejected',
            advisoryCodes: [],
            candidate: {} as never,
            summariesStatus: 'failed',
            heartbeatsStatus: 'skipped',
            durationsStatus: 'skipped'
          };
        }
      });

      await coordinator.start();

      const activeRunRes = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'stop-active-run',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-02'
      });

      // Wait for run to become active
      await new Promise((r) => setTimeout(r, 20));

      // Stop coordinator
      await coordinator.stop('shutdown', 500);

      expect(abortedWork).toBe(true);

      // Verify active run became interrupted
      const activeRun = syncRepo.getRun(activeRunRes.runId);
      expect(activeRun?.status).toBe('interrupted');

      // Verify future intake is rejected
      await expect(
        coordinator.enqueue({
          mode: 'backfill',
          trigger: 'manual',
          idempotencyKey: 'rejected-intake',
          rangeStartDate: '2026-09-01',
          rangeEndDate: '2026-09-01'
        })
      ).rejects.toThrow(/intake rejected/i);
    });

    it('marks active run and dates interrupted when date executor returns cancelled on abort during stop (real P5 worker pattern)', async () => {
      let signalObservedAborted = false;

      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => {
          if (options.date === '2026-09-01') {
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener('abort', () => {
                signalObservedAborted = true;
                resolve();
              });
            });
            // Real P5 worker returns cancelled on abort
            return {
              date: options.date,
              status: 'cancelled',
              disposition: 'rejected',
              advisoryCodes: [RECONCILE_CODES.RUN_CANCELLED],
              errorMessage: 'Day execution cancelled before reconcile commit',
              candidate: {} as never,
              summariesStatus: 'skipped',
              heartbeatsStatus: 'skipped',
              durationsStatus: 'skipped'
            };
          }
          return {
            date: options.date,
            status: 'succeeded',
            disposition: 'updated',
            advisoryCodes: [],
            candidate: {} as never,
            summariesStatus: 'succeeded',
            heartbeatsStatus: 'skipped',
            durationsStatus: 'skipped'
          };
        }
      });

      await coordinator.start();

      const { runId } = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'stop-returns-cancelled-key',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-03' // 3 dates
      });

      await new Promise((r) => setTimeout(r, 20));
      await coordinator.stop('shutdown', 500);

      expect(signalObservedAborted).toBe(true);

      // Active run must be interrupted (NOT cancelled), so recovery can resume it later
      const run = syncRepo.getRun(runId);
      expect(run?.status).toBe('interrupted');

      // Both active date and remaining unstarted dates must be interrupted
      const days = syncRepo.getSyncDaysForRun(runId);
      expect(days.length).toBe(3);
      expect(days[0].status).toBe('interrupted');
      expect(days[1].status).toBe('interrupted');
      expect(days[2].status).toBe('interrupted');
    });

    it('marks active run and dates interrupted when date executor throws AbortError during stop', async () => {
      let signalObservedAborted = false;

      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => {
          if (options.date === '2026-09-01') {
            await new Promise<void>((_, reject) => {
              options.signal?.addEventListener('abort', () => {
                signalObservedAborted = true;
                const abortErr = new Error('The operation was aborted');
                abortErr.name = 'AbortError';
                reject(abortErr);
              });
            });
          }
          return {} as never;
        }
      });

      await coordinator.start();

      const { runId } = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'stop-throws-aborterror-key',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-02'
      });

      await new Promise((r) => setTimeout(r, 20));
      await coordinator.stop('shutdown', 500);

      expect(signalObservedAborted).toBe(true);

      const run = syncRepo.getRun(runId);
      expect(run?.status).toBe('interrupted');

      const days = syncRepo.getSyncDaysForRun(runId);
      expect(days[0].status).toBe('interrupted');
      expect(days[1].status).toBe('interrupted');
    });

    it('marks registry run interrupted when registry refresh aborts during stop', async () => {
      let signalObservedAborted = false;

      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        client: {} as never,
        executeRegistryRefresh: async (options) => {
          await new Promise<void>((_, reject) => {
            options.signal?.addEventListener('abort', () => {
              signalObservedAborted = true;
              const err = new Error('Registry aborted');
              err.name = 'AbortError';
              reject(err);
            });
          });
          return {} as never;
        }
      });

      await coordinator.start();

      const { runId } = await coordinator.enqueue({
        mode: 'registry',
        trigger: 'manual',
        idempotencyKey: 'reg-stop-abort-key'
      });

      await new Promise((r) => setTimeout(r, 20));
      await coordinator.stop('shutdown', 500);

      expect(signalObservedAborted).toBe(true);

      const run = syncRepo.getRun(runId);
      expect(run?.status).toBe('interrupted');
    });

    it('marks run and dates cancelled when explicit cancel is requested even if stopped afterwards', async () => {
      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => {
          await new Promise<void>((resolve) => {
            options.signal?.addEventListener('abort', () => {
              resolve();
            });
          });
          return {
            date: options.date,
            status: 'cancelled',
            disposition: 'rejected',
            advisoryCodes: [RECONCILE_CODES.RUN_CANCELLED],
            errorMessage: 'Cancelled',
            candidate: {} as never,
            summariesStatus: 'skipped',
            heartbeatsStatus: 'skipped',
            durationsStatus: 'skipped'
          };
        }
      });

      await coordinator.start();

      const { runId } = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'explicit-cancel-then-stop-key',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-02'
      });

      await new Promise((r) => setTimeout(r, 20));

      // Explicit cancel requested!
      const status = await coordinator.cancel(runId);
      expect(status).toBe('cancelled');

      await coordinator.stop();

      const run = syncRepo.getRun(runId);
      expect(run?.status).toBe('cancelled');

      const days = syncRepo.getSyncDaysForRun(runId);
      expect(days.every((d) => d.status === 'cancelled')).toBe(true);
    });

    it('treats ordinary error with upstream aborted connection in date path as operational failure without interrupting run', async () => {
      const executedDates: string[] = [];

      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => {
          executedDates.push(options.date);
          if (options.date === '2026-09-01') {
            // Ordinary Error whose message happens to contain 'aborted connection'
            throw new Error('fetch failed: upstream aborted connection by peer (ECONNRESET)');
          }
          return {
            date: options.date,
            status: 'succeeded',
            disposition: 'updated',
            advisoryCodes: [],
            candidate: {} as never,
            summariesStatus: 'succeeded',
            heartbeatsStatus: 'skipped',
            durationsStatus: 'skipped'
          };
        }
      });

      await coordinator.start();

      const { runId } = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'upstream-aborted-date-key',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-02'
      });

      const finishedRun = await coordinator.waitForRun(runId);
      await coordinator.stop();

      // Both dates must be dispatched; ordinary error did not interrupt or halt the run
      expect(executedDates).toEqual(['2026-09-01', '2026-09-02']);

      const days = syncRepo.getSyncDaysForRun(runId);
      expect(days[0].status).toBe('failed');
      expect(days[0].advisoryCodes).toContain('OPERATION_ERROR');
      expect(days[0].errorMessage).toContain('upstream aborted connection');
      expect(days[1].status).toBe('succeeded');

      // Run outcome is partial (date 1 failed, date 2 succeeded), NOT interrupted
      expect(finishedRun.status).toBe('partial');
    });
  });

  // ==========================================================================
  // Test 9: Recovery Link, Disabled Deferral, and Manual Survival
  // ==========================================================================
  describe('9. Recovery', () => {
    it('interrupts stale running runs, creates deterministic linked retry for unfinished dates, and defers automatic recovery when scheduling is disabled', async () => {
      // 1. Seed database with stale running runs
      // Run A: manual, 2 dates (1 succeeded, 1 pending)
      const { runId: manualRunId } = syncRepo.enqueueRun(
        {
          mode: 'backfill',
          trigger: 'manual',
          idempotencyKey: 'manual-stale-1',
          rangeStartDate: '2026-09-01',
          rangeEndDate: '2026-09-02'
        },
        ['2026-09-01', '2026-09-02']
      );

      // Simulate date 1 completed before crash
      syncRepo.updateSyncDay(
        manualRunId,
        '2026-09-01',
        { status: 'succeeded', disposition: 'updated' },
        fixedNow.toISOString()
      );

      // Mark manual run as running
      db.prepare(`UPDATE sync_runs SET status = 'running' WHERE id = ?`).run(manualRunId);

      // Run B: scheduled, 2 dates (previously interrupted from earlier restart)
      const { runId: schedRunId } = syncRepo.enqueueRun(
        {
          mode: 'backfill',
          trigger: 'scheduled',
          idempotencyKey: 'sched-stale-1',
          rangeStartDate: '2026-09-03',
          rangeEndDate: '2026-09-04'
        },
        ['2026-09-03', '2026-09-04']
      );
      db.prepare(`UPDATE sync_runs SET status = 'interrupted' WHERE id = ?`).run(schedRunId);
      db.prepare(`UPDATE sync_days SET status = 'interrupted' WHERE sync_run_id = ?`).run(schedRunId);

      // Disable scheduling in settings
      syncRepo.updateSyncSettings({ schedulingEnabled: false });

      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow
      });

      // Run recovery with scheduling disabled
      const recoveryResult = await coordinator.runRecovery();

      expect(recoveryResult.interruptedRunIds).toContain(manualRunId);

      // Manual run should have a linked retry created immediately (survives disabled scheduling!)
      const manualRun = syncRepo.getRun(manualRunId);
      expect(manualRun?.status).toBe('interrupted');

      const manualDays = syncRepo.getSyncDaysForRun(manualRunId);
      expect(manualDays.find((d) => d.date === '2026-09-01')?.status).toBe('succeeded');
      expect(manualDays.find((d) => d.date === '2026-09-02')?.status).toBe('interrupted');

      // The linked retry run for manual must only have 2026-09-02!
      const manualRetry = db
        .prepare(`SELECT * FROM sync_runs WHERE resumed_from_run_id = ?`)
        .get(manualRunId) as { id: number; status: string; day_count: number } | undefined;

      expect(manualRetry).toBeDefined();
      expect(manualRetry?.day_count).toBe(1);
      const retryDays = syncRepo.getSyncDaysForRun(manualRetry!.id);
      expect(retryDays.map((d) => d.date)).toEqual(['2026-09-02']);

      // Scheduled run's recovery must be DEFERRED while scheduling is disabled!
      const schedRetry = db
        .prepare(`SELECT * FROM sync_runs WHERE resumed_from_run_id = ?`)
        .get(schedRunId) as { id: number } | undefined;
      expect(schedRetry).toBeUndefined(); // Deferred!

      // Now enable scheduling
      syncRepo.updateSyncSettings({ schedulingEnabled: true });

      // Run recovery again
      await coordinator.runRecovery();

      // Now scheduled run's retry must be created!
      const schedRetryAfter = db
        .prepare(`SELECT * FROM sync_runs WHERE resumed_from_run_id = ?`)
        .get(schedRunId) as { id: number } | undefined;
      expect(schedRetryAfter).toBeDefined();
    });

    it('never creates retry work for cancelled runs', async () => {
      const { runId: cancelledRunId } = syncRepo.enqueueRun(
        {
          mode: 'backfill',
          trigger: 'manual',
          idempotencyKey: 'cancelled-no-retry',
          rangeStartDate: '2026-09-01',
          rangeEndDate: '2026-09-02'
        },
        ['2026-09-01', '2026-09-02']
      );

      // Cancel run
      syncRepo.cancelRun(cancelledRunId, fixedNow.toISOString());

      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow
      });

      await coordinator.runRecovery();

      const retryRow = db
        .prepare(`SELECT * FROM sync_runs WHERE resumed_from_run_id = ?`)
        .get(cancelledRunId);
      expect(retryRow).toBeUndefined();
    });
  });

  // ==========================================================================
  // Test 10: Restart Skips Terminal Dates
  // ==========================================================================
  describe('10. Restart After Committed Date', () => {
    it('skips terminal dates on restart so commit-before-loop-crash cannot double count', async () => {
      const executedDates: string[] = [];

      const { runId } = syncRepo.enqueueRun(
        {
          mode: 'backfill',
          trigger: 'manual',
          idempotencyKey: 'restart-skip-terminal-1',
          rangeStartDate: '2026-09-01',
          rangeEndDate: '2026-09-03'
        },
        ['2026-09-01', '2026-09-02', '2026-09-03']
      );

      // Suppose date 1 was already committed as succeeded before crash
      syncRepo.updateSyncDay(
        runId,
        '2026-09-01',
        { status: 'succeeded', disposition: 'updated' },
        fixedNow.toISOString()
      );

      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => {
          executedDates.push(options.date);
          return {
            date: options.date,
            status: 'succeeded',
            disposition: 'updated',
            advisoryCodes: [],
            candidate: {} as never,
            summariesStatus: 'succeeded',
            heartbeatsStatus: 'skipped',
            durationsStatus: 'skipped'
          };
        }
      });

      await coordinator.start();
      const finishedRun = await coordinator.waitForRun(runId);
      await coordinator.stop();

      expect(finishedRun.status).toBe('succeeded');
      // Date 2026-09-01 was terminal and must have been SKIPPED!
      expect(executedDates).not.toContain('2026-09-01');
      expect(executedDates).toEqual(['2026-09-02', '2026-09-03']);
    });
  });

  // ==========================================================================
  // Test 11: Revoked Auth Blocking Subsequent Dates
  // ==========================================================================
  describe('11. Revoked Auth Handling', () => {
    it('stops further date dispatch when revoked auth occurs and surfaces reconnect', async () => {
      const executedDates: string[] = [];

      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => {
          executedDates.push(options.date);

          if (options.date === '2026-09-02') {
            // Throw persistent auth error on second date
            throw new WakaTimeOAuthRevokedError('/users/current/summaries');
          }

          return {
            date: options.date,
            status: 'succeeded',
            disposition: 'updated',
            advisoryCodes: [],
            candidate: {} as never,
            summariesStatus: 'succeeded',
            heartbeatsStatus: 'skipped',
            durationsStatus: 'skipped'
          };
        }
      });

      await coordinator.start();

      const { runId } = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'revoked-auth-run-1',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-03' // 3 dates
      });

      const finishedRun = await coordinator.waitForRun(runId);
      await coordinator.stop();

      // Date 1 succeeded, Date 2 failed with auth error
      // Date 3 must NOT have been dispatched!
      expect(executedDates).toEqual(['2026-09-01', '2026-09-02']);
      expect(executedDates).not.toContain('2026-09-03');

      // Date 3 must be marked skipped with AUTH_FAILED
      const days = syncRepo.getSyncDaysForRun(runId);
      const day3 = days.find((d) => d.date === '2026-09-03');
      expect(day3?.status).toBe('skipped');
      expect(day3?.advisoryCodes).toContain('AUTH_FAILED');

      // Run outcome must be partial (since date 1 succeeded, date 2 failed) and include AUTH_FAILED
      expect(finishedRun.status).toBe('partial');
      expect(finishedRun.advisoryCodes).toContain('AUTH_FAILED');
    });

    it('does not treat transient token-bucket throttling messages in thrown errors as persistent auth failures', async () => {
      const executedDates: string[] = [];

      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => {
          executedDates.push(options.date);

          if (options.date === '2026-09-02') {
            // Operational rate-limiting message mentioning token bucket
            throw new Error('Rate limit exceeded: 0 tokens left in token bucket; retry after 1s');
          }

          return {
            date: options.date,
            status: 'succeeded',
            disposition: 'updated',
            advisoryCodes: [],
            candidate: {} as never,
            summariesStatus: 'succeeded',
            heartbeatsStatus: 'skipped',
            durationsStatus: 'skipped'
          };
        }
      });

      await coordinator.start();

      const { runId } = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'token-bucket-throttling-run',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-03' // 3 dates
      });

      const finishedRun = await coordinator.waitForRun(runId);
      await coordinator.stop();

      // All 3 dates must be dispatched; transient token bucket must NOT stop subsequent dates!
      expect(executedDates).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);

      const days = syncRepo.getSyncDaysForRun(runId);
      const day2 = days.find((d) => d.date === '2026-09-02');
      expect(day2?.status).toBe('failed');
      expect(day2?.advisoryCodes).toContain('OPERATION_ERROR');
      expect(day2?.advisoryCodes).not.toContain('AUTH_FAILED');

      const day3 = days.find((d) => d.date === '2026-09-03');
      expect(day3?.status).toBe('succeeded');

      expect(finishedRun.status).toBe('partial');
      expect(finishedRun.advisoryCodes).not.toContain('AUTH_FAILED');
    });

    it('does not treat transient token-bucket error messages in worker dayResult as persistent auth failures', async () => {
      const executedDates: string[] = [];

      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        executeDayWorker: async (options) => {
          executedDates.push(options.date);

          if (options.date === '2026-09-02') {
            // Worker returned failed with token message but OPERATION_ERROR advisory (no AUTH_FAILED)
            return {
              date: options.date,
              status: 'failed',
              disposition: 'rejected',
              advisoryCodes: ['OPERATION_ERROR'],
              errorMessage: '429 Too Many Requests: token bucket depleted',
              candidate: {} as never,
              summariesStatus: 'failed',
              heartbeatsStatus: 'skipped',
              durationsStatus: 'skipped'
            };
          }

          return {
            date: options.date,
            status: 'succeeded',
            disposition: 'updated',
            advisoryCodes: [],
            candidate: {} as never,
            summariesStatus: 'succeeded',
            heartbeatsStatus: 'skipped',
            durationsStatus: 'skipped'
          };
        }
      });

      await coordinator.start();

      const { runId } = await coordinator.enqueue({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'token-bucket-result-run',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-03'
      });

      const finishedRun = await coordinator.waitForRun(runId);
      await coordinator.stop();

      // All 3 dates must be dispatched
      expect(executedDates).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);

      const days = syncRepo.getSyncDaysForRun(runId);
      const day2 = days.find((d) => d.date === '2026-09-02');
      expect(day2?.status).toBe('failed');
      expect(day2?.advisoryCodes).not.toContain('AUTH_FAILED');

      const day3 = days.find((d) => d.date === '2026-09-03');
      expect(day3?.status).toBe('succeeded');

      expect(finishedRun.status).toBe('partial');
      expect(finishedRun.advisoryCodes).not.toContain('AUTH_FAILED');
    });
  });

  // ==========================================================================
  // Test 12: No Import / Build Side Effects
  // ==========================================================================
  describe('12. No Side Effects on Import', () => {
    it('creates no active timers or background intervals simply by importing or instantiating', async () => {
      // Creating coordinator does not start loops or timers until start() is called
      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow
      });

      expect(coordinator.isRunning()).toBe(false);
      expect(coordinator.getCurrentActiveRunId()).toBeNull();
      expect(coordinator.getCurrentActiveDate()).toBeNull();
    });
  });

  // ==========================================================================
  // Test 13: Registry Runs (P4 Injected Executor)
  // ==========================================================================
  describe('13. Registry Runs', () => {
    it('executes registry run with no date records and uses atomic P4 executor', async () => {
      let registryExecutorCalled = false;

      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        client: {} as never,
        executeRegistryRefresh: async () => {
          registryExecutorCalled = true;
          return {
            publishedCount: 5,
            historicalCount: 0,
            pageCount: 1,
            rowCount: 5,
            refreshedAt: fixedNow.toISOString()
          };
        }
      });

      await coordinator.start();

      const { runId } = await coordinator.enqueue({
        mode: 'registry',
        trigger: 'manual',
        idempotencyKey: 'reg-run-1'
      });

      const finishedRun = await coordinator.waitForRun(runId);
      await coordinator.stop();

      expect(registryExecutorCalled).toBe(true);
      expect(finishedRun.status).toBe('succeeded');
      expect(finishedRun.dayCount).toBe(0);

      // Registry run has strictly no dates
      const days = syncRepo.getSyncDaysForRun(runId);
      expect(days.length).toBe(0);
    });

    it('records failed status when registry refresh fails', async () => {
      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        client: {} as never,
        executeRegistryRefresh: async () => {
          throw new Error('Registry API unavailable (500)');
        }
      });

      await coordinator.start();

      const { runId } = await coordinator.enqueue({
        mode: 'registry',
        trigger: 'manual',
        idempotencyKey: 'reg-fail-1'
      });

      const finishedRun = await coordinator.waitForRun(runId);
      await coordinator.stop();

      expect(finishedRun.status).toBe('failed');
      expect(finishedRun.errorMessage).toContain('Registry API unavailable');
    });

    it('treats ordinary error with upstream aborted connection in registry path as operational failure without interrupting run', async () => {
      const coordinator = createSyncCoordinator({
        db,
        repository: syncRepo,
        now: () => fixedNow,
        client: {} as never,
        executeRegistryRefresh: async () => {
          // Ordinary Error whose message happens to contain 'aborted'
          throw new Error('registry fetch failed: upstream aborted connection (502)');
        }
      });

      await coordinator.start();

      const { runId } = await coordinator.enqueue({
        mode: 'registry',
        trigger: 'manual',
        idempotencyKey: 'reg-upstream-aborted-key'
      });

      const finishedRun = await coordinator.waitForRun(runId);
      await coordinator.stop();

      // Must be failed, NOT interrupted
      expect(finishedRun.status).toBe('failed');
      expect(finishedRun.errorMessage).toContain('upstream aborted connection');
    });
  });
});
