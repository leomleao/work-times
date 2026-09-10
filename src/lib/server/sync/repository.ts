/**
 * Sync repository interfaces and SQLite implementation.
 *
 * Provides persistence primitives for sync runs, dates, layer freshness,
 * reconciliation allocations overlay, heartbeat active memberships,
 * user-agent registry staging/publication, and sync settings.
 */

import type {
  LayerFreshnessRecord,
  LayerStatus,
  ReconcileDisposition,
  RunRequest,
  RunStatus,
  SummaryFidelity,
  SyncDayStatus
} from './contracts.js';
import {
  SqliteSyncRepository,
  IdempotencyConflictError,
  QueueFullError,
  type DailyTimeAllocationRecord,
  type SyncDayRecord,
  type SyncLayer,
  type SyncRunProgress,
  type SyncRunRecord,
  type UserAgentRegistryEntry
} from '$lib/server/db/repositories/sync.js';

export interface SyncRepository {
  enqueueRun(req: RunRequest, dates?: string[]): { runId: number; reused: boolean };
  claimNextRun(now?: string): SyncRunRecord | null;
  cancelRun(runId: number, now?: string): { run: SyncRunRecord; cancelledNow: boolean };
  isRunCancelRequested(runId: number): boolean;
  completeRun(
    runId: number,
    outcome: {
      status: RunStatus;
      advisoryCodes?: string[];
      summary?: string;
      errorMessage?: string | null;
    },
    now?: string
  ): SyncRunRecord;
  recoverInterruptedRuns(now?: string): { interruptedRunIds: number[]; interruptedDateCount: number };
  getRun(runId: number): SyncRunRecord | null;
  getRunProgress(runId: number): SyncRunProgress;
  listRuns(options?: { limit?: number; offset?: number }): SyncRunRecord[];

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
    now?: string
  ): void;
  getSyncDaysForRun(runId: number): SyncDayRecord[];
  getSyncDay(runId: number, date: string): SyncDayRecord | null;

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
    now?: string
  ): void;
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
    now?: string
  ): void;
  getLayerFreshness(date: string, layer: SyncLayer): LayerFreshnessRecord | null;

  getAllocationsForDate(date: string): DailyTimeAllocationRecord[];
  detachAllocation(allocationId: string, now?: string): void;
  adjustAllocationDuration(allocationId: string, newTotalSeconds: number, now?: string): void;
  reattachAllocation(allocationId: string, totalSeconds: number, now?: string): void;

  getActiveHeartbeatIds(date: string): number[];
  replaceHeartbeatMembership(
    date: string,
    activeHeartbeatIds: number[]
  ): { activeCount: number; retiredCount: number };

  clearRegistryStaging(): void;
  stageRegistryEntries(entries: UserAgentRegistryEntry[]): void;
  publishRegistryStaging(): { publishedCount: number; historicalCount: number };
  getRegistryEntry(id: string): UserAgentRegistryEntry | null;
  listRegistryEntries(options?: { includeHistorical?: boolean }): UserAgentRegistryEntry[];

  getSyncSettings(): {
    schedulingEnabled: boolean;
    connectionGeneration: number;
    boundArchiveIdentity: string | null;
  };
  updateSyncSettings(settings: { schedulingEnabled?: boolean }): void;
}

export {
  SqliteSyncRepository,
  IdempotencyConflictError,
  QueueFullError,
  type DailyTimeAllocationRecord,
  type SyncDayRecord,
  type SyncLayer,
  type SyncRunProgress,
  type SyncRunRecord,
  type UserAgentRegistryEntry
};
