import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDatabase } from '../db/connection.js';
import { syncDayWorker } from './worker.js';
import { createRecordingFetch } from './fetch-day.js';
import { SqliteSyncRepository } from './repository.js';
import { WakaTimeClient } from '../wakatime/client.js';
import { RECONCILE_CODES } from './contracts.js';
import { VERIFIED_ZERO_DAY_RAW } from './fixtures/index.js';

describe('syncDayWorker (Single-Date Worker)', () => {
  let db: Database.Database;
  let syncRepo: SqliteSyncRepository;
  const fixedNow = new Date('2026-09-10T12:00:00.000Z');
  const dummyToken = 'test_token_worker_123';

  const validDetailedSummaryRaw = {
    data: [
      {
        date: '2026-09-08',
        range: {
          date: '2026-09-08',
          start: '2026-09-08T00:00:00Z',
          end: '2026-09-08T23:59:59Z',
          timezone: 'Europe/London'
        },
        grand_total: {
          total_seconds: 7200,
          human_additions: 50,
          human_deletions: 10,
          ai_additions: 0,
          ai_deletions: 0,
          ai_sessions: 0
        },
        projects: [
          {
            name: 'work-times',
            total_seconds: 7200,
            percent: 100,
            entities: [
              {
                name: 'src/lib/server/worker.ts',
                type: 'file',
                total_seconds: 7200,
                percent: 100
              }
            ]
          }
        ]
      }
    ]
  };

  const validHeartbeatsRaw = {
    data: [
      {
        id: '999e4567-e89b-12d3-a456-426614174999',
        entity: 'src/lib/server/worker.ts',
        type: 'file',
        time: 1788868800, // 2026-09-08T12:00:00Z
        project: 'work-times',
        branch: 'main',
        language: 'TypeScript',
        category: 'coding',
        dependencies: ['better-sqlite3'],
        user_agent_id: 'ua_worker'
      }
    ]
  };

  beforeEach(() => {
    db = openTestDatabase();
    syncRepo = new SqliteSyncRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('orchestrates complete single-date sync: fetches, normalizes, and reconciles atomically', async () => {
    const summaryJson = JSON.stringify(validDetailedSummaryRaw);
    const heartbeatsJson = JSON.stringify(validHeartbeatsRaw);

    const baseFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('/summaries')) {
        return new Response(summaryJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/heartbeats')) {
        return new Response(heartbeatsJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    };

    const recording = createRecordingFetch(baseFetch);
    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: recording.fetch });

    // Enqueue run in SQLite repository with target date
    const { runId } = syncRepo.enqueueRun(
      {
        mode: 'recent',
        trigger: 'manual',
        rangeStartDate: '2026-09-08',
        rangeEndDate: '2026-09-08',
        idempotencyKey: 'run_test_1'
      },
      ['2026-09-08']
    );

    const result = await syncDayWorker({
      db,
      date: '2026-09-08',
      client,
      runId,
      pinnedTimezone: 'Europe/London',
      recordingFetch: recording,
      syncRepo,
      now: () => fixedNow
    });

    expect(result.status).toBe('succeeded');
    expect(result.disposition).toBe('updated');
    expect(result.totalSeconds).toBe(7200);
    expect(result.heartbeatCount).toBe(1);

    // Verify durable SQLite records
    const syncDay = syncRepo.getSyncDay(runId, '2026-09-08');
    expect(syncDay?.status).toBe('succeeded');
    expect(syncDay?.disposition).toBe('updated');
    expect(syncDay?.totalSeconds).toBe(7200);
    expect(syncDay?.heartbeatCount).toBe(1);

    // Verify daily totals
    const dailyTotal = db.prepare('SELECT total_seconds FROM daily_totals WHERE date = ?').get('2026-09-08') as {
      total_seconds: number;
    };
    expect(dailyTotal.total_seconds).toBe(7200);

    // Verify slices
    const slices = db.prepare('SELECT entity, total_seconds FROM day_project_entity_slices WHERE date = ?').all('2026-09-08') as Array<{
      entity: string;
      total_seconds: number;
    }>;
    expect(slices.length).toBe(1);
    expect(slices[0].entity).toBe('src/lib/server/worker.ts');
    expect(slices[0].total_seconds).toBe(7200);

    // Verify layer freshness
    const summaryFreshness = syncRepo.getLayerFreshness('2026-09-08', 'summaries');
    expect(summaryFreshness?.acceptedSnapshotVersion).toBe(1);
    expect(summaryFreshness?.acceptedFidelity).toBe('entity_detail');
  });

  it('ensures idempotent unchanged replay without snapshot inflation or duplicated slices', async () => {
    const summaryJson = JSON.stringify(validDetailedSummaryRaw);
    const heartbeatsJson = JSON.stringify(validHeartbeatsRaw);

    const baseFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('/summaries')) {
        return new Response(summaryJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/heartbeats')) {
        return new Response(heartbeatsJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    };

    const recording = createRecordingFetch(baseFetch);
    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: recording.fetch });

    const { runId: run1 } = syncRepo.enqueueRun(
      {
        mode: 'recent',
        trigger: 'manual',
        rangeStartDate: '2026-09-08',
        rangeEndDate: '2026-09-08',
        idempotencyKey: 'run_replay_1'
      },
      ['2026-09-08']
    );

    // Run 1: initial update
    const result1 = await syncDayWorker({
      db,
      date: '2026-09-08',
      client,
      runId: run1,
      pinnedTimezone: 'Europe/London',
      recordingFetch: recording,
      syncRepo,
      now: () => fixedNow
    });
    expect(result1.disposition).toBe('updated');

    const freshnessBefore = syncRepo.getLayerFreshness('2026-09-08', 'summaries');
    const snapshotBefore = freshnessBefore?.acceptedSnapshotVersion;
    expect(snapshotBefore).toBe(1);

    const slicesBefore = db.prepare('SELECT id, entity FROM day_project_entity_slices WHERE date = ?').all('2026-09-08') as Array<{
      id: number;
      entity: string;
    }>;

    // Run 2: repeat execution with identical normalized data
    const { runId: run2 } = syncRepo.enqueueRun(
      {
        mode: 'recent',
        trigger: 'manual',
        rangeStartDate: '2026-09-08',
        rangeEndDate: '2026-09-08',
        idempotencyKey: 'run_replay_2'
      },
      ['2026-09-08']
    );

    const result2 = await syncDayWorker({
      db,
      date: '2026-09-08',
      client,
      runId: run2,
      pinnedTimezone: 'Europe/London',
      recordingFetch: recording,
      syncRepo,
      now: () => fixedNow
    });

    expect(result2.status).toBe('succeeded');
    expect(result2.disposition).toBe('unchanged');

    // Snapshot version must NOT have inflated
    const freshnessAfter = syncRepo.getLayerFreshness('2026-09-08', 'summaries');
    expect(freshnessAfter?.acceptedSnapshotVersion).toBe(snapshotBefore);

    // Slice IDs must remain stable without duplication
    const slicesAfter = db.prepare('SELECT id, entity FROM day_project_entity_slices WHERE date = ?').all('2026-09-08') as Array<{
      id: number;
      entity: string;
    }>;
    expect(slicesAfter).toEqual(slicesBefore);
  });

  it('preserves manual allocations when duration changes on source update', async () => {
    const summaryJson1 = JSON.stringify(validDetailedSummaryRaw);
    const baseFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('/summaries')) {
        return new Response(summaryJson1, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/heartbeats')) {
        return new Response(JSON.stringify(validHeartbeatsRaw), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    };

    const recording = createRecordingFetch(baseFetch);
    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: recording.fetch });

    // Initial sync
    await syncDayWorker({
      db,
      date: '2026-09-08',
      client,
      pinnedTimezone: 'Europe/London',
      recordingFetch: recording,
      syncRepo,
      now: () => fixedNow
    });

    // Create an active manual allocation on the slice using semantic identity
    const slice = db.prepare('SELECT id, project_id, entity, entity_type, kind FROM day_project_entity_slices WHERE date = ?').get('2026-09-08') as {
      id: number;
      project_id: number;
      entity: string;
      entity_type: string;
      kind: string;
    };

    db.prepare(`
      INSERT INTO daily_time_allocations (
        id, date, project_id, entity, entity_type, kind, classification, allocated_seconds, note, state
      ) VALUES (?, ?, ?, ?, ?, ?, 'work', ?, 'Important client feature', 'active')
    `).run('alloc_1', '2026-09-08', slice.project_id, slice.entity, slice.entity_type, slice.kind, 7200);

    // Second sync: duration changes to 9000s
    const updatedSummary = JSON.parse(summaryJson1);
    updatedSummary.data[0].grand_total.total_seconds = 9000;
    updatedSummary.data[0].projects[0].total_seconds = 9000;
    updatedSummary.data[0].projects[0].entities[0].total_seconds = 9000;

    const updatedFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('/summaries')) {
        return new Response(JSON.stringify(updatedSummary), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/heartbeats')) {
        return new Response(JSON.stringify(validHeartbeatsRaw), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    };

    const client2 = new WakaTimeClient({ accessToken: dummyToken, fetch: updatedFetch });

    const result2 = await syncDayWorker({
      db,
      date: '2026-09-08',
      client: client2,
      pinnedTimezone: 'Europe/London',
      syncRepo,
      now: () => fixedNow
    });

    expect(result2.disposition).toBe('updated');

    // Check that allocation survived and allocated_seconds was adjusted to new official total
    const alloc = db.prepare('SELECT state, allocated_seconds, note FROM daily_time_allocations WHERE id = ?').get('alloc_1') as {
      state: string;
      allocated_seconds: number;
      note: string;
    };
    expect(alloc.state).toBe('active');
    expect(alloc.allocated_seconds).toBe(9000);
    expect(alloc.note).toBe('Important client feature');

    // Audit revisions must record the duration adjustment in classification_revisions
    const revisions = db.prepare('SELECT mutation_type FROM classification_revisions WHERE target_id = ?').all('alloc_1') as Array<{
      mutation_type: string;
    }>;
    expect(revisions.length).toBeGreaterThan(0);
    expect(revisions.some((r) => r.mutation_type.includes('reconciliation') || r.mutation_type.includes('adjusted'))).toBe(true);
  });

  it('rechecks cancellation immediately before reconcile commit and aborts cleanly', async () => {
    const summaryJson = JSON.stringify(validDetailedSummaryRaw);
    const mockFetch: typeof fetch = async () => {
      return new Response(summaryJson, { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: mockFetch });

    const { runId } = syncRepo.enqueueRun(
      {
        mode: 'recent',
        trigger: 'manual',
        rangeStartDate: '2026-09-08',
        rangeEndDate: '2026-09-08',
        idempotencyKey: 'run_cancel_precommit'
      },
      ['2026-09-08']
    );

    // Request cancellation of the run right after enqueue
    syncRepo.cancelRun(runId);

    const result = await syncDayWorker({
      db,
      date: '2026-09-08',
      client,
      runId,
      pinnedTimezone: 'Europe/London',
      syncRepo,
      now: () => fixedNow
    });

    expect(result.status).toBe('cancelled');
    expect(result.advisoryCodes).toContain(RECONCILE_CODES.RUN_CANCELLED);

    // No slices or totals must have been committed to SQLite
    const totalCount = db.prepare('SELECT COUNT(*) as c FROM daily_totals WHERE date = ?').get('2026-09-08') as { c: number };
    expect(totalCount.c).toBe(0);
  });

  it('rejects candidate when connection generation CAS fails', async () => {
    const summaryJson = JSON.stringify(validDetailedSummaryRaw);
    const mockFetch: typeof fetch = async () => {
      return new Response(summaryJson, { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: mockFetch });

    // Current DB settings has connection generation 1. We pass stale expected generation 999.
    const result = await syncDayWorker({
      db,
      date: '2026-09-08',
      client,
      connectionGeneration: 999,
      pinnedTimezone: 'Europe/London',
      syncRepo,
      now: () => fixedNow
    });

    expect(result.status).toBe('failed');
    expect(result.disposition).toBe('rejected');
    expect(result.advisoryCodes).toContain(RECONCILE_CODES.STALE_CONNECTION_GENERATION);
  });

  it('rejects candidate when staged day size exceeds ceiling (64 MiB)', async () => {
    const summaryJson = JSON.stringify(validDetailedSummaryRaw);
    const mockFetch: typeof fetch = async () => {
      return new Response(summaryJson, { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: mockFetch });

    // Set maxStagedDayBytes to very small (e.g. 50 bytes) to force limit exceed
    const result = await syncDayWorker({
      db,
      date: '2026-09-08',
      client,
      pinnedTimezone: 'Europe/London',
      maxStagedDayBytes: 50,
      syncRepo,
      now: () => fixedNow
    });

    expect(result.status).toBe('failed');
    expect(result.disposition).toBe('rejected');
    expect(result.advisoryCodes).toContain(RECONCILE_CODES.STAGED_DAY_SIZE_EXCEEDED);
  });

  it('handles optional heartbeat failure on nonzero day by marking status partial', async () => {
    const summaryJson = JSON.stringify(validDetailedSummaryRaw);
    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('/summaries')) {
        return new Response(summaryJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/heartbeats')) {
        return new Response(JSON.stringify({ error: 'Endpoint forbidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(null, { status: 404 });
    };

    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: mockFetch });

    const result = await syncDayWorker({
      db,
      date: '2026-09-08',
      client,
      pinnedTimezone: 'Europe/London',
      syncRepo,
      now: () => fixedNow
    });

    // Nonzero summary day with restricted heartbeats must be partial
    expect(result.status).toBe('partial');
    expect(result.heartbeatsStatus).toBe('restricted');
    expect(result.totalSeconds).toBe(7200);
    expect(result.advisoryCodes).toContain('HEARTBEATS_PLAN_RESTRICTED');
  });

  it('handles verified zero day truthfully: succeeds without heartbeat request, skipped heartbeat status, no heartbeat rawSources, and no successful heartbeat freshness', async () => {
    const zeroSummaryJson = JSON.stringify(VERIFIED_ZERO_DAY_RAW);
    const requestedUrls: string[] = [];

    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      requestedUrls.push(url);
      if (url.includes('/summaries')) {
        return new Response(zeroSummaryJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    };

    const recording = createRecordingFetch(mockFetch);
    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: recording.fetch });

    const { runId } = syncRepo.enqueueRun(
      {
        mode: 'recent',
        trigger: 'manual',
        rangeStartDate: '2026-09-07',
        rangeEndDate: '2026-09-07',
        idempotencyKey: 'run_zero_1'
      },
      ['2026-09-07']
    );

    const result = await syncDayWorker({
      db,
      date: '2026-09-07',
      client,
      runId,
      pinnedTimezone: 'Europe/London',
      recordingFetch: recording,
      syncRepo,
      now: () => fixedNow
    });

    // 1. Day succeeds
    expect(result.status).toBe('succeeded');
    expect(result.totalSeconds).toBe(0);
    expect(result.advisoryCodes).toContain(RECONCILE_CODES.VERIFIED_ZERO_ACCEPTED);

    // 2. No heartbeat call occurred
    expect(requestedUrls.some((u) => u.includes('/heartbeats'))).toBe(false);

    // 3. Heartbeat status is truthfully skipped
    expect(result.heartbeatsStatus).toBe('skipped');
    const syncDay = syncRepo.getSyncDay(runId, '2026-09-07');
    expect(syncDay?.heartbeatsStatus).toBe('skipped');

    // 4. No heartbeat rawSources invented
    expect(result.rawSources?.heartbeats).toBeUndefined();
    const hbPayloads = db.prepare("SELECT COUNT(*) as c FROM source_payloads WHERE endpoint LIKE '%heartbeat%' AND covered_date = ?").get('2026-09-07') as { c: number };
    expect(hbPayloads.c).toBe(0);

    // 5. No successful heartbeat freshness or accepted version
    const hbFreshness = syncRepo.getLayerFreshness('2026-09-07', 'heartbeats');
    expect(hbFreshness?.acceptedSnapshotVersion).toBeFalsy();
  });

  it('rejects candidate when batch payload fits but batch plus per-event payloads exceeds staged ceiling', async () => {
    // First, seed accepted data for 2026-09-08
    const summaryJson = JSON.stringify(validDetailedSummaryRaw);
    const heartbeatsJson = JSON.stringify(validHeartbeatsRaw);

    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('/summaries')) {
        return new Response(summaryJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/heartbeats')) {
        return new Response(heartbeatsJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    };

    const recording = createRecordingFetch(mockFetch);
    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: recording.fetch });

    const seedResult = await syncDayWorker({
      db,
      date: '2026-09-08',
      client,
      pinnedTimezone: 'Europe/London',
      recordingFetch: recording,
      syncRepo,
      now: () => fixedNow
    });
    expect(seedResult.status).toBe('succeeded');
    expect(seedResult.disposition).toBe('updated');

    // Verify accepted data in SQLite
    const totalBefore = db.prepare('SELECT total_seconds FROM daily_totals WHERE date = ?').get('2026-09-08') as { total_seconds: number };
    expect(totalBefore.total_seconds).toBe(7200);

    // Now construct a payload where batch alone (summaryBytes + heartbeatBatchBytes) fits,
    // but batch + per-event payloads exceeds the ceiling
    const summaryBytes = Buffer.byteLength(summaryJson, 'utf8');
    const heartbeatBatchBytes = Buffer.byteLength(heartbeatsJson, 'utf8');
    const batchBytes = summaryBytes + heartbeatBatchBytes;

    // Build rawSources with 10 event payloads of 100 bytes each
    const dummyEvents = Array.from({ length: 10 }, (_, i) => ({
      externalId: `evt_${i}`,
      canonicalHash: `hash_${i}`,
      rawJson: JSON.stringify({ id: `evt_${i}`, dummy: 'x'.repeat(80) })
    }));
    const eventBytes = dummyEvents.reduce((acc, e) => acc + Buffer.byteLength(e.rawJson, 'utf8'), 0);

    // Set ceiling between batchBytes and batchBytes + eventBytes
    const injectedCeiling = batchBytes + Math.floor(eventBytes / 2);
    expect(batchBytes).toBeLessThan(injectedCeiling);
    expect(batchBytes + eventBytes).toBeGreaterThan(injectedCeiling);

    const result = await syncDayWorker({
      db,
      date: '2026-09-08',
      client,
      pinnedTimezone: 'Europe/London',
      maxStagedDayBytes: injectedCeiling,
      rawSources: {
        summaries: { rawJson: summaryJson },
        heartbeats: { rawJson: heartbeatsJson, events: dummyEvents }
      },
      syncRepo,
      now: () => fixedNow
    });

    expect(result.status).toBe('failed');
    expect(result.disposition).toBe('rejected');
    expect(result.advisoryCodes).toContain(RECONCILE_CODES.STAGED_DAY_SIZE_EXCEEDED);

    // Accepted data in SQLite MUST remain untouched!
    const totalAfter = db.prepare('SELECT total_seconds FROM daily_totals WHERE date = ?').get('2026-09-08') as { total_seconds: number };
    expect(totalAfter.total_seconds).toBe(7200);
    const freshness = syncRepo.getLayerFreshness('2026-09-08', 'summaries');
    expect(freshness?.acceptedSnapshotVersion).toBe(1);
  });

  it('reflects response/commit time in freshness and attempt metadata with advancing injected clock', async () => {
    const summaryJson = JSON.stringify(validDetailedSummaryRaw);
    const heartbeatsJson = JSON.stringify(validHeartbeatsRaw);

    let clockTicks = 0;
    // Clock starts at fixedNow, advances by 10s on each check
    const advancingNow = () => {
      clockTicks++;
      return new Date(fixedNow.getTime() + clockTicks * 10000);
    };

    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('/summaries')) {
        return new Response(summaryJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/heartbeats')) {
        return new Response(heartbeatsJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    };

    const recording = createRecordingFetch(mockFetch);
    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: recording.fetch });

    const { runId } = syncRepo.enqueueRun(
      {
        mode: 'recent',
        trigger: 'manual',
        rangeStartDate: '2026-09-08',
        rangeEndDate: '2026-09-08',
        idempotencyKey: 'run_clock_1'
      },
      ['2026-09-08']
    );

    const result = await syncDayWorker({
      db,
      date: '2026-09-08',
      client,
      runId,
      pinnedTimezone: 'Europe/London',
      recordingFetch: recording,
      syncRepo,
      now: advancingNow
    });

    expect(result.status).toBe('succeeded');

    // Freshness metadata must reflect a timestamp after the initial start
    const freshness = syncRepo.getLayerFreshness('2026-09-08', 'summaries');
    expect(freshness).toBeDefined();
    const freshnessSuccessTime = new Date(freshness!.lastSuccessAt!).getTime();
    expect(freshnessSuccessTime).toBeGreaterThan(fixedNow.getTime());
    const freshnessAttemptTime = new Date(freshness!.lastAttemptAt!).getTime();
    expect(freshnessAttemptTime).toBeGreaterThan(fixedNow.getTime());

    // Sync day record synced_at must also be strictly greater than start time
    const syncDay = syncRepo.getSyncDay(runId, '2026-09-08');
    expect(syncDay?.syncedAt).toBeDefined();
    const syncedAtTime = new Date(syncDay!.syncedAt!).getTime();
    expect(syncedAtTime).toBeGreaterThan(fixedNow.getTime());
  });

  it('preserves accepted data and never becomes complete empty data on malformed summary failure', async () => {
    // 1. Seed accepted data
    const summaryJson = JSON.stringify(validDetailedSummaryRaw);
    const heartbeatsJson = JSON.stringify(validHeartbeatsRaw);
    const baseFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('/summaries')) {
        return new Response(summaryJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/heartbeats')) {
        return new Response(heartbeatsJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    };
    const client1 = new WakaTimeClient({ accessToken: dummyToken, fetch: baseFetch });

    await syncDayWorker({
      db,
      date: '2026-09-08',
      client: client1,
      pinnedTimezone: 'Europe/London',
      syncRepo,
      now: () => fixedNow
    });

    // Verify initial acceptance
    const totalBefore = db.prepare('SELECT total_seconds FROM daily_totals WHERE date = ?').get('2026-09-08') as { total_seconds: number };
    expect(totalBefore.total_seconds).toBe(7200);

    // 2. Subsequent sync returns malformed/incomplete summary (missing grand_total)
    const malformedFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({ data: [{ date: '2026-09-08' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    const client2 = new WakaTimeClient({ accessToken: dummyToken, fetch: malformedFetch });

    const result = await syncDayWorker({
      db,
      date: '2026-09-08',
      client: client2,
      pinnedTimezone: 'Europe/London',
      syncRepo,
      now: () => fixedNow
    });

    expect(result.status).toBe('failed');
    expect(result.disposition).toBe('rejected');

    // Accepted data in SQLite MUST be preserved (NOT complete empty data)
    const totalAfter = db.prepare('SELECT total_seconds FROM daily_totals WHERE date = ?').get('2026-09-08') as { total_seconds: number };
    expect(totalAfter.total_seconds).toBe(7200);
    const slices = db.prepare('SELECT COUNT(*) as c FROM day_project_entity_slices WHERE date = ?').get('2026-09-08') as { c: number };
    expect(slices.c).toBe(1);
  });

  it('preserves accepted data on response-size exceeded failure', async () => {
    // 1. Seed accepted data
    const summaryJson = JSON.stringify(validDetailedSummaryRaw);
    const client1 = new WakaTimeClient({
      accessToken: dummyToken,
      fetch: (async () => new Response(summaryJson, { status: 200, headers: { 'content-type': 'application/json' } })) as any
    });

    await syncDayWorker({
      db,
      date: '2026-09-08',
      client: client1,
      pinnedTimezone: 'Europe/London',
      syncRepo,
      now: () => fixedNow
    });

    // 2. Next sync encounters response size exceeded
    const oversizeFetch: typeof fetch = async () => {
      const payload = 'x'.repeat(200);
      return new Response(payload, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(payload.length) }
      });
    };
    const client2 = new WakaTimeClient({
      accessToken: dummyToken,
      fetch: oversizeFetch,
      maxResponseSizeBytes: 50
    });

    const result = await syncDayWorker({
      db,
      date: '2026-09-08',
      client: client2,
      pinnedTimezone: 'Europe/London',
      syncRepo,
      now: () => fixedNow
    });

    expect(result.status).toBe('failed');
    expect(result.disposition).toBe('rejected');

    // Accepted data preserved
    const total = db.prepare('SELECT total_seconds FROM daily_totals WHERE date = ?').get('2026-09-08') as { total_seconds: number };
    expect(total.total_seconds).toBe(7200);
  });

  it('preserves accepted data on in-flight cancellation', async () => {
    // 1. Seed accepted data
    const summaryJson = JSON.stringify(validDetailedSummaryRaw);
    const client1 = new WakaTimeClient({
      accessToken: dummyToken,
      fetch: (async () => new Response(summaryJson, { status: 200, headers: { 'content-type': 'application/json' } })) as any
    });

    await syncDayWorker({
      db,
      date: '2026-09-08',
      client: client1,
      pinnedTimezone: 'Europe/London',
      syncRepo,
      now: () => fixedNow
    });

    // 2. Next sync with in-flight cancellation
    const controller = new AbortController();
    const abortingFetch: typeof fetch = async () => {
      controller.abort(new Error('In-flight cancellation'));
      throw controller.signal.reason;
    };
    const client2 = new WakaTimeClient({ accessToken: dummyToken, fetch: abortingFetch });

    const result = await syncDayWorker({
      db,
      date: '2026-09-08',
      client: client2,
      signal: controller.signal,
      pinnedTimezone: 'Europe/London',
      syncRepo,
      now: () => fixedNow
    });

    expect(result.status).toBe('cancelled');
    expect(result.disposition).toBe('rejected');

    // Accepted data preserved
    const total = db.prepare('SELECT total_seconds FROM daily_totals WHERE date = ?').get('2026-09-08') as { total_seconds: number };
    expect(total.total_seconds).toBe(7200);
  });
});
