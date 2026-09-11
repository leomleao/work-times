/**
 * Transactional reconciliation engine for Work Times.
 *
 * Implements Stage B of Milestone P3 (docs/NEXT-MILESTONE.md §2.3-2.5):
 * - Strict adherence to the fidelity matrix and source lineage.
 * - Mathematical invariant enforcement (0.001s tolerance, no negative residual, sum(slices) == daily_total).
 * - Full transactional rollback on mid-write failure or invariant violation.
 * - Snapshot versioning and connection generation checks.
 * - Manual allocation preservation: duration adjustments, auditable detachment, reattachment,
 *   and coarse-to-entity detachment.
 * - Active heartbeat evidence membership management and conflict handling.
 */

import type Database from 'better-sqlite3';
import { getZonedDateString, isValidDateString } from '../sync/calendar.js';
import {
  DURATION_COMPARISON_TOLERANCE_SECONDS,
  RECONCILE_CODES,
  type DayCandidate,
  type NormalizedHeartbeatEvent,
  type NormalizedScopedDimension,
  type NormalizedSlice,
  type ReconcileCode,
  type ReconcileDayStatus,
  type ReconcileDisposition,
  type ReconcileResult
} from './types.js';
import { SqliteSyncRepository, type SyncRepository } from '../sync/repository.js';
import {
  canonicalHeartbeatPayload,
  normalizeEntity,
  sliceIntrinsicIdentities,
  stableStringify,
  sha256Hex
} from '../import/canonical.js';

export interface ReconcileRawSourcePayload {
  /** Exact UTF-8 JSON response text consumed by the normalizer. */
  rawJson: string;
}

export interface ReconcileRawHeartbeatEvent {
  externalId: string;
  canonicalHash: string;
  /** Exact UTF-8 JSON text for this event object. */
  rawJson: string;
}

export interface ReconcileHeartbeatSourcePayload extends ReconcileRawSourcePayload {
  events?: readonly ReconcileRawHeartbeatEvent[];
}

export interface ReconcileDayOptions {
  /** Optional sync run ID to update sync_days record. */
  runId?: number;
  /** Optional source reference string (e.g. 'api:2026-01-01' or 'dump'). */
  sourceReference?: string;
  /**
   * Exact transport payloads supplied by the single-date fetcher. Normalized
   * content hashes remain separate from these byte-faithful observations.
   */
  rawSources?: {
    summaries?: ReconcileRawSourcePayload;
    heartbeats?: ReconcileHeartbeatSourcePayload;
  };
  /** Optional legacy source import ID to attribute stored slices/totals to. */
  sourceImportId?: number;
  /** Optional expected snapshot version to guard against concurrent mutations. */
  expectedSnapshotVersion?: number;
  /** Cancellation check callback. */
  isCancelled?: () => boolean;
  /** Pinned/verified account timezone. */
  pinnedTimezone?: string;
  /** Explicit ISO 8601 timestamp for reconciliation operations and audits. */
  now?: string;
  /** Inject a failure inside the transaction to verify atomic rollback. */
  injectFailure?: 'before_commit' | 'after_slices' | 'after_allocations';
  /** Optional pre-instantiated sync repository. */
  syncRepo?: SyncRepository;
  /** Optional classification service to invalidate caches post-commit. */
  classification?: { invalidateIdentityCaches(): void; clearCaches(): void };
  /** Optional post-commit callback. */
  onCommitted?: () => void;
}

function computeSliceKey(
  projectId: number,
  entity: string,
  entityType: string,
  kind: string
): string {
  return `${projectId}\u0000${entity}\u0000${entityType}\u0000${kind}`;
}

function heartbeatRawKey(externalId: string, canonicalHash: string): string {
  return `${externalId}\u0000${canonicalHash}`;
}

function serializeCanonicalHeartbeatPayload(beat: NormalizedHeartbeatEvent): string {
  const payload = canonicalHeartbeatPayload({
    id: beat.id,
    time: beat.occurredAtUs / 1000000,
    entity: beat.entity,
    type: beat.entityType,
    category: beat.category,
    project: beat.projectName,
    branch: beat.branch,
    language: beat.language,
    dependencies: beat.dependencies,
    machine_name_id: beat.machineNameId,
    user_agent_id: beat.userAgentId,
    is_write: beat.isWrite,
    lines: beat.lines,
    lineno: beat.lineno,
    cursorpos: beat.cursorpos
  });
  return stableStringify(payload);
}

function serializeHeartbeatPayload(
  beat: NormalizedHeartbeatEvent,
  exactRawByKey: ReadonlyMap<string, string>
): string {
  return exactRawByKey.get(heartbeatRawKey(beat.id, beat.canonicalHash)) ?? serializeCanonicalHeartbeatPayload(beat);
}

