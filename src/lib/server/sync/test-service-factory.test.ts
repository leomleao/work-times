import { describe, it, expect } from 'vitest';
import { createTestSyncService } from './test-service-factory.js';
import type { SyncDayWorkerResult } from './worker.js';

describe('TestServiceFactory', () => {
  it('creates an isolated test sync service and runs a mock backfill run to completion', async () => {
    const fixedNow = new Date('2026-09-10T12:00:00.000Z');

    const mockWorker = async (options: { date: string }): Promise<SyncDayWorkerResult> => {
      return {
        date: options.date,
        status: 'succeeded',
        disposition: 'updated',
        advisoryCodes: [],
        candidate: {
          date: options.date,
          timezone: 'Europe/London',
          connectionGeneration: 1,
          summaries: {
            kind: 'complete',
            value: {} as never,
            contentHash: 'hash1',
            observedAt: fixedNow.toISOString()
          },
          heartbeats: { kind: 'skipped', reason: 'mock' }
        },
        summariesStatus: 'succeeded',
        heartbeatsStatus: 'skipped',
        durationsStatus: 'skipped'
      };
    };

    const ctx = await createTestSyncService({
      now: () => fixedNow,
      executeDayWorker: mockWorker
    });

    try {
      const { runId, reused, run } = await ctx.enqueueAndDrain({
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'test-factory-run-1',
        rangeStartDate: '2026-09-01',
        rangeEndDate: '2026-09-02'
      });

      expect(reused).toBe(false);
      expect(run.status).toBe('succeeded');
      expect(run.daysSynced).toBe(2);
      expect(run.daysFailed).toBe(0);

      const days = ctx.getSyncDays(runId);
      expect(days.length).toBe(2);
      expect(days[0].status).toBe('succeeded');
      expect(days[1].status).toBe('succeeded');

      const progress = ctx.getRunProgress(runId);
      expect(progress.total).toBe(2);
      expect(progress.succeeded).toBe(2);
      expect(progress.completed).toBe(2);
    } finally {
      await ctx.close();
    }
  });

  it('supports disabled scheduling configuration and manual queue survival', async () => {
    const fixedNow = new Date('2026-09-10T12:00:00.000Z');

    const ctx = await createTestSyncService({
      now: () => fixedNow,
      schedulingEnabled: false,
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
      // Manual run must execute even when scheduling is disabled
      const { run } = await ctx.enqueueAndDrain({
        mode: 'recent',
        trigger: 'manual',
        idempotencyKey: 'manual-disabled-sched-1'
      });

      expect(run.status).toBe('succeeded');
    } finally {
      await ctx.close();
    }
  });

  it('correctly initializes connectionGeneration and boundArchiveIdentity in sync settings', async () => {
    const fixedNow = new Date('2026-09-10T12:00:00.000Z');

    const ctx = await createTestSyncService({
      now: () => fixedNow,
      schedulingEnabled: true,
      connectionGeneration: 3,
      boundArchiveIdentity: 'user-waka-archive-99'
    });

    try {
      const settings = ctx.repository.getSyncSettings();
      expect(settings.schedulingEnabled).toBe(true);
      expect(settings.connectionGeneration).toBe(3);
      expect(settings.boundArchiveIdentity).toBe('user-waka-archive-99');
    } finally {
      await ctx.close();
    }
  });
});
