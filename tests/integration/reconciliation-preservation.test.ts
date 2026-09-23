import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase } from '../../src/lib/server/db/connection.js';
import { SqliteSyncRepository } from '../../src/lib/server/sync/repository.js';
import { SqliteClassificationService } from '../../src/lib/server/classification/sqlite.js';
import { SqliteWorkOnlyAnalytics } from '../../src/lib/server/analytics/sqlite.js';
import { reconcileDay } from '../../src/lib/server/ingest/reconcile.js';
import {
  normalizeSummaryDay,
  normalizeHeartbeatDay,
  type DayCandidate
} from '../../src/lib/server/ingest/index.js';

describe('Integration: Reconciliation, Allocation Preservation, and Heartbeat Invariants', () => {
  let db: Database.Database;
  let syncRepo: SqliteSyncRepository;
  let classification: SqliteClassificationService;
  let analytics: SqliteWorkOnlyAnalytics;

  beforeEach(() => {
    db = openTestDatabase();
    syncRepo = new SqliteSyncRepository(db);
    classification = new SqliteClassificationService(db);
    analytics = new SqliteWorkOnlyAnalytics(db, classification);
  });

  afterEach(() => {
    db.close();
  });

  const HB_UUID_A = '00000000-0000-4000-8000-0000000000aa';
  const HB_UUID_B = '00000000-0000-4000-8000-0000000000bb';

  function buildCandidate(
    date: string,
    options: {
      slices: Array<{ entity: string; type: 'file' | 'app' | 'domain'; seconds: number }>;
      heartbeats?: Array<{
        id: string;
        entity: string;
        type: 'file' | 'app' | 'domain';
        category?: string;
        user_agent_id?: string;
      }>;
      coarseOnly?: boolean;
    }
  ): DayCandidate {
    const totalSeconds = options.slices.reduce((sum, s) => sum + s.seconds, 0);

    const rawSummary = {
      data: [
        {
          date,
          range: { date, timezone: 'Europe/London' },
          grand_total: {
            total_seconds: totalSeconds,
            human_additions: 10,
            human_deletions: 5,
            ai_additions: 0,
            ai_deletions: 0,
            ai_sessions: 0
          },
          projects: options.coarseOnly
            ? [
                {
                  name: 'proj-alpha',
                  total_seconds: totalSeconds,
                  percent: 100.0
                }
              ]
            : [
                {
                  name: 'proj-alpha',
                  total_seconds: totalSeconds,
                  percent: 100.0,
                  entities: options.slices.map((s) => ({
                    name: s.entity,
                    type: s.type,
                    total_seconds: s.seconds
                  }))
                }
              ]
        }
      ]
    };

    const baseEpoch = Math.floor(new Date(`${date}T12:00:00Z`).getTime() / 1000);
    const rawHeartbeats = (options.heartbeats ?? []).map((h, idx) => ({
      id: h.id,
      time: baseEpoch + idx * 60,
      entity: h.entity,
      type: h.type,
      category: h.category ?? 'coding',
      project: 'proj-alpha',
      branch: 'main',
      language: 'TypeScript',
      dependencies: ['better-sqlite3'],
      machine_name_id: 'dev-machine',
      user_agent_id: h.user_agent_id ?? 'vscode-1'
    }));

    const summariesRes = normalizeSummaryDay(rawSummary, { date, accountTimezone: 'Europe/London' });
    const heartbeatsRes = normalizeHeartbeatDay(rawHeartbeats, { date, timezone: 'Europe/London' });

    return {
      date,
      timezone: 'Europe/London',
      connectionGeneration: 1,
      summaries: summariesRes,
      heartbeats: heartbeatsRes
    };
  }

  it('adjusts manual allocation duration and records audit revision when source slice changes duration', () => {
    const date = '2026-09-10';

    // Step 1: Initial day reconciliation with 2 slices
    const candidate1 = buildCandidate(date, {
      slices: [
        { entity: 'src/core.ts', type: 'file', seconds: 4000.0 },
        { entity: 'src/helper.ts', type: 'file', seconds: 2000.0 }
      ]
    });
    const res1 = reconcileDay(db, candidate1);
    expect(res1.dayStatus).toBe('succeeded');
    expect(res1.disposition).toBe('updated');

    // Retrieve project ID for proj-alpha
    const project = db.prepare('SELECT id FROM projects WHERE name = ?').get('proj-alpha') as { id: number };
    expect(project).toBeDefined();

    // Step 2: Create a manual time allocation on src/core.ts matching exact duration 4000s
    const { allocation: allocInitial } = classification.createAllocation({
      date,
      projectId: project.id,
      entity: 'src/core.ts',
      entityType: 'file',
      kind: 'entity',
      classification: 'work',
      note: 'Core engine development'
    });

    expect(allocInitial.state).toBe('active');
    expect(allocInitial.allocated_seconds).toBe(4000.0);

    // Step 3: Reconcile with updated slice duration (src/core.ts shrinks to 3500.0s, helper expands to 2500.0s)
    const candidate2 = buildCandidate(date, {
      slices: [
        { entity: 'src/core.ts', type: 'file', seconds: 3500.0 },
        { entity: 'src/helper.ts', type: 'file', seconds: 2500.0 }
      ]
    });
    const res2 = reconcileDay(db, candidate2, { syncRepo, classification });
    expect(res2.dayStatus).toBe('succeeded');
    expect(res2.disposition).toBe('updated');

    // Allocation should automatically adjust duration in lockstep
    const allocUpdated = syncRepo.getAllocationsForDate(date).find((a) => a.id === allocInitial.id);
    expect(allocUpdated?.state).toBe('active');
    expect(allocUpdated?.allocatedSeconds).toBe(3500.0);

    // Verify append-only audit trail in classification_revisions
    const revisions = db
      .prepare('SELECT mutation_type, target_id, before_json, after_json FROM classification_revisions WHERE target_id = ? ORDER BY id ASC')
      .all(allocInitial.id) as Array<Record<string, unknown>>;
    expect(revisions.length).toBeGreaterThanOrEqual(2);

    const adjustmentRev = revisions.find((r) => r.mutation_type === 'reconciliation_adjusted');
    expect(adjustmentRev).toBeDefined();
    expect(adjustmentRev?.before_json).toContain('4000');
    expect(adjustmentRev?.after_json).toContain('3500');
  });

  it('detaches manual allocation when source slice is deleted and reattaches when slice reappears', () => {
    const date = '2026-09-11';

    // Step 1: Initial ingest with file slice
    const candidate1 = buildCandidate(date, {
      slices: [
        { entity: 'src/feature.ts', type: 'file', seconds: 3000.0 },
        { entity: 'src/other.ts', type: 'file', seconds: 1000.0 }
      ]
    });
    reconcileDay(db, candidate1);

    const project = db.prepare('SELECT id FROM projects WHERE name = ?').get('proj-alpha') as { id: number };

    // Step 2: Create manual allocation for src/feature.ts
    const { allocation: allocInitial } = classification.createAllocation({
      date,
      projectId: project.id,
      entity: 'src/feature.ts',
      entityType: 'file',
      kind: 'entity',
      classification: 'work',
      note: 'Feature development'
    });

    // Step 3: Reconcile with day where src/feature.ts is DELETED (disappeared upstream)
    const candidate2 = buildCandidate(date, {
      slices: [
        { entity: 'src/other.ts', type: 'file', seconds: 4000.0 }
      ]
    });
    const res2 = reconcileDay(db, candidate2, { syncRepo, classification });
    expect(res2.dayStatus).toBe('succeeded');

    // Allocation must survive with state = 'detached' and duration preserved!
    const allocDetached = syncRepo.getAllocationsForDate(date).find((a) => a.id === allocInitial.id);
    expect(allocDetached).toBeDefined();
    expect(allocDetached?.state).toBe('detached');
    expect(allocDetached?.allocatedSeconds).toBe(3000.0);
    expect(allocDetached?.detachedAt).toBeTruthy();
    expect(allocDetached?.note).toBe('Feature development');

    // Audit trail records allocation_detached
    const detachRev = db
      .prepare("SELECT * FROM classification_revisions WHERE target_id = ? AND mutation_type = 'allocation_detached'")
      .get(allocInitial.id) as Record<string, unknown>;
    expect(detachRev).toBeDefined();

    // Step 4: Detached allocation trigger behavior
    // Updating detached allocation while remaining detached is allowed
    expect(() => {
      db.prepare("UPDATE daily_time_allocations SET note = 'Updated while detached' WHERE id = ?").run(allocInitial.id);
    }).not.toThrow();

    // But attempting to set state = 'active' while matching slice is missing must fail trigger!
    expect(() => {
      db.prepare("UPDATE daily_time_allocations SET state = 'active' WHERE id = ?").run(allocInitial.id);
    }).toThrow(/allocated_seconds does not match authoritative slice total_seconds/);

    // Step 5: Slice reappears in a subsequent fetch (reconciliation)
    const candidate3 = buildCandidate(date, {
      slices: [
        { entity: 'src/feature.ts', type: 'file', seconds: 3000.0 },
        { entity: 'src/other.ts', type: 'file', seconds: 1000.0 }
      ]
    });
    const res3 = reconcileDay(db, candidate3, { syncRepo, classification });
    expect(res3.dayStatus).toBe('succeeded');

    // Allocation must transition back to active!
    const allocReattached = syncRepo.getAllocationsForDate(date).find((a) => a.id === allocInitial.id);
    expect(allocReattached?.state).toBe('active');
    expect(allocReattached?.reattachedAt).toBeTruthy();

    const reattachRev = db
      .prepare("SELECT * FROM classification_revisions WHERE target_id = ? AND mutation_type = 'allocation_reattached'")
      .get(allocInitial.id) as Record<string, unknown>;
    expect(reattachRev).toBeDefined();
  });

  it('detaches coarse project allocation when transitioning from coarse summary to entity detail', () => {
    const date = '2026-09-12';

    // Step 1: Ingest day as coarse project summary (no entity breakdown)
    const candidateCoarse = buildCandidate(date, {
      slices: [{ entity: 'proj-alpha', type: 'file', seconds: 5000.0 }],
      coarseOnly: true
    });
    const resCoarse = reconcileDay(db, candidateCoarse);
    expect(resCoarse.dayStatus).toBe('succeeded');

    const project = db.prepare('SELECT id FROM projects WHERE name = ?').get('proj-alpha') as { id: number };

    // Coarse slice created
    const coarseSlice = db
      .prepare('SELECT id, project_id, entity, entity_type, kind, total_seconds FROM day_project_entity_slices WHERE date = ? AND project_id = ?')
      .get(date, project.id) as { id: number; project_id: number; entity: string; entity_type: 'file' | 'app' | 'domain' | 'unattributed'; kind: 'entity' | 'project_summary'; total_seconds: number };
    expect(coarseSlice.kind).toBe('project_summary');
    expect(coarseSlice.total_seconds).toBe(5000.0);

    // Create coarse allocation
    const { allocation: allocCoarse } = classification.createAllocation({
      date,
      projectId: project.id,
      entity: coarseSlice.entity,
      entityType: coarseSlice.entity_type,
      kind: 'project_summary',
      classification: 'work',
      note: 'Coarse project override'
    });

    // Step 2: Ingest detailed entity breakdown for the same day
    const candidateDetailed = buildCandidate(date, {
      slices: [
        { entity: 'src/module1.ts', type: 'file', seconds: 3000.0 },
        { entity: 'src/module2.ts', type: 'file', seconds: 2000.0 }
      ],
      coarseOnly: false
    });
    const resDetailed = reconcileDay(db, candidateDetailed, { syncRepo, classification });
    expect(resDetailed.dayStatus).toBe('succeeded');

    // Coarse allocation must detach cleanly rather than fabricate distributed entity allocations
    const allocAfter = syncRepo.getAllocationsForDate(date).find((a) => a.id === allocCoarse.id);
    expect(allocAfter?.state).toBe('detached');
    expect(allocAfter?.kind).toBe('project_summary');
    expect(allocAfter?.allocatedSeconds).toBe(5000.0);

    const detachRev = db
      .prepare("SELECT * FROM classification_revisions WHERE target_id = ? AND mutation_type = 'allocation_detached'")
      .get(allocCoarse.id) as Record<string, unknown>;
    expect(detachRev).toBeDefined();
  });

  it('manages active heartbeat memberships and preserves historical variants across omission and conflicts', () => {
    const date = '2026-09-13';

    // Step 1: Initial ingest with 2 heartbeats matching slices
    const candidate1 = buildCandidate(date, {
      slices: [{ entity: 'src/index.ts', type: 'file', seconds: 3600.0 }],
      heartbeats: [
        { id: HB_UUID_A, entity: 'src/index.ts', type: 'file' },
        { id: HB_UUID_B, entity: 'src/index.ts', type: 'file' }
      ]
    });

    const res1 = reconcileDay(db, candidate1);
    expect(res1.dayStatus).toBe('succeeded');

    // Verify both heartbeats are active in heartbeat_memberships
    const active1 = db
      .prepare('SELECT heartbeat_id, active FROM heartbeat_memberships WHERE date = ? ORDER BY heartbeat_id ASC')
      .all(date) as Array<{ heartbeat_id: number; active: number }>;
    expect(active1).toHaveLength(2);
    expect(active1.every((m) => m.active === 1)).toBe(true);

    const hbA = db.prepare('SELECT id FROM heartbeats WHERE external_id = ?').get(HB_UUID_A) as { id: number };
    const hbB = db.prepare('SELECT id FROM heartbeats WHERE external_id = ?').get(HB_UUID_B) as { id: number };

    // Step 2: Next ingest omits HB_UUID_B (upstream deleted/omitted)
    const candidate2 = buildCandidate(date, {
      slices: [{ entity: 'src/index.ts', type: 'file', seconds: 3600.0 }],
      heartbeats: [{ id: HB_UUID_A, entity: 'src/index.ts', type: 'file' }]
    });

    const res2 = reconcileDay(db, candidate2);
    expect(res2.dayStatus).toBe('succeeded');

    // HB_UUID_A is still active (active = 1), HB_UUID_B is retired from active evidence (active = 0)
    const active2 = db
      .prepare('SELECT heartbeat_id, active FROM heartbeat_memberships WHERE date = ? ORDER BY heartbeat_id ASC')
      .all(date) as Array<{ heartbeat_id: number; active: number }>;
    expect(active2).toEqual([
      { heartbeat_id: hbA.id, active: 1 },
      { heartbeat_id: hbB.id, active: 0 }
    ]);

    // Invariant: HB_UUID_B is NOT deleted from heartbeats or heartbeat_variants!
    expect(db.prepare('SELECT id FROM heartbeats WHERE external_id = ?').get(HB_UUID_B)).toBeDefined();
    expect(db.prepare('SELECT id FROM heartbeat_variants WHERE external_id = ?').get(HB_UUID_B)).toBeDefined();

    // Step 3: Conflict detection - same UUID with contradictory category
    const conflictingCandidate = buildCandidate(date, {
      slices: [{ entity: 'src/index.ts', type: 'file', seconds: 3600.0 }],
      heartbeats: [
        {
          id: HB_UUID_A,
          entity: 'src/index.ts',
          type: 'file',
          category: 'browsing' // Conflicting category with original 'coding'
        }
      ]
    });

    const resConflict = reconcileDay(db, conflictingCandidate);
    // When a heartbeat payload conflicts, heartbeat layer fails or flags conflict without corrupting canonical data
    expect(
      resConflict.dayStatus === 'partial' ||
      resConflict.dayStatus === 'failed' ||
      resConflict.codes.includes('HEARTBEAT_CANONICAL_CONFLICT')
    ).toBe(true);

    // Verify existing canonical data was not silently corrupted
    const hbRecord = db.prepare('SELECT category FROM heartbeats WHERE external_id = ?').get(HB_UUID_A) as { category: string };
    expect(hbRecord.category).toBe('coding');
  });

  it('guarantees no inferred heartbeat duration and no work-time expansion', async () => {
    const date = '2026-09-14';

    // Official summary states 1800.0 total seconds for the slice
    const candidate = buildCandidate(date, {
      slices: [{ entity: 'src/worker.ts', type: 'file', seconds: 1800.0 }],
      // Provide 50 distinct heartbeats across the day
      heartbeats: Array.from({ length: 50 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        entity: 'src/worker.ts',
        type: 'file' as const
      }))
    });

    const res = reconcileDay(db, candidate);
    expect(res.dayStatus).toBe('succeeded');

    // 1. Total seconds in daily_totals must equal 1800.0 (official summary value)
    const dailyTotal = db.prepare('SELECT total_seconds FROM daily_totals WHERE date = ?').get(date) as { total_seconds: number };
    expect(dailyTotal.total_seconds).toBe(1800.0);

    // 2. Slice total_seconds must equal 1800.0
    const slice = db.prepare('SELECT total_seconds FROM day_project_entity_slices WHERE date = ?').get(date) as { total_seconds: number };
    expect(slice.total_seconds).toBe(1800.0);

    // 3. 50 heartbeats exist as evidence
    const hbCount = db.prepare('SELECT COUNT(*) AS c FROM heartbeats WHERE local_date = ?').get(date) as { c: number };
    expect(hbCount.c).toBe(50);

    // 4. Analytics work-only range summary strictly reports 1800s, not expanded by heartbeats
    classification.unsafeSeedRule({
      name: 'Work Rule',
      classification: 'work',
      selectorType: 'project',
      selectorValue: 'proj-alpha'
    });

    const summary = await analytics.getRangeSummary({ start: date, end: date });
    expect(summary.workSeconds).toBe(1800.0);
    expect(summary.unclassifiedSeconds).toBe(0.0);
  });
});
