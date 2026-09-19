import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { createTempDb, getAvailablePort, spawnServer } from './helpers';
import { createRuntime, FsExtProcessLock } from '$lib/server/runtime';
import { parsePublicUrl } from '$lib/server/config';
import { openTestDatabase } from '$lib/server/db/connection';

describe('P10A2 Process Evidence: Readiness Before Listen & Startup Failure Cleanup', () => {
  describe('Readiness Before Listen Without Upstream Reachability', () => {
    it('achieves lifecycle readiness and binds HTTP port without WakaTime upstream reachability', async () => {
      const temp = createTempDb('wt-readiness-no-upstream-');
      const port = await getAvailablePort();

      const server = await spawnServer({
        dbPath: temp.dbPath,
        port,
        env: {
          // Explicitly dummy / unreachable upstream
          WAKATIME_CLIENT_ID: 'dummy-client-id',
          WAKATIME_CLIENT_SECRET: 'dummy-client-secret',
          WAKATIME_API_BASE: 'http://127.0.0.1:59999'
        }
      });

      try {
        // Wait for server to complete startup and achieve readiness before listen
        await server.waitForStarted();
        expect(server.getStdout()).toContain('server.started');

        // Verify HTTP endpoints respond immediately
        const healthStatus = await new Promise<number>((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on('error', reject);
        });
        expect(healthStatus).toBe(200);

        const loginStatus = await new Promise<number>((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${port}/login`, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on('error', reject);
        });
        expect(loginStatus).toBe(200);
      } finally {
        server.kill('SIGTERM');
        await server.waitForExit();
        temp.cleanup();
      }
    }, 25_000);

    it('runtime in-process achieves readiness without wakatimeClient and reports truthful status', async () => {
      const testDb = openTestDatabase();
      const isolated = createRuntime(
        {
          databasePath: ':memory:',
          wakatimeOAuthClientId: null,
          wakatimeOAuthClientSecret: null,
          adminUsername: 'admin',
          adminPasswordHash: null,
          sessionSecret: '0123456789abcdef0123456789abcdef',
          publicUrl: parsePublicUrl('http://localhost:3002'),
          cookieSecure: false,
          maxDirectImportBytes: 10 * 1024 * 1024
        },
        testDb,
        {
          wakatimeClient: undefined
        }
      );

      await isolated.lifecycle.start();

      const readiness = isolated.getReadiness();
      expect(readiness.ready).toBe(true);
      expect(readiness.state).toBe('running');
      expect(readiness.migrationsComplete).toBe(true);
      expect(readiness.recoveryComplete).toBe(true);
      expect(readiness.serviceRegistered).toBe(true);
      expect(readiness.ownershipLockHeld).toBe(true);
      expect(readiness.errorCode).toBeNull();

      await isolated.lifecycle.stop('shutdown', 5000);
      expect(isolated.lifecycle.getReadiness().ready).toBe(false);
    });
  });

  describe('Startup Failure Cleanup & Lock Release', () => {
    it('quiesces services, closes DB, and releases lock on recovery failure', async () => {
      const temp = createTempDb('wt-fail-recovery-');

      const isolated = createRuntime({
        databasePath: temp.dbPath,
        wakatimeOAuthClientId: null,
        wakatimeOAuthClientSecret: null,
        adminUsername: 'admin',
        adminPasswordHash: null,
        sessionSecret: '0123456789abcdef0123456789abcdef',
        publicUrl: parsePublicUrl('http://localhost:3002'),
        cookieSecure: false,
        maxDirectImportBytes: 10 * 1024 * 1024
      });

      // Inject recovery failure
      isolated.coordinator.runRecovery = async () => {
        throw new Error('Simulated crash recovery failure');
      };

      await expect(isolated.lifecycle.start()).rejects.toThrow('Simulated crash recovery failure');

      // Verify state and allowlisted error code
      const readiness = isolated.getReadiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.state).toBe('failed');
      expect(readiness.ownershipLockHeld).toBe(false);
      expect(readiness.errorCode).toBe('RECOVERY_FAILED');

      // Services quiesced & DB closed
      expect(isolated.coordinator.isRunning()).toBe(false);
      expect(isolated.scheduler.isRunning()).toBe(false);
      expect(isolated.db.open).toBe(false);

      // Lock was released: sibling can acquire immediately
      const siblingLock = new FsExtProcessLock(temp.dbPath);
      expect(await siblingLock.acquire()).toBe(true);
      await siblingLock.release();

      // Subsequent fresh runtime can start successfully
      const freshRuntime = createRuntime({
        databasePath: temp.dbPath,
        wakatimeOAuthClientId: null,
        wakatimeOAuthClientSecret: null,
        adminUsername: 'admin',
        adminPasswordHash: null,
        sessionSecret: '0123456789abcdef0123456789abcdef',
        publicUrl: parsePublicUrl('http://localhost:3002'),
        cookieSecure: false,
        maxDirectImportBytes: 10 * 1024 * 1024
      });
      await freshRuntime.lifecycle.start();
      expect(freshRuntime.lifecycle.getReadiness().ready).toBe(true);
      await freshRuntime.lifecycle.stop('shutdown', 5000);

      temp.cleanup();
    });

    it('quiesces services, closes DB, and releases lock on coordinator start failure', async () => {
      const temp = createTempDb('wt-fail-coord-');

      const isolated = createRuntime({
        databasePath: temp.dbPath,
        wakatimeOAuthClientId: null,
        wakatimeOAuthClientSecret: null,
        adminUsername: 'admin',
        adminPasswordHash: null,
        sessionSecret: '0123456789abcdef0123456789abcdef',
        publicUrl: parsePublicUrl('http://localhost:3002'),
        cookieSecure: false,
        maxDirectImportBytes: 10 * 1024 * 1024
      });

      // Inject coordinator start failure
      isolated.coordinator.start = async () => {
        throw new Error('Simulated coordinator start failure');
      };

      await expect(isolated.lifecycle.start()).rejects.toThrow('Simulated coordinator start failure');

      const readiness = isolated.getReadiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.state).toBe('failed');
      expect(readiness.ownershipLockHeld).toBe(false);
      expect(readiness.errorCode).toBe('COORDINATOR_FAILED');
      expect(isolated.db.open).toBe(false);

      // Lock released
      const siblingLock = new FsExtProcessLock(temp.dbPath);
      expect(await siblingLock.acquire()).toBe(true);
      await siblingLock.release();

      temp.cleanup();
    });

    it('quiesces services, closes DB, and releases lock on scheduler start failure', async () => {
      const temp = createTempDb('wt-fail-sched-');

      const isolated = createRuntime({
        databasePath: temp.dbPath,
        wakatimeOAuthClientId: null,
        wakatimeOAuthClientSecret: null,
        adminUsername: 'admin',
        adminPasswordHash: null,
        sessionSecret: '0123456789abcdef0123456789abcdef',
        publicUrl: parsePublicUrl('http://localhost:3002'),
        cookieSecure: false,
        maxDirectImportBytes: 10 * 1024 * 1024
      });

      // Seed scheduling enabled in DB
      isolated.db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('sync.scheduling_enabled', 'true', '2026-09-01T00:00:00.000Z')").run();

      // Inject scheduler start failure
      isolated.scheduler.start = async () => {
        throw new Error('Simulated scheduler start failure');
      };

      await expect(isolated.lifecycle.start()).rejects.toThrow('Simulated scheduler start failure');

      const readiness = isolated.getReadiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.state).toBe('failed');
      expect(readiness.ownershipLockHeld).toBe(false);
      expect(readiness.errorCode).toBe('SCHEDULER_FAILED');
      expect(isolated.db.open).toBe(false);

      // Lock released
      const siblingLock = new FsExtProcessLock(temp.dbPath);
      expect(await siblingLock.acquire()).toBe(true);
      await siblingLock.release();

      temp.cleanup();
    });

    it('reports allowlisted errorCode and ready: false without leaking raw SQL when schema query fails during running', async () => {
      const testDb = openTestDatabase();
      const isolated = createRuntime(
        {
          databasePath: ':memory:',
          wakatimeOAuthClientId: null,
          wakatimeOAuthClientSecret: null,
          adminUsername: 'admin',
          adminPasswordHash: null,
          sessionSecret: '0123456789abcdef0123456789abcdef',
          publicUrl: parsePublicUrl('http://localhost:3002'),
          cookieSecure: false,
          maxDirectImportBytes: 10 * 1024 * 1024
        },
        testDb
      );

      await isolated.lifecycle.start();
      expect(isolated.lifecycle.getReadiness().ready).toBe(true);

      // Drop table while running
      testDb.exec('DROP TABLE sync_runs');

      const readiness = isolated.getReadiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.errorCode).toBe('SCHEMA_QUERY_FAILED');
      // No raw SQL error details leaked
      expect(readiness.errorCode).not.toContain('sqlite3');
      expect(readiness.errorCode).not.toContain('sync_runs');

      await isolated.lifecycle.stop('shutdown', 5000);
    });
  });
});
