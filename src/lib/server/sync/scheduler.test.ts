import { describe, expect, it } from 'vitest';
import { openTestDatabase } from '$lib/server/db/connection';
import { SqliteSyncRepository } from './repository';
import { SyncScheduler, SETTINGS_KEYS } from './scheduler';
import { SqliteWakaTimeOAuthConnectionRepository } from '$lib/server/db/repositories/wakatime-oauth';
import type { RunRequest, RunStatus, SyncService } from './contracts';

class MockCoordinator implements SyncService {
  public enqueuedRequests: RunRequest[] = [];
  public nextRunId = 100;

  async enqueue(input: RunRequest): Promise<{ runId: number; reused: boolean }> {
    this.enqueuedRequests.push(input);
    return { runId: ++this.nextRunId, reused: false };
  }

  async cancel(runId: number): Promise<RunStatus> {
    return 'cancelled';
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

function setupTestEnvironment(options?: {
  schedulingEnabled?: boolean;
  boundArchiveIdentity?: string | null;
  connectionGeneration?: number;
  accountUserId?: string;
  accountTimezone?: string;
  pinnedTimezone?: string;
  now?: () => Date;
}) {
  const db = openTestDatabase();
  const repo = new SqliteSyncRepository(db);
  const coordinator = new MockCoordinator();

  const schedulingEnabled = options?.schedulingEnabled ?? true;
  repo.updateSyncSettings({ schedulingEnabled });

  const timezone = options?.accountTimezone ?? options?.pinnedTimezone ?? 'Europe/London';
  const pinnedTz = options?.pinnedTimezone ?? timezone;

  // Setup OAuth connection
  const oauthRepo = new SqliteWakaTimeOAuthConnectionRepository(db);
  const nowIso = (options?.now ? options.now() : new Date()).toISOString();
  oauthRepo.upsert({
    accessTokenSealed: 'sealed-token',
    refreshTokenSealed: 'sealed-refresh',
    tokenType: 'Bearer',
    scopes: ['read_logged_time', 'read_summaries'],
    expiresAt: null,
    connectedAt: nowIso,
    updatedAt: nowIso,
    generation: options?.connectionGeneration ?? 1,
    boundArchiveIdentity: options?.boundArchiveIdentity ?? (options?.accountUserId ?? 'test-user-1')
  });

  // Setup account_settings
  const accountUserId = options?.accountUserId ?? 'test-user-1';
  db.prepare(`
    INSERT INTO account_settings (wakatime_user_id, timezone, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(wakatime_user_id) DO UPDATE SET
      timezone = excluded.timezone,
      updated_at = excluded.updated_at
  `).run(accountUserId, timezone, nowIso);

  const scheduler = new SyncScheduler({
    db,
    coordinator,
    repository: repo,
    pinnedTimezone: pinnedTz,
    now: options?.now
  });

  return { db, repo, coordinator, scheduler, oauthRepo };
}

describe('SyncScheduler', () => {
  describe('Cadence Intents', () => {
    it('enqueues hourly recent intent with today and yesterday in source timezone', async () => {
      // 2026-09-11 14:05 in London (BST, UTC+1)
      const fakeTime = new Date('2026-09-11T13:05:00.000Z');
      const { scheduler, coordinator } = setupTestEnvironment({
        now: () => fakeTime,
        pinnedTimezone: 'Europe/London'
      });

      // Mark seeded so first-enable seeding doesn't run
      scheduler['setAppSetting'](SETTINGS_KEYS.SEEDED, 'true');

      const result = await scheduler.tick(fakeTime);
      expect(result.ran).toBe(true);

      const recentIntent = result.enqueuedIntents.find((i) => i.intent === 'recent');
      expect(recentIntent).toBeDefined();
      expect(recentIntent?.dates).toEqual(['2026-09-10', '2026-09-11']);

      const req = coordinator.enqueuedRequests.find((r) => r.mode === 'recent');
      expect(req).toBeDefined();
      expect(req?.trigger).toBe('scheduled');
      expect(req?.rangeStartDate).toBe('2026-09-10');
      expect(req?.rangeEndDate).toBe('2026-09-11');
      expect(req?.idempotencyKey).toBe('scheduled-recent-2026-09-11T14:00');
    });

    it('enqueues daily 03:00 reconciliation intent with prior 14 completed dates', async () => {
      // 2026-09-11 03:15 London time (BST: UTC 02:15)
      const fakeTime = new Date('2026-09-11T02:15:00.000Z');
      const { scheduler, coordinator } = setupTestEnvironment({
        now: () => fakeTime,
        pinnedTimezone: 'Europe/London'
      });
      scheduler['setAppSetting'](SETTINGS_KEYS.SEEDED, 'true');

      const result = await scheduler.tick(fakeTime);
      expect(result.ran).toBe(true);

      const reconcileIntent = result.enqueuedIntents.find((i) => i.intent === 'reconcile');
      expect(reconcileIntent).toBeDefined();
      expect(reconcileIntent?.dates).toHaveLength(14);
      // Prior 14 completed dates before 2026-09-11: 2026-08-28 to 2026-09-10
      expect(reconcileIntent?.dates[0]).toBe('2026-08-28');
      expect(reconcileIntent?.dates[13]).toBe('2026-09-10');

      const req = coordinator.enqueuedRequests.find((r) => r.idempotencyKey.startsWith('scheduled-reconcile'));
      expect(req).toBeDefined();
      expect(req?.mode).toBe('backfill');
      expect(req?.trigger).toBe('scheduled');
      expect(req?.rangeStartDate).toBe('2026-08-28');
      expect(req?.rangeEndDate).toBe('2026-09-10');
    });

    it('enqueues Monday 04:00 comparison intent with prior 90 completed dates', async () => {
      // 2026-09-07 was a Monday. 04:30 BST -> UTC 03:30
      const fakeTime = new Date('2026-09-07T03:30:00.000Z');
      const { scheduler, coordinator } = setupTestEnvironment({
        now: () => fakeTime,
        pinnedTimezone: 'Europe/London'
      });
      scheduler['setAppSetting'](SETTINGS_KEYS.SEEDED, 'true');

      const result = await scheduler.tick(fakeTime);
      expect(result.ran).toBe(true);

      const compareIntent = result.enqueuedIntents.find((i) => i.intent === 'compare');
      expect(compareIntent).toBeDefined();
      expect(compareIntent?.dates).toHaveLength(90);
      expect(compareIntent?.dates[89]).toBe('2026-09-06'); // yesterday relative to 09-07

      const req = coordinator.enqueuedRequests.find((r) => r.mode === 'compare');
      expect(req).toBeDefined();
      expect(req?.trigger).toBe('scheduled');
      expect(req?.rangeEndDate).toBe('2026-09-06');
    });
  });

  describe('First Enable Seeding', () => {
    it('seeds seven days in policy window order when first enabled', async () => {
      const fakeTime = new Date('2026-09-11T12:00:00.000Z');
      const { scheduler, coordinator } = setupTestEnvironment({
        now: () => fakeTime,
        pinnedTimezone: 'Europe/London'
      });

      // Initially unseeded
      expect(scheduler.getScheduleState().seeded).toBe(false);

      const result = await scheduler.tick(fakeTime);
      expect(result.ran).toBe(true);

      const startupIntent = result.enqueuedIntents.find((i) => i.intent === 'startup');
      expect(startupIntent).toBeDefined();
      expect(startupIntent?.dates).toEqual([
        '2026-09-11',
        '2026-09-10',
        '2026-09-05',
        '2026-09-06',
        '2026-09-07',
        '2026-09-08',
        '2026-09-09'
      ]);

      expect(scheduler.getScheduleState().seeded).toBe(true);

      // Second tick does NOT seed again
      coordinator.enqueuedRequests = [];
      const result2 = await scheduler.tick(fakeTime);
      const startup2 = result2.enqueuedIntents.find((i) => i.intent === 'startup');
      expect(startup2).toBeUndefined();
    });
  });

  describe('Coalescing Missed Intervals', () => {
    it('coalesces multiple missed hourly intervals into single current run', async () => {
      let fakeTime = new Date('2026-09-11T10:00:00.000Z');
      const { scheduler, coordinator } = setupTestEnvironment({
        now: () => fakeTime,
        pinnedTimezone: 'Europe/London'
      });
      scheduler['setAppSetting'](SETTINGS_KEYS.SEEDED, 'true');
      scheduler['setAppSetting'](SETTINGS_KEYS.LAST_SLOT_RECONCILE, '2026-09-11');
      scheduler['setAppSetting'](SETTINGS_KEYS.LAST_SLOT_COMPARE, 'WEEK_2026-09-07');

      // Tick at 10:00 UTC (11:00 BST)
      await scheduler.tick(fakeTime);
      expect(coordinator.enqueuedRequests).toHaveLength(1);
      expect(coordinator.enqueuedRequests[0].idempotencyKey).toBe('scheduled-recent-2026-09-11T11:00');

      coordinator.enqueuedRequests = [];

      // Server is down for 5 hours. Wakes up at 15:30 UTC (16:30 BST)
      fakeTime = new Date('2026-09-11T15:30:00.000Z');
      const result = await scheduler.tick(fakeTime);
      expect(result.ran).toBe(true);

      // Only ONE recent run enqueued for the 16:00 slot, NOT 5 separate runs
      const recentRuns = coordinator.enqueuedRequests.filter((r) => r.mode === 'recent');
      expect(recentRuns).toHaveLength(1);
      expect(recentRuns[0].idempotencyKey).toBe('scheduled-recent-2026-09-11T16:00');

      expect(scheduler.getScheduleState().lastHandledSlots.recent).toBe('2026-09-11T16:00');
    });
  });

  describe('31-Date Cursor & Bounded Catch-Up', () => {
    it('bounds catch-up to 31 dates and persists durable cursor for continuation', async () => {
      // 2026-09-11. Archive has dates only up to 2026-07-01 (71 days of backlog)
      const fakeTime = new Date('2026-09-11T12:00:00.000Z');
      const { scheduler, db } = setupTestEnvironment({
        now: () => fakeTime,
        pinnedTimezone: 'UTC'
      });
      scheduler['setAppSetting'](SETTINGS_KEYS.SEEDED, 'true');

      // Populate older archive date in daily_totals
      db.prepare(`
        INSERT INTO source_imports (id, source_type, source_hash, byte_size, status)
        VALUES (1, 'daily_dump', 'dump-hash-1', 100, 'completed')
      `).run();

      db.prepare(`
        INSERT INTO daily_totals (date, timezone, total_seconds, grand_total_json, source_import_id, source_hash)
        VALUES ('2026-07-01', 'UTC', 3600, '{}', 1, 'dump-hash-1')
      `).run();

      const batch1 = await scheduler.runStartupCatchup(fakeTime);
      expect(batch1).not.toBeNull();
      expect(batch1?.dates).toHaveLength(31);

      // Priority ordering: today, yesterday, 7-day policy window gaps, then older
      expect(batch1?.dates[0]).toBe('2026-09-11');
      expect(batch1?.dates[1]).toBe('2026-09-10');
      expect(batch1?.dates[2]).toBe('2026-09-05');

      // Cursor persisted
      const cursor1 = scheduler.getScheduleState().catchupCursor;
      expect(cursor1).not.toBeNull();

      // Second batch continues from cursor
      const batch2 = await scheduler.runStartupCatchup(fakeTime);
      expect(batch2).not.toBeNull();
      expect(batch2?.dates).toHaveLength(31);
      // Older gap continuation includes cursor
      expect(batch2?.dates).toContain(cursor1);
    });
  });

  describe('Disabled Scheduling', () => {
    it('does not execute any scheduled runs or catch-up runs when scheduling is disabled', async () => {
      const fakeTime = new Date('2026-09-11T12:00:00.000Z');
      const { scheduler, coordinator } = setupTestEnvironment({
        schedulingEnabled: false,
        now: () => fakeTime
      });

      const result = await scheduler.tick(fakeTime);
      expect(result.ran).toBe(false);
      expect(result.pauseReason).toBe('disabled');
      expect(coordinator.enqueuedRequests).toHaveLength(0);

      const catchup = await scheduler.runStartupCatchup(fakeTime);
      expect(catchup).toBeNull();
      expect(coordinator.enqueuedRequests).toHaveLength(0);
    });
  });

  describe('Retry Waits & Restricted History', () => {
    it('defers failed dates with future next_retry_at and syncs due dates', async () => {
      const fakeTime = new Date('2026-09-11T12:00:00.000Z');
      const { scheduler, db } = setupTestEnvironment({
        now: () => fakeTime,
        pinnedTimezone: 'UTC'
      });
      scheduler['setAppSetting'](SETTINGS_KEYS.SEEDED, 'true');

      // Insert two dates in sync_layer_state:
      // 1. Future retry (14:00 UTC, 2h in future) -> DEFERRED
      // 2. Due retry (10:00 UTC, 2h in past) -> ELIGIBLE
      db.prepare(`
        INSERT INTO sync_layer_state (date, layer, status_code, next_retry_at, has_restriction)
        VALUES
          ('2026-08-10', 'summaries', 'HTTP_429', '2026-09-11T14:00:00.000Z', 1),
          ('2026-08-11', 'summaries', 'HTTP_429', '2026-09-11T10:00:00.000Z', 1)
      `).run();

      const batch = await scheduler.runStartupCatchup(fakeTime);
      expect(batch).not.toBeNull();

      expect(batch?.dates).toContain('2026-08-11'); // due
      expect(batch?.dates).not.toContain('2026-08-10'); // deferred
    });
  });

  describe('Startup Ordering with Dump Dates', () => {
    it('respects accepted dump dates in daily_totals and prioritizes gaps correctly', async () => {
      const fakeTime = new Date('2026-09-11T12:00:00.000Z');
      const { scheduler, db } = setupTestEnvironment({
        now: () => fakeTime,
        pinnedTimezone: 'UTC'
      });
      scheduler['setAppSetting'](SETTINGS_KEYS.SEEDED, 'true');

      // Accepted dump dates in daily_totals
      db.prepare(`
        INSERT INTO source_imports (id, source_type, source_hash, byte_size, status)
        VALUES (1, 'daily_dump', 'dump-hash-1', 100, 'completed')
      `).run();

      db.prepare(`
        INSERT INTO daily_totals (date, timezone, total_seconds, grand_total_json, source_import_id, source_hash)
        VALUES
          ('2026-09-01', 'UTC', 7200, '{}', 1, 'dump-hash-1'),
          ('2026-09-02', 'UTC', 3600, '{}', 1, 'dump-hash-1'),
          ('2026-09-04', 'UTC', 1800, '{}', 1, 'dump-hash-1')
      `).run();
      // Notice: 2026-09-03 is missing between 09-02 and 09-04!

      const batch = await scheduler.runStartupCatchup(fakeTime);
      expect(batch).not.toBeNull();

      // Today (09-11) and yesterday (09-10) are first
      expect(batch?.dates[0]).toBe('2026-09-11');
      expect(batch?.dates[1]).toBe('2026-09-10');

      // Missing gap 2026-09-03 must be detected and selected
      expect(batch?.dates).toContain('2026-09-03');

      // Accepted dump dates (09-01, 09-02) already present and not failing should not be re-selected
      expect(batch?.dates).not.toContain('2026-09-01');
      expect(batch?.dates).not.toContain('2026-09-02');
    });
  });

  describe('Timezone & Generation Pause', () => {
    it('pauses scheduling when connection is replaced without rebound', async () => {
      const fakeTime = new Date('2026-09-11T12:00:00.000Z');
      const { scheduler, db } = setupTestEnvironment({
        now: () => fakeTime,
        accountUserId: 'user-waka-999',
        boundArchiveIdentity: 'user-waka-999'
      });

      // Initially active
      expect(scheduler.checkPauseStatus().paused).toBe(false);

      // Reconnect: sets bound_archive_identity to null and bumps generation to 2
      db.prepare(`
        UPDATE wakatime_oauth_connection
        SET bound_archive_identity = NULL, generation = 2
        WHERE id = 1
      `).run();

      const pause = scheduler.checkPauseStatus();
      expect(pause.paused).toBe(true);
      expect(pause.reason).toBe('connection_replaced');

      const tickResult = await scheduler.tick(fakeTime);
      expect(tickResult.ran).toBe(false);
      expect(tickResult.pauseReason).toBe('connection_replaced');
    });

    it('pauses scheduling when source timezone mismatch is detected', async () => {
      const fakeTime = new Date('2026-09-11T12:00:00.000Z');
      const { scheduler, db } = setupTestEnvironment({
        now: () => fakeTime,
        pinnedTimezone: 'Europe/London',
        accountTimezone: 'Europe/London'
      });

      expect(scheduler.checkPauseStatus().paused).toBe(false);

      // Record a TIMEZONE_MISMATCH code in sync_layer_state
      db.prepare(`
        INSERT INTO sync_layer_state (date, layer, status_code, updated_at)
        VALUES ('2026-09-10', 'summaries', 'TIMEZONE_MISMATCH', '2026-09-11T12:00:00.000Z')
      `).run();

      const pause = scheduler.checkPauseStatus();
      expect(pause.paused).toBe(true);
      expect(pause.reason).toBe('timezone_mismatch');

      const tickResult = await scheduler.tick(fakeTime);
      expect(tickResult.ran).toBe(false);
      expect(tickResult.pauseReason).toBe('timezone_mismatch');
    });
  });

  describe('DST / Leap / Year Boundaries', () => {
    it('handles UK spring-forward 23h DST transition without hour/date key skew', async () => {
      // UK spring forward 2026 is Sunday March 29 at 01:00 UTC -> 02:00 BST
      // Let's test at 02:30 UTC (03:30 BST)
      const springForwardTime = new Date('2026-03-29T02:30:00.000Z');
      const { scheduler } = setupTestEnvironment({
        now: () => springForwardTime,
        pinnedTimezone: 'Europe/London'
      });
      scheduler['setAppSetting'](SETTINGS_KEYS.SEEDED, 'true');

      const result = await scheduler.tick(springForwardTime);
      expect(result.ran).toBe(true);

      const state = scheduler.getScheduleState();
      // Date in London on 03-29 is 2026-03-29
      expect(state.lastHandledSlots.recent).toBe('2026-03-29T03:00');
    });

    it('handles UK fall-back 25h DST transition without hour/date key skew', async () => {
      // UK fall back 2026 is Sunday October 25 at 02:00 BST -> 01:00 GMT
      const fallBackTime = new Date('2026-10-25T01:30:00.000Z');
      const { scheduler } = setupTestEnvironment({
        now: () => fallBackTime,
        pinnedTimezone: 'Europe/London'
      });
      scheduler['setAppSetting'](SETTINGS_KEYS.SEEDED, 'true');

      const result = await scheduler.tick(fallBackTime);
      expect(result.ran).toBe(true);

      const state = scheduler.getScheduleState();
      expect(state.lastHandledSlots.recent).toBe('2026-10-25T01:00');
    });

    it('handles leap day boundary arithmetic (2024-02-28 -> 2024-02-29 -> 2024-03-01)', async () => {
      const leapDay = new Date('2024-02-29T12:00:00.000Z');
      const { scheduler } = setupTestEnvironment({
        now: () => leapDay,
        pinnedTimezone: 'UTC'
      });
      scheduler['setAppSetting'](SETTINGS_KEYS.SEEDED, 'true');

      const result = await scheduler.tick(leapDay);
      expect(result.ran).toBe(true);

      const recent = result.enqueuedIntents.find((i) => i.intent === 'recent');
      expect(recent?.dates).toEqual(['2024-02-28', '2024-02-29']);
    });

    it('handles year rollover boundary (2025-12-31 to 2026-01-01)', async () => {
      const newYear = new Date('2026-01-01T00:15:00.000Z');
      const { scheduler } = setupTestEnvironment({
        now: () => newYear,
        pinnedTimezone: 'UTC'
      });
      scheduler['setAppSetting'](SETTINGS_KEYS.SEEDED, 'true');

      const result = await scheduler.tick(newYear);
      expect(result.ran).toBe(true);

      const recent = result.enqueuedIntents.find((i) => i.intent === 'recent');
      expect(recent?.dates).toEqual(['2025-12-31', '2026-01-01']);
    });
  });

  describe('Coordinator Review P7 Corrections', () => {
    it('effective timezone never invents a fallback when unknown and pauses scheduling', () => {
      const db = openTestDatabase();
      const repo = new SqliteSyncRepository(db);
      const coordinator = new MockCoordinator();
      repo.updateSyncSettings({ schedulingEnabled: true });

      // Create scheduler without pinned timezone and without account_settings timezone
      const scheduler = new SyncScheduler({ db, coordinator, repository: repo });
      expect(scheduler.getEffectiveTimezone()).toBeNull();

      const pause = scheduler.checkPauseStatus();
      expect(pause.paused).toBe(true);
      expect(pause.reason).toBe('timezone_mismatch');
    });

    it('evaluates missing, retryable, unfinished, and dump-accepted dates on startup even when already seeded', async () => {
      const fakeNow = new Date('2026-09-10T12:00:00.000Z');
      const { scheduler, db, coordinator } = setupTestEnvironment({
        now: () => fakeNow,
        pinnedTimezone: 'Europe/London'
      });

      // Mark already seeded, no cursor
      scheduler['setAppSetting'](SETTINGS_KEYS.SEEDED, 'true');
      scheduler['deleteAppSetting'](SETTINGS_KEYS.CATCHUP_CURSOR);

      // 1. Insert dump import parent & dump date in daily_totals
      db.prepare(`
        INSERT INTO source_imports (id, source_type, source_hash, byte_size, started_at, status, dry_run, day_count, record_count, duplicate_count, conflict_count)
        VALUES (10, 'daily_dump', 'hash-dump-1', 1024, '2026-09-01T00:00:00Z', 'completed', 0, 1, 1, 0, 0)
      `).run();
      db.prepare(`
        INSERT INTO daily_totals (date, timezone, total_seconds, project_sum_seconds, project_sum_delta, grand_total_json, source_import_id, source_hash)
        VALUES ('2026-08-15', 'Europe/London', 3600, 3600, 0, '{}', 10, 'hash-dump-1')
      `).run();

      // 2. Insert unfinished date in sync_days
      db.prepare(`
        INSERT INTO sync_runs (id, started_at, status, trigger, mode)
        VALUES (50, '2026-09-09T00:00:00Z', 'interrupted', 'scheduled', 'recent')
      `).run();
      db.prepare(`
        INSERT INTO sync_days (sync_run_id, date, status, synced_at)
        VALUES (50, '2026-08-20', 'interrupted', '2026-09-09T00:00:00Z')
      `).run();

      // 3. Insert retryable failed date in sync_layer_state with past next_retry_at
      db.prepare(`
        INSERT INTO sync_layer_state (date, layer, has_failure, next_retry_at, updated_at)
        VALUES ('2026-08-25', 'summaries', 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
      `).run();

      const catchup = await scheduler.runStartupCatchup(fakeNow);
      expect(catchup).toBeDefined();
      expect(catchup?.dates).toContain('2026-08-20'); // unfinished date
      expect(catchup?.dates).toContain('2026-08-25'); // retryable date

      // Clean up and test cursor persistence
    });

    it('persists continuation cursor only after durable enqueue succeeds', async () => {
      const fakeNow = new Date('2026-09-10T12:00:00.000Z');
      const { scheduler, db, coordinator } = setupTestEnvironment({
        now: () => fakeNow,
        pinnedTimezone: 'Europe/London'
      });

      scheduler['setAppSetting'](SETTINGS_KEYS.SEEDED, 'true');
      scheduler['deleteAppSetting'](SETTINGS_KEYS.CATCHUP_CURSOR);

      // Create >31 missing dates by setting earliest watermark far in past
      db.prepare(`
        INSERT INTO source_imports (id, source_type, source_hash, byte_size, started_at, status, dry_run, day_count, record_count, duplicate_count, conflict_count)
        VALUES (11, 'daily_dump', 'hash-dump-2', 1024, '2026-06-01T00:00:00Z', 'completed', 0, 1, 1, 0, 0)
      `).run();
      db.prepare(`
        INSERT INTO daily_totals (date, timezone, total_seconds, project_sum_seconds, project_sum_delta, grand_total_json, source_import_id, source_hash)
        VALUES ('2026-06-01', 'Europe/London', 3600, 3600, 0, '{}', 11, 'hash-dump-2')
      `).run();

      // Case A: Coordinator enqueue fails
      const originalEnqueue = coordinator.enqueue.bind(coordinator);
      coordinator.enqueue = async () => {
        throw new Error('Upstream network failure or disk error');
      };

      const failResult = await scheduler.runStartupCatchup(fakeNow);
      expect(failResult).toBeNull();
      // Cursor MUST NOT have been updated!
      expect(scheduler.getScheduleState().catchupCursor).toBeNull();

      // Case B: Coordinator enqueue succeeds
      coordinator.enqueue = originalEnqueue;
      const successResult = await scheduler.runStartupCatchup(fakeNow);
      expect(successResult).toBeDefined();
      expect(successResult?.dates.length).toBe(31);
      // Cursor MUST NOW be set!
      expect(scheduler.getScheduleState().catchupCursor).not.toBeNull();
    });
  });
});