export function reconcileDay(
  db: Database.Database,
  candidate: DayCandidate,
  options?: ReconcileDayOptions
): ReconcileResult {
  const syncRepo = options?.syncRepo ?? new SqliteSyncRepository(db);
  const now = options?.now ?? new Date().toISOString();

  // ==========================================================================
  // Phase 1: Pre-Transaction Validation & Early Guards
  // ==========================================================================

  // 1. Date string validation
  if (!isValidDateString(candidate.date)) {
    if (options?.runId) {
      syncRepo.updateSyncDay(
        options.runId,
        candidate.date,
        {
          status: 'failed',
          disposition: 'rejected',
          summariesStatus: 'failed',
          advisoryCodes: [RECONCILE_CODES.MISSING_REQUESTED_DATE]
        },
        now
      );
    }
    return {
      disposition: 'rejected',
      dayStatus: 'failed',
      codes: [RECONCILE_CODES.MISSING_REQUESTED_DATE]
    };
  }

  // 2. Candidate layer status guards
  if (candidate.summaries.kind === 'restricted') {
    if (options?.runId) {
      syncRepo.updateSyncDay(
        options.runId,
        candidate.date,
        {
          status: 'skipped',
          disposition: 'preserved',
          summariesStatus: 'restricted',
          advisoryCodes: [candidate.summaries.code || 'SUMMARIES_RESTRICTED']
        },
        now
      );
    }
    return {
      disposition: 'preserved',
      dayStatus: 'skipped',
      codes: [candidate.summaries.code || 'SUMMARIES_RESTRICTED']
    };
  }

  if (candidate.summaries.kind === 'failed') {
    if (options?.runId) {
      syncRepo.updateSyncDay(
        options.runId,
        candidate.date,
        {
          status: 'failed',
          disposition: 'rejected',
          summariesStatus: 'failed',
          advisoryCodes: [candidate.summaries.code || 'SUMMARIES_FAILED']
        },
        now
      );
    }
    return {
      disposition: 'rejected',
      dayStatus: 'failed',
      codes: [candidate.summaries.code || 'SUMMARIES_FAILED']
    };
  }

  if (candidate.summaries.kind === 'skipped') {
    if (options?.runId) {
      syncRepo.updateSyncDay(
        options.runId,
        candidate.date,
        {
          status: 'skipped',
          disposition: 'preserved',
          summariesStatus: 'skipped',
          advisoryCodes: []
        },
        now
      );
    }
    return {
      disposition: 'preserved',
      dayStatus: 'skipped',
      codes: []
    };
  }

  // 3. Mathematical invariant enforcement on complete summary
  const summaryResult = candidate.summaries;
  const summary = summaryResult.value;
  const summaryContentHash = summaryResult.contentHash;
  const summaryRawJson = options?.rawSources?.summaries?.rawJson ?? stableStringify(summary);
  const exactHeartbeatRawByKey = new Map<string, string>();
  for (const event of options?.rawSources?.heartbeats?.events ?? []) {
    const key = heartbeatRawKey(event.externalId, event.canonicalHash);
    const existing = exactHeartbeatRawByKey.get(key);
    if (existing !== undefined && existing !== event.rawJson) {
      throw new Error(`Conflicting exact heartbeat payloads for ${event.externalId}`);
    }
    exactHeartbeatRawByKey.set(key, event.rawJson);
  }
  let didMutateClassificationEvidence = false;
  const grandTotalSecs = summary.grandTotal.total_seconds;

  if (
    !Number.isFinite(grandTotalSecs) ||
    grandTotalSecs < -DURATION_COMPARISON_TOLERANCE_SECONDS ||
    !Number.isFinite(summary.totalSeconds) ||
    summary.totalSeconds < -DURATION_COMPARISON_TOLERANCE_SECONDS
  ) {
    if (options?.runId) {
      syncRepo.updateSyncDay(
        options.runId,
        candidate.date,
        {
          status: 'failed',
          disposition: 'rejected',
          summariesStatus: 'failed',
          advisoryCodes: [RECONCILE_CODES.MATHEMATICAL_INVARIANT_VIOLATION]
        },
        now
      );
    }
    return {
      disposition: 'rejected',
      dayStatus: 'failed',
      codes: [RECONCILE_CODES.MATHEMATICAL_INVARIANT_VIOLATION]
    };
  }

  let sliceSum = 0;
  for (const slice of summary.slices) {
    if (!Number.isFinite(slice.totalSeconds)) {
      if (options?.runId) {
        syncRepo.updateSyncDay(
          options.runId,
          candidate.date,
          {
            status: 'failed',
            disposition: 'rejected',
            summariesStatus: 'failed',
            advisoryCodes: [RECONCILE_CODES.MATHEMATICAL_INVARIANT_VIOLATION]
          },
          now
        );
      }
      return {
        disposition: 'rejected',
        dayStatus: 'failed',
        codes: [RECONCILE_CODES.MATHEMATICAL_INVARIANT_VIOLATION]
      };
    }
    if (slice.totalSeconds < 0) {
      const codes = [
        RECONCILE_CODES.NEGATIVE_RESIDUAL,
        RECONCILE_CODES.MATHEMATICAL_INVARIANT_VIOLATION
      ];
      if (options?.runId) {
        syncRepo.updateSyncDay(
          options.runId,
          candidate.date,
          {
            status: 'failed',
            disposition: 'rejected',
            summariesStatus: 'failed',
            advisoryCodes: codes
          },
          now
        );
      }
      return {
        disposition: 'rejected',
        dayStatus: 'failed',
        codes
      };
    }
    sliceSum += slice.totalSeconds;
  }

  const delta = sliceSum - grandTotalSecs;
  if (Math.abs(delta) > DURATION_COMPARISON_TOLERANCE_SECONDS) {
    const codes: string[] = [RECONCILE_CODES.MATHEMATICAL_INVARIANT_VIOLATION];
    if (delta > DURATION_COMPARISON_TOLERANCE_SECONDS) {
      codes.unshift(RECONCILE_CODES.OVERCOUNT_TOLERANCE_EXCEEDED);
    }
    if (options?.runId) {
      syncRepo.updateSyncDay(
        options.runId,
        candidate.date,
        {
          status: 'failed',
          disposition: 'rejected',
          summariesStatus: 'failed',
          advisoryCodes: codes
        },
        now
      );
    }
    return {
      disposition: 'rejected',
      dayStatus: 'failed',
      codes
    };
  }

  // ==========================================================================
  // Phase 2: Transactional Execution
  // ==========================================================================

  const runTx = db.transaction((): ReconcileResult => {
    // 1. Cancellation check
    if (options?.isCancelled?.()) {
      if (options?.runId) {
        syncRepo.updateSyncDay(
          options.runId,
          candidate.date,
          {
            status: 'cancelled',
            disposition: 'preserved',
            advisoryCodes: [RECONCILE_CODES.RUN_CANCELLED]
          },
          now
        );
      }
      return {
        disposition: 'preserved',
        dayStatus: 'skipped',
        codes: [RECONCILE_CODES.RUN_CANCELLED]
      };
    }

    // 2. Connection generation CAS check
    const syncSettings = syncRepo.getSyncSettings();
    if (candidate.connectionGeneration !== syncSettings.connectionGeneration) {
      if (options?.runId) {
        syncRepo.updateSyncDay(
          options.runId,
          candidate.date,
          {
            status: 'failed',
            disposition: 'rejected',
            summariesStatus: 'failed',
            advisoryCodes: [RECONCILE_CODES.STALE_CONNECTION_GENERATION]
          },
          now
        );
      }
      return {
        disposition: 'rejected',
        dayStatus: 'failed',
        codes: [RECONCILE_CODES.STALE_CONNECTION_GENERATION]
      };
    }

    // 3. Timezone verification
    if (options?.pinnedTimezone && candidate.timezone !== options.pinnedTimezone) {
      if (options?.runId) {
        syncRepo.updateSyncDay(
          options.runId,
          candidate.date,
          {
            status: 'failed',
            disposition: 'rejected',
            summariesStatus: 'failed',
            advisoryCodes: [RECONCILE_CODES.TIMEZONE_MISMATCH]
          },
          now
        );
      }
      return {
        disposition: 'rejected',
        dayStatus: 'failed',
        codes: [RECONCILE_CODES.TIMEZONE_MISMATCH]
      };
    }

    // 4. Stale snapshot version check
    const acceptedSummaries = syncRepo.getLayerFreshness(candidate.date, 'summaries');
    if (
      options?.expectedSnapshotVersion !== undefined &&
      (acceptedSummaries?.acceptedSnapshotVersion ?? 0) !== options.expectedSnapshotVersion
    ) {
      if (options?.runId) {
        syncRepo.updateSyncDay(
          options.runId,
          candidate.date,
          {
            status: 'failed',
            disposition: 'rejected',
            summariesStatus: 'failed',
            advisoryCodes: [RECONCILE_CODES.STALE_SNAPSHOT_VERSION]
          },
          now
        );
      }
      return {
        disposition: 'rejected',
        dayStatus: 'failed',
        codes: [RECONCILE_CODES.STALE_SNAPSHOT_VERSION]
      };
    }

    // 5. Fidelity matrix evaluation
    const advisoryCodes: string[] = [];

    const getOrCreateApiSourceImport = (
      sourceType: 'api_summaries' | 'api_heartbeats',
      rawJson: string,
      recordCount: number
    ): number => {
      const byteSize = new TextEncoder().encode(rawJson).byteLength;
      if (byteSize === 0) {
        throw new Error(`Empty raw payload for ${sourceType}`);
      }
      const sourceHash = sha256Hex(rawJson);
      const existingImport = db
        .prepare(
          `SELECT id
           FROM source_imports
           WHERE source_type = ? AND source_hash = ? AND byte_size = ?
             AND status = 'completed' AND range_start_date = ? AND range_end_date = ?
           ORDER BY id ASC
           LIMIT 1`
        )
        .get(sourceType, sourceHash, byteSize, candidate.date, candidate.date) as
        | { id: number }
        | undefined;
      if (existingImport) return existingImport.id;
      const info = db
        .prepare(
          `INSERT INTO source_imports (
            source_type, source_hash, byte_size, status, range_start_date, range_end_date,
            started_at, finished_at, day_count, record_count
          ) VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, 1, ?)`
        )
        .run(sourceType, sourceHash, byteSize, candidate.date, candidate.date, now, now, recordCount);
      return Number(info.lastInsertRowid);
    };

    const summarySourceImportId =
      options?.sourceImportId ?? getOrCreateApiSourceImport('api_summaries', summaryRawJson, 1);
    if (!options?.sourceImportId) {
      db.prepare(
        `INSERT INTO source_payloads (
          source_import_id, endpoint, covered_date, payload_hash, payload_json,
          first_seen_at, last_seen_at
        ) VALUES (?, 'api:summaries', ?, ?, ?, ?, ?)
        ON CONFLICT(source_import_id, endpoint, covered_date) DO UPDATE SET
          last_seen_at = excluded.last_seen_at`
      ).run(
        summarySourceImportId,
        candidate.date,
        summaryContentHash,
        summaryRawJson,
        now,
        now
      );
    }

    let heartbeatSourceImportId: number | null = null;
    const getHeartbeatSourceImportId = (
      heartbeatDay: Extract<DayCandidate['heartbeats'], { kind: 'complete' }>['value']
    ): number => {
      if (heartbeatSourceImportId !== null) return heartbeatSourceImportId;
      const rawJson =
        options?.rawSources?.heartbeats?.rawJson ??
        stableStringify(
          heartbeatDay.heartbeats.map((beat) =>
            JSON.parse(serializeCanonicalHeartbeatPayload(beat))
          )
        );
      heartbeatSourceImportId = getOrCreateApiSourceImport(
        'api_heartbeats',
        rawJson,
        heartbeatDay.heartbeats.length
      );
      return heartbeatSourceImportId;
    };
    // Provisional day check: active day in source timezone is provisional until source day closes
    const nowDate = options?.now ? new Date(options.now) : new Date();
    const sourceToday = getZonedDateString(candidate.timezone, nowDate);
    if (candidate.date === sourceToday) {
      advisoryCodes.push(RECONCILE_CODES.CURRENT_DAY_PROVISIONAL);
    }

    // Unchanged content hash check
    const acceptedHeartbeats = syncRepo.getLayerFreshness(candidate.date, 'heartbeats');
    const isVerifiedZero = summary.fidelity === 'verified_zero' || summary.completeness.isVerifiedZero;
    const summariesUnchanged = Boolean(
      acceptedSummaries?.acceptedContentHash &&
      acceptedSummaries.acceptedContentHash === summaryContentHash
    );

    if (acceptedSummaries && acceptedSummaries.acceptedContentHash && summariesUnchanged) {
      let heartbeatsStatus: 'succeeded' | 'failed' | 'restricted' | 'skipped' = 'skipped';
      let dayStatus: ReconcileDayStatus = 'succeeded';

      if (candidate.heartbeats.kind === 'complete') {
        const hbDay = candidate.heartbeats.value;
        const heartbeatImportId = getHeartbeatSourceImportId(hbDay);
        let hasHeartbeatConflict = false;
        const conflictingBeats: typeof hbDay.heartbeats = [];
        for (const beat of hbDay.heartbeats) {
          const existing = db
            .prepare(`SELECT id, canonical_hash FROM heartbeats WHERE external_id = ?`)
            .get(beat.id) as { id: number; canonical_hash: string } | undefined;

          if (existing && existing.canonical_hash !== beat.canonicalHash) {
            hasHeartbeatConflict = true;
            conflictingBeats.push(beat);
          }
        }

        if (hasHeartbeatConflict || hbDay.completeness.conflictEventCount > 0) {
          advisoryCodes.push(RECONCILE_CODES.HEARTBEAT_PAYLOAD_CONFLICT);
          heartbeatsStatus = 'failed';
          dayStatus = 'partial';
          for (const beat of conflictingBeats) {
            db.prepare(`
              INSERT INTO heartbeat_variants (
                external_id, canonical_hash, raw_json, conflict_state, source_import_id
              ) VALUES (?, ?, ?, 'conflict', ?)
              ON CONFLICT(external_id, canonical_hash) DO UPDATE SET
                conflict_state = 'conflict',
                last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                occurrence_count = occurrence_count + 1
            `).run(
              beat.id,
              beat.canonicalHash,
              serializeHeartbeatPayload(beat, exactHeartbeatRawByKey),
              heartbeatImportId
            );
          }
          syncRepo.recordLayerAttempt(candidate.date, 'heartbeats', {
            statusCode: RECONCILE_CODES.HEARTBEAT_PAYLOAD_CONFLICT,
            hasFailure: true,
            unresolvedMismatch: true
          }, now);
        } else {
          if (candidate.heartbeats.contentHash !== acceptedHeartbeats?.acceptedContentHash) {
            const activeHeartbeatIds: number[] = [];
            const srcImpId = heartbeatImportId;

            const upsertHeartbeatStmt = db.prepare(`
              INSERT INTO heartbeats (
                external_id, occurred_at_us, occurred_at, local_date, entity,
                entity_type, category, project_id, project_name, branch, language,
                machine_name_id, user_agent_id, is_write, lines, lineno, cursorpos,
                canonical_hash, source_import_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(external_id) DO UPDATE SET
                last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                occurrence_count = occurrence_count + 1
              RETURNING id
            `);

            const upsertVariantStmt = db.prepare(`
              INSERT INTO heartbeat_variants (
                external_id, canonical_hash, raw_json, conflict_state, source_import_id
              ) VALUES (?, ?, ?, 'canonical', ?)
              ON CONFLICT(external_id, canonical_hash) DO UPDATE SET
                last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                occurrence_count = occurrence_count + 1
            `);

            const projRows = db.prepare(`SELECT id, name FROM projects`).all() as Array<{ id: number; name: string }>;
            const existingProjMap = new Map<string, number>(projRows.map((p) => [p.name, p.id]));

            for (const beat of hbDay.heartbeats) {
              const beatProjId = beat.projectName ? (existingProjMap.get(beat.projectName) ?? null) : null;
              const res = upsertHeartbeatStmt.get(
                beat.id,
                beat.occurredAtUs,
                beat.occurredAt,
                beat.localDate,
                beat.entity,
                beat.entityType,
                beat.category,
                beatProjId,
                beat.projectName,
                beat.branch,
                beat.language,
                beat.machineNameId,
                beat.userAgentId,
                beat.isWrite ? 1 : 0,
                beat.lines,
                beat.lineno,
                beat.cursorpos,
                beat.canonicalHash,
                srcImpId
              ) as { id: number };

              activeHeartbeatIds.push(res.id);

              upsertVariantStmt.run(
                beat.id,
                beat.canonicalHash,
                serializeHeartbeatPayload(beat, exactHeartbeatRawByKey),
                srcImpId
              );
            }

            syncRepo.replaceHeartbeatMembership(candidate.date, activeHeartbeatIds);

            const existingSlices = db.prepare(
              `SELECT id, project_id, entity, entity_type, kind FROM day_project_entity_slices WHERE date = ?`
            ).all(candidate.date) as Array<{ id: number; project_id: number; entity: string; entity_type: string; kind: string }>;

            const existingSliceIdByKey = new Map<string, number>();
            for (const s of existingSlices) {
              existingSliceIdByKey.set(computeSliceKey(s.project_id, s.entity, s.entity_type, s.kind), s.id);
            }

            const sliceIds = existingSlices.map((s) => s.id);
            if (sliceIds.length > 0) {
              const ph = sliceIds.map(() => '?').join(',');
              db.prepare(`DELETE FROM slice_identities WHERE slice_id IN (${ph}) AND source = 'heartbeat'`).run(...sliceIds);
            }

            const insertHbIdentStmt = db.prepare(`
              INSERT INTO slice_identities (slice_id, selector_type, value, source, observed_heartbeats)
              VALUES (?, ?, ?, 'heartbeat', 1)
              ON CONFLICT(slice_id, selector_type, value) DO UPDATE SET
                observed_heartbeats = observed_heartbeats + 1
            `);

            const unattributedId = existingProjMap.get('__unattributed__');
            for (const beat of hbDay.heartbeats) {
              const beatProjId = beat.projectName ? (existingProjMap.get(beat.projectName) ?? null) : null;
              const normBeatEntity = normalizeEntity(beat.entity, beat.entityType);

              const sliceKey = beatProjId !== null
                ? computeSliceKey(beatProjId, normBeatEntity, beat.entityType, 'entity')
                : null;
              const targetSliceId =
                (sliceKey ? existingSliceIdByKey.get(sliceKey) : undefined) ??
                (unattributedId !== undefined ? existingSliceIdByKey.get(computeSliceKey(unattributedId, '__unattributed__', 'unattributed', 'unattributed_residual')) : undefined);

              if (targetSliceId !== undefined) {
                if (beat.machineNameId) {
                  insertHbIdentStmt.run(targetSliceId, 'machine', beat.machineNameId.trim().toLowerCase());
                }
                if (beat.userAgentId) {
                  insertHbIdentStmt.run(targetSliceId, 'editor', beat.userAgentId.trim().toLowerCase());
                }
              }
            }

            const nextHbVer = (acceptedHeartbeats?.acceptedSnapshotVersion ?? 0) + 1;
            syncRepo.recordLayerAccepted(
              candidate.date,
              'heartbeats',
              {
                snapshotVersion: nextHbVer,
                contentHash: candidate.heartbeats.contentHash,
                fidelity: 'entity_detail',
                sourceReference: options?.sourceReference ?? 'sync',
                timezone: candidate.timezone,
                evidenceMatchesSummary: true
              },
              now
            );
            didMutateClassificationEvidence = true;
          } else if (acceptedHeartbeats?.acceptedContentHash) {
            syncRepo.recordLayerAccepted(
              candidate.date,
              'heartbeats',
              {
                snapshotVersion: acceptedHeartbeats.acceptedSnapshotVersion ?? 1,
                contentHash: acceptedHeartbeats.acceptedContentHash,
                fidelity: acceptedHeartbeats.acceptedFidelity ?? 'entity_detail',
                sourceReference: acceptedHeartbeats.acceptedSourceReference ?? (options?.sourceReference ?? 'sync'),
                timezone: candidate.timezone,
                evidenceMatchesSummary: true
              },
              now
            );
          }
          heartbeatsStatus = 'succeeded';
        }
      } else if (candidate.heartbeats.kind === 'restricted') {
        heartbeatsStatus = 'restricted';
        dayStatus = 'partial';
        advisoryCodes.push(candidate.heartbeats.code || 'HEARTBEATS_RESTRICTED');
        syncRepo.recordLayerAttempt(candidate.date, 'heartbeats', {
          hasRestriction: true,
          statusCode: candidate.heartbeats.code
        }, now);
      } else if (candidate.heartbeats.kind === 'failed') {
        heartbeatsStatus = 'failed';
        dayStatus = 'partial';
        advisoryCodes.push(candidate.heartbeats.code || 'HEARTBEATS_FAILED');
        syncRepo.recordLayerAttempt(candidate.date, 'heartbeats', {
          hasFailure: true,
          statusCode: candidate.heartbeats.code
        }, now);
      } else if (!isVerifiedZero) {
        heartbeatsStatus = 'skipped';
        dayStatus = 'partial';
      } else {
        heartbeatsStatus = 'succeeded';
      }

      // Refresh verification metadata without mutating slices or allocations
      syncRepo.recordLayerAccepted(
        candidate.date,
        'summaries',
        {
          snapshotVersion: acceptedSummaries.acceptedSnapshotVersion ?? 1,
          contentHash: acceptedSummaries.acceptedContentHash,
          fidelity: acceptedSummaries.acceptedFidelity ?? summary.fidelity,
          sourceReference: acceptedSummaries.acceptedSourceReference ?? (options?.sourceReference ?? 'sync'),
          timezone: candidate.timezone,
          evidenceMatchesSummary: dayStatus === 'succeeded'
        },
        now
      );

      if (options?.runId) {
        syncRepo.updateSyncDay(
          options.runId,
          candidate.date,
          {
            status: dayStatus,
            disposition: 'unchanged',
            summariesStatus: 'succeeded',
            heartbeatsStatus,
            totalSeconds: summary.grandTotal.total_seconds,
            advisoryCodes
          },
          now
        );
      }

      return {
        disposition: 'unchanged',
        dayStatus,
        codes: advisoryCodes
      };
    }

    // Detail downgrade check
    if (acceptedSummaries?.acceptedFidelity === 'entity_detail' && summary.fidelity === 'coarse_project') {
      syncRepo.recordLayerAttempt(
        candidate.date,
        'summaries',
        { hasDetailDowngrade: true },
        now
      );

      const codes = [RECONCILE_CODES.DETAIL_DOWNGRADE, ...advisoryCodes];

      if (options?.runId) {
        syncRepo.updateSyncDay(
          options.runId,
          candidate.date,
          {
            status: 'partial',
            disposition: 'preserved',
            summariesStatus: 'succeeded',
            totalSeconds: acceptedSummaries.acceptedSnapshotVersion ? undefined : summary.grandTotal.total_seconds,
            advisoryCodes: codes
          },
          now
        );
      }

      return {
        disposition: 'preserved',
        dayStatus: 'partial',
        codes
      };
    }

    // Check scope coverage against accepted snapshot completeness if present
    const existingSliceRows = db
      .prepare(
        `SELECT s.id, s.project_id, s.entity, s.entity_type, s.kind, s.total_seconds, p.name AS project_name
         FROM day_project_entity_slices s
         JOIN projects p ON p.id = s.project_id
         WHERE s.date = ?`
      )
      .all(candidate.date) as Array<{
        id: number;
        project_id: number;
        entity: string;
        entity_type: string;
        kind: string;
        total_seconds: number;
        project_name: string;
      }>;

    const hadEntityDetail = existingSliceRows.some((r) => r.kind === 'entity');
    const incomingHasEntityDetail = summary.slices.some((s) => s.kind === 'entity');

    // Ambiguous zero safety: an ambiguous zero summary (0 seconds, but unverified)
    // must not overwrite an existing day with real activity or entity detail.
    const isAmbiguousZero = summary.totalSeconds === 0 && !isVerifiedZero;

    // Per-project fidelity check: verify that no previously detailed project suffers a detail downgrade
    const detailedProjectsInDb = new Set(
      existingSliceRows.filter((r) => r.kind === 'entity').map((r) => r.project_name)
    );

    let hasPerProjectDowngrade = false;
    if (detailedProjectsInDb.size > 0 && !isVerifiedZero) {
      if (!incomingHasEntityDetail) {
        hasPerProjectDowngrade = true;
      } else {
        for (const projName of detailedProjectsInDb) {
          const incomingScope = summary.completeness.projectScopes[projName];
          if (!incomingScope || incomingScope.entityDetailState === 'absent') {
            hasPerProjectDowngrade = true;
            break;
          }
          const hasIncomingEntitySlices = summary.slices.some(
            (s) => s.projectName === projName && s.kind === 'entity'
          );
          const hasIncomingCoarseOnly = summary.slices.some(
            (s) => s.projectName === projName && s.kind === 'project_summary'
          );
          if (hasIncomingCoarseOnly && !hasIncomingEntitySlices) {
            hasPerProjectDowngrade = true;
            break;
          }
        }
      }
    }

    if (
      (hadEntityDetail && !incomingHasEntityDetail && !isVerifiedZero) ||
      (existingSliceRows.length > 0 && isAmbiguousZero) ||
      hasPerProjectDowngrade
    ) {
      syncRepo.recordLayerAttempt(
        candidate.date,
        'summaries',
        { hasDetailDowngrade: true },
        now
      );

      const codes = [RECONCILE_CODES.DETAIL_DOWNGRADE, ...advisoryCodes];

      if (options?.runId) {
        syncRepo.updateSyncDay(
          options.runId,
          candidate.date,
          {
            status: 'partial',
            disposition: 'preserved',
            summariesStatus: 'succeeded',
            advisoryCodes: codes
          },
          now
        );
      }

      return {
        disposition: 'preserved',
        dayStatus: 'partial',
        codes
      };
    }

    if (summary.fidelity === 'verified_zero' || summary.completeness.isVerifiedZero) {
      advisoryCodes.push(RECONCILE_CODES.VERIFIED_ZERO_ACCEPTED);
    }

    // 6. Source import record acquisition
    const sourceImportId = summarySourceImportId;

    // 7. Projects upsert
    const projectMap = new Map<string, number>();

    // Always ensure __unattributed__ project exists
    const unattributedProj = db
      .prepare(`SELECT id FROM projects WHERE name = '__unattributed__'`)
      .get() as { id: number } | undefined;
    if (unattributedProj) {
      projectMap.set('__unattributed__', unattributedProj.id);
    } else {
      const info = db
        .prepare(
          `INSERT INTO projects (name, is_unattributed, first_activity_date, last_activity_date, first_seen_at, last_seen_at)
           VALUES ('__unattributed__', 1, ?, ?, ?, ?)`
        )
        .run(candidate.date, candidate.date, now, now);
      projectMap.set('__unattributed__', Number(info.lastInsertRowid));
    }

    const upsertProjectStmt = db.prepare(`
      INSERT INTO projects (name, is_unattributed, first_activity_date, last_activity_date, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        first_activity_date = CASE
          WHEN projects.first_activity_date IS NULL OR excluded.first_activity_date < projects.first_activity_date
          THEN excluded.first_activity_date
          ELSE projects.first_activity_date
        END,
        last_activity_date = CASE
          WHEN projects.last_activity_date IS NULL OR excluded.last_activity_date > projects.last_activity_date
          THEN excluded.last_activity_date
          ELSE projects.last_activity_date
        END,
        last_seen_at = excluded.last_seen_at
      RETURNING id
    `);

    for (const proj of summary.projects) {
      const res = upsertProjectStmt.get(
        proj.name,
        0,
        candidate.date,
        candidate.date,
        now,
        now
      ) as { id: number };
      projectMap.set(proj.name, res.id);
    }

    // Also ensure project names from slices are present
    for (const slice of summary.slices) {
      if (slice.projectName && !projectMap.has(slice.projectName)) {
        const res = upsertProjectStmt.get(
          slice.projectName,
          slice.isUnattributed ? 1 : 0,
          candidate.date,
          candidate.date,
          now,
          now
        ) as { id: number };
        projectMap.set(slice.projectName, res.id);
      }
    }

    // 8. Slices reconciliation
    const nextSnapshotVersion = (acceptedSummaries?.acceptedSnapshotVersion ?? 0) + 1;

    const existingSliceMap = new Map<string, { id: number; totalSeconds: number }>();
    for (const row of existingSliceRows) {
      const key = computeSliceKey(row.project_id, row.entity, row.entity_type, row.kind);
      existingSliceMap.set(key, { id: row.id, totalSeconds: row.total_seconds });
    }

    const incomingSliceKeys = new Set<string>();
    const retainedSliceIds = new Set<number>();
    const sliceIdByKey = new Map<string, number>();

    const insertSliceStmt = db.prepare(`
      INSERT INTO day_project_entity_slices (
        date, project_id, entity, entity_type, kind, total_seconds, percent,
        project_root_count, human_additions, human_deletions, ai_additions,
        ai_deletions, ai_sessions, is_unattributed, source_import_id, snapshot_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    const updateSliceStmt = db.prepare(`
      UPDATE day_project_entity_slices SET
        total_seconds = ?,
        percent = ?,
        project_root_count = ?,
        human_additions = ?,
        human_deletions = ?,
        ai_additions = ?,
        ai_deletions = ?,
        ai_sessions = ?,
        source_import_id = ?,
        snapshot_version = ?
      WHERE id = ?
    `);

    for (const slice of summary.slices) {
      const projId = slice.isUnattributed
        ? projectMap.get('__unattributed__')!
        : projectMap.get(slice.projectName) ?? projectMap.get('__unattributed__')!;

      const entityName = normalizeEntity(slice.entity, slice.entityType);
      const key = computeSliceKey(projId, entityName, slice.entityType, slice.kind);
      incomingSliceKeys.add(key);

      const existing = existingSliceMap.get(key);
      let sliceId: number;

      if (existing) {
        sliceId = existing.id;
        updateSliceStmt.run(
          slice.totalSeconds,
          null,
          slice.projectRootCount ?? null,
          slice.humanAdditions,
          slice.humanDeletions,
          slice.aiAdditions,
          slice.aiDeletions,
          slice.aiSessions,
          sourceImportId,
          nextSnapshotVersion,
          sliceId
        );
      } else {
        const info = insertSliceStmt.get(
          candidate.date,
          projId,
          entityName,
          slice.entityType,
          slice.kind,
          slice.totalSeconds,
          null,
          slice.projectRootCount ?? null,
          slice.humanAdditions,
          slice.humanDeletions,
          slice.aiAdditions,
          slice.aiDeletions,
          slice.aiSessions,
          slice.isUnattributed ? 1 : 0,
          sourceImportId,
          nextSnapshotVersion
        ) as { id: number };
        sliceId = info.id;
      }

      retainedSliceIds.add(sliceId);
      sliceIdByKey.set(key, sliceId);
    }

    if (options?.injectFailure === 'after_slices') {
      throw new Error('Injected failure after slices');
    }

    // 9. Manual allocation preservation & reconciliation
    const existingAllocations = syncRepo.getAllocationsForDate(candidate.date);

    for (const alloc of existingAllocations) {
      const incomingSlice = summary.slices.find((s) => {
        const projId = s.isUnattributed
          ? projectMap.get('__unattributed__')!
          : projectMap.get(s.projectName) ?? projectMap.get('__unattributed__')!;
        const entityName = normalizeEntity(s.entity, s.entityType);
        return (
          projId === alloc.projectId &&
          entityName === alloc.entity &&
          s.entityType === alloc.entityType &&
          s.kind === alloc.kind
        );
      });

      if (incomingSlice) {
        // Slice survived or reappeared
        if (alloc.state === 'detached') {
          syncRepo.reattachAllocation(alloc.id, incomingSlice.totalSeconds, now);
        } else if (Math.abs(alloc.allocatedSeconds - incomingSlice.totalSeconds) > DURATION_COMPARISON_TOLERANCE_SECONDS) {
          syncRepo.adjustAllocationDuration(alloc.id, incomingSlice.totalSeconds, now);
        }
      } else {
        // Slice is removed in candidate replacement set
        if (alloc.state === 'active') {
          syncRepo.detachAllocation(alloc.id, now);
        }
      }
    }

    // Retire slices absent from complete replacement set
    for (const [key, existing] of existingSliceMap.entries()) {
      if (!incomingSliceKeys.has(key)) {
        db.prepare(`DELETE FROM day_project_entity_slices WHERE id = ?`).run(existing.id);
      }
    }

    if (options?.injectFailure === 'after_allocations') {
      throw new Error('Injected failure after allocations');
    }

    // 10. Dimensions reconciliation (replace dimensions for this date)
    db.prepare(`DELETE FROM daily_dimension_totals WHERE date = ?`).run(candidate.date);

    const insertDimStmt = db.prepare(`
      INSERT INTO daily_dimension_totals (
        date, scope, project_id, dimension, name, entity_type, machine_name_id,
        project_root_count, total_seconds, percent, human_additions, human_deletions,
        ai_additions, ai_deletions, ai_sessions, raw_json, source_import_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const dim of summary.scopedDimensions) {
      const projName = dim.scope === 'project' ? dim.projectName : undefined;
      const projId = projName ? (projectMap.get(projName) ?? null) : null;

      insertDimStmt.run(
        candidate.date,
        dim.scope,
        projId,
        dim.dimension,
        dim.name,
        dim.entityType ?? null,
        dim.machineNameId ?? null,
        null,
        dim.totalSeconds,
        dim.percent ?? null,
        0,
        0,
        0,
        0,
        0,
        dim.rawJson ?? null,
        sourceImportId
      );
    }

    // 11. Daily totals upsert
    db.prepare(`
      INSERT INTO daily_totals (
        date, timezone, total_seconds, human_additions, human_deletions, ai_additions,
        ai_deletions, ai_sessions, ai_input_tokens, ai_output_tokens,
        grand_total_json, project_sum_seconds, project_sum_delta, source_import_id, source_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        timezone = excluded.timezone,
        total_seconds = excluded.total_seconds,
        human_additions = excluded.human_additions,
        human_deletions = excluded.human_deletions,
        ai_additions = excluded.ai_additions,
        ai_deletions = excluded.ai_deletions,
        ai_sessions = excluded.ai_sessions,
        ai_input_tokens = excluded.ai_input_tokens,
        ai_output_tokens = excluded.ai_output_tokens,
        grand_total_json = excluded.grand_total_json,
        project_sum_seconds = excluded.project_sum_seconds,
        project_sum_delta = excluded.project_sum_delta,
        source_import_id = excluded.source_import_id,
        source_hash = excluded.source_hash
    `).run(
      candidate.date,
      summary.timezone ?? 'UTC',
      summary.grandTotal.total_seconds,
      summary.grandTotal.human_additions,
      summary.grandTotal.human_deletions,
      summary.grandTotal.ai_additions,
      summary.grandTotal.ai_deletions,
      summary.grandTotal.ai_sessions,
      summary.grandTotal.ai_input_tokens ?? 0,
      summary.grandTotal.ai_output_tokens ?? 0,
      JSON.stringify(summary.grandTotal),
      summary.projectSumSeconds,
      summary.projectSumDelta,
      sourceImportId,
      summaryContentHash
    );

    // 12. Intrinsic slice identities
    const insertIdentStmt = db.prepare(`
      INSERT INTO slice_identities (slice_id, selector_type, value, source, observed_heartbeats)
      VALUES (?, ?, ?, 'slice', 0)
      ON CONFLICT(slice_id, selector_type, value) DO NOTHING
    `);

    for (const slice of summary.slices) {
      const projId = slice.isUnattributed
        ? projectMap.get('__unattributed__')!
        : projectMap.get(slice.projectName) ?? projectMap.get('__unattributed__')!;
      const entityName = normalizeEntity(slice.entity, slice.entityType);
      const key = computeSliceKey(projId, entityName, slice.entityType, slice.kind);
      const sliceId = sliceIdByKey.get(key);

      if (sliceId !== undefined) {
        for (const ident of sliceIntrinsicIdentities({
          projectName: slice.projectName,
          entity: entityName,
          entityType: slice.entityType
        })) {
          insertIdentStmt.run(sliceId, ident.selectorType, ident.value);
        }
      }
    }

    // 13. Heartbeats layer reconciliation
    let evidenceMatchesSummary = false;
    let heartbeatsStatus: 'succeeded' | 'failed' | 'restricted' | 'skipped' = 'skipped';
    let heartbeatCount = 0;

    if (candidate.heartbeats.kind === 'complete') {
      const hbDay = candidate.heartbeats.value;
      const heartbeatImportId = getHeartbeatSourceImportId(hbDay);
      heartbeatCount = hbDay.heartbeats.length;

      // Check for conflict payloads
      let hasHeartbeatConflict = false;
      const conflictingBeats: typeof hbDay.heartbeats = [];
      for (const beat of hbDay.heartbeats) {
        const existing = db
          .prepare(`SELECT id, canonical_hash FROM heartbeats WHERE external_id = ?`)
          .get(beat.id) as { id: number; canonical_hash: string } | undefined;

        if (existing && existing.canonical_hash !== beat.canonicalHash) {
          hasHeartbeatConflict = true;
          conflictingBeats.push(beat);
        }
      }

      if (hasHeartbeatConflict || hbDay.completeness.conflictEventCount > 0) {
        advisoryCodes.push(RECONCILE_CODES.HEARTBEAT_PAYLOAD_CONFLICT);
        evidenceMatchesSummary = false;
        heartbeatsStatus = 'failed';
        for (const beat of conflictingBeats) {
          db.prepare(`
            INSERT INTO heartbeat_variants (
              external_id, canonical_hash, raw_json, conflict_state, source_import_id
            ) VALUES (?, ?, ?, 'conflict', ?)
            ON CONFLICT(external_id, canonical_hash) DO UPDATE SET
              conflict_state = 'conflict',
              last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              occurrence_count = occurrence_count + 1
          `).run(
            beat.id,
            beat.canonicalHash,
            serializeHeartbeatPayload(beat, exactHeartbeatRawByKey),
            heartbeatImportId
          );
        }
        syncRepo.recordLayerAttempt(candidate.date, 'heartbeats', {
          statusCode: RECONCILE_CODES.HEARTBEAT_PAYLOAD_CONFLICT,
          hasFailure: true,
          unresolvedMismatch: true
        }, now);
        // Mark current evidence unavailable/false (NULL is not complete)
        db.prepare(`
          INSERT INTO sync_layer_state (date, layer, evidence_matches_summary, updated_at)
          VALUES (?, 'heartbeats', 0, ?)
          ON CONFLICT(date, layer) DO UPDATE SET
            evidence_matches_summary = 0,
            updated_at = excluded.updated_at
        `).run(candidate.date, now);
      } else {
        evidenceMatchesSummary = true;
        heartbeatsStatus = 'succeeded';
        const activeHeartbeatIds: number[] = [];

        const upsertHeartbeatStmt = db.prepare(`
          INSERT INTO heartbeats (
            external_id, occurred_at_us, occurred_at, local_date, entity,
            entity_type, category, project_id, project_name, branch, language,
            machine_name_id, user_agent_id, is_write, lines, lineno, cursorpos,
            canonical_hash, source_import_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(external_id) DO UPDATE SET
            last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            occurrence_count = occurrence_count + 1
          RETURNING id
        `);

        const upsertVariantStmt = db.prepare(`
          INSERT INTO heartbeat_variants (
            external_id, canonical_hash, raw_json, conflict_state, source_import_id
          ) VALUES (?, ?, ?, 'canonical', ?)
          ON CONFLICT(external_id, canonical_hash) DO UPDATE SET
            last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            occurrence_count = occurrence_count + 1
        `);

        for (const beat of hbDay.heartbeats) {
          const beatProjId = beat.projectName ? (projectMap.get(beat.projectName) ?? null) : null;
          const res = upsertHeartbeatStmt.get(
            beat.id,
            beat.occurredAtUs,
            beat.occurredAt,
            beat.localDate,
            beat.entity,
            beat.entityType,
            beat.category,
            beatProjId,
            beat.projectName,
            beat.branch,
            beat.language,
            beat.machineNameId,
            beat.userAgentId,
            beat.isWrite ? 1 : 0,
            beat.lines,
            beat.lineno,
            beat.cursorpos,
            beat.canonicalHash,
            heartbeatImportId
          ) as { id: number };

          activeHeartbeatIds.push(res.id);

          upsertVariantStmt.run(
            beat.id,
            beat.canonicalHash,
            serializeHeartbeatPayload(beat, exactHeartbeatRawByKey),
            heartbeatImportId
          );
        }

        // Transactionally update active membership
        syncRepo.replaceHeartbeatMembership(candidate.date, activeHeartbeatIds);

        // Rebuild slice identities from active heartbeats
        const sliceIdsForDate = Array.from(retainedSliceIds);
        if (sliceIdsForDate.length > 0) {
          const ph = sliceIdsForDate.map(() => '?').join(',');
          db.prepare(`DELETE FROM slice_identities WHERE slice_id IN (${ph}) AND source = 'heartbeat'`).run(...sliceIdsForDate);
        }

        const insertHbIdentStmt = db.prepare(`
          INSERT INTO slice_identities (slice_id, selector_type, value, source, observed_heartbeats)
          VALUES (?, ?, ?, 'heartbeat', 1)
          ON CONFLICT(slice_id, selector_type, value) DO UPDATE SET
            observed_heartbeats = observed_heartbeats + 1
        `);

        for (const beat of hbDay.heartbeats) {
          const beatProjId = beat.projectName ? (projectMap.get(beat.projectName) ?? null) : null;
          const normBeatEntity = normalizeEntity(beat.entity, beat.entityType);

          // Find matching slice
          const sliceKey = beatProjId !== null
            ? computeSliceKey(beatProjId, normBeatEntity, beat.entityType, 'entity')
            : null;
          const targetSliceId =
            (sliceKey ? sliceIdByKey.get(sliceKey) : undefined) ??
            sliceIdByKey.get(computeSliceKey(projectMap.get('__unattributed__')!, '__unattributed__', 'unattributed', 'unattributed_residual'));

          if (targetSliceId !== undefined) {
            if (beat.machineNameId) {
              insertHbIdentStmt.run(targetSliceId, 'machine', beat.machineNameId.trim().toLowerCase());
            }
            if (beat.userAgentId) {
              insertHbIdentStmt.run(targetSliceId, 'editor', beat.userAgentId.trim().toLowerCase());
            }
          }
        }

        const acceptedHb = syncRepo.getLayerFreshness(candidate.date, 'heartbeats');
        const nextHbVer = (acceptedHb?.acceptedSnapshotVersion ?? 0) + 1;
        syncRepo.recordLayerAccepted(
          candidate.date,
          'heartbeats',
          {
            snapshotVersion: nextHbVer,
            contentHash: candidate.heartbeats.contentHash,
            fidelity: 'entity_detail',
            sourceReference: options?.sourceReference ?? 'sync',
            timezone: candidate.timezone,
            evidenceMatchesSummary: true
          },
          now
        );
      }
    } else if (candidate.heartbeats.kind === 'restricted') {
      evidenceMatchesSummary = false;
      heartbeatsStatus = 'restricted';
      advisoryCodes.push(candidate.heartbeats.code || 'HEARTBEATS_RESTRICTED');
      syncRepo.recordLayerAttempt(candidate.date, 'heartbeats', {
        hasRestriction: true,
        statusCode: candidate.heartbeats.code
      }, now);
      // Mark current evidence unavailable/false (NULL is not complete)
      db.prepare(`
        INSERT INTO sync_layer_state (date, layer, evidence_matches_summary, updated_at)
        VALUES (?, 'heartbeats', 0, ?)
        ON CONFLICT(date, layer) DO UPDATE SET
          evidence_matches_summary = 0,
          updated_at = excluded.updated_at
      `).run(candidate.date, now);
    } else if (candidate.heartbeats.kind === 'failed') {
      evidenceMatchesSummary = false;
      heartbeatsStatus = 'failed';
      advisoryCodes.push(candidate.heartbeats.code || 'HEARTBEATS_FAILED');
      syncRepo.recordLayerAttempt(candidate.date, 'heartbeats', {
        hasFailure: true,
        statusCode: candidate.heartbeats.code
      }, now);
      // Mark current evidence unavailable/false (NULL is not complete)
      db.prepare(`
        INSERT INTO sync_layer_state (date, layer, evidence_matches_summary, updated_at)
        VALUES (?, 'heartbeats', 0, ?)
        ON CONFLICT(date, layer) DO UPDATE SET
          evidence_matches_summary = 0,
          updated_at = excluded.updated_at
      `).run(candidate.date, now);
    } else if (candidate.heartbeats.kind === 'skipped') {
      evidenceMatchesSummary = isVerifiedZero;
      heartbeatsStatus = isVerifiedZero ? 'succeeded' : 'skipped';
      if (!isVerifiedZero) {
        // Mark current evidence unavailable/false (NULL is not complete)
        db.prepare(`
          INSERT INTO sync_layer_state (date, layer, evidence_matches_summary, updated_at)
          VALUES (?, 'heartbeats', 0, ?)
          ON CONFLICT(date, layer) DO UPDATE SET
            evidence_matches_summary = 0,
            updated_at = excluded.updated_at
        `).run(candidate.date, now);
      }
    }

    if (options?.injectFailure === 'before_commit') {
      throw new Error('Injected failure before commit');
    }

    // 14. Record layer accepted for summaries
    syncRepo.recordLayerAccepted(
      candidate.date,
      'summaries',
      {
        snapshotVersion: nextSnapshotVersion,
        contentHash: summaryContentHash,
        fidelity: summary.fidelity,
        sourceReference: options?.sourceReference ?? 'sync',
        timezone: candidate.timezone,
        evidenceMatchesSummary: isVerifiedZero || evidenceMatchesSummary
      },
      now
    );

    const finalDayStatus: ReconcileDayStatus =
      isVerifiedZero || (evidenceMatchesSummary && heartbeatsStatus === 'succeeded')
        ? 'succeeded'
        : 'partial';

    // 15. Update sync_days record if runId provided
    if (options?.runId) {
      syncRepo.updateSyncDay(
        options.runId,
        candidate.date,
        {
          status: finalDayStatus,
          disposition: 'updated',
          summariesStatus: 'succeeded',
          heartbeatsStatus,
          totalSeconds: summary.grandTotal.total_seconds,
          heartbeatCount,
          advisoryCodes
        },
        now
      );
    }

    didMutateClassificationEvidence = true;
    return {
      disposition: 'updated',
      dayStatus: finalDayStatus,
      codes: advisoryCodes
    };
  });

  const result = runTx();
  if (didMutateClassificationEvidence) {
    options?.classification?.invalidateIdentityCaches?.();
    options?.classification?.clearCaches?.();
    options?.onCommitted?.();
  }
  return result;
}
