import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDatabase } from '../db/connection.js';
import {
  reconcileDay,
  type ReconcileDayOptions
} from './reconcile.js';
import {
  RECONCILE_CODES,
  type DayCandidate,
  type LayerResult,
  type NormalizedHeartbeatDay,
  type NormalizedSummaryDay,
  normalizeSummaryDay,
  normalizeHeartbeatDay
} from './index.js';
import { SqliteSyncRepository } from '../sync/repository.js';
import { SqliteClassificationService } from '../classification/sqlite.js';
import { SqliteWorkOnlyAnalytics } from '../analytics/sqlite.js';

describe('Milestone P3 Stage B: Transactional Reconciliation Engine', () => {
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

  const HB_UUID_1 = '00000000-0000-4000-8000-000000000001';
  const HB_UUID_2 = '00000000-0000-4000-8000-000000000002';

  function createDetailedCandidate(date: string = '2026-09-10'): DayCandidate {
    const rawSummary = {
      data: [
        {
          date,
          range: { date, timezone: 'Europe/London' },
          grand_total: {
            total_seconds: 7200.0,
            human_additions: 100,
            human_deletions: 20,
            ai_additions: 0,
            ai_deletions: 0,
            ai_sessions: 0
          },
          projects: [
            {
              name: 'project-alpha',
              total_seconds: 7200.0,
              percent: 100.0,
              entities: [
                {
                  name: 'src/app.ts',
                  type: 'file',
                  total_seconds: 4000.0
                },
                {
                  name: 'src/utils.ts',
                  type: 'file',
                  total_seconds: 3200.0
                }
              ]
            }
          ]
        }
      ]
    };

    const rawHeartbeats = [
      {
        id: HB_UUID_1,
        time: 1789038000,
        entity: 'src/app.ts',
        type: 'file',
        category: 'coding',
        project: 'project-alpha',
        branch: 'main',
        language: 'TypeScript',
        dependencies: ['vitest'],
        machine_name_id: 'macbook-pro',
        user_agent_id: 'vscode-client'
      }
    ];

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

  // --------------------------------------------------------------------------
  // 1. Stable Replay IDs, Counts, and Digest
  // --------------------------------------------------------------------------
  it('preserves stable IDs, counts, and digest on identical replay (disposition: unchanged)', () => {
    const candidate = createDetailedCandidate('2026-09-10');

    // First reconciliation
    const firstRes = reconcileDay(db, candidate);
    expect(firstRes.disposition).toBe('updated');
    expect(firstRes.dayStatus).toBe('succeeded');

    const firstSlices = db.prepare('SELECT id, entity, total_seconds FROM day_project_entity_slices WHERE date = ? ORDER BY id ASC').all('2026-09-10') as Array<{ id: number; entity: string; total_seconds: number }>;
    expect(firstSlices).toHaveLength(2);

    const firstDigest = classification.getRevisionState().digest;

    // Replay identical candidate
    const replayRes = reconcileDay(db, candidate);
    expect(replayRes.disposition).toBe('unchanged');
    expect(replayRes.dayStatus).toBe('succeeded');

    const secondSlices = db.prepare('SELECT id, entity, total_seconds FROM day_project_entity_slices WHERE date = ? ORDER BY id ASC').all('2026-09-10') as Array<{ id: number; entity: string; total_seconds: number }>;
    expect(secondSlices).toEqual(firstSlices);

    const secondDigest = classification.getRevisionState().digest;
    expect(secondDigest).toBe(firstDigest);
  });

  it('stores URL heartbeat evidence without creating a URL slice or classification identity', () => {
    const candidate = createDetailedCandidate();
    candidate.heartbeats = normalizeHeartbeatDay([{
      id: HB_UUID_2,
      time: 1789038000,
      entity: 'https://Example.com/Path',
      type: 'url',
      category: 'browsing',
      project: 'project-alpha',
      machine_name_id: 'browser-machine',
      user_agent_id: 'browser/1'
    }], { date: candidate.date, timezone: candidate.timezone });

    const result = reconcileDay(db, candidate);
    expect(result.dayStatus).toBe('succeeded');
    expect(db.prepare('SELECT entity, entity_type FROM heartbeats WHERE external_id = ?').get(HB_UUID_2))
      .toEqual({ entity: 'https://Example.com/Path', entity_type: 'url' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM day_project_entity_slices WHERE entity_type = 'url'").get())
      .toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM slice_identities WHERE source = 'heartbeat'").get())
      .toEqual({ n: 0 });
  });

  // --------------------------------------------------------------------------
  // 2. Allocations Preservation: Duration Change, Detach, Audit, Reattach
  // --------------------------------------------------------------------------
  it('adjusts duration, audits revisions, detaches removed slices, and reattaches reappearing slices', () => {
    const candidate = createDetailedCandidate('2026-09-10');
    reconcileDay(db, candidate);

    const initialSlice = db.prepare("SELECT id, project_id, entity, entity_type, kind, total_seconds FROM day_project_entity_slices WHERE entity = 'src/app.ts'").get() as {
      id: number;
      project_id: number;
      entity: string;
      entity_type: 'file';
      kind: 'entity';
      total_seconds: number;
    };

    // Create an active allocation on src/app.ts
    const allocRes = classification.createAllocation({
      date: '2026-09-10',
      projectId: initialSlice.project_id,
      entity: 'src/app.ts',
      entityType: initialSlice.entity_type,
      kind: initialSlice.kind,
      classification: 'work',
      note: 'Initial allocation'
    });
    expect(allocRes.allocation.allocated_seconds).toBe(4000.0);
    expect(allocRes.allocation.state).toBe('active');

    // Reconcile with changed duration: src/app.ts goes from 4000 -> 5000, src/utils.ts goes from 3200 -> 2200
    const rawUpdated = {
      data: [
        {
          date: '2026-09-10',
          range: { date: '2026-09-10', timezone: 'Europe/London' },
          grand_total: { total_seconds: 7200.0 },
          projects: [
            {
              name: 'project-alpha',
              total_seconds: 7200.0,
              entities: [
                { name: 'src/app.ts', type: 'file', total_seconds: 5000.0 },
                { name: 'src/utils.ts', type: 'file', total_seconds: 2200.0 }
              ]
            }
          ]
        }
      ]
    };
    const updatedCandidate: DayCandidate = {
      date: '2026-09-10',
      timezone: 'Europe/London',
      connectionGeneration: 1,
      summaries: normalizeSummaryDay(rawUpdated, { date: '2026-09-10', accountTimezone: 'Europe/London' }),
      heartbeats: { kind: 'skipped', reason: 'none' }
    };

    const updateRes = reconcileDay(db, updatedCandidate);
    expect(updateRes.disposition).toBe('updated');

    const allocAfterDurationChange = syncRepo.getAllocationsForDate('2026-09-10').find((a) => a.entity === 'src/app.ts')!;
    expect(allocAfterDurationChange.allocatedSeconds).toBe(5000.0);
    expect(allocAfterDurationChange.state).toBe('active');

    const revisions = syncRepo['db'].prepare("SELECT * FROM classification_revisions WHERE mutation_type = 'reconciliation_adjusted'").all();
    expect(revisions.length).toBeGreaterThan(0);

    // Reconcile with src/app.ts REMOVED (only src/utils.ts remains with 7200s)
    const rawRemoved = {
      data: [
        {
          date: '2026-09-10',
          range: { date: '2026-09-10', timezone: 'Europe/London' },
          grand_total: { total_seconds: 7200.0 },
          projects: [
            {
              name: 'project-alpha',
              total_seconds: 7200.0,
              entities: [{ name: 'src/utils.ts', type: 'file', total_seconds: 7200.0 }]
            }
          ]
        }
      ]
    };
    const removedCandidate: DayCandidate = {
      date: '2026-09-10',
      timezone: 'Europe/London',
      connectionGeneration: 1,
      summaries: normalizeSummaryDay(rawRemoved, { date: '2026-09-10', accountTimezone: 'Europe/London' }),
      heartbeats: { kind: 'skipped', reason: 'none' }
    };

    reconcileDay(db, removedCandidate);

    const allocAfterRemoval = syncRepo.getAllocationsForDate('2026-09-10').find((a) => a.entity === 'src/app.ts')!;
    expect(allocAfterRemoval.state).toBe('detached');
    expect(allocAfterRemoval.allocatedSeconds).toBe(5000.0); // Retains last known duration
    expect(
      classification.getAllocationBySlice(
        '2026-09-10',
        initialSlice.project_id,
        'src/app.ts'
      )
    ).toBeNull();
    expect(
      classification.getAllocationBySlice(
        '2026-09-10',
        initialSlice.project_id,
        'src/app.ts',
        initialSlice.entity_type,
        initialSlice.kind
      )?.state
    ).toBe('detached');

    const detachRevisions = syncRepo['db'].prepare("SELECT * FROM classification_revisions WHERE mutation_type = 'allocation_detached'").all();
    expect(detachRevisions.length).toBeGreaterThan(0);

    // Reconcile with src/app.ts REAPPEARING with 6000s
    const rawReappearing = {
      data: [
        {
          date: '2026-09-10',
          range: { date: '2026-09-10', timezone: 'Europe/London' },
          grand_total: { total_seconds: 7200.0 },
          projects: [
            {
              name: 'project-alpha',
              total_seconds: 7200.0,
              entities: [
                { name: 'src/app.ts', type: 'file', total_seconds: 6000.0 },
                { name: 'src/utils.ts', type: 'file', total_seconds: 1200.0 }
              ]
            }
          ]
        }
      ]
    };
    const reappearingCandidate: DayCandidate = {
      date: '2026-09-10',
      timezone: 'Europe/London',
      connectionGeneration: 1,
      summaries: normalizeSummaryDay(rawReappearing, { date: '2026-09-10', accountTimezone: 'Europe/London' }),
      heartbeats: { kind: 'skipped', reason: 'none' }
    };

    reconcileDay(db, reappearingCandidate);

    const allocAfterReappear = syncRepo.getAllocationsForDate('2026-09-10').find((a) => a.entity === 'src/app.ts')!;
    expect(allocAfterReappear.state).toBe('active');
    expect(allocAfterReappear.allocatedSeconds).toBe(6000.0);

    const reattachRevisions = syncRepo['db'].prepare("SELECT * FROM classification_revisions WHERE mutation_type = 'allocation_reattached'").all();
    expect(reattachRevisions.length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // 3. Coarse-to-Entity Transition Detaches Coarse Override
  // --------------------------------------------------------------------------
  it('detaches coarse project override when transitioning from coarse to entity detail', () => {
    // 1. Initial coarse summary candidate (no entity breakdown)
    const rawCoarse = {
      data: [
        {
          date: '2026-09-10',
          range: { date: '2026-09-10', timezone: 'Europe/London' },
          grand_total: { total_seconds: 3600.0 },
          projects: [{ name: 'project-coarse', total_seconds: 3600.0 }]
        }
      ]
    };
    const coarseCandidate: DayCandidate = {
      date: '2026-09-10',
      timezone: 'Europe/London',
      connectionGeneration: 1,
      summaries: normalizeSummaryDay(rawCoarse, { date: '2026-09-10', accountTimezone: 'Europe/London' }),
      heartbeats: { kind: 'skipped', reason: 'none' }
    };

    reconcileDay(db, coarseCandidate);

    const coarseSlice = db.prepare("SELECT * FROM day_project_entity_slices WHERE kind = 'project_summary'").get() as {
      id: number;
      project_id: number;
      entity: string;
      entity_type: 'app';
      kind: 'project_summary';
      total_seconds: number;
    };
    expect(coarseSlice).toBeDefined();

    // Create a whole-project allocation override on this coarse slice
    classification.createAllocation({
      date: '2026-09-10',
      projectId: coarseSlice.project_id,
      entity: coarseSlice.entity,
      entityType: coarseSlice.entity_type,
      kind: coarseSlice.kind,
      classification: 'work'
    });

    const coarseAlloc = syncRepo.getAllocationsForDate('2026-09-10').find((a) => a.kind === 'project_summary')!;
    expect(coarseAlloc.state).toBe('active');

    // 2. Incoming replacement candidate has entity detail
    const rawEntity = {
      data: [
        {
          date: '2026-09-10',
          range: { date: '2026-09-10', timezone: 'Europe/London' },
          grand_total: { total_seconds: 3600.0 },
          projects: [
            {
              name: 'project-coarse',
              total_seconds: 3600.0,
              entities: [
                { name: 'src/main.ts', type: 'file', total_seconds: 2000.0 },
                { name: 'src/test.ts', type: 'file', total_seconds: 1600.0 }
              ]
            }
          ]
        }
      ]
    };
    const entityCandidate: DayCandidate = {
      date: '2026-09-10',
      timezone: 'Europe/London',
      connectionGeneration: 1,
      summaries: normalizeSummaryDay(rawEntity, { date: '2026-09-10', accountTimezone: 'Europe/London' }),
      heartbeats: { kind: 'skipped', reason: 'none' }
    };

    const res = reconcileDay(db, entityCandidate);
    expect(res.disposition).toBe('updated');

    // Coarse allocation must now be detached, not distributed among new entities
    const coarseAllocAfter = syncRepo.getAllocationsForDate('2026-09-10').find((a) => a.kind === 'project_summary')!;
    expect(coarseAllocAfter.state).toBe('detached');

    // Entity slices do NOT have automatic allocations
    const entityAllocs = syncRepo.getAllocationsForDate('2026-09-10').filter((a) => a.kind === 'entity');
    expect(entityAllocs).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // 4. Detail Downgrade: Retains Accepted Rich Snapshot
  // --------------------------------------------------------------------------
  it('preserves existing entity detail when incoming candidate suffers detail downgrade', () => {
    // 1. Reconcile detailed candidate
    const candidate = createDetailedCandidate('2026-09-10');
    reconcileDay(db, candidate);

    const initialSnapshot = db.prepare('SELECT accepted_snapshot_version, accepted_fidelity FROM sync_layer_state WHERE date = ? AND layer = ?').get('2026-09-10', 'summaries') as {
      accepted_snapshot_version: number;
      accepted_fidelity: string;
    };
    expect(initialSnapshot.accepted_fidelity).toBe('entity_detail');

    // 2. Incoming flat summary suffers detail downgrade
    const rawCoarse = {
      data: [
        {
          date: '2026-09-10',
          range: { date: '2026-09-10', timezone: 'Europe/London' },
          grand_total: { total_seconds: 7200.0 },
          projects: [{ name: 'project-alpha', total_seconds: 7200.0 }]
        }
      ]
    };
    const downgradeCandidate: DayCandidate = {
      date: '2026-09-10',
      timezone: 'Europe/London',
      connectionGeneration: 1,
      summaries: normalizeSummaryDay(rawCoarse, { date: '2026-09-10', accountTimezone: 'Europe/London' }),
      heartbeats: { kind: 'skipped', reason: 'none' }
    };

    const res = reconcileDay(db, downgradeCandidate);
    expect(res.disposition).toBe('preserved');
    expect(res.dayStatus).toBe('partial');
    expect(res.codes).toContain(RECONCILE_CODES.DETAIL_DOWNGRADE);

    // Verify detailed slices are retained untouched
    const slices = db.prepare('SELECT kind FROM day_project_entity_slices WHERE date = ?').all('2026-09-10') as Array<{ kind: string }>;
    expect(slices.every((s) => s.kind === 'entity')).toBe(true);

    const preservedSnapshot = db.prepare('SELECT accepted_snapshot_version, accepted_fidelity FROM sync_layer_state WHERE date = ? AND layer = ?').get('2026-09-10', 'summaries') as {
      accepted_snapshot_version: number;
      accepted_fidelity: string;
    };
    expect(preservedSnapshot.accepted_snapshot_version).toBe(initialSnapshot.accepted_snapshot_version);
  });

  // --------------------------------------------------------------------------
  // 5. Valid Zero vs Missing
  // --------------------------------------------------------------------------
  it('accepts verified zero day with code VERIFIED_ZERO_ACCEPTED', () => {
    const rawZero = {
      data: [
        {
          date: '2026-09-10',
          range: { date: '2026-09-10', timezone: 'UTC' },
          grand_total: { total_seconds: 0 },
          projects: []
        }
      ]
    };
    const zeroCandidate: DayCandidate = {
      date: '2026-09-10',
      timezone: 'UTC',
      connectionGeneration: 1,
      summaries: normalizeSummaryDay(rawZero, { date: '2026-09-10', accountTimezone: 'UTC' }),
      heartbeats: { kind: 'skipped', reason: 'none' }
    };

    const res = reconcileDay(db, zeroCandidate);
    expect(res.disposition).toBe('updated');
    expect(res.dayStatus).toBe('succeeded');
    expect(res.codes).toContain(RECONCILE_CODES.VERIFIED_ZERO_ACCEPTED);
  });

  it('rejects invalid/missing requested date', () => {
    const invalidCandidate: DayCandidate = {
      date: 'invalid-date',
      timezone: 'UTC',
      connectionGeneration: 1,
      summaries: { kind: 'skipped', reason: 'none' },
      heartbeats: { kind: 'skipped', reason: 'none' }
    };

    const res = reconcileDay(db, invalidCandidate);
    expect(res.disposition).toBe('rejected');
    expect(res.dayStatus).toBe('failed');
    expect(res.codes).toContain(RECONCILE_CODES.MISSING_REQUESTED_DATE);
  });

  // --------------------------------------------------------------------------
  // 6. Injected Mid-Write Rollback
  // --------------------------------------------------------------------------
  it('atomically rolls back all changes on mid-write error', () => {
    // Stage an initial coherent day
    const candidate = createDetailedCandidate('2026-09-10');
    reconcileDay(db, candidate);

    const initialSliceCount = (db.prepare('SELECT COUNT(*) AS n FROM day_project_entity_slices WHERE date = ?').get('2026-09-10') as { n: number }).n;
    expect(initialSliceCount).toBe(2);

    // Next candidate with updated duration that injects failure
    const rawUpdated = {
      data: [
        {
          date: '2026-09-10',
          range: { date: '2026-09-10', timezone: 'Europe/London' },
          grand_total: { total_seconds: 7200.0 },
          projects: [
            {
              name: 'project-alpha',
              total_seconds: 7200.0,
              entities: [
                { name: 'src/app.ts', type: 'file', total_seconds: 7200.0 }
              ]
            }
          ]
        }
      ]
    };
    const failCandidate: DayCandidate = {
      date: '2026-09-10',
      timezone: 'Europe/London',
      connectionGeneration: 1,
      summaries: normalizeSummaryDay(rawUpdated, { date: '2026-09-10', accountTimezone: 'Europe/London' }),
      heartbeats: { kind: 'skipped', reason: 'none' }
    };

    expect(() => {
      reconcileDay(db, failCandidate, { injectFailure: 'after_slices' });
    }).toThrow('Injected failure after slices');

    // Verify DB rolled back to initial state
    const currentSliceCount = (db.prepare('SELECT COUNT(*) AS n FROM day_project_entity_slices WHERE date = ?').get('2026-09-10') as { n: number }).n;
    expect(currentSliceCount).toBe(2);

    const appSlice = db.prepare("SELECT total_seconds FROM day_project_entity_slices WHERE entity = 'src/app.ts'").get() as { total_seconds: number };
    expect(appSlice.total_seconds).toBe(4000.0); // Retained original 4000.0, not 7200.0
  });

  // --------------------------------------------------------------------------
  // 7. Stale Snapshot, Generation, and Cancellation
  // --------------------------------------------------------------------------
  it('rejects candidate with stale connection generation', () => {
    const candidate = createDetailedCandidate('2026-09-10');
    candidate.connectionGeneration = 999; // Current generation is 1

    const res = reconcileDay(db, candidate);
    expect(res.disposition).toBe('rejected');
    expect(res.dayStatus).toBe('failed');
    expect(res.codes).toContain(RECONCILE_CODES.STALE_CONNECTION_GENERATION);
  });

  it('rejects candidate with stale snapshot version', () => {
    const candidate = createDetailedCandidate('2026-09-10');
    reconcileDay(db, candidate); // Snapshot version is now 1

    // Pass expectedSnapshotVersion: 99
    const res = reconcileDay(db, candidate, { expectedSnapshotVersion: 99 });
    expect(res.disposition).toBe('rejected');
    expect(res.dayStatus).toBe('failed');
    expect(res.codes).toContain(RECONCILE_CODES.STALE_SNAPSHOT_VERSION);
  });

  it('preserves day when cancelled', () => {
    const candidate = createDetailedCandidate('2026-09-10');
    const res = reconcileDay(db, candidate, { isCancelled: () => true });

    expect(res.disposition).toBe('preserved');
    expect(res.dayStatus).toBe('skipped');
    expect(res.codes).toContain(RECONCILE_CODES.RUN_CANCELLED);
  });

  // --------------------------------------------------------------------------
  // 8. Heartbeat Membership Replacement & Conflict
  // --------------------------------------------------------------------------
  it('replaces active heartbeat membership transactionally and isolates conflicts', () => {
    const candidate = createDetailedCandidate('2026-09-10');
    reconcileDay(db, candidate);

    const activeIds = syncRepo.getActiveHeartbeatIds('2026-09-10');
    expect(activeIds).toHaveLength(1);

    // Reconcile replacement with a second heartbeat event
    const rawHeartbeats2 = [
      {
        id: HB_UUID_2,
        time: 1789038060,
        entity: 'src/utils.ts',
        type: 'file',
        category: 'coding',
        project: 'project-alpha',
        branch: 'main',
        language: 'TypeScript',
        dependencies: [],
        machine_name_id: 'macbook-pro',
        user_agent_id: 'vscode-client'
      }
    ];
    const candidate2 = createDetailedCandidate('2026-09-10');
    candidate2.heartbeats = normalizeHeartbeatDay(rawHeartbeats2, { date: '2026-09-10', timezone: 'Europe/London' });

    reconcileDay(db, candidate2);

    // Active IDs must now be exactly HB_UUID_2
    const activeIdsAfter = syncRepo.getActiveHeartbeatIds('2026-09-10');
    expect(activeIdsAfter).toHaveLength(1);
    expect(activeIdsAfter[0]).not.toBe(activeIds[0]);

    // Check that HB_UUID_1 row still exists in raw heartbeats table but has active = 0 in memberships
    const hb1Membership = db.prepare(`SELECT active FROM heartbeat_memberships WHERE heartbeat_id = ?`).get(activeIds[0]) as { active: number };
    expect(hb1Membership.active).toBe(0);

    // Reconcile with conflicting payload for HB_UUID_2
    const rawConflicting = [
      {
        id: HB_UUID_2,
        time: 1789038060,
        entity: 'src/DIFFERENT_ENTITY.ts', // Conflict!
        type: 'file',
        category: 'coding',
        project: 'project-alpha',
        branch: 'main',
        language: 'TypeScript',
        dependencies: [],
        machine_name_id: 'macbook-pro',
        user_agent_id: 'vscode-client'
      }
    ];
    const candidateConflict = createDetailedCandidate('2026-09-10');
    candidateConflict.heartbeats = normalizeHeartbeatDay(rawConflicting, { date: '2026-09-10', timezone: 'Europe/London' });

    const conflictRes = reconcileDay(db, candidateConflict);
    expect(conflictRes.codes).toContain(RECONCILE_CODES.HEARTBEAT_PAYLOAD_CONFLICT);

    // Conflicting payload is recorded in heartbeat_variants as 'conflict'
    const variant = db.prepare('SELECT conflict_state FROM heartbeat_variants WHERE external_id = ? AND conflict_state = ?').get(HB_UUID_2, 'conflict');
    expect(variant).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // 9. Missing Identity Evidence Blocks Broader Work Fallback
  // --------------------------------------------------------------------------
  it('blocks broader work rule when machine/editor rules exist and heartbeat evidence is missing or stale', () => {
    const candidate = createDetailedCandidate('2026-09-10');
    reconcileDay(db, candidate);

    // Create an editor rule: editor 'emacs' -> work
    const preview1 = classification.previewRuleChange({
      type: 'create',
      rule: {
        name: 'Emacs Rule',
        classification: 'work',
        selectorType: 'editor',
        selectorValue: 'emacs'
      }
    });
    classification.createRule({
      id: preview1.proposedRuleId,
      name: 'Emacs Rule',
      classification: 'work',
      selectorType: 'editor',
      selectorValue: 'emacs'
    }, { expectedDigest: preview1.previewDigest });

    // Create a broader project rule: project 'project-alpha' -> work
    const preview2 = classification.previewRuleChange({
      type: 'create',
      rule: {
        name: 'Project Rule',
        classification: 'work',
        selectorType: 'project',
        selectorValue: 'project-alpha'
      }
    });
    classification.createRule({
      id: preview2.proposedRuleId,
      name: 'Project Rule',
      classification: 'work',
      selectorType: 'project',
      selectorValue: 'project-alpha'
    }, { expectedDigest: preview2.previewDigest });

    // When heartbeats layer is marked stale/unresolved in sync_layer_state
    db.prepare(`
      UPDATE sync_layer_state
      SET is_stale = 1, evidence_matches_summary = 0
      WHERE date = '2026-09-10' AND layer = 'heartbeats'
    `).run();

    // Classification evaluation for 2026-09-10
    const slices = classification.classifySlices({ date: '2026-09-10' });
    const appSlice = slices.find((s) => s.entity === 'src/app.ts')!;

    // Because editor rule exists and heartbeats are stale, broader project rule MUST NOT win
    expect(appSlice.decision.classification).toBe('unclassified');
    expect(appSlice.decision.source).toBe('default');
  });

  // --------------------------------------------------------------------------
  // 10. Analytics: Current Official Seconds and Excluded Detached
  // --------------------------------------------------------------------------
  it('calculates analytics using current official seconds and excludes detached allocations', async () => {
    const candidate = createDetailedCandidate('2026-09-10');
    reconcileDay(db, candidate);

    // Manual allocation on src/app.ts for work
    const slice = db.prepare("SELECT project_id FROM day_project_entity_slices WHERE entity = 'src/app.ts'").get() as { project_id: number };
    classification.createAllocation({
      date: '2026-09-10',
      projectId: slice.project_id,
      entity: 'src/app.ts',
      entityType: 'file',
      kind: 'entity',
      classification: 'work'
    });

    const initialSummary = await analytics.getRangeSummary({ start: '2026-09-10', end: '2026-09-10' });
    expect(initialSummary.workSeconds).toBe(4000.0);

    // Update duration of src/app.ts to 5500.0
    const rawUpdated = {
      data: [
        {
          date: '2026-09-10',
          range: { date: '2026-09-10', timezone: 'Europe/London' },
          grand_total: { total_seconds: 7200.0 },
          projects: [
            {
              name: 'project-alpha',
              total_seconds: 7200.0,
              entities: [
                { name: 'src/app.ts', type: 'file', total_seconds: 5500.0 },
                { name: 'src/utils.ts', type: 'file', total_seconds: 1700.0 }
              ]
            }
          ]
        }
      ]
    };
    const updateCandidate: DayCandidate = {
      date: '2026-09-10',
      timezone: 'Europe/London',
      connectionGeneration: 1,
      summaries: normalizeSummaryDay(rawUpdated, { date: '2026-09-10', accountTimezone: 'Europe/London' }),
      heartbeats: { kind: 'skipped', reason: 'none' }
    };
    reconcileDay(db, updateCandidate);

    const updatedSummary = await analytics.getRangeSummary({ start: '2026-09-10', end: '2026-09-10' });
    expect(updatedSummary.workSeconds).toBe(5500.0); // Uses new official duration

    // Now remove src/app.ts so allocation detaches
    const rawRemoved = {
      data: [
        {
          date: '2026-09-10',
          range: { date: '2026-09-10', timezone: 'Europe/London' },
          grand_total: { total_seconds: 7200.0 },
          projects: [
            {
              name: 'project-alpha',
              total_seconds: 7200.0,
              entities: [{ name: 'src/utils.ts', type: 'file', total_seconds: 7200.0 }]
            }
          ]
        }
      ]
    };
    const removedCandidate: DayCandidate = {
      date: '2026-09-10',
      timezone: 'Europe/London',
      connectionGeneration: 1,
      summaries: normalizeSummaryDay(rawRemoved, { date: '2026-09-10', accountTimezone: 'Europe/London' }),
      heartbeats: { kind: 'skipped', reason: 'none' }
    };
    reconcileDay(db, removedCandidate);

    const removedSummary = await analytics.getRangeSummary({ start: '2026-09-10', end: '2026-09-10' });
    // Detached allocation contributes 0 seconds
    expect(removedSummary.workSeconds).toBe(0);
  });

  // --------------------------------------------------------------------------
  // 11. Unchanged Summary + Degraded Heartbeat
  // --------------------------------------------------------------------------
  it('preserves accepted heartbeat layer on unchanged summary when heartbeats are degraded', () => {
    const candidate = createDetailedCandidate('2026-09-10');
    const firstRes = reconcileDay(db, candidate);
    expect(firstRes.disposition).toBe('updated');
    expect(firstRes.dayStatus).toBe('succeeded');

    const activeIdsBefore = syncRepo.getActiveHeartbeatIds('2026-09-10');
    expect(activeIdsBefore).toHaveLength(1);

    const hbFreshnessBefore = syncRepo.getLayerFreshness('2026-09-10', 'heartbeats');
    expect(hbFreshnessBefore?.acceptedSnapshotVersion).toBe(1);

    const hbIdentitiesBefore = db
      .prepare(`SELECT * FROM slice_identities WHERE source = 'heartbeat'`)
      .all();
    expect(hbIdentitiesBefore.length).toBeGreaterThan(0);

    const { runId } = syncRepo.enqueueRun(
      {
        mode: 'recent',
        trigger: 'manual',
        idempotencyKey: 'unchanged_degraded_hb',
        rangeStartDate: '2026-09-10',
        rangeEndDate: '2026-09-10'
      },
      ['2026-09-10']
    );

    // Reconcile unchanged summary with degraded (restricted) heartbeats
    const candidateDegraded = createDetailedCandidate('2026-09-10');
    candidateDegraded.heartbeats = {
      kind: 'restricted',
      code: 'HEARTBEATS_RATE_LIMITED',
      retryAt: '2026-09-10T12:00:00Z'
    };

    const res = reconcileDay(db, candidateDegraded, { runId });
    expect(res.disposition).toBe('unchanged');
    expect(res.dayStatus).toBe('partial');
    expect(res.codes).toContain('HEARTBEATS_RATE_LIMITED');

    // Preserves accepted layer exactly:
    const activeIdsAfter = syncRepo.getActiveHeartbeatIds('2026-09-10');
    expect(activeIdsAfter).toEqual(activeIdsBefore);

    const hbFreshnessAfter = syncRepo.getLayerFreshness('2026-09-10', 'heartbeats');
    expect(hbFreshnessAfter?.acceptedSnapshotVersion).toBe(1); // NOT advanced!

    const hbIdentitiesAfter = db
      .prepare(`SELECT * FROM slice_identities WHERE source = 'heartbeat'`)
      .all();
    expect(hbIdentitiesAfter).toEqual(hbIdentitiesBefore); // NOT cleared!

    // sync_days record reflects partial day status and restricted heartbeats
    const syncDay = syncRepo.getSyncDay(runId, '2026-09-10');
    expect(syncDay?.status).toBe('partial');
    expect(syncDay?.disposition).toBe('unchanged');
    expect(syncDay?.summariesStatus).toBe('succeeded');
    expect(syncDay?.heartbeatsStatus).toBe('restricted');
  });

  // --------------------------------------------------------------------------
  // 12. Changed Summary + Degraded Heartbeat
  // --------------------------------------------------------------------------
  it('updates summary, preserves previous heartbeat layer, and marks current evidence unavailable/false', () => {
    const candidate = createDetailedCandidate('2026-09-10');
    reconcileDay(db, candidate);

    const activeIdsBefore = syncRepo.getActiveHeartbeatIds('2026-09-10');
    expect(activeIdsBefore).toHaveLength(1);

    const { runId } = syncRepo.enqueueRun(
      {
        mode: 'recent',
        trigger: 'manual',
        idempotencyKey: 'changed_degraded_hb',
        rangeStartDate: '2026-09-10',
        rangeEndDate: '2026-09-10'
      },
      ['2026-09-10']
    );

    // Incoming candidate has updated summary but failed heartbeats
    const rawUpdated = {
      data: [
        {
          date: '2026-09-10',
          range: { date: '2026-09-10', timezone: 'Europe/London' },
          grand_total: { total_seconds: 9000.0, human_additions: 150, human_deletions: 30, ai_additions: 0, ai_deletions: 0, ai_sessions: 0 },
          projects: [
            {
              name: 'project-alpha',
              total_seconds: 9000.0,
              percent: 100.0,
              entities: [
                { name: 'src/app.ts', type: 'file', total_seconds: 5000.0 },
                { name: 'src/utils.ts', type: 'file', total_seconds: 4000.0 }
              ]
            }
          ]
        }
      ]
    };

    const updateCandidate: DayCandidate = {
      date: '2026-09-10',
      timezone: 'Europe/London',
      connectionGeneration: 1,
      summaries: normalizeSummaryDay(rawUpdated, { date: '2026-09-10', accountTimezone: 'Europe/London' }),
      heartbeats: { kind: 'failed', code: 'UPSTREAM_TIMEOUT', retryAt: null }
    };

    const res = reconcileDay(db, updateCandidate, { runId });
    expect(res.disposition).toBe('updated');
    expect(res.dayStatus).toBe('partial');
    expect(res.codes).toContain('UPSTREAM_TIMEOUT');

    // New slices are updated
    const appSlice = db.prepare(`SELECT total_seconds FROM day_project_entity_slices WHERE entity = 'src/app.ts'`).get() as { total_seconds: number };
    expect(appSlice.total_seconds).toBe(5000.0);

    // Previously accepted heartbeat memberships and identities are PRESERVED (not retired or cleared)
    const activeIdsAfter = syncRepo.getActiveHeartbeatIds('2026-09-10');
    expect(activeIdsAfter).toEqual(activeIdsBefore);

    const hbFreshnessAfter = syncRepo.getLayerFreshness('2026-09-10', 'heartbeats');
    expect(hbFreshnessAfter?.acceptedSnapshotVersion).toBe(1); // NOT advanced!

    // But current evidence is marked unavailable/false (0, NOT null, NOT 1) so classification cannot reuse it as current proof
    const hbLayerState = db
      .prepare(`SELECT evidence_matches_summary, has_failure, status_code FROM sync_layer_state WHERE date = '2026-09-10' AND layer = 'heartbeats'`)
      .get() as { evidence_matches_summary: number | null; has_failure: number; status_code: string };
    expect(hbLayerState.evidence_matches_summary).toBe(0);
    expect(hbLayerState.has_failure).toBe(1);
    expect(hbLayerState.status_code).toBe('UPSTREAM_TIMEOUT');

    const summaryLayerState = db
      .prepare(`SELECT evidence_matches_summary FROM sync_layer_state WHERE date = '2026-09-10' AND layer = 'summaries'`)
      .get() as { evidence_matches_summary: number | null };
    expect(summaryLayerState.evidence_matches_summary).toBe(0);

    // sync_days record reflects partial day status and failed heartbeats
    const syncDay = syncRepo.getSyncDay(runId, '2026-09-10');
    expect(syncDay?.status).toBe('partial');
    expect(syncDay?.disposition).toBe('updated');
    expect(syncDay?.summariesStatus).toBe('succeeded');
    expect(syncDay?.heartbeatsStatus).toBe('failed');
  });

  // --------------------------------------------------------------------------
  // 13. Conflict Preservation & Lossless Canonical Raw JSON
  // --------------------------------------------------------------------------
  it('preserves existing canonical heartbeat and stores full canonical JSON in quarantined variant on conflict', () => {
    const candidate = createDetailedCandidate('2026-09-10');
    reconcileDay(db, candidate);

    const initialHb = db
      .prepare(`SELECT id, external_id, canonical_hash, entity FROM heartbeats WHERE external_id = ?`)
      .get(HB_UUID_1) as { id: number; external_id: string; canonical_hash: string; entity: string };
    expect(initialHb.entity).toBe('src/app.ts');

    const rawConflicting = [
      {
        id: HB_UUID_1,
        time: 1789038000,
        entity: 'src/CONFLICTING_PAYLOAD.ts', // Conflicting entity!
        type: 'file',
        category: 'coding',
        project: 'project-alpha',
        branch: 'main',
        language: 'TypeScript',
        dependencies: ['vitest'],
        machine_name_id: 'macbook-pro',
        user_agent_id: 'vscode-client'
      }
    ];

    const candidateConflict = createDetailedCandidate('2026-09-10');
    candidateConflict.heartbeats = normalizeHeartbeatDay(rawConflicting, { date: '2026-09-10', timezone: 'Europe/London' });

    const conflictRes = reconcileDay(db, candidateConflict);
    expect(conflictRes.codes).toContain(RECONCILE_CODES.HEARTBEAT_PAYLOAD_CONFLICT);
    expect(conflictRes.dayStatus).toBe('partial');

    // Existing canonical heartbeat is PRESERVED (NOT overwritten by conflict!)
    const preservedHb = db
      .prepare(`SELECT id, external_id, canonical_hash, entity FROM heartbeats WHERE external_id = ?`)
      .get(HB_UUID_1) as { id: number; external_id: string; canonical_hash: string; entity: string };
    expect(preservedHb.canonical_hash).toBe(initialHb.canonical_hash);
    expect(preservedHb.entity).toBe('src/app.ts');

    // Conflicting variant is quarantined in heartbeat_variants
    const variant = db
      .prepare(`SELECT external_id, canonical_hash, raw_json, conflict_state FROM heartbeat_variants WHERE external_id = ? AND conflict_state = 'conflict'`)
      .get(HB_UUID_1) as { external_id: string; canonical_hash: string; raw_json: string; conflict_state: string };
    expect(variant).toBeDefined();
    expect(variant.conflict_state).toBe('conflict');

    // Lossless provenance: raw_json must contain the full canonical payload (not just external_id!)
    const parsedPayload = JSON.parse(variant.raw_json);
    expect(parsedPayload.id).toBe(HB_UUID_1);
    expect(parsedPayload.entity).toBe('src/CONFLICTING_PAYLOAD.ts');
    expect(parsedPayload.project).toBe('project-alpha');
    expect(parsedPayload.language).toBe('TypeScript');
    expect(parsedPayload.type).toBe('file');

    // Attempt is recorded with HEARTBEAT_PAYLOAD_CONFLICT
    const layerState = db
      .prepare(`SELECT status_code, has_failure, unresolved_mismatch FROM sync_layer_state WHERE date = '2026-09-10' AND layer = 'heartbeats'`)
      .get() as { status_code: string; has_failure: number; unresolved_mismatch: number };
    expect(layerState.status_code).toBe(RECONCILE_CODES.HEARTBEAT_PAYLOAD_CONFLICT);
    expect(layerState.has_failure).toBe(1);
    expect(layerState.unresolved_mismatch).toBe(1);
  });

  it('persists exact API source lineage, reuses identical raw bytes, and records changed raw bytes without a snapshot bump', () => {
    const candidate = createDetailedCandidate('2026-09-10');
    if (candidate.summaries.kind !== 'complete') throw new Error('expected complete summary');
    if (candidate.heartbeats.kind !== 'complete') throw new Error('expected complete heartbeats');
    const beat = candidate.heartbeats.value.heartbeats[0];
    const summaryRawA = '{ "data" : [ { "date" : "2026-09-10", "private" : "kept" } ] }';
    const summaryRawB = `{
  "data": [{"date":"2026-09-10","private":"kept"}]
}`;
    const heartbeatEventRaw = '{ "id" : "' + beat.id + '", "entity" : "src/app.ts", "unknown" : "kept" }';
    const heartbeatBatchRaw = '{"data":[' + heartbeatEventRaw + ']}';
    const rawSources = {
      summaries: { rawJson: summaryRawA },
      heartbeats: {
        rawJson: heartbeatBatchRaw,
        events: [
          {
            externalId: beat.id,
            canonicalHash: beat.canonicalHash,
            rawJson: heartbeatEventRaw
          }
        ]
      }
    };

    reconcileDay(db, candidate, { now: '2026-09-11T08:00:00.000Z', rawSources });

    const imports = db
      .prepare(
        `SELECT id, source_type, source_hash, byte_size
         FROM source_imports
         WHERE source_type IN ('api_summaries', 'api_heartbeats')
         ORDER BY id`
      )
      .all() as Array<{ id: number; source_type: string; source_hash: string; byte_size: number }>;
    expect(imports.map((row) => row.source_type)).toEqual(['api_summaries', 'api_heartbeats']);
    expect(imports[0].byte_size).toBe(new TextEncoder().encode(summaryRawA).byteLength);
    expect(imports[1].byte_size).toBe(new TextEncoder().encode(heartbeatBatchRaw).byteLength);
    expect(imports.every((row) => row.source_hash.length === 64 && row.byte_size > 0)).toBe(true);

    const summaryPayload = db
      .prepare(
        `SELECT endpoint, payload_hash, payload_json, first_seen_at, last_seen_at
         FROM source_payloads
         WHERE covered_date = ?`
      )
      .get('2026-09-10') as {
      endpoint: string;
      payload_hash: string;
      payload_json: string;
      first_seen_at: string;
      last_seen_at: string;
    };
    expect(summaryPayload.endpoint).toBe('api:summaries');
    expect(summaryPayload.payload_hash).toBe(candidate.summaries.contentHash);
    expect(summaryPayload.payload_json).toBe(summaryRawA);
    expect(summaryPayload.first_seen_at).toBe('2026-09-11T08:00:00.000Z');

    const variant = db
      .prepare(
        `SELECT v.raw_json, i.source_type
         FROM heartbeat_variants v
         JOIN source_imports i ON i.id = v.source_import_id
         WHERE v.external_id = ? AND v.canonical_hash = ?`
      )
      .get(beat.id, beat.canonicalHash) as { raw_json: string; source_type: string };
    expect(variant.raw_json).toBe(heartbeatEventRaw);
    expect(variant.source_type).toBe('api_heartbeats');

    const firstHeartbeatFreshness = syncRepo.getLayerFreshness('2026-09-10', 'heartbeats');
    expect(firstHeartbeatFreshness?.acceptedSnapshotVersion).toBe(1);
    expect(firstHeartbeatFreshness?.lastSuccessAt).toBe('2026-09-11T08:00:00.000Z');

    const replay = reconcileDay(db, candidate, {
      now: '2026-09-11T09:00:00.000Z',
      rawSources
    });
    expect(replay.disposition).toBe('unchanged');
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM source_imports
             WHERE source_type IN ('api_summaries', 'api_heartbeats')`
          )
          .get() as { count: number }
      ).count
    ).toBe(2);
    expect(
      (
        db
          .prepare(`SELECT last_seen_at FROM source_payloads WHERE covered_date = ?`)
          .get('2026-09-10') as { last_seen_at: string }
      ).last_seen_at
    ).toBe('2026-09-11T09:00:00.000Z');
    const replayHeartbeatFreshness = syncRepo.getLayerFreshness('2026-09-10', 'heartbeats');
    expect(replayHeartbeatFreshness?.acceptedSnapshotVersion).toBe(1);
    expect(replayHeartbeatFreshness?.lastSuccessAt).toBe('2026-09-11T09:00:00.000Z');

    const rawChanged = reconcileDay(db, candidate, {
      now: '2026-09-11T10:00:00.000Z',
      rawSources: {
        ...rawSources,
        summaries: { rawJson: summaryRawB }
      }
    });
    expect(rawChanged.disposition).toBe('unchanged');
    expect(syncRepo.getLayerFreshness('2026-09-10', 'summaries')?.acceptedSnapshotVersion).toBe(1);
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS count FROM source_imports WHERE source_type = 'api_summaries'`)
          .get() as { count: number }
      ).count
    ).toBe(2);
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS count FROM source_imports WHERE source_type = 'api_heartbeats'`)
          .get() as { count: number }
      ).count
    ).toBe(1);
    expect(
      (
        db
          .prepare(`SELECT payload_json FROM source_payloads ORDER BY id DESC LIMIT 1`)
          .get() as { payload_json: string }
      ).payload_json
    ).toBe(summaryRawB);
  });

  it('marks an unchanged nonzero summary partial when heartbeat evidence is skipped', () => {
    const candidate = createDetailedCandidate('2026-09-10');
    reconcileDay(db, candidate, { now: '2026-09-11T08:00:00.000Z' });
    const skippedCandidate = createDetailedCandidate('2026-09-10');
    skippedCandidate.heartbeats = { kind: 'skipped', reason: 'not-requested' };
    const result = reconcileDay(db, skippedCandidate, {
      now: '2026-09-11T09:00:00.000Z'
    });
    expect(result.disposition).toBe('unchanged');
    expect(result.dayStatus).toBe('partial');
    expect(syncRepo.getLayerFreshness('2026-09-10', 'summaries')?.acceptedSnapshotVersion).toBe(1);
    expect(syncRepo.getLayerFreshness('2026-09-10', 'heartbeats')?.acceptedSnapshotVersion).toBe(1);
  });

  it('invalidates classification caches after an accepted heartbeat identity change on an unchanged summary', () => {
    const initial = createDetailedCandidate('2026-09-10');
    reconcileDay(db, initial);
    let identityInvalidations = 0;
    let cacheClears = 0;
    let committedCalls = 0;
    const changed = createDetailedCandidate('2026-09-10');
    const replacementRaw = [
      {
        id: HB_UUID_2,
        time: 1789038060,
        entity: 'src/utils.ts',
        type: 'file',
        category: 'coding',
        project: 'project-alpha',
        machine_name_id: 'replacement-machine',
        user_agent_id: 'replacement-editor'
      }
    ];
    changed.heartbeats = normalizeHeartbeatDay(replacementRaw, {
      date: '2026-09-10',
      timezone: 'Europe/London'
    });
    const result = reconcileDay(db, changed, {
      classification: {
        invalidateIdentityCaches: () => {
          identityInvalidations += 1;
        },
        clearCaches: () => {
          cacheClears += 1;
        }
      },
      onCommitted: () => {
        committedCalls += 1;
      }
    });
    expect(result.disposition).toBe('unchanged');
    expect(result.dayStatus).toBe('succeeded');
    expect(identityInvalidations).toBe(1);
    expect(cacheClears).toBe(1);
    expect(committedCalls).toBe(1);
    expect(syncRepo.getLayerFreshness('2026-09-10', 'summaries')?.acceptedSnapshotVersion).toBe(1);
    expect(syncRepo.getLayerFreshness('2026-09-10', 'heartbeats')?.acceptedSnapshotVersion).toBe(2);
    expect(syncRepo.getActiveHeartbeatIds('2026-09-10')).toHaveLength(1);
  });

  it('preserves a previously detailed project when it is missing from incoming project scopes', () => {
    const date = '2026-09-10';
    const initialRaw = {
      data: [
        {
          date,
          range: { date, timezone: 'Europe/London' },
          grand_total: { total_seconds: 7200 },
          projects: [
            {
              name: 'project-alpha',
              total_seconds: 3600,
              entities: [{ name: 'src/a.ts', type: 'file', total_seconds: 3600 }]
            },
            {
              name: 'project-beta',
              total_seconds: 3600,
              entities: [{ name: 'src/b.ts', type: 'file', total_seconds: 3600 }]
            }
          ]
        }
      ]
    };
    const initial: DayCandidate = {
      date,
      timezone: 'Europe/London',
      connectionGeneration: 1,
      summaries: normalizeSummaryDay(initialRaw, { date, accountTimezone: 'Europe/London' }),
      heartbeats: { kind: 'skipped', reason: 'not-requested' }
    };
    reconcileDay(db, initial);
    const missingProjectRaw = {
      data: [
        {
          date,
          range: { date, timezone: 'Europe/London' },
          grand_total: { total_seconds: 3600 },
          projects: [
            {
              name: 'project-alpha',
              total_seconds: 3600,
              entities: [{ name: 'src/a.ts', type: 'file', total_seconds: 3600 }]
            }
          ]
        }
      ]
    };
    const missingProject: DayCandidate = {
      date,
      timezone: 'Europe/London',
      connectionGeneration: 1,
      summaries: normalizeSummaryDay(missingProjectRaw, {
        date,
        accountTimezone: 'Europe/London'
      }),
      heartbeats: { kind: 'skipped', reason: 'not-requested' }
    };

    const result = reconcileDay(db, missingProject);
    expect(result.disposition).toBe('preserved');
    expect(result.dayStatus).toBe('partial');
    expect(result.codes).toContain(RECONCILE_CODES.DETAIL_DOWNGRADE);
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM day_project_entity_slices s
             JOIN projects p ON p.id = s.project_id
             WHERE s.date = ? AND p.name = 'project-beta' AND s.entity = 'src/b.ts'`
          )
          .get(date) as { count: number }
      ).count
    ).toBe(1);
    expect(
      (
        db.prepare(`SELECT total_seconds FROM daily_totals WHERE date = ?`).get(date) as {
          total_seconds: number;
        }
      ).total_seconds
    ).toBe(7200);
  });

});
