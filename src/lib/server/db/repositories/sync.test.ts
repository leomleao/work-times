import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDatabase } from '../connection.js';
import {
  IdempotencyConflictError,
  QueueFullError,
  SqliteSyncRepository
} from './sync.js';
import type { RunRequest } from '$lib/server/sync/contracts.js';

describe('SqliteSyncRepository', () => {
  let db: Database.Database;
  let repo: SqliteSyncRepository;

  beforeEach(() => {
    db = openTestDatabase();
    repo = new SqliteSyncRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('Queue bounds and claim concurrency', () => {
    it('enforces maximum 10 queued nonterminal runs and throws QueueFullError on queue full', () => {
      // Enqueue 10 nonterminal runs (the maximum permitted)
      for (let i = 1; i <= 10; i++) {
        const req: RunRequest = {
          mode: 'recent',
          trigger: 'scheduled',
          idempotencyKey: `key_${i}`,
          rangeStartDate: '2026-01-01',
          rangeEndDate: '2026-01-01'
        };
        const result = repo.enqueueRun(req, ['2026-01-01']);
        expect(result.runId).toBe(i);
        expect(result.reused).toBe(false);
      }

      // 11th run must be rejected with QueueFullError (trigger trg_sync_runs_queue_limit_insert)
      const req11: RunRequest = {
        mode: 'recent',
        trigger: 'manual',
        idempotencyKey: 'key_11',
        rangeStartDate: '2026-01-01',
        rangeEndDate: '2026-01-01'
      };
      expect(() => repo.enqueueRun(req11, ['2026-01-01'])).toThrow(QueueFullError);
    });

    it('enforces strictly one running claim via database constraint and prioritizes manual runs', () => {
      const scheduledReq: RunRequest = {
        mode: 'recent',
        trigger: 'scheduled',
        idempotencyKey: 'sched_1',
        rangeStartDate: '2026-01-01',
        rangeEndDate: '2026-01-01'
      };
      const manualReq: RunRequest = {
        mode: 'recent',
        trigger: 'manual',
        idempotencyKey: 'man_1',
        rangeStartDate: '2026-01-01',
        rangeEndDate: '2026-01-01'
      };

      const r1 = repo.enqueueRun(scheduledReq, ['2026-01-01']);
      const r2 = repo.enqueueRun(manualReq, ['2026-01-01']);

      // First claim: manual run must be prioritized over older scheduled run
      const claimed = repo.claimNextRun('2026-01-01T12:00:00.000Z');
      expect(claimed).not.toBeNull();
      expect(claimed?.id).toBe(r2.runId);
      expect(claimed?.trigger).toBe('manual');
      expect(claimed?.status).toBe('running');

      // Second claim while first is running returns null (strictly one running claim)
      const secondClaim = repo.claimNextRun();
      expect(secondClaim).toBeNull();

      // Attempting to set another run to running directly in SQLite violates unique index
      expect(() =>
        db
          .prepare("UPDATE sync_runs SET status = 'running' WHERE id = ?")
          .run(r1.runId)
      ).toThrow(/UNIQUE constraint failed/);

      // Completing active run allows next run to be claimed
      repo.completeRun(r2.runId, { status: 'succeeded' });
      const nextClaim = repo.claimNextRun('2026-01-01T12:05:00.000Z');
      expect(nextClaim).not.toBeNull();
      expect(nextClaim?.id).toBe(r1.runId);
      expect(nextClaim?.trigger).toBe('scheduled');
    });
  });

  describe('Idempotency handling', () => {
    it('returns existing run when replaying with same key and same payload', () => {
      const req: RunRequest = {
        mode: 'recent',
        trigger: 'manual',
        idempotencyKey: 'idemp_key_1',
        rangeStartDate: '2026-01-01',
        rangeEndDate: '2026-01-02'
      };

      const first = repo.enqueueRun(req, ['2026-01-01', '2026-01-02']);
      expect(first.reused).toBe(false);

      const replay = repo.enqueueRun(req, ['2026-01-01', '2026-01-02']);
      expect(replay.reused).toBe(true);
      expect(replay.runId).toBe(first.runId);
    });

    it('rejects replay with same key and conflicting payload with IdempotencyConflictError', () => {
      const req1: RunRequest = {
        mode: 'recent',
        trigger: 'manual',
        idempotencyKey: 'idemp_key_conflict',
        rangeStartDate: '2026-01-01',
        rangeEndDate: '2026-01-02'
      };
      repo.enqueueRun(req1, ['2026-01-01', '2026-01-02']);

      const req2Conflicting: RunRequest = {
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'idemp_key_conflict',
        rangeStartDate: '2026-01-01',
        rangeEndDate: '2026-01-10'
      };

      expect(() => repo.enqueueRun(req2Conflicting, ['2026-01-01'])).toThrow(
        IdempotencyConflictError
      );
    });
  });

  describe('Cancellation and Recovery', () => {
    it('cancels queued run immediately and marks pending dates cancelled', () => {
      const req: RunRequest = {
        mode: 'recent',
        trigger: 'manual',
        idempotencyKey: 'cancel_queued_key',
        rangeStartDate: '2026-01-01',
        rangeEndDate: '2026-01-02'
      };

      const { runId } = repo.enqueueRun(req, ['2026-01-01', '2026-01-02']);
      const cancelResult = repo.cancelRun(runId, '2026-01-01T10:00:00.000Z');

      expect(cancelResult.cancelledNow).toBe(true);
      expect(cancelResult.run.status).toBe('cancelled');
      expect(cancelResult.run.finishedAt).toBe('2026-01-01T10:00:00.000Z');

      const days = repo.getSyncDaysForRun(runId);
      expect(days).toHaveLength(2);
      expect(days[0].status).toBe('cancelled');
      expect(days[1].status).toBe('cancelled');

      // Subsequent cancel is idempotent
      const secondCancel = repo.cancelRun(runId);
      expect(secondCancel.cancelledNow).toBe(false);
      expect(secondCancel.run.status).toBe('cancelled');
    });

    it('persists cancel_requested_at when cancelling an active running run', () => {
      const req: RunRequest = {
        mode: 'recent',
        trigger: 'manual',
        idempotencyKey: 'cancel_running_key',
        rangeStartDate: '2026-01-01',
        rangeEndDate: '2026-01-01'
      };

      const { runId } = repo.enqueueRun(req, ['2026-01-01']);
      repo.claimNextRun();

      expect(repo.isRunCancelRequested(runId)).toBe(false);

      const cancelResult = repo.cancelRun(runId, '2026-01-01T11:00:00.000Z');
      expect(cancelResult.cancelledNow).toBe(false);
      expect(cancelResult.run.status).toBe('running');
      expect(cancelResult.run.cancelRequestedAt).toBe('2026-01-01T11:00:00.000Z');
      expect(repo.isRunCancelRequested(runId)).toBe(true);
    });

    it('marks running runs and pending/running dates as interrupted upon recovery', () => {
      const req: RunRequest = {
        mode: 'recent',
        trigger: 'scheduled',
        idempotencyKey: 'recov_key',
        rangeStartDate: '2026-01-01',
        rangeEndDate: '2026-01-02'
      };

      const { runId } = repo.enqueueRun(req, ['2026-01-01', '2026-01-02']);
      repo.claimNextRun();
      repo.updateSyncDay(runId, '2026-01-01', { status: 'running' });

      const recovery = repo.recoverInterruptedRuns('2026-01-01T15:00:00.000Z');
      expect(recovery.interruptedRunIds).toEqual([runId]);
      expect(recovery.interruptedDateCount).toBe(2);

      const run = repo.getRun(runId);
      expect(run?.status).toBe('interrupted');
      expect(run?.finishedAt).toBe('2026-01-01T15:00:00.000Z');

      const days = repo.getSyncDaysForRun(runId);
      expect(days[0].status).toBe('interrupted');
      expect(days[1].status).toBe('interrupted');
    });

    it('recovers interrupted running runs while leaving queued-run dates pending (regression)', () => {
      // 1. Run 1 is claimed and running
      const req1: RunRequest = {
        mode: 'recent',
        trigger: 'scheduled',
        idempotencyKey: 'recov_running_key',
        rangeStartDate: '2026-01-01',
        rangeEndDate: '2026-01-02'
      };
      const { runId: runningRunId } = repo.enqueueRun(req1, ['2026-01-01', '2026-01-02']);
      repo.claimNextRun();
      repo.updateSyncDay(runningRunId, '2026-01-01', { status: 'running' });

      // 2. Run 2 is queued (not claimed) with pending dates
      const req2: RunRequest = {
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'recov_queued_key',
        rangeStartDate: '2026-01-03',
        rangeEndDate: '2026-01-04'
      };
      const { runId: queuedRunId } = repo.enqueueRun(req2, ['2026-01-03', '2026-01-04']);

      // 3. Server recovery executes
      const recovery = repo.recoverInterruptedRuns('2026-01-01T16:00:00.000Z');
      expect(recovery.interruptedRunIds).toEqual([runningRunId]);
      expect(recovery.interruptedDateCount).toBe(2);

      // Running run is marked interrupted
      expect(repo.getRun(runningRunId)?.status).toBe('interrupted');
      const runningDays = repo.getSyncDaysForRun(runningRunId);
      expect(runningDays.every((d) => d.status === 'interrupted')).toBe(true);

      // Queued run remains queued and its dates remain pending!
      expect(repo.getRun(queuedRunId)?.status).toBe('queued');
      const queuedDays = repo.getSyncDaysForRun(queuedRunId);
      expect(queuedDays).toHaveLength(2);
      expect(queuedDays[0].status).toBe('pending');
      expect(queuedDays[1].status).toBe('pending');
    });
  });

  describe('Reconciliation Overlay: Allocations Detach, Reattach, and Triggers', () => {
    beforeEach(() => {
      db.prepare(
        `INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (1, 'daily_dump', 'hash1', 100)`
      ).run();
      db.prepare(
        `INSERT INTO projects (id, name) VALUES (10, 'project-a')`
      ).run();
      db.prepare(
        `INSERT INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, is_unattributed, source_import_id)
         VALUES (1, '2026-01-01', 10, 'src/main.ts', 'file', 1200.0, 0, 1)`
      ).run();
    });

    it('enforces duration match trigger on active allocations and rejects mismatches', () => {
      const insertAllocation = db.prepare(`
        INSERT INTO daily_time_allocations (id, date, project_id, entity, classification, allocated_seconds, state)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      // Valid allocation matching slice total_seconds (1200.0)
      expect(() =>
        insertAllocation.run('alloc_ok', '2026-01-01', 10, 'src/main.ts', 'work', 1200.0, 'active')
      ).not.toThrow();

      // Mismatched duration triggers abort
      expect(() =>
        insertAllocation.run('alloc_bad', '2026-01-01', 10, 'src/main.ts', 'work', 1199.0, 'active')
      ).toThrow(/allocated_seconds does not match authoritative slice total_seconds/);
    });

    it('preserves allocations when underlying slices are deleted and records append-only revision on detachment', () => {
      db.prepare(`
        INSERT INTO daily_time_allocations (id, date, project_id, entity, classification, allocated_seconds, state)
        VALUES ('alloc_1', '2026-01-01', 10, 'src/main.ts', 'work', 1200.0, 'active')
      `).run();

      // Detach allocation when slice vanishes
      repo.detachAllocation('alloc_1', '2026-01-01T12:00:00.000Z');

      const allocs = repo.getAllocationsForDate('2026-01-01');
      expect(allocs).toHaveLength(1);
      expect(allocs[0].state).toBe('detached');
      expect(allocs[0].detachedAt).toBe('2026-01-01T12:00:00.000Z');
      expect(allocs[0].allocatedSeconds).toBe(1200.0);

      // Audit revision recorded
      const rev = db
        .prepare('SELECT * FROM classification_revisions WHERE target_id = ?')
        .get('alloc_1') as Record<string, unknown>;
      expect(rev.mutation_type).toBe('allocation_detached');
      expect(rev.actor).toBe('system');

      // Now deleting the slice does NOT cascade delete the allocation!
      db.prepare('DELETE FROM day_project_entity_slices WHERE id = 1').run();
      const surviving = repo.getAllocationsForDate('2026-01-01');
      expect(surviving).toHaveLength(1);
      expect(surviving[0].id).toBe('alloc_1');
      expect(surviving[0].state).toBe('detached');
    });

    it('adjusts duration and reattaches allocation when slice reappears', () => {
      db.prepare(`
        INSERT INTO daily_time_allocations (id, date, project_id, entity, classification, allocated_seconds, state)
        VALUES ('alloc_2', '2026-01-01', 10, 'src/main.ts', 'work', 1200.0, 'active')
      `).run();

      // Slice duration changed in reconciliation: update allocation duration
      db.prepare('UPDATE day_project_entity_slices SET total_seconds = 1500.0 WHERE id = 1').run();
      repo.adjustAllocationDuration('alloc_2', 1500.0, '2026-01-01T13:00:00.000Z');

      let alloc = repo.getAllocationsForDate('2026-01-01')[0];
      expect(alloc.allocatedSeconds).toBe(1500.0);

      // Detach
      repo.detachAllocation('alloc_2', '2026-01-01T13:30:00.000Z');
      alloc = repo.getAllocationsForDate('2026-01-01')[0];
      expect(alloc.state).toBe('detached');

      // Reattach to slice
      repo.reattachAllocation('alloc_2', 1500.0, '2026-01-01T14:00:00.000Z');
      alloc = repo.getAllocationsForDate('2026-01-01')[0];
      expect(alloc.state).toBe('active');
      expect(alloc.reattachedAt).toBe('2026-01-01T14:00:00.000Z');

      const revs = db
        .prepare('SELECT mutation_type FROM classification_revisions WHERE target_id = ? ORDER BY id ASC')
        .all('alloc_2') as Array<{ mutation_type: string }>;
      expect(revs.map((r) => r.mutation_type)).toEqual([
        'reconciliation_adjusted',
        'allocation_detached',
        'allocation_reattached'
      ]);
    });
  });

  describe('Heartbeat Memberships Seed and Replacement', () => {
    it('seeds memberships during migration and replaces memberships without deleting raw heartbeats', () => {
      db.prepare(
        `INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (1, 'daily_dump', 'h', 1)`
      ).run();

      const insertHb = db.prepare(`
        INSERT INTO heartbeats (id, external_id, occurred_at_us, occurred_at, local_date, entity, entity_type, category, user_agent_id, canonical_hash, source_import_id)
        VALUES (?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01', 'file.ts', 'file', 'coding', 'ua1', 'hash', 1)
      `);
      insertHb.run(101, 'hb-101', 1000);
      insertHb.run(102, 'hb-102', 2000);
      insertHb.run(103, 'hb-103', 3000);

      // Seed membership for all 3
      repo.replaceHeartbeatMembership('2026-01-01', [101, 102, 103]);
      expect(repo.getActiveHeartbeatIds('2026-01-01')).toEqual([101, 102, 103]);

      // Fresh sync replaces membership with [102, 104]
      insertHb.run(104, 'hb-104', 4000);
      repo.replaceHeartbeatMembership('2026-01-01', [102, 104]);

      expect(repo.getActiveHeartbeatIds('2026-01-01')).toEqual([102, 104]);

      // Raw heartbeats 101 and 103 are NOT deleted
      const allHeartbeats = db.prepare('SELECT id FROM heartbeats ORDER BY id ASC').all();
      expect(allHeartbeats.map((h) => (h as { id: number }).id)).toEqual([101, 102, 103, 104]);
    });

    it('returns exact number of retired IDs across overlap, new IDs, duplicates, and empty input', () => {
      db.prepare(
        `INSERT INTO source_imports (id, source_type, source_hash, byte_size) VALUES (2, 'daily_dump', 'h2', 1)`
      ).run();

      const insertHb = db.prepare(`
        INSERT INTO heartbeats (id, external_id, occurred_at_us, occurred_at, local_date, entity, entity_type, category, user_agent_id, canonical_hash, source_import_id)
        VALUES (?, ?, ?, '2026-01-02T00:00:00Z', '2026-01-02', 'file.ts', 'file', 'coding', 'ua1', 'hash', 2)
      `);
      for (let i = 1; i <= 10; i++) {
        insertHb.run(i + 200, `hb-${i + 200}`, i * 1000);
      }

      // Initial seed: 201, 202, 203 active
      const r1 = repo.replaceHeartbeatMembership('2026-01-02', [201, 202, 203]);
      expect(r1).toEqual({ activeCount: 3, retiredCount: 0 });
      expect(repo.getActiveHeartbeatIds('2026-01-02')).toEqual([201, 202, 203]);

      // Case 1: Overlap ([202, 203] overlap, [204] new -> 201 is retired)
      const r2 = repo.replaceHeartbeatMembership('2026-01-02', [202, 203, 204]);
      expect(r2).toEqual({ activeCount: 3, retiredCount: 1 });
      expect(repo.getActiveHeartbeatIds('2026-01-02')).toEqual([202, 203, 204]);

      // Case 2: Completely new IDs ([205, 206] new -> 202, 203, 204 are retired)
      const r3 = repo.replaceHeartbeatMembership('2026-01-02', [205, 206]);
      expect(r3).toEqual({ activeCount: 2, retiredCount: 3 });
      expect(repo.getActiveHeartbeatIds('2026-01-02')).toEqual([205, 206]);

      // Case 3: Duplicates in input ([206, 206, 207, 207] -> 205 retired, active count = 2 for unique 206, 207)
      const r4 = repo.replaceHeartbeatMembership('2026-01-02', [206, 206, 207, 207]);
      expect(r4).toEqual({ activeCount: 2, retiredCount: 1 });
      expect(repo.getActiveHeartbeatIds('2026-01-02')).toEqual([206, 207]);

      // Case 4: Empty input (all previously active [206, 207] retired)
      const r5 = repo.replaceHeartbeatMembership('2026-01-02', []);
      expect(r5).toEqual({ activeCount: 0, retiredCount: 2 });
      expect(repo.getActiveHeartbeatIds('2026-01-02')).toEqual([]);
    });
  });

  describe('User-Agent Registry Staging, Publication, and Historical Retention', () => {
    it('stages refresh entries and rolls back on failure leaving published registry untouched', () => {
      repo.stageRegistryEntries([
        {
          id: 'uuid-1',
          editor: 'VS Code',
          userAgentValue: 'vscode/1.0',
          os: 'mac'
        }
      ]);

      // Clearing / aborting staging leaves published registry empty
      repo.clearRegistryStaging();
      expect(repo.listRegistryEntries()).toHaveLength(0);
    });

    it('publishes staging entries and preserves missing historical UUID mappings with is_historical = 1', () => {
      // 1. Initial publication
      repo.stageRegistryEntries([
        {
          id: 'uuid-old-1',
          editor: 'Sublime Text',
          userAgentValue: 'sublime/3',
          os: 'linux'
        },
        {
          id: 'uuid-surviving',
          editor: 'VS Code',
          userAgentValue: 'vscode/1.90',
          os: 'mac'
        }
      ]);

      const pub1 = repo.publishRegistryStaging();
      expect(pub1.publishedCount).toBe(2);
      expect(pub1.historicalCount).toBe(0);

      // 2. Newer refresh omits uuid-old-1 and adds uuid-new-2
      repo.stageRegistryEntries([
        {
          id: 'uuid-surviving',
          editor: 'VS Code',
          userAgentValue: 'vscode/1.91',
          os: 'mac'
        },
        {
          id: 'uuid-new-2',
          editor: 'Cursor',
          userAgentValue: 'cursor/0.40',
          os: 'mac'
        }
      ]);

      const pub2 = repo.publishRegistryStaging();
      expect(pub2.publishedCount).toBe(2);
      expect(pub2.historicalCount).toBe(1); // uuid-old-1 marked historical!

      // uuid-old-1 is retained as historical
      const oldEntry = repo.getRegistryEntry('uuid-old-1');
      expect(oldEntry).not.toBeNull();
      expect(oldEntry?.isHistorical).toBe(true);

      const surviving = repo.getRegistryEntry('uuid-surviving');
      expect(surviving?.userAgentValue).toBe('vscode/1.91');
      expect(surviving?.isHistorical).toBe(false);

      const activeList = repo.listRegistryEntries({ includeHistorical: false });
      expect(activeList.map((e) => e.id)).toEqual(['uuid-new-2', 'uuid-surviving']);
    });
  });

  describe('Layer Freshness Tracking', () => {
    it('records layer attempts and accepted state transitions', () => {
      repo.recordLayerAttempt('2026-01-01', 'summaries', {
        statusCode: 'HTTP_402_PAYMENT_REQUIRED',
        retryAt: '2026-01-02T00:00:00.000Z',
        hasRestriction: true,
        isStale: true
      });

      let freshness = repo.getLayerFreshness('2026-01-01', 'summaries');
      expect(freshness?.statusCode).toBe('HTTP_402_PAYMENT_REQUIRED');
      expect(freshness?.hasRestriction).toBe(true);
      expect(freshness?.isStale).toBe(true);
      expect(freshness?.nextRetryAt).toBe('2026-01-02T00:00:00.000Z');

      // Accepted update resets failure and sets snapshot version and fidelity
      repo.recordLayerAccepted('2026-01-01', 'summaries', {
        snapshotVersion: 2,
        contentHash: 'hash_accepted_123',
        fidelity: 'coarse_project',
        sourceReference: 'imp_1',
        timezone: 'Europe/London',
        evidenceMatchesSummary: true
      });

      freshness = repo.getLayerFreshness('2026-01-01', 'summaries');
      expect(freshness?.acceptedSnapshotVersion).toBe(2);
      expect(freshness?.acceptedContentHash).toBe('hash_accepted_123');
      expect(freshness?.acceptedFidelity).toBe('coarse_project');
      expect(freshness?.verifiedTimezone).toBe('Europe/London');
      expect(freshness?.evidenceMatchesSummary).toBe(true);
      expect(freshness?.statusCode).toBeNull();
      expect(freshness?.isStale).toBe(false);
      expect(freshness?.hasRestriction).toBe(false);
    });

    it('preserves last_accepted_change_at, snapshot version, and identity when content hash is unchanged', () => {
      // 1. Initial accepted record
      const t1 = '2026-01-01T10:00:00.000Z';
      repo.recordLayerAccepted(
        '2026-01-01',
        'summaries',
        {
          snapshotVersion: 1,
          contentHash: 'hash_unchanged',
          fidelity: 'entity_detail',
          sourceReference: 'import_ref_1',
          timezone: 'UTC',
          evidenceMatchesSummary: true
        },
        t1
      );

      const f1 = repo.getLayerFreshness('2026-01-01', 'summaries');
      expect(f1?.acceptedSnapshotVersion).toBe(1);
      expect(f1?.acceptedContentHash).toBe('hash_unchanged');
      expect(f1?.acceptedSourceReference).toBe('import_ref_1');
      expect(f1?.acceptedFidelity).toBe('entity_detail');
      expect(f1?.lastAcceptedChangeAt).toBe(t1);
      expect(f1?.lastAttemptAt).toBe(t1);
      expect(f1?.lastSuccessAt).toBe(t1);

      // 2. Second record with identical contentHash but different attempt timestamp and observation metadata
      const t2 = '2026-01-01T12:00:00.000Z';
      repo.recordLayerAccepted(
        '2026-01-01',
        'summaries',
        {
          snapshotVersion: 99, // Should NOT overwrite because hash is identical!
          contentHash: 'hash_unchanged',
          fidelity: 'coarse_project', // Should NOT overwrite!
          sourceReference: 'new_ref_ignored', // Should NOT overwrite!
          timezone: 'Europe/London', // Observation metadata CAN update
          evidenceMatchesSummary: false
        },
        t2
      );

      const f2 = repo.getLayerFreshness('2026-01-01', 'summaries');
      // Preserved fields:
      expect(f2?.lastAcceptedChangeAt).toBe(t1); // PRESERVED!
      expect(f2?.acceptedSnapshotVersion).toBe(1); // PRESERVED!
      expect(f2?.acceptedContentHash).toBe('hash_unchanged'); // PRESERVED!
      expect(f2?.acceptedSourceReference).toBe('import_ref_1'); // PRESERVED!
      expect(f2?.acceptedFidelity).toBe('entity_detail'); // PRESERVED!

      // Updated observation/success metadata:
      expect(f2?.lastAttemptAt).toBe(t2); // UPDATED
      expect(f2?.lastSuccessAt).toBe(t2); // UPDATED
      expect(f2?.verifiedTimezone).toBe('Europe/London'); // UPDATED
      expect(f2?.evidenceMatchesSummary).toBe(false); // UPDATED

      // 3. Third record with DIFFERENT contentHash
      const t3 = '2026-01-01T14:00:00.000Z';
      repo.recordLayerAccepted(
        '2026-01-01',
        'summaries',
        {
          snapshotVersion: 2,
          contentHash: 'hash_changed_content',
          fidelity: 'coarse_project',
          sourceReference: 'import_ref_2',
          timezone: 'Europe/London',
          evidenceMatchesSummary: true
        },
        t3
      );

      const f3 = repo.getLayerFreshness('2026-01-01', 'summaries');
      // Now lastAcceptedChangeAt and identity update
      expect(f3?.lastAcceptedChangeAt).toBe(t3); // UPDATED
      expect(f3?.acceptedSnapshotVersion).toBe(2); // UPDATED
      expect(f3?.acceptedContentHash).toBe('hash_changed_content'); // UPDATED
      expect(f3?.acceptedSourceReference).toBe('import_ref_2'); // UPDATED
      expect(f3?.acceptedFidelity).toBe('coarse_project'); // UPDATED
      expect(f3?.lastAttemptAt).toBe(t3);
      expect(f3?.lastSuccessAt).toBe(t3);
    });
  });
});
