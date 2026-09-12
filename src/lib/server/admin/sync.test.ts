import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  sanitizeErrorMessage,
  getDateQualityProjection,
  getDatesQualityProjection,
  getSyncAdminData,
  getSyncRunDetail,
  getSyncData,
  getAdminSyncService,
  getVerifiedSourceTimezone,
  AdminSyncService
} from './sync.js';
import type { SyncService, RunRequest, RunStatus } from '../sync/contracts.js';

describe('Admin Sync Backend', () => {
  describe('sanitizeErrorMessage', () => {
    it('returns null for empty or null inputs', () => {
      expect(sanitizeErrorMessage(null)).toBeNull();
      expect(sanitizeErrorMessage(undefined)).toBeNull();
      expect(sanitizeErrorMessage('')).toBeNull();
      expect(sanitizeErrorMessage('   ')).toBeNull();
    });

    it('redacts tokens and bearer credentials to safe code', () => {
      const err = 'Failed with bearer 1234567890abcdef and token waka_sec_9999888877776666';
      const sanitized = sanitizeErrorMessage(err);
      expect(sanitized).not.toContain('1234567890abcdef');
      expect(sanitized).not.toContain('waka_sec_9999888877776666');
      expect(sanitized).toBe('UPSTREAM_ERROR');
    });

    it('maps auth failures to AUTH_REVOKED', () => {
      expect(sanitizeErrorMessage('401 Unauthorized')).toBe('AUTH_REVOKED');
      expect(sanitizeErrorMessage('token expired')).toBe('AUTH_REVOKED');
    });

    it('redacts account UUIDs to safe code', () => {
      const err = 'User aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee not found';
      const sanitized = sanitizeErrorMessage(err);
      expect(sanitized).not.toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      expect(sanitized).toBe('UPSTREAM_ERROR');
    });

    it('redacts user filesystem paths to safe code', () => {
      const err = 'Error reading /Users/leo/secret/file.json';
      const sanitized = sanitizeErrorMessage(err);
      expect(sanitized).not.toContain('/Users/leo');
      expect(sanitized).toBe('UPSTREAM_ERROR');
    });

    it('returns allowlisted codes directly', () => {
      expect(sanitizeErrorMessage('AUTH_REVOKED')).toBe('AUTH_REVOKED');
      expect(sanitizeErrorMessage('RATE_LIMITED')).toBe('RATE_LIMITED');
      expect(sanitizeErrorMessage('DETAIL_DOWNGRADE')).toBe('DETAIL_DOWNGRADE');
      expect(sanitizeErrorMessage('TIMEZONE_MISMATCH')).toBe('TIMEZONE_MISMATCH');
    });
  });

  describe('Date Quality & Admin Sync Data', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(':memory:');
      // Create schema for testing
      db.exec(`
        CREATE TABLE sync_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          trigger TEXT NOT NULL DEFAULT 'manual',
          mode TEXT NOT NULL DEFAULT 'recent',
          status TEXT NOT NULL DEFAULT 'running',
          range_start_date TEXT,
          range_end_date TEXT,
          day_count INTEGER NOT NULL DEFAULT 0,
          days_synced INTEGER NOT NULL DEFAULT 0,
          days_failed INTEGER NOT NULL DEFAULT 0,
          degraded_capabilities TEXT,
          advisory_codes TEXT,
          summary TEXT,
          error_message TEXT,
          policy_state_json TEXT,
          idempotency_key TEXT,
          payload_hash TEXT,
          resumed_from_run_id INTEGER,
          cancel_requested_at TEXT
        );

        CREATE TABLE sync_days (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sync_run_id INTEGER REFERENCES sync_runs(id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          disposition TEXT,
          summaries_status TEXT,
          durations_status TEXT,
          heartbeats_status TEXT,
          source_import_id INTEGER,
          total_seconds REAL NOT NULL DEFAULT 0.0,
          heartbeat_count INTEGER NOT NULL DEFAULT 0,
          advisory_codes_json TEXT,
          error_message TEXT,
          synced_at TEXT NOT NULL
        );

        CREATE TABLE sync_layer_state (
          date TEXT NOT NULL,
          layer TEXT NOT NULL,
          last_attempt_at TEXT,
          last_success_at TEXT,
          last_accepted_change_at TEXT,
          accepted_source_reference TEXT,
          accepted_snapshot_version INTEGER NOT NULL DEFAULT 0,
          accepted_fidelity TEXT,
          accepted_content_hash TEXT,
          verified_timezone TEXT,
          evidence_matches_summary INTEGER,
          status_code TEXT,
          next_retry_at TEXT,
          is_stale INTEGER NOT NULL DEFAULT 0,
          unresolved_mismatch INTEGER NOT NULL DEFAULT 0,
          has_detail_downgrade INTEGER NOT NULL DEFAULT 0,
          has_restriction INTEGER NOT NULL DEFAULT 0,
          has_failure INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (date, layer)
        );

        CREATE TABLE app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE wakatime_oauth_connection (
          id INTEGER PRIMARY KEY,
          access_token_sealed TEXT,
          refresh_token_sealed TEXT,
          token_type TEXT,
          scopes TEXT,
          expires_at TEXT,
          connected_at TEXT,
          updated_at TEXT,
          generation INTEGER DEFAULT 1,
          bound_archive_identity TEXT,
          rebound_at TEXT
        );

        CREATE TABLE user_agent_registry (
          id TEXT PRIMARY KEY,
          editor TEXT NOT NULL,
          user_agent_value TEXT NOT NULL,
          os TEXT NOT NULL,
          refreshed_at TEXT NOT NULL
        );

        CREATE TABLE account_settings (
          timezone TEXT NOT NULL
        );

        CREATE TABLE daily_totals (
          date TEXT PRIMARY KEY,
          total_seconds REAL NOT NULL DEFAULT 0.0,
          timezone TEXT NOT NULL
        );
      `);
    });

    afterEach(() => {
      db.close();
    });

    it('projects quality status correctly for various date states', () => {
      const now = new Date('2026-03-01T12:00:00.000Z');
      db.exec(`INSERT INTO account_settings (timezone) VALUES ('Europe/London');`);

      // 1. Missing date -> missing
      const missingProj = getDateQualityProjection(db, '2026-02-15', now);
      expect(missingProj.qualityStatus).toBe('missing');
      expect(missingProj.isStale).toBe(true);
      expect(missingProj.lastSyncedAt).toBeNull();

      // 2. Today's date missing -> current_day_provisional
      const todayProj = getDateQualityProjection(db, '2026-03-01', now);
      expect(todayProj.qualityStatus).toBe('current_day_provisional');
      expect(todayProj.isProvisional).toBe(true);

      // 3. Failed date
      db.exec(`
        INSERT INTO sync_runs (id, started_at, status) VALUES (1, '2026-03-01T10:00:00.000Z', 'failed');
        INSERT INTO sync_days (id, sync_run_id, date, status, synced_at, total_seconds)
        VALUES (1, 1, '2026-02-20', 'failed', '2026-03-01T10:00:00.000Z', 0);
      `);
      const failedProj = getDateQualityProjection(db, '2026-02-20', now);
      expect(failedProj.qualityStatus).toBe('failed');

      // 4. Stale date (success > 26 hours ago for a date within 14 days)
      db.exec(`
        INSERT INTO sync_runs (id, started_at, status) VALUES (2, '2026-02-25T10:00:00.000Z', 'succeeded');
        INSERT INTO sync_days (id, sync_run_id, date, status, synced_at, total_seconds)
        VALUES (2, 2, '2026-02-25', 'succeeded', '2026-02-25T10:00:00.000Z', 3600);
        INSERT INTO sync_layer_state (date, layer, last_success_at, updated_at, verified_timezone)
        VALUES ('2026-02-25', 'summaries', '2026-02-25T10:00:00.000Z', '2026-02-25T10:00:00.000Z', 'Europe/London');
      `);
      const staleProj = getDateQualityProjection(db, '2026-02-25', now);
      expect(staleProj.qualityStatus).toBe('stale');
      expect(staleProj.isStale).toBe(true);

      // 5. Degraded date (restricted layer)
      db.exec(`
        INSERT INTO sync_runs (id, started_at, status) VALUES (3, '2026-03-01T11:00:00.000Z', 'partial');
        INSERT INTO sync_days (id, sync_run_id, date, status, summaries_status, durations_status, heartbeats_status, synced_at, total_seconds)
        VALUES (3, 3, '2026-02-28', 'partial', 'succeeded', 'restricted', 'restricted', '2026-03-01T11:00:00.000Z', 1800);
        INSERT INTO sync_layer_state (date, layer, last_success_at, updated_at, verified_timezone)
        VALUES ('2026-02-28', 'summaries', '2026-03-01T11:00:00.000Z', '2026-03-01T11:00:00.000Z', 'Europe/London');
      `);
      const degradedProj = getDateQualityProjection(db, '2026-02-28', now);
      expect(degradedProj.qualityStatus).toBe('restricted');
      expect(degradedProj.degradedLayers).toContain('durations');
      expect(degradedProj.degradedLayers).toContain('heartbeats');

      // 6. Verified zero
      db.exec(`
        INSERT INTO sync_runs (id, started_at, status) VALUES (4, '2026-03-01T11:30:00.000Z', 'succeeded');
        INSERT INTO sync_days (id, sync_run_id, date, status, synced_at, total_seconds, advisory_codes_json)
        VALUES (4, 4, '2026-02-27', 'succeeded', '2026-03-01T11:30:00.000Z', 0, '["VERIFIED_ZERO_ACCEPTED"]');
        INSERT INTO sync_layer_state (date, layer, last_success_at, updated_at, verified_timezone, accepted_fidelity, accepted_source_reference, accepted_content_hash, accepted_snapshot_version)
        VALUES ('2026-02-27', 'summaries', '2026-03-01T11:30:00.000Z', '2026-03-01T11:30:00.000Z', 'Europe/London', 'verified_zero', 'ref-0', 'hash-0', 1);
        INSERT INTO daily_totals (date, total_seconds, timezone) VALUES ('2026-02-27', 0, 'Europe/London');
      `);
      const emptyProj = getDateQualityProjection(db, '2026-02-27', now);
      expect(emptyProj.qualityStatus).toBe('verified_zero');

      // 7. Verified complete / updated
      db.exec(`
        INSERT INTO sync_runs (id, started_at, status) VALUES (5, '2026-03-01T11:45:00.000Z', 'succeeded');
        INSERT INTO sync_days (id, sync_run_id, date, status, summaries_status, durations_status, heartbeats_status, synced_at, total_seconds)
        VALUES (5, 5, '2026-02-26', 'succeeded', 'succeeded', 'succeeded', 'succeeded', '2026-03-01T11:45:00.000Z', 7200);
        INSERT INTO sync_layer_state (date, layer, last_success_at, updated_at, verified_timezone)
        VALUES ('2026-02-26', 'summaries', '2026-03-01T11:45:00.000Z', '2026-03-01T11:45:00.000Z', 'Europe/London');
        INSERT INTO daily_totals (date, total_seconds, timezone) VALUES ('2026-02-26', 7200, 'Europe/London');
      `);
      const verifiedProj = getDateQualityProjection(db, '2026-02-26', now);
      expect(verifiedProj.qualityStatus).toBe('updated');
      expect(verifiedProj.isStale).toBe(false);
    });

    it('batch projects multiple dates via getDatesQualityProjection', () => {
      const now = new Date('2026-03-01T12:00:00.000Z');
      db.exec(`INSERT INTO account_settings (timezone) VALUES ('Europe/London');`);
      const map = getDatesQualityProjection(db, ['2026-02-26', '2026-03-01'], now);
      expect(map.size).toBe(2);
      expect(map.get('2026-03-01')?.isProvisional).toBe(true);
    });

    it('returns full DTO and backward-compatible data via getSyncAdminData', () => {
      const now = new Date('2026-03-01T12:00:00.000Z');
      db.exec(`
        INSERT INTO app_settings (key, value, updated_at) VALUES ('sync.scheduling_enabled', 'true', '2026-03-01T10:00:00.000Z');
        INSERT INTO wakatime_oauth_connection (id, access_token_sealed, refresh_token_sealed, token_type, scopes, generation, bound_archive_identity)
        VALUES (1, 'sealed_token', 'sealed_refresh', 'Bearer', 'email,read_logged_time', 2, 'user_123');
        INSERT INTO user_agent_registry (id, editor, user_agent_value, os, refreshed_at)
        VALUES ('id-1', 'vscode', 'vscode/1.0', 'mac', '2026-03-01T09:00:00.000Z');
        INSERT INTO sync_runs (id, started_at, status, trigger, mode, day_count, days_synced)
        VALUES (1, '2026-03-01T10:00:00.000Z', 'succeeded', 'manual', 'recent', 1, 1);
        INSERT INTO sync_days (id, sync_run_id, date, status, total_seconds, synced_at)
        VALUES (1, 1, '2026-02-28', 'succeeded', 3600, '2026-03-01T10:00:00.000Z');
      `);

      const fakeConfig = {
        wakatimeOAuthClientId: 'client_id',
        wakatimeOAuthClientSecret: 'client_secret',
        sessionSecret: 'session_secret'
      } as any;

      const adminData = getSyncAdminData(db, { config: fakeConfig, now });

      // Check DTO blocks
      expect(adminData.readiness.oauthAppConfigured).toBe(true);
      expect(adminData.readiness.oauthConnected).toBe(true);
      expect(adminData.readiness.hasActiveGrant).toBe(true);
      expect(adminData.readiness.discoveryReady).toBe(true);

      expect(adminData.schedule.enabled).toBe(true);
      expect(adminData.schedule.lastEnqueuedRunId).toBeNull();

      expect(adminData.registry.totalEntries).toBe(1);
      expect(adminData.registry.distinctEditors).toBe(1);

      expect(adminData.runs).toHaveLength(1);
      expect(adminData.runs[0].id).toBe(1);

      expect(adminData.dates).toHaveLength(1);
      expect(adminData.dates[0].date).toBe('2026-02-28');

      // Check backward compatibility fields
      expect(adminData.syncRuns).toHaveLength(1);
      expect(adminData.syncDays).toHaveLength(1);
      expect(adminData.isEmpty).toBe(false);

      // getSyncData compatibility wrapper
      const syncData = getSyncData(db, fakeConfig);
      expect(syncData.syncRuns).toHaveLength(1);
    });

    it('returns run detail with pagination via getSyncRunDetail', () => {
      db.exec(`
        INSERT INTO sync_runs (id, started_at, status, trigger, mode, day_count, days_synced)
        VALUES (1, '2026-03-01T10:00:00.000Z', 'succeeded', 'manual', 'backfill', 3, 3);
        INSERT INTO sync_days (id, sync_run_id, date, status, total_seconds, synced_at)
        VALUES
          (1, 1, '2026-02-26', 'succeeded', 3600, '2026-03-01T10:00:00.000Z'),
          (2, 1, '2026-02-27', 'succeeded', 1800, '2026-03-01T10:00:00.000Z'),
          (3, 1, '2026-02-28', 'succeeded', 7200, '2026-03-01T10:00:00.000Z');
      `);

      const detail = getSyncRunDetail(db, 1, { page: 1, pageSize: 2 });
      expect(detail).not.toBeNull();
      expect(detail!.run.id).toBe(1);
      expect(detail!.days).toHaveLength(2);
      expect(detail!.pagination.totalDays).toBe(3);
      expect(detail!.pagination.totalPages).toBe(2);

      const page2 = getSyncRunDetail(db, 1, { page: 2, pageSize: 2 });
      expect(page2!.days).toHaveLength(1);
      expect(page2!.days[0].date).toBe('2026-02-28');

      expect(getSyncRunDetail(db, 999)).toBeNull();
    });

    it('resolves sync service via AdminSyncService with test seams', async () => {
      const mockService: SyncService = {
        enqueue: async (req: RunRequest) => ({ runId: 100, reused: false }),
        cancel: async (id: number) => 'cancelled' as RunStatus,
        start: async () => {},
        stop: async () => {}
      };

      const adminService = getAdminSyncService({
        db,
        config: {} as any,
        sync: mockService
      });

      expect(adminService.sync).toBe(mockService);
      const res = await adminService.enqueue({ mode: 'recent', trigger: 'manual', idempotencyKey: 'k' });
      expect(res.runId).toBe(100);
    });

    it('returns null for getVerifiedSourceTimezone when no timezone evidence exists in DB', () => {
      expect(getVerifiedSourceTimezone(db)).toBeNull();
    });

    it('populates schedule state from scheduler.getScheduleState and avoids fake fallback', () => {
      const mockScheduler = {
        getScheduleState: () => ({
          enabled: true,
          lastTickAt: '2026-03-01T09:00:00.000Z',
          nextTickAt: '2026-03-01T10:00:00.000Z',
          lastEnqueuedRunId: 42,
          failureBackoffUntil: null,
          activeRunId: null
        })
      };

      const dataWithScheduler = getSyncAdminData(db, {
        runtime: { db, config: {} as any, scheduler: mockScheduler }
      });
      expect(dataWithScheduler.schedule.nextTickAt).toBe('2026-03-01T10:00:00.000Z');
      expect(dataWithScheduler.schedule.lastEnqueuedRunId).toBe(42);

      // When scheduler is absent, nextTickAt must be null (never computed next-UTC-hour)
      const dataWithoutScheduler = getSyncAdminData(db);
      expect(dataWithoutScheduler.schedule.nextTickAt).toBeNull();
    });

    it('requires complete summary evidence and daily_totals for verified_zero', () => {
      // Incomplete summary evidence (missing hash and fidelity)
      db.exec(`
        INSERT INTO sync_layer_state (layer, date, last_success_at, updated_at, has_failure, has_restriction, unresolved_mismatch)
        VALUES ('summaries', '2026-03-01', '2026-03-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z', 0, 0, 0);
      `);

      const q1 = getDateQualityProjection(db, '2026-03-01', new Date('2026-03-01T14:00:00.000Z'), 'UTC');
      expect(q1.qualityStatus).not.toBe('verified_zero');

      // Add complete required layer evidence and daily_totals = 0
      db.exec(`
        UPDATE sync_layer_state
        SET accepted_fidelity = 'verified_zero',
            accepted_source_reference = 'ref-1',
            accepted_content_hash = 'hash-1',
            accepted_snapshot_version = 1
        WHERE layer = 'summaries' AND date = '2026-03-01';
        INSERT INTO daily_totals (date, total_seconds, timezone)
        VALUES ('2026-03-01', 0, 'UTC');
      `);

      const q2 = getDateQualityProjection(db, '2026-03-01', new Date('2026-03-01T14:00:00.000Z'), 'UTC');
      expect(q2.qualityStatus).toBe('verified_zero');
    });
  });
});
