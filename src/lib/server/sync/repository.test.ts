import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDatabase } from '$lib/server/db/connection.js';
import {
  SqliteSyncRepository,
  type SyncRepository
} from './repository.js';
import type { RunRequest } from './contracts.js';

describe('SyncRepository Interface Integration', () => {
  let db: Database.Database;
  let syncRepo: SyncRepository;

  beforeEach(() => {
    db = openTestDatabase();
    syncRepo = new SqliteSyncRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('tracks durable progress counters across date dispositions and statuses', () => {
    const req: RunRequest = {
      mode: 'recent',
      trigger: 'manual',
      idempotencyKey: 'prog_key',
      rangeStartDate: '2026-01-01',
      rangeEndDate: '2026-01-04'
    };

    const { runId } = syncRepo.enqueueRun(req, [
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04'
    ]);

    let progress = syncRepo.getRunProgress(runId);
    expect(progress.total).toBe(4);
    expect(progress.pending).toBe(4);
    expect(progress.completed).toBe(0);

    // Update dates with different statuses and dispositions
    syncRepo.updateSyncDay(runId, '2026-01-01', {
      status: 'succeeded',
      disposition: 'updated',
      totalSeconds: 3600
    });
    syncRepo.updateSyncDay(runId, '2026-01-02', {
      status: 'succeeded',
      disposition: 'unchanged',
      totalSeconds: 1800
    });
    syncRepo.updateSyncDay(runId, '2026-01-03', {
      status: 'partial',
      disposition: 'preserved',
      totalSeconds: 900
    });
    syncRepo.updateSyncDay(runId, '2026-01-04', {
      status: 'failed',
      disposition: 'rejected',
      errorMessage: 'Network timeout'
    });

    progress = syncRepo.getRunProgress(runId);
    expect(progress.total).toBe(4);
    expect(progress.pending).toBe(0);
    expect(progress.succeeded).toBe(2);
    expect(progress.partial).toBe(1);
    expect(progress.failed).toBe(1);
    expect(progress.completed).toBe(4);
    expect(progress.dispositions).toEqual({
      updated: 1,
      unchanged: 1,
      preserved: 1,
      rejected: 1
    });
  });

  it('reads and updates sync settings including scheduling and archive identity binding', () => {
    const initialSettings = syncRepo.getSyncSettings();
    expect(initialSettings.schedulingEnabled).toBe(false);
    expect(initialSettings.connectionGeneration).toBe(1);
    expect(initialSettings.boundArchiveIdentity).toBeNull();

    // Enable scheduling
    syncRepo.updateSyncSettings({ schedulingEnabled: true });
    expect(syncRepo.getSyncSettings().schedulingEnabled).toBe(true);

    // Disable scheduling
    syncRepo.updateSyncSettings({ schedulingEnabled: false });
    expect(syncRepo.getSyncSettings().schedulingEnabled).toBe(false);
  });

  it('completes a run with advisory codes, summary, and error message', () => {
    const req: RunRequest = {
      mode: 'recent',
      trigger: 'manual',
      idempotencyKey: 'complete_key',
      rangeStartDate: '2026-01-01',
      rangeEndDate: '2026-01-01'
    };

    const { runId } = syncRepo.enqueueRun(req, ['2026-01-01']);
    syncRepo.claimNextRun();

    syncRepo.updateSyncDay(runId, '2026-01-01', {
      status: 'succeeded',
      disposition: 'updated',
      advisoryCodes: ['CURRENT_DAY_PROVISIONAL']
    });

    const completed = syncRepo.completeRun(runId, {
      status: 'succeeded',
      advisoryCodes: ['CURRENT_DAY_PROVISIONAL'],
      summary: 'Successfully synced 1 date'
    });

    expect(completed.status).toBe('succeeded');
    expect(completed.advisoryCodes).toEqual(['CURRENT_DAY_PROVISIONAL']);
    expect(completed.summary).toBe('Successfully synced 1 date');
    expect(completed.finishedAt).not.toBeNull();
  });
});
