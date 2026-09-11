/**
 * Test service factory for Work Times sync coordinator and services.
 *
 * Provides reusable isolated service setups for testing coordinator (P6),
 * scheduler (P7), admin endpoints (P8), and integration workflows.
 */

import type Database from 'better-sqlite3';
import { openTestDatabase } from '../db/connection.js';
import { SqliteSyncRepository } from './repository.js';
import { SqliteWakaTimeOAuthConnectionRepository } from '../db/repositories/wakatime-oauth.js';
import { SyncCoordinator, type SyncCoordinatorOptions } from './coordinator.js';
import { CapabilityPolicy } from './capabilities.js';
import { WakaTimeClient } from '../wakatime/client.js';
import type { RunRequest } from './contracts.js';
import type { SyncRunRecord, SyncDayRecord, SyncRunProgress } from './repository.js';
import type { SyncDayWorkerOptions, SyncDayWorkerResult } from './worker.js';
import type { RegistryRefreshOptions, RegistryRefreshResult } from './user-agent-registry.js';

export interface TestSyncServiceOptions {
  /** Optional custom BetterSQLite3 database instance (creates openTestDatabase() if omitted). */
  db?: Database.Database;
  /** Whether recurring scheduling is enabled. */
  schedulingEnabled?: boolean;
  /** Initial connection generation to initialize in OAuth connection record. */
  connectionGeneration?: number;
  /** Bound archive identity to initialize in OAuth connection record. */
  boundArchiveIdentity?: string | null;
  /** Pinned source timezone (defaults to 'Europe/London'). */
  pinnedTimezone?: string;
  /** Injectable clock function for deterministic time testing. */
  now?: () => Date;
  /** Injectable custom single-day worker executor. */
  executeDayWorker?: (options: SyncDayWorkerOptions) => Promise<SyncDayWorkerResult>;
  /** Injectable custom registry refresh executor. */
  executeRegistryRefresh?: (options: RegistryRefreshOptions) => Promise<RegistryRefreshResult>;
  /** Optional WakaTimeClient instance. */
  client?: WakaTimeClient;
  /** Whether to automatically start coordinator on creation (defaults to true). */
  autoStart?: boolean;
}

export interface TestSyncServiceContext {
  db: Database.Database;
  repository: SqliteSyncRepository;
  coordinator: SyncCoordinator;
  policy: CapabilityPolicy;
  client?: WakaTimeClient;
  enqueue(req: RunRequest): Promise<{ runId: number; reused: boolean }>;
  enqueueAndDrain(
    req: RunRequest,
    timeoutMs?: number
  ): Promise<{ runId: number; reused: boolean; run: SyncRunRecord }>;
  waitForRun(runId: number, timeoutMs?: number): Promise<SyncRunRecord>;
  waitForIdle(timeoutMs?: number): Promise<void>;
  getRun(runId: number): SyncRunRecord | null;
  getSyncDays(runId: number): SyncDayRecord[];
  getRunProgress(runId: number): SyncRunProgress;
  stop(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Creates an isolated test sync service with in-memory database and test coordinator.
 */
export async function createTestSyncService(
  options: TestSyncServiceOptions = {}
): Promise<TestSyncServiceContext> {
  const db = options.db ?? openTestDatabase();
  const repository = new SqliteSyncRepository(db);
  const policy = new CapabilityPolicy();

  // Initialize sync settings if specified
  if (options.schedulingEnabled !== undefined) {
    repository.updateSyncSettings({ schedulingEnabled: options.schedulingEnabled });
  }

  // Initialize OAuth connection settings if specified
  if (options.connectionGeneration !== undefined || options.boundArchiveIdentity !== undefined) {
    const oauthRepo = new SqliteWakaTimeOAuthConnectionRepository(db);
    const nowStr = (options.now ? options.now() : new Date()).toISOString();
    oauthRepo.upsert({
      accessTokenSealed: 'test-sealed-access-token',
      refreshTokenSealed: 'test-sealed-refresh-token',
      tokenType: 'Bearer',
      scopes: ['email', 'read_logged_time'],
      expiresAt: null,
      connectedAt: nowStr,
      updatedAt: nowStr,
      generation: options.connectionGeneration ?? 1,
      boundArchiveIdentity: options.boundArchiveIdentity ?? null
    });
  }

  const coordinatorOptions: SyncCoordinatorOptions = {
    db,
    repository,
    client: options.client,
    executeDayWorker: options.executeDayWorker,
    executeRegistryRefresh: options.executeRegistryRefresh,
    now: options.now,
    pinnedTimezone: options.pinnedTimezone ?? 'Europe/London',
    policy
  };

  const coordinator = new SyncCoordinator(coordinatorOptions);

  if (options.autoStart !== false) {
    await coordinator.start();
  }

  const context: TestSyncServiceContext = {
    db,
    repository,
    coordinator,
    policy,
    client: options.client,

    async enqueue(req: RunRequest): Promise<{ runId: number; reused: boolean }> {
      return coordinator.enqueue(req);
    },

    async enqueueAndDrain(
      req: RunRequest,
      timeoutMs = 10_000
    ): Promise<{ runId: number; reused: boolean; run: SyncRunRecord }> {
      const { runId, reused } = await coordinator.enqueue(req);
      const run = await coordinator.waitForRun(runId, timeoutMs);
      return { runId, reused, run };
    },

    async waitForRun(runId: number, timeoutMs = 10_000): Promise<SyncRunRecord> {
      return coordinator.waitForRun(runId, timeoutMs);
    },

    async waitForIdle(timeoutMs = 10_000): Promise<void> {
      return coordinator.waitForIdle(timeoutMs);
    },

    getRun(runId: number): SyncRunRecord | null {
      return repository.getRun(runId);
    },

    getSyncDays(runId: number): SyncDayRecord[] {
      return repository.getSyncDaysForRun(runId);
    },

    getRunProgress(runId: number): SyncRunProgress {
      return repository.getRunProgress(runId);
    },

    async stop(): Promise<void> {
      await coordinator.stop();
    },

    async close(): Promise<void> {
      await coordinator.stop();
      try {
        db.close();
      } catch {
        // Ignore if already closed
      }
    }
  };

  return context;
}
