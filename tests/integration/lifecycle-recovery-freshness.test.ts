import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase } from '../../src/lib/server/db/connection.js';
import { createTestSyncService } from '../../src/lib/server/sync/test-service-factory.js';
import { SqliteSyncRepository } from '../../src/lib/server/sync/repository.js';
import {
  reconcileDay
} from '../../src/lib/server/ingest/reconcile.js';
import {
  normalizeSummaryDay,
  type DayCandidate
} from '../../src/lib/server/ingest/index.js';
import {
  VERIFIED_ZERO_DAY_RAW,
  MISSING_REQUESTED_DATE_RAW
} from '../../src/lib/server/sync/fixtures/index.js';
import {
  getZonedDateString,
  getZonedDateParts,
  addDays,
  differenceInDays,
  isValidDateString,
  selectStartupCatchupDates
} from '../../src/lib/server/sync/calendar.js';

describe('Integration: Lifecycle, Cancellation, Recovery, Freshness, and Timezone Calendar', () => {
  let db: Database.Database;
  let syncRepo: SqliteSyncRepository;

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

  // ==========================================================================
  // 1. Cancellation Before Commit
  // ==========================================================================
  describe('Cancellation Before Commit', () => {
    it('cancels a queued run immediately, marking pending dates cancelled with zero partial state', async () => {
      const fixedNow = new Date('2026-09-10T10:00:00Z');
      const ctx = await createTestSyncService({
        db,
        now: () => fixedNow,
        autoStart: false // Don't process queue immediately so we can cancel while queued
      });

      try {
        const { runId } = await ctx.enqueue({
          mode: 'backfill',
          trigger: 'manual',
          idempotencyKey: 'cancel-queued-integration',
          rangeStartDate: '2026-09-01',
          rangeEndDate: '2026-09-03'
        });

        // Verify initially queued
        const initialRun = ctx.getRun(runId);
        expect(initialRun?.status).toBe('queued');

        // Cancel the run
        const cancelStatus = await ctx.coordinator.cancel(runId);
        expect(cancelStatus).toBe('cancelled');

        // Verify run record is cancelled
        const runAfter = ctx.getRun(runId);
        expect(runAfter?.status).toBe('cancelled');

        // Verify all associated sync_days are cancelled
        const days = ctx.getSyncDays(runId);
        expect(days).toHaveLength(3);
        expect(days.every((d) => d.status === 'cancelled')).toBe(true);

        // Verify no fact data was written to database
        const totalsCount = db.prepare('SELECT COUNT(*) AS c FROM daily_totals').get() as { c: number };
        expect(totalsCount.c).toBe(0);

        const slicesCount = db.prepare('SELECT COUNT(*) AS c FROM day_project_entity_slices').get() as { c: number };
        expect(slicesCount.c).toBe(0);
      } finally {
        await ctx.close();
      }
    });

    it('cancels active execution before day commit, rolling back partial mutations', async () => {
      const date = '2026-09-10';
      const rawSummary = {
        data: [
          {
            date,
            range: { date, timezone: 'Europe/London' },
            grand_total: { total_seconds: 3600.0 },
            projects: [
              {
                name: 'proj-cancel',
                total_seconds: 3600.0,
                percent: 100.0,
                entities: [{ name: 'src/cancel.ts', type: 'file', total_seconds: 3600.0 }]
              }
            ]
          }
        ]
      };

      const summaries = normalizeSummaryDay(rawSummary, { date, accountTimezone: 'Europe/London' });
      const candidate: DayCandidate = {
        date,
        timezone: 'Europe/London',
        connectionGeneration: 1,
        summaries,
        heartbeats: { kind: 'skipped', reason: 'test' }
      };

      // Ingest day with isCancelled returning true
      const result = reconcileDay(db, candidate, {
        isCancelled: () => true
      });

      // Reconciliation should abort with skipped/cancelled code
      expect(result.dayStatus).toBe('skipped');
      expect(result.disposition).toBe('preserved');
      expect(result.codes).toContain('RUN_CANCELLED');

      // Database should contain NO uncommitted totals or slices
      const total = db.prepare('SELECT * FROM daily_totals WHERE date = ?').get(date);
      expect(total).toBeUndefined();

      const slice = db.prepare('SELECT * FROM day_project_entity_slices WHERE date = ?').get(date);
      expect(slice).toBeUndefined();
    });
  });

  // ==========================================================================
  // 2. Recovery After Accepted Commit
  // ==========================================================================
  describe('Recovery After Accepted Commit', () => {
    it('preserves accepted committed days without double counting and schedules retries for unfinished dates', async () => {
      const fixedNow = new Date('2026-09-10T12:00:00Z');

      // Create a multi-day run where Day 1 succeeded and Day 2 was interrupted
      const { runId } = syncRepo.enqueueRun(
        {
          mode: 'backfill',
          trigger: 'manual',
          idempotencyKey: 'recovery-accepted-commit-key',
          rangeStartDate: '2026-09-01',
          rangeEndDate: '2026-09-02'
        },
        ['2026-09-01', '2026-09-02']
      );

      // Start the run
      syncRepo.claimNextRun(fixedNow.toISOString());

      // Day 1: Commits successfully with real project and slices
      db.exec(`
        INSERT INTO projects (id, name) VALUES (100, 'recovered-project');
        INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (10, 'api_summaries', 'hash10', 500);
        INSERT INTO daily_totals (date, total_seconds, grand_total_json, source_import_id, source_hash)
        VALUES ('2026-09-01', 3600.0, '{"total_seconds":3600.0}', 10, 'hash10');
        INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, kind, total_seconds, source_import_id)
        VALUES (500, '2026-09-01', 100, 'src/recovered.ts', 'file', 'entity', 3600.0, 10);
      `);

      syncRepo.updateSyncDay(
        runId,
        '2026-09-01',
        {
          status: 'succeeded',
          disposition: 'updated',
          summariesStatus: 'succeeded',
          totalSeconds: 3600.0
        },
        fixedNow.toISOString()
      );

      // Day 2 remains pending when process dies (run was left in 'running' state)

      // Now boot a new test sync coordinator and run recovery
      const ctx = await createTestSyncService({
        db,
        now: () => fixedNow,
        schedulingEnabled: true,
        autoStart: false,
        executeDayWorker: async (options) => ({
          date: options.date,
          status: 'succeeded',
          disposition: 'updated',
          advisoryCodes: [],
          candidate: {} as never,
          summariesStatus: 'succeeded',
          heartbeatsStatus: 'skipped',
          durationsStatus: 'skipped'
        })
      });

      try {
        const recoveryResult = await ctx.coordinator.runRecovery();
        expect(recoveryResult.interruptedRunIds).toContain(runId);
        expect(recoveryResult.recoveredRunIds.length).toBeGreaterThan(0);

        // Verify Day 1 data is still intact and not duplicated
        const day1Totals = db.prepare("SELECT COUNT(*) AS c FROM daily_totals WHERE date = '2026-09-01'").get() as { c: number };
        expect(day1Totals.c).toBe(1);

        const day1Slices = db.prepare("SELECT COUNT(*) AS c FROM day_project_entity_slices WHERE date = '2026-09-01'").get() as { c: number };
        expect(day1Slices.c).toBe(1);

        // Verify newly enqueued retry run was linked to the original interrupted run
        const retryRunId = recoveryResult.recoveredRunIds[0];
        const retryRun = ctx.getRun(retryRunId);
        expect(retryRun?.resumedFromRunId).toBe(runId);
        expect(retryRun?.rangeStartDate).toBe('2026-09-02');
        expect(retryRun?.rangeEndDate).toBe('2026-09-02');
      } finally {
        await ctx.close();
      }
    });
  });

  // ==========================================================================
  // 3. Truthful Zero-Versus-Missing Freshness
  // ==========================================================================
  describe('Truthful Zero-Versus-Missing Freshness', () => {
    it('distinguishes complete verified zero day from missing requested date in layer state', () => {
      const dateZero = '2026-09-07';
      const dateMissing = '2026-09-06';

      // 1. Verified Zero Day: total_seconds = 0, empty projects
      const zeroSummary = normalizeSummaryDay(VERIFIED_ZERO_DAY_RAW, {
        date: dateZero,
        accountTimezone: 'Europe/London'
      });
      expect(zeroSummary.kind).toBe('complete');
      if (zeroSummary.kind === 'complete') {
        expect(zeroSummary.value.fidelity).toBe('verified_zero');
      }

      const zeroCandidate: DayCandidate = {
        date: dateZero,
        timezone: 'Europe/London',
        connectionGeneration: 1,
        summaries: zeroSummary,
        heartbeats: { kind: 'skipped', reason: 'zero_day' }
      };

      const resZero = reconcileDay(db, zeroCandidate, { syncRepo });
      expect(resZero.dayStatus).toBe('succeeded');
      expect(resZero.disposition).toBe('updated');

      // Layer state records verified_zero with last_success_at
      const zeroFreshness = syncRepo.getLayerFreshness(dateZero, 'summaries');
      expect(zeroFreshness).toBeDefined();
      expect(zeroFreshness?.acceptedFidelity).toBe('verified_zero');
      expect(zeroFreshness?.lastSuccessAt).toBeTruthy();

      const zeroRow = db.prepare("SELECT has_failure, is_stale FROM sync_layer_state WHERE date = ? AND layer = 'summaries'").get(dateZero) as { has_failure: number; is_stale: number };
      expect(zeroRow.has_failure).toBe(0);
      expect(zeroRow.is_stale).toBe(0);

      // Daily totals has total_seconds = 0
      const totalRow = db.prepare('SELECT total_seconds FROM daily_totals WHERE date = ?').get(dateZero) as { total_seconds: number };
      expect(totalRow.total_seconds).toBe(0.0);

      // 2. Missing Requested Date: upstream response has no data for this date
      const missingSummary = normalizeSummaryDay(MISSING_REQUESTED_DATE_RAW, {
        date: dateMissing,
        accountTimezone: 'Europe/London'
      });
      // normalizeSummaryDay identifies date is missing
      expect(missingSummary.kind).toBe('failed');

      const missingCandidate: DayCandidate = {
        date: dateMissing,
        timezone: 'Europe/London',
        connectionGeneration: 1,
        summaries: missingSummary,
        heartbeats: { kind: 'skipped', reason: 'missing_date' }
      };

      const resMissing = reconcileDay(db, missingCandidate, { syncRepo });
      // Missing requested date must NOT report succeeded or verified zero!
      expect(resMissing.dayStatus).toBe('failed');
      expect(resMissing.disposition).toBe('rejected');
      expect(resMissing.codes).toContain('MISSING_REQUESTED_DATE');

      const missingFreshness = syncRepo.getLayerFreshness(dateMissing, 'summaries');
      expect(missingFreshness).toBeNull();

      // Invariant: no daily_totals row fabricated for missing date
      const missingTotalRow = db.prepare('SELECT total_seconds FROM daily_totals WHERE date = ?').get(dateMissing);
      expect(missingTotalRow).toBeUndefined();
    });
  });

  // ==========================================================================
  // 4. Exact Timezone, DST, Leap Year, and Restriction Retry Behavior
  // ==========================================================================
  describe('Exact Timezone, DST, Leap Year, and Restriction Retries', () => {
    it('handles London Spring and Autumn DST transitions without date shift', () => {
      // 2026-03-29: London springs forward (GMT -> BST)
      const springPre = new Date('2026-03-29T00:30:00Z');
      const springPost = new Date('2026-03-29T01:30:00Z');
      expect(getZonedDateString('Europe/London', springPre)).toBe('2026-03-29');
      expect(getZonedDateString('Europe/London', springPost)).toBe('2026-03-29');

      const partsSpringPre = getZonedDateParts('Europe/London', springPre);
      expect(partsSpringPre.hour).toBe(0);
      const partsSpringPost = getZonedDateParts('Europe/London', springPost);
      expect(partsSpringPost.hour).toBe(2); // 01:30 UTC is 02:30 BST

      // 2026-10-25: London falls back (BST -> GMT)
      const autumnPre = new Date('2026-10-25T00:30:00Z');
      const autumnPost = new Date('2026-10-25T02:30:00Z');
      expect(getZonedDateString('Europe/London', autumnPre)).toBe('2026-10-25');
      expect(getZonedDateString('Europe/London', autumnPost)).toBe('2026-10-25');
    });

    it('correctly calculates dates across midnight boundaries in different timezones', () => {
      const instant = new Date('2026-09-09T02:00:00Z');
      expect(getZonedDateString('UTC', instant)).toBe('2026-09-09');
      expect(getZonedDateString('America/New_York', instant)).toBe('2026-09-08'); // UTC-4 -> 22:00 previous day
      expect(getZonedDateString('Asia/Tokyo', instant)).toBe('2026-09-09'); // UTC+9 -> 11:00 same day
    });

    it('accurately calculates leap year differences and validates February 29', () => {
      // Leap year 2024
      expect(isValidDateString('2024-02-29')).toBe(true);
      expect(differenceInDays('2024-02-28', '2024-03-01')).toBe(2); // Includes Feb 29
      expect(addDays('2024-02-28', 1)).toBe('2024-02-29');

      // Non-leap year 2025
      expect(isValidDateString('2025-02-29')).toBe(false);
      expect(differenceInDays('2025-02-28', '2025-03-01')).toBe(1);
      expect(addDays('2025-02-28', 1)).toBe('2025-03-01');

      // Century leap year rules: 2000 is leap, 1900 is not
      expect(isValidDateString('2000-02-29')).toBe(true);
      expect(isValidDateString('1900-02-29')).toBe(false);
    });

    it('defers restriction retries with future nextRetryAt and selects eligible past dates', () => {
      const fixedNow = new Date('2026-09-10T12:00:00Z');

      const failedDates = [
        // 1. Future retry date (4 hours in future) -> must be DEFERRED
        { date: '2026-09-01', nextRetryAt: '2026-09-10T16:00:00Z' },
        // 2. Past retry date (2 hours in past) -> must be ELIGIBLE
        { date: '2026-09-02', nextRetryAt: '2026-09-10T10:00:00Z' },
        // 3. Corrupted nextRetryAt timestamp -> must FAIL CLOSED (excluded)
        { date: '2026-09-03', nextRetryAt: 'corrupted-timestamp' },
        // 4. Future work date -> must be EXCLUDED
        { date: '2026-09-15', nextRetryAt: null }
      ];

      const selection = selectStartupCatchupDates({
        archiveDates: ['2026-09-09'],
        failedDates,
        timezone: 'UTC',
        now: fixedNow
      });

      expect(selection.datesToSync).not.toContain('2026-09-01'); // Deferred
      expect(selection.datesToSync).toContain('2026-09-02');     // Eligible past retry
      expect(selection.datesToSync).not.toContain('2026-09-03'); // Corrupt timestamp
      expect(selection.datesToSync).not.toContain('2026-09-15'); // Future date
    });
  });
});
