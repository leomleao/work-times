import type Database from 'better-sqlite3';
import {
  computeRunRequestPayloadHash,
  type LayerStatus,
  type ReconcileDisposition,
  type RunRequest,
  type RunRequestMode,
  type RunStatus,
  type RunTrigger,
  type SummaryFidelity,
  type SyncDayStatus,
  type LayerFreshnessRecord
} from '$lib/server/sync/contracts.js';
import type { SliceEntityType, SliceKind } from '../schema.js';

export class IdempotencyConflictError extends Error {
  constructor(message = 'A different sync run request already exists for this idempotency key') {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class QueueFullError extends Error {
  constructor(message = 'Sync run queue is full (max 10 queued or running runs)') {
    super(message);
    this.name = 'QueueFullError';
  }
}

export interface SyncRunRecord {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  trigger: RunTrigger;
  mode: RunRequestMode;
  status: RunStatus;
  rangeStartDate: string | null;
  rangeEndDate: string | null;
  dayCount: number;
  daysSynced: number;
  daysFailed: number;
  degradedCapabilities: string | null;
  advisoryCodes: string[];
  summary: string | null;
  errorMessage: string | null;
  policyStateJson: string | null;
  idempotencyKey: string | null;
  payloadHash: string | null;
  resumedFromRunId: number | null;
  cancelRequestedAt: string | null;
}

export interface SyncDayRecord {
  id: number;
  syncRunId: number;
  date: string;
  status: SyncDayStatus;
  disposition: ReconcileDisposition | null;
  summariesStatus: LayerStatus | null;
  durationsStatus: LayerStatus | null;
  heartbeatsStatus: LayerStatus | null;
  sourceImportId: number | null;
  totalSeconds: number;
  heartbeatCount: number;
  advisoryCodes: string[];
  errorMessage: string | null;
  syncedAt: string;
}

export interface SyncRunProgress {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  partial: number;
  failed: number;
  skipped: number;
  cancelled: number;
  interrupted: number;
  completed: number;
  dispositions: {
    updated: number;
    unchanged: number;
    preserved: number;
    rejected: number;
  };
}

export interface DailyTimeAllocationRecord {
  id: string;
  date: string;
  projectId: number;
  entity: string;
  entityType: SliceEntityType;
  kind: SliceKind;
  classification: 'work' | 'personal';
  allocatedSeconds: number;
  timesheetCode: string | null;
  note: string | null;
  state: 'active' | 'detached';
  detachedAt: string | null;
  reattachedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserAgentRegistryEntry {
  id: string;
  editor: string;
  userAgentValue: string;
  os: string;
  version?: string | null;
  aiModel?: string | null;
  aiModelVersion?: string | null;
  aiModelComplexity?: string | null;
  isBrowserExtension?: boolean;
  isDesktopApp?: boolean;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  isHistorical?: boolean;
  refreshedAt?: string;
}

export type SyncLayer = 'summaries' | 'durations' | 'heartbeats';

export class SqliteSyncRepository {
  constructor(private readonly db: Database.Database) {}

  // ==========================================================================
  // 1. Run Lifecycle & Queue
  // ==========================================================================

  /**
   * Enqueues a sync run with idempotency check and bounded queue constraints.
   * If same idempotency key + same payload: returns existing run with reused: true.
   * If same idempotency key + conflicting payload: throws IdempotencyConflictError.
   * If queue has >= 10 nonterminal runs: throws QueueFullError.
   */
  enqueueRun(
    req: RunRequest,
    dates: string[] = []
  ): { runId: number; reused: boolean } {
    const payloadHash = computeRunRequestPayloadHash(req);

    return this.db.transaction(() => {
      // 1. Check idempotency key if supplied
      if (req.idempotencyKey) {
        const existing = this.db
          .prepare(
            `SELECT id, payload_hash FROM sync_runs WHERE idempotency_key = ?`
          )
          .get(req.idempotencyKey) as { id: number; payload_hash: string | null } | undefined;

        if (existing) {
          if (existing.payload_hash === payloadHash) {
            return { runId: existing.id, reused: true };
          }
          throw new IdempotencyConflictError(
            `Sync run idempotency key "${req.idempotencyKey}" already exists with a different payload`
          );
        }
      }

      // 2. Insert queued run (trigger trg_sync_runs_queue_limit_insert enforces max 10)
      const now = new Date().toISOString();
      let runId: number;
      try {
        const info = this.db
          .prepare(
            `INSERT INTO sync_runs (
              started_at, trigger, mode, status, range_start_date, range_end_date,
              day_count, days_synced, days_failed, idempotency_key, payload_hash,
              resumed_from_run_id
            ) VALUES (?, ?, ?, 'queued', ?, ?, ?, 0, 0, ?, ?, ?)`
          )
          .run(
            now,
            req.trigger,
            req.mode,
            req.rangeStartDate ?? null,
            req.rangeEndDate ?? null,
            dates.length,
            req.idempotencyKey ?? null,
            payloadHash,
            req.resumedFromRunId ?? null
          );
        runId = Number(info.lastInsertRowid);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('SYNC_QUEUE_FULL')) {
          throw new QueueFullError();
        }
        throw error;
      }

      // 3. Insert initial pending date records
      const insertDay = this.db.prepare(
        `INSERT INTO sync_days (sync_run_id, date, status, synced_at)
         VALUES (?, ?, 'pending', ?)`
      );

      for (const date of dates) {
        insertDay.run(runId, date, now);
      }

      return { runId, reused: false };
    })();
  }

  /**
   * Atomically claims the next queued run for execution.
   * Enforces strictly one running run via database index and manual prioritization.
   * Returns null if a run is already running or if no queued runs exist.
   */
  claimNextRun(now: string = new Date().toISOString()): SyncRunRecord | null {
    return this.db.transaction(() => {
      // Check if any run is currently running
      const runningCount = this.db
        .prepare(`SELECT COUNT(*) as c FROM sync_runs WHERE status = 'running'`)
        .get() as { c: number };

      if (runningCount.c > 0) {
        return null;
      }

      // Select highest priority queued run (manual triggers before scheduled/startup/catchup)
      const nextRun = this.db
        .prepare(
          `SELECT id FROM sync_runs
           WHERE status = 'queued'
           ORDER BY CASE WHEN trigger = 'manual' THEN 0 ELSE 1 END, id ASC
           LIMIT 1`
        )
        .get() as { id: number } | undefined;

      if (!nextRun) {
        return null;
      }

      this.db
        .prepare(
          `UPDATE sync_runs
           SET status = 'running', started_at = ?
           WHERE id = ? AND status = 'queued'`
        )
        .run(now, nextRun.id);

      return this.getRun(nextRun.id);
    })();
  }

  /**
   * Idempotent cancellation:
   * - Terminal runs: unchanged.
   * - Queued runs: marked cancelled immediately, all pending dates marked cancelled.
   * - Running runs: cancel_requested_at timestamp persisted.
   */
  cancelRun(
    runId: number,
    now: string = new Date().toISOString()
  ): { run: SyncRunRecord; cancelledNow: boolean } {
    return this.db.transaction(() => {
      const existing = this.getRun(runId);
      if (!existing) {
        throw new Error(`Sync run ${runId} not found`);
      }

      if (
        existing.status === 'succeeded' ||
        existing.status === 'partial' ||
        existing.status === 'failed' ||
        existing.status === 'cancelled' ||
        existing.status === 'interrupted'
      ) {
        return { run: existing, cancelledNow: false };
      }

      if (existing.status === 'queued') {
        this.db
          .prepare(
            `UPDATE sync_runs
             SET status = 'cancelled', finished_at = ?
             WHERE id = ?`
          )
          .run(now, runId);

        this.db
          .prepare(
            `UPDATE sync_days
             SET status = 'cancelled', synced_at = ?
             WHERE sync_run_id = ? AND status IN ('pending', 'running')`
          )
          .run(now, runId);

        return { run: this.getRun(runId)!, cancelledNow: true };
      }

      // Running run: record cancel request
      this.db
        .prepare(
          `UPDATE sync_runs
           SET cancel_requested_at = ?
           WHERE id = ?`
        )
        .run(now, runId);

      return { run: this.getRun(runId)!, cancelledNow: false };
    })();
  }

  isRunCancelRequested(runId: number): boolean {
    const row = this.db
      .prepare(
        `SELECT status, cancel_requested_at FROM sync_runs WHERE id = ?`
      )
      .get(runId) as { status: string; cancel_requested_at: string | null } | undefined;

    if (!row) return false;
    return row.status === 'cancelled' || row.cancel_requested_at !== null;
  }

  completeRun(
    runId: number,
    outcome: {
      status: RunStatus;
      advisoryCodes?: string[];
      summary?: string;
      errorMessage?: string | null;
    },
    now: string = new Date().toISOString()
  ): SyncRunRecord {
    return this.db.transaction(() => {
      const dayStats = this.db
        .prepare(
          `SELECT
             COUNT(CASE WHEN status = 'succeeded' THEN 1 END) as succeeded_count,
             COUNT(CASE WHEN status IN ('failed', 'partial') THEN 1 END) as failed_count
           FROM sync_days
           WHERE sync_run_id = ?`
        )
        .get(runId) as { succeeded_count: number; failed_count: number };

      this.db
        .prepare(
          `UPDATE sync_runs
           SET status = ?,
               finished_at = ?,
               days_synced = ?,
               days_failed = ?,
               advisory_codes = ?,
               summary = ?,
               error_message = ?
           WHERE id = ?`
        )
        .run(
          outcome.status,
          now,
          dayStats.succeeded_count,
          dayStats.failed_count,
          JSON.stringify(outcome.advisoryCodes ?? []),
          outcome.summary ?? null,
          outcome.errorMessage ?? null,
          runId
        );

      return this.getRun(runId)!;
    })();
  }

  /**
   * Recovery: marks stale running runs as interrupted upon server restart,
   * along with any unfinished date records.
   */
  recoverInterruptedRuns(
    now: string = new Date().toISOString()
  ): { interruptedRunIds: number[]; interruptedDateCount: number } {
    return this.db.transaction(() => {
      const runningRuns = this.db
        .prepare(`SELECT id FROM sync_runs WHERE status = 'running'`)
        .all() as Array<{ id: number }>;

      const interruptedRunIds = runningRuns.map((r) => r.id);

      if (interruptedRunIds.length === 0) {
        return { interruptedRunIds: [], interruptedDateCount: 0 };
      }

      for (const id of interruptedRunIds) {
        this.db
          .prepare(
            `UPDATE sync_runs
             SET status = 'interrupted', finished_at = ?
             WHERE id = ?`
          )
          .run(now, id);
      }

      const placeholders = interruptedRunIds.map(() => '?').join(',');
      const info = this.db
        .prepare(
          `UPDATE sync_days
           SET status = 'interrupted', synced_at = ?
           WHERE sync_run_id IN (${placeholders}) AND status IN ('pending', 'running')`
        )
        .run(now, ...interruptedRunIds);

      return {
        interruptedRunIds,
        interruptedDateCount: info.changes
      };
    })();
  }

  getRun(runId: number): SyncRunRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM sync_runs WHERE id = ?`)
      .get(runId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.mapRunRow(row);
  }

  getRunProgress(runId: number): SyncRunProgress {
    const rows = this.db
      .prepare(
        `SELECT status, disposition FROM sync_days WHERE sync_run_id = ?`
      )
      .all(runId) as Array<{ status: SyncDayStatus; disposition: ReconcileDisposition | null }>;

    const progress: SyncRunProgress = {
      total: rows.length,
      pending: 0,
      running: 0,
      succeeded: 0,
      partial: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      interrupted: 0,
      completed: 0,
      dispositions: {
        updated: 0,
        unchanged: 0,
        preserved: 0,
        rejected: 0
      }
    };

    for (const r of rows) {
      if (r.status in progress) {
        progress[r.status]++;
      }
      if (
        r.status === 'succeeded' ||
        r.status === 'partial' ||
        r.status === 'failed' ||
        r.status === 'skipped'
      ) {
        progress.completed++;
      }
      if (r.disposition && r.disposition in progress.dispositions) {
        progress.dispositions[r.disposition]++;
      }
    }

    return progress;
  }

  listRuns(options?: { limit?: number; offset?: number }): SyncRunRecord[] {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const rows = this.db
      .prepare(
        `SELECT * FROM sync_runs ORDER BY id DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as Array<Record<string, unknown>>;

    return rows.map((r) => this.mapRunRow(r));
  }

  // ==========================================================================
  // 2. Day Records
  // ==========================================================================

  updateSyncDay(
    runId: number,
    date: string,
    update: {
      status: SyncDayStatus;
      disposition?: ReconcileDisposition | null;
      summariesStatus?: LayerStatus | null;
      durationsStatus?: LayerStatus | null;
      heartbeatsStatus?: LayerStatus | null;
      sourceImportId?: number | null;
      totalSeconds?: number;
      heartbeatCount?: number;
      advisoryCodes?: string[];
      errorMessage?: string | null;
    },
    now: string = new Date().toISOString()
  ): void {
    this.db
      .prepare(
        `UPDATE sync_days
         SET status = ?,
             disposition = ?,
             summaries_status = ?,
             durations_status = ?,
             heartbeats_status = ?,
             source_import_id = COALESCE(?, source_import_id),
             total_seconds = COALESCE(?, total_seconds),
             heartbeat_count = COALESCE(?, heartbeat_count),
             advisory_codes_json = ?,
             error_message = ?,
             synced_at = ?
         WHERE sync_run_id = ? AND date = ?`
      )
      .run(
        update.status,
        update.disposition ?? null,
        update.summariesStatus ?? null,
        update.durationsStatus ?? null,
        update.heartbeatsStatus ?? null,
        update.sourceImportId ?? null,
        update.totalSeconds ?? null,
        update.heartbeatCount ?? null,
        JSON.stringify(update.advisoryCodes ?? []),
        update.errorMessage ?? null,
        now,
        runId,
        date
      );
  }

  getSyncDaysForRun(runId: number): SyncDayRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM sync_days WHERE sync_run_id = ? ORDER BY date ASC`)
      .all(runId) as Array<Record<string, unknown>>;

    return rows.map((r) => this.mapDayRow(r));
  }

  getSyncDay(runId: number, date: string): SyncDayRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM sync_days WHERE sync_run_id = ? AND date = ?`)
      .get(runId, date) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.mapDayRow(row);
  }

  // ==========================================================================
  // 3. Layer Freshness & State
  // ==========================================================================

  recordLayerAttempt(
    date: string,
    layer: SyncLayer,
    attempt: {
      statusCode?: string | null;
      retryAt?: string | null;
      isStale?: boolean;
      hasRestriction?: boolean;
      hasFailure?: boolean;
      hasDetailDowngrade?: boolean;
      unresolvedMismatch?: boolean;
    },
    now: string = new Date().toISOString()
  ): void {
    this.db
      .prepare(
        `INSERT INTO sync_layer_state (
          date, layer, last_attempt_at, status_code, next_retry_at,
          is_stale, has_restriction, has_failure, has_detail_downgrade,
          unresolved_mismatch, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, layer) DO UPDATE SET
          last_attempt_at = excluded.last_attempt_at,
          status_code = excluded.status_code,
          next_retry_at = excluded.next_retry_at,
          is_stale = excluded.is_stale,
          has_restriction = excluded.has_restriction,
          has_failure = excluded.has_failure,
          has_detail_downgrade = excluded.has_detail_downgrade,
          unresolved_mismatch = excluded.unresolved_mismatch,
          updated_at = excluded.updated_at`
      )
      .run(
        date,
        layer,
        now,
        attempt.statusCode ?? null,
        attempt.retryAt ?? null,
        attempt.isStale ? 1 : 0,
        attempt.hasRestriction ? 1 : 0,
        attempt.hasFailure ? 1 : 0,
        attempt.hasDetailDowngrade ? 1 : 0,
        attempt.unresolvedMismatch ? 1 : 0,
        now
      );
  }

  recordLayerAccepted(
    date: string,
    layer: SyncLayer,
    accepted: {
      snapshotVersion: number;
      contentHash: string;
      fidelity: SummaryFidelity;
      sourceReference: string;
      timezone: string;
      evidenceMatchesSummary?: boolean;
    },
    now: string = new Date().toISOString()
  ): void {
    this.db
      .prepare(
        `INSERT INTO sync_layer_state (
          date, layer, last_attempt_at, last_success_at, last_accepted_change_at,
          accepted_source_reference, accepted_snapshot_version, accepted_fidelity,
          accepted_content_hash, verified_timezone, evidence_matches_summary,
          status_code, next_retry_at, is_stale, has_restriction, has_failure,
          has_detail_downgrade, unresolved_mismatch, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, 0, 0, 0, ?)
        ON CONFLICT(date, layer) DO UPDATE SET
          last_attempt_at = excluded.last_attempt_at,
          last_success_at = excluded.last_success_at,
          last_accepted_change_at = CASE
            WHEN sync_layer_state.accepted_content_hash = excluded.accepted_content_hash
            THEN sync_layer_state.last_accepted_change_at
            ELSE excluded.last_accepted_change_at
          END,
          accepted_source_reference = CASE
            WHEN sync_layer_state.accepted_content_hash = excluded.accepted_content_hash
            THEN sync_layer_state.accepted_source_reference
            ELSE excluded.accepted_source_reference
          END,
          accepted_snapshot_version = CASE
            WHEN sync_layer_state.accepted_content_hash = excluded.accepted_content_hash
            THEN sync_layer_state.accepted_snapshot_version
            ELSE excluded.accepted_snapshot_version
          END,
          accepted_fidelity = CASE
            WHEN sync_layer_state.accepted_content_hash = excluded.accepted_content_hash
            THEN sync_layer_state.accepted_fidelity
            ELSE excluded.accepted_fidelity
          END,
          accepted_content_hash = CASE
            WHEN sync_layer_state.accepted_content_hash = excluded.accepted_content_hash
            THEN sync_layer_state.accepted_content_hash
            ELSE excluded.accepted_content_hash
          END,
          verified_timezone = excluded.verified_timezone,
          evidence_matches_summary = excluded.evidence_matches_summary,
          status_code = NULL,
          next_retry_at = NULL,
          is_stale = 0,
          has_restriction = 0,
          has_failure = 0,
          has_detail_downgrade = 0,
          unresolved_mismatch = 0,
          updated_at = excluded.updated_at`
      )
      .run(
        date,
        layer,
        now,
        now,
        now,
        accepted.sourceReference,
        accepted.snapshotVersion,
        accepted.fidelity,
        accepted.contentHash,
        accepted.timezone,
        accepted.evidenceMatchesSummary !== undefined
          ? (accepted.evidenceMatchesSummary ? 1 : 0)
          : null,
        now
      );
  }

  getLayerFreshness(date: string, layer: SyncLayer): LayerFreshnessRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sync_layer_state WHERE date = ? AND layer = ?`
      )
      .get(date, layer) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      lastAttemptAt: (row.last_attempt_at as string) ?? null,
      lastSuccessAt: (row.last_success_at as string) ?? null,
      lastAcceptedChangeAt: (row.last_accepted_change_at as string) ?? null,
      acceptedSourceReference: (row.accepted_source_reference as string) ?? null,
      acceptedSnapshotVersion: typeof row.accepted_snapshot_version === 'number'
        ? row.accepted_snapshot_version
        : null,
      acceptedFidelity: (row.accepted_fidelity as SummaryFidelity) ?? null,
      acceptedContentHash: (row.accepted_content_hash as string) ?? null,
      verifiedTimezone: (row.verified_timezone as string) ?? null,
      evidenceMatchesSummary: row.evidence_matches_summary !== null && row.evidence_matches_summary !== undefined
        ? Boolean(row.evidence_matches_summary)
        : null,
      statusCode: (row.status_code as string) ?? null,
      nextRetryAt: (row.next_retry_at as string) ?? null,
      isStale: Boolean(row.is_stale),
      unresolvedMismatch: Boolean(row.unresolved_mismatch),
      hasDetailDowngrade: Boolean(row.has_detail_downgrade),
      hasRestriction: Boolean(row.has_restriction),
      hasFailure: Boolean(row.has_failure)
    };
  }

  // ==========================================================================
  // 4. Reconciliation Allocations Overlay
  // ==========================================================================

  getAllocationsForDate(date: string): DailyTimeAllocationRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM daily_time_allocations WHERE date = ?`)
      .all(date) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      date: String(r.date),
      projectId: Number(r.project_id),
      entity: String(r.entity),
      entityType: r.entity_type as SliceEntityType,
      kind: r.kind as SliceKind,
      classification: r.classification as 'work' | 'personal',
      allocatedSeconds: Number(r.allocated_seconds),
      timesheetCode: (r.timesheet_code as string) ?? null,
      note: (r.note as string) ?? null,
      state: r.state as 'active' | 'detached',
      detachedAt: (r.detached_at as string) ?? null,
      reattachedAt: (r.reattached_at as string) ?? null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at)
    }));
  }

  /**
   * Detaches an allocation whose underlying slice was removed.
   * Preserves historical duration; records append-only revision.
   */
  detachAllocation(allocationId: string, now: string = new Date().toISOString()): void {
    this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM daily_time_allocations WHERE id = ?`)
        .get(allocationId) as Record<string, unknown> | undefined;

      if (!existing) {
        throw new Error(`Allocation ${allocationId} not found`);
      }

      this.db
        .prepare(
          `UPDATE daily_time_allocations
           SET state = 'detached', detached_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(now, now, allocationId);

      this.db
        .prepare(
          `INSERT INTO classification_revisions (
            mutation_type, target_type, target_id, before_json, after_json, actor, created_at
          ) VALUES ('allocation_detached', 'allocation', ?, ?, ?, 'system', ?)`
        )
        .run(
          allocationId,
          JSON.stringify({ state: existing.state, allocated_seconds: existing.allocated_seconds }),
          JSON.stringify({ state: 'detached', allocated_seconds: existing.allocated_seconds }),
          now
        );
    })();
  }

  /**
   * Adjusts the allocated seconds of a surviving allocation whose slice duration changed.
   * Records append-only reconciliation revision.
   */
  adjustAllocationDuration(
    allocationId: string,
    newTotalSeconds: number,
    now: string = new Date().toISOString()
  ): void {
    this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM daily_time_allocations WHERE id = ?`)
        .get(allocationId) as Record<string, unknown> | undefined;

      if (!existing) {
        throw new Error(`Allocation ${allocationId} not found`);
      }

      this.db
        .prepare(
          `UPDATE daily_time_allocations
           SET allocated_seconds = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(newTotalSeconds, now, allocationId);

      this.db
        .prepare(
          `INSERT INTO classification_revisions (
            mutation_type, target_type, target_id, before_json, after_json, actor, created_at
          ) VALUES ('reconciliation_adjusted', 'allocation', ?, ?, ?, 'system', ?)`
        )
        .run(
          allocationId,
          JSON.stringify({ allocated_seconds: existing.allocated_seconds }),
          JSON.stringify({ allocated_seconds: newTotalSeconds }),
          now
        );
    })();
  }

  /**
   * Reattaches a previously detached allocation when its semantic slice reappears.
   * Records append-only reconciliation revision.
   */
  reattachAllocation(
    allocationId: string,
    totalSeconds: number,
    now: string = new Date().toISOString()
  ): void {
    this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM daily_time_allocations WHERE id = ?`)
        .get(allocationId) as Record<string, unknown> | undefined;

      if (!existing) {
        throw new Error(`Allocation ${allocationId} not found`);
      }

      this.db
        .prepare(
          `UPDATE daily_time_allocations
           SET state = 'active', allocated_seconds = ?, reattached_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(totalSeconds, now, now, allocationId);

      this.db
        .prepare(
          `INSERT INTO classification_revisions (
            mutation_type, target_type, target_id, before_json, after_json, actor, created_at
          ) VALUES ('allocation_reattached', 'allocation', ?, ?, ?, 'system', ?)`
        )
        .run(
          allocationId,
          JSON.stringify({ state: existing.state, allocated_seconds: existing.allocated_seconds }),
          JSON.stringify({ state: 'active', allocated_seconds: totalSeconds }),
          now
        );
    })();
  }

  // ==========================================================================
  // 5. Heartbeat Memberships
  // ==========================================================================

  getActiveHeartbeatIds(date: string): number[] {
    const rows = this.db
      .prepare(
        `SELECT heartbeat_id FROM heartbeat_memberships WHERE date = ? AND active = 1`
      )
      .all(date) as Array<{ heartbeat_id: number }>;

    return rows.map((r) => r.heartbeat_id);
  }

  /**
   * Transactionally sets active evidence membership for a date.
   * Heartbeats not in the active list are marked active = 0 without deleting raw rows.
   */
  replaceHeartbeatMembership(
    date: string,
    activeHeartbeatIds: number[]
  ): { activeCount: number; retiredCount: number } {
    return this.db.transaction(() => {
      const uniqueActiveIds = Array.from(new Set(activeHeartbeatIds));
      const activeSet = new Set(uniqueActiveIds);

      // Fetch previously active heartbeat IDs for this date
      const previouslyActiveRows = this.db
        .prepare(
          `SELECT heartbeat_id FROM heartbeat_memberships WHERE date = ? AND active = 1`
        )
        .all(date) as Array<{ heartbeat_id: number }>;

      let retiredCount = 0;
      const idsToDeactivate: number[] = [];

      for (const row of previouslyActiveRows) {
        if (!activeSet.has(row.heartbeat_id)) {
          retiredCount++;
          idsToDeactivate.push(row.heartbeat_id);
        }
      }

      // Deactivate previously active members not in the new active set
      if (idsToDeactivate.length > 0) {
        const placeholders = idsToDeactivate.map(() => '?').join(',');
        this.db
          .prepare(
            `UPDATE heartbeat_memberships
             SET active = 0
             WHERE date = ? AND heartbeat_id IN (${placeholders})`
          )
          .run(date, ...idsToDeactivate);
      }

      // Upsert active memberships
      const upsert = this.db.prepare(
        `INSERT INTO heartbeat_memberships (date, heartbeat_id, active)
         VALUES (?, ?, 1)
         ON CONFLICT(date, heartbeat_id) DO UPDATE SET active = 1`
      );

      for (const id of uniqueActiveIds) {
        upsert.run(date, id);
      }

      return {
        activeCount: uniqueActiveIds.length,
        retiredCount
      };
    })();
  }

  // ==========================================================================
  // 6. User-Agent Registry (Atomic Staging & Historical Mappings)
  // ==========================================================================

  clearRegistryStaging(): void {
    this.db.prepare(`DELETE FROM user_agent_registry_staging`).run();
  }

  stageRegistryEntries(entries: UserAgentRegistryEntry[]): void {
    const insert = this.db.prepare(`
      INSERT INTO user_agent_registry_staging (
        id, editor, user_agent_value, os, version, ai_model,
        ai_model_version, ai_model_complexity, is_browser_extension,
        is_desktop_app, first_seen_at, last_seen_at, is_historical, refreshed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const e of entries) {
        insert.run(
          e.id,
          e.editor,
          e.userAgentValue,
          e.os,
          e.version ?? null,
          e.aiModel ?? null,
          e.aiModelVersion ?? null,
          e.aiModelComplexity ?? null,
          e.isBrowserExtension ? 1 : 0,
          e.isDesktopApp ? 1 : 0,
          e.firstSeenAt ?? null,
          e.lastSeenAt ?? null,
          0,
          e.refreshedAt ?? now
        );
      }
    })();
  }

  /**
   * Atomically publishes staged registry entries:
   * - Retains historical mappings not in staging by setting is_historical = 1.
   * - Inserts/updates staged entries with is_historical = 0.
   * - Clears staging table.
   */
  publishRegistryStaging(): { publishedCount: number; historicalCount: number } {
    return this.db.transaction(() => {
      const now = new Date().toISOString();

      // 1. Mark existing entries not present in staging as historical
      this.db.prepare(`
        UPDATE user_agent_registry
        SET is_historical = 1
        WHERE id NOT IN (SELECT id FROM user_agent_registry_staging)
      `).run();

      // 2. Publish staging entries into user_agent_registry
      this.db.prepare(`
        INSERT INTO user_agent_registry (
          id, editor, user_agent_value, os, version, ai_model,
          ai_model_version, ai_model_complexity, is_browser_extension,
          is_desktop_app, first_seen_at, last_seen_at, is_historical, refreshed_at
        )
        SELECT
          id, editor, user_agent_value, os, version, ai_model,
          ai_model_version, ai_model_complexity, is_browser_extension,
          is_desktop_app, first_seen_at, last_seen_at, 0, refreshed_at
        FROM user_agent_registry_staging
        WHERE true
        ON CONFLICT(id) DO UPDATE SET
          editor = excluded.editor,
          user_agent_value = excluded.user_agent_value,
          os = excluded.os,
          version = excluded.version,
          ai_model = excluded.ai_model,
          ai_model_version = excluded.ai_model_version,
          ai_model_complexity = excluded.ai_model_complexity,
          is_browser_extension = excluded.is_browser_extension,
          is_desktop_app = excluded.is_desktop_app,
          first_seen_at = COALESCE(user_agent_registry.first_seen_at, excluded.first_seen_at),
          last_seen_at = COALESCE(excluded.last_seen_at, user_agent_registry.last_seen_at),
          is_historical = 0,
          refreshed_at = excluded.refreshed_at
      `).run();

      const published = this.db
        .prepare(`SELECT COUNT(*) as c FROM user_agent_registry WHERE is_historical = 0`)
        .get() as { c: number };

      const historical = this.db
        .prepare(`SELECT COUNT(*) as c FROM user_agent_registry WHERE is_historical = 1`)
        .get() as { c: number };

      // 3. Clear staging table
      this.db.prepare(`DELETE FROM user_agent_registry_staging`).run();

      return {
        publishedCount: published.c,
        historicalCount: historical.c
      };
    })();
  }

  getRegistryEntry(id: string): UserAgentRegistryEntry | null {
    const row = this.db
      .prepare(`SELECT * FROM user_agent_registry WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.mapRegistryRow(row);
  }

  listRegistryEntries(options?: { includeHistorical?: boolean }): UserAgentRegistryEntry[] {
    const sql = options?.includeHistorical === false
      ? `SELECT * FROM user_agent_registry WHERE is_historical = 0 ORDER BY editor ASC`
      : `SELECT * FROM user_agent_registry ORDER BY editor ASC`;

    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRegistryRow(r));
  }

  // ==========================================================================
  // 7. Settings Primitives
  // ==========================================================================

  getSyncSettings(): {
    schedulingEnabled: boolean;
    connectionGeneration: number;
    boundArchiveIdentity: string | null;
  } {
    const settingRow = this.db
      .prepare(`SELECT value FROM app_settings WHERE key = 'sync.scheduling_enabled'`)
      .get() as { value: string } | undefined;

    const connectionRow = this.db
      .prepare(`SELECT generation, bound_archive_identity FROM wakatime_oauth_connection WHERE id = 1`)
      .get() as { generation: number; bound_archive_identity: string | null } | undefined;

    return {
      schedulingEnabled: settingRow?.value === 'true',
      connectionGeneration: connectionRow?.generation ?? 1,
      boundArchiveIdentity: connectionRow?.bound_archive_identity ?? null
    };
  }

  updateSyncSettings(settings: { schedulingEnabled?: boolean }): void {
    if (settings.schedulingEnabled !== undefined) {
      const val = settings.schedulingEnabled ? 'true' : 'false';
      this.db
        .prepare(
          `INSERT INTO app_settings (key, value, updated_at)
           VALUES ('sync.scheduling_enabled', ?, (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`
        )
        .run(val);
    }
  }

  // ==========================================================================
  // Row mappers
  // ==========================================================================

  private mapRunRow(r: Record<string, unknown>): SyncRunRecord {
    let codes: string[] = [];
    if (typeof r.advisory_codes === 'string' && r.advisory_codes.trim()) {
      try {
        const parsed = JSON.parse(r.advisory_codes);
        if (Array.isArray(parsed)) codes = parsed;
      } catch {
        codes = [];
      }
    }

    return {
      id: Number(r.id),
      startedAt: String(r.started_at),
      finishedAt: (r.finished_at as string) ?? null,
      trigger: r.trigger as RunTrigger,
      mode: r.mode as RunRequestMode,
      status: r.status as RunStatus,
      rangeStartDate: (r.range_start_date as string) ?? null,
      rangeEndDate: (r.range_end_date as string) ?? null,
      dayCount: Number(r.day_count ?? 0),
      daysSynced: Number(r.days_synced ?? 0),
      daysFailed: Number(r.days_failed ?? 0),
      degradedCapabilities: (r.degraded_capabilities as string) ?? null,
      advisoryCodes: codes,
      summary: (r.summary as string) ?? null,
      errorMessage: (r.error_message as string) ?? null,
      policyStateJson: (r.policy_state_json as string) ?? null,
      idempotencyKey: (r.idempotency_key as string) ?? null,
      payloadHash: (r.payload_hash as string) ?? null,
      resumedFromRunId: typeof r.resumed_from_run_id === 'number' ? r.resumed_from_run_id : null,
      cancelRequestedAt: (r.cancel_requested_at as string) ?? null
    };
  }

  private mapDayRow(r: Record<string, unknown>): SyncDayRecord {
    let codes: string[] = [];
    if (typeof r.advisory_codes_json === 'string' && r.advisory_codes_json.trim()) {
      try {
        const parsed = JSON.parse(r.advisory_codes_json);
        if (Array.isArray(parsed)) codes = parsed;
      } catch {
        codes = [];
      }
    }

    return {
      id: Number(r.id),
      syncRunId: Number(r.sync_run_id),
      date: String(r.date),
      status: r.status as SyncDayStatus,
      disposition: (r.disposition as ReconcileDisposition) ?? null,
      summariesStatus: (r.summaries_status as LayerStatus) ?? null,
      durationsStatus: (r.durations_status as LayerStatus) ?? null,
      heartbeatsStatus: (r.heartbeats_status as LayerStatus) ?? null,
      sourceImportId: typeof r.source_import_id === 'number' ? r.source_import_id : null,
      totalSeconds: Number(r.total_seconds ?? 0),
      heartbeatCount: Number(r.heartbeat_count ?? 0),
      advisoryCodes: codes,
      errorMessage: (r.error_message as string) ?? null,
      syncedAt: String(r.synced_at)
    };
  }

  private mapRegistryRow(r: Record<string, unknown>): UserAgentRegistryEntry {
    return {
      id: String(r.id),
      editor: String(r.editor),
      userAgentValue: String(r.user_agent_value),
      os: String(r.os),
      version: (r.version as string) ?? null,
      aiModel: (r.ai_model as string) ?? null,
      aiModelVersion: (r.ai_model_version as string) ?? null,
      aiModelComplexity: (r.ai_model_complexity as string) ?? null,
      isBrowserExtension: Boolean(r.is_browser_extension),
      isDesktopApp: Boolean(r.is_desktop_app),
      firstSeenAt: (r.first_seen_at as string) ?? null,
      lastSeenAt: (r.last_seen_at as string) ?? null,
      isHistorical: Boolean(r.is_historical),
      refreshedAt: (r.refreshed_at as string) ?? undefined
    };
  }
}
