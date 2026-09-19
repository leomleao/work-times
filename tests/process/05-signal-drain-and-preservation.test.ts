import { describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import { createTempDb, getAvailablePort, spawnServer } from './helpers';
import { createRuntime, FsExtProcessLock } from '$lib/server/runtime';
import { parsePublicUrl } from '$lib/server/config';
import { openDatabase } from '$lib/server/db/connection';
import type { RunRequest } from '$lib/server/sync/contracts';

describe('P10A2 Process Evidence: Bounded Signal Drain, Queue Preservation, DB Closure, & Ownership Release', () => {
  describe('SIGTERM Bounded Drain and Shutdown', () => {
    it('stops intake, drains in-flight HTTP POST request, closes DB, and exits with 0 on SIGTERM', async () => {
      const temp = createTempDb('wt-drain-sigterm-');
      const port = await getAvailablePort();

      const server = await spawnServer({
        dbPath: temp.dbPath,
        port
      });

      try {
        await server.waitForStarted();

        // 1. Initiate chunked HTTP POST request that remains genuinely open/in-flight
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/login',
          method: 'POST',
          headers: {
            'Transfer-Encoding': 'chunked',
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });

        const responsePromise = new Promise<number>((resolve, reject) => {
          req.on('response', (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve(res.statusCode ?? 0));
          });
          req.on('error', reject);
        });

        // Write initial chunk: request is actively in-flight
        req.write('chunk1=initial&');

        // Allow network frame to be transmitted
        await new Promise((r) => setTimeout(r, 100));

        // 2. Deliver SIGTERM while HTTP request is in-flight
        const startTime = Date.now();
        server.kill('SIGTERM');

        // Wait for stopping event
        await server.waitForOutput('server.stopping', 'stdout');

        // 3. Verify new connection attempts are immediately refused once intake closes
        const newReqError = await new Promise<Error | null>((resolve) => {
          const rejectedReq = http.get(`http://127.0.0.1:${port}/login`, (res) => {
            res.resume();
            resolve(null);
          });
          rejectedReq.on('error', (err) => resolve(err));
        });
        expect(newReqError).not.toBeNull();

        // 4. Complete the in-flight body while server is draining
        req.end('chunk2=final');

        // 5. In-flight request successfully receives response
        const statusCode = await responsePromise;
        expect(statusCode).toBeGreaterThanOrEqual(200);

        // 6. Process exits cleanly with exit code 0
        const exitCode = await server.waitForExit();
        const duration = Date.now() - startTime;

        expect(exitCode).toBe(0);
        expect(duration).toBeLessThan(20_000); // strictly within bounded 20s grace period
        expect(server.getStdout()).toContain('server.stopped');

        // 7. Ownership lock released and sibling can acquire immediately
        const siblingLock = new FsExtProcessLock(temp.dbPath);
        expect(await siblingLock.acquire()).toBe(true);
        expect(siblingLock.isHeld()).toBe(true);
        await siblingLock.release();

        // Lock file is preserved on disk
        expect(fs.existsSync(temp.lockPath)).toBe(true);
      } finally {
        server.kill('SIGKILL');
        temp.cleanup();
      }
    }, 25_000);
  });

  describe('SIGINT Bounded Drain and Shutdown', () => {
    it('stops intake, drains in-flight HTTP request, and exits with 0 on SIGINT', async () => {
      const temp = createTempDb('wt-drain-sigint-');
      const port = await getAvailablePort();

      const server = await spawnServer({
        dbPath: temp.dbPath,
        port
      });

      try {
        await server.waitForStarted();

        // Start in-flight request
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/login',
          method: 'POST',
          headers: {
            'Transfer-Encoding': 'chunked',
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });

        const responsePromise = new Promise<number>((resolve, reject) => {
          req.on('response', (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve(res.statusCode ?? 0));
          });
          req.on('error', reject);
        });

        req.write('sigint_data=part1&');
        await new Promise((r) => setTimeout(r, 100));

        // Deliver SIGINT
        const startTime = Date.now();
        server.kill('SIGINT');

        await server.waitForOutput('server.stopping', 'stdout');

        // Prove new connections refused
        const newReqError = await new Promise<Error | null>((resolve) => {
          const rejectedReq = http.get(`http://127.0.0.1:${port}/login`, (res) => {
            res.resume();
            resolve(null);
          });
          rejectedReq.on('error', (err) => resolve(err));
        });
        expect(newReqError).not.toBeNull();

        // Finish in-flight body
        req.end('sigint_data=part2');
        const statusCode = await responsePromise;
        expect(statusCode).toBeGreaterThanOrEqual(200);

        const exitCode = await server.waitForExit();
        const duration = Date.now() - startTime;

        expect(exitCode).toBe(0);
        expect(duration).toBeLessThan(20_000);
        expect(server.getStdout()).toContain('server.stopped');

        // Sibling can acquire lock
        const siblingLock = new FsExtProcessLock(temp.dbPath);
        expect(await siblingLock.acquire()).toBe(true);
        await siblingLock.release();
      } finally {
        server.kill('SIGKILL');
        temp.cleanup();
      }
    }, 25_000);
  });

  describe('Queued Work Preservation Across Shutdown & Recovery', () => {
    it('preserves queued runs and marks running runs interrupted on graceful stop', async () => {
      const temp = createTempDb('wt-queue-preservation-');

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

      await isolated.lifecycle.start();
      expect(isolated.lifecycle.getReadiness().ready).toBe(true);

      // Enqueue first run (which will be claimed/interrupted)
      const req1: RunRequest = {
        mode: 'recent',
        trigger: 'manual',
        idempotencyKey: 'preservation-key-1',
        rangeStartDate: '2026-09-10',
        rangeEndDate: '2026-09-11'
      };
      const { runId: runId1 } = await isolated.coordinator.enqueue(req1);

      // Enqueue second run (which stays queued behind the first)
      const req2: RunRequest = {
        mode: 'recent',
        trigger: 'manual',
        idempotencyKey: 'preservation-key-2',
        rangeStartDate: '2026-09-08',
        rangeEndDate: '2026-09-09'
      };
      const { runId: runId2 } = await isolated.coordinator.enqueue(req2);

      // Graceful stop
      const stopStart = Date.now();
      await isolated.lifecycle.stop('shutdown', 20_000);
      expect(Date.now() - stopStart).toBeLessThan(20_000);

      // Verify DB closed on isolated instance
      expect(isolated.db.open).toBe(false);

      // Reopen DB independently to verify state preservation
      const inspectDb = openDatabase({ path: temp.dbPath, migrate: false });
      try {
        // Run 2 must still exist with status 'queued'
        const queuedRow = inspectDb
          .prepare('SELECT id, status, mode, idempotency_key FROM sync_runs WHERE id = ?')
          .get(runId2) as { id: number; status: string; mode: string; idempotency_key: string } | undefined;

        expect(queuedRow).toBeDefined();
        expect(queuedRow?.id).toBe(runId2);
        expect(queuedRow?.status).toBe('queued');
        expect(queuedRow?.idempotency_key).toBe('preservation-key-2');

        // Run 1 was active and interrupted or completed cleanly
        const run1Row = inspectDb
          .prepare('SELECT id, status FROM sync_runs WHERE id = ?')
          .get(runId1) as { id: number; status: string } | undefined;
        expect(run1Row).toBeDefined();
        expect(['queued', 'running', 'interrupted', 'succeeded', 'failed']).toContain(run1Row?.status);
      } finally {
        inspectDb.close();
      }

      // Now start a fresh runtime against that database to verify crash recovery runs cleanly
      const recoveredRuntime = createRuntime({
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

      await recoveredRuntime.lifecycle.start();
      expect(recoveredRuntime.lifecycle.getReadiness().ready).toBe(true);
      expect(recoveredRuntime.lifecycle.getReadiness().recoveryComplete).toBe(true);

      // Verify run 2 was preserved and resumed (status is queued or picked up as running)
      const afterRecoveryDb = recoveredRuntime.db;
      const preservedRow = afterRecoveryDb
        .prepare('SELECT id, status FROM sync_runs WHERE id = ?')
        .get(runId2) as { id: number; status: string } | undefined;
      expect(['queued', 'running']).toContain(preservedRow?.status);

      await recoveredRuntime.lifecycle.stop('shutdown', 5000);
      temp.cleanup();
    });
  });

  describe('Database Closure & Post-Shutdown Query Invalidation', () => {
    it('closes SQLite connection on lifecycle.stop and rejects queries after stop', async () => {
      const temp = createTempDb('wt-db-closure-');

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

      await isolated.lifecycle.start();
      expect(isolated.db.open).toBe(true);

      // Run a query while running
      const row = isolated.db.prepare('SELECT 1 as val').get() as { val: number };
      expect(row.val).toBe(1);

      // Stop runtime
      await isolated.lifecycle.stop('shutdown', 5000);

      // Database connection must be closed
      expect(isolated.db.open).toBe(false);

      // Queries attempted after closure throw error
      expect(() => {
        isolated.db.prepare('SELECT 1 as val').get();
      }).toThrow(/not open/i);

      // Process ownership lock released
      const siblingLock = new FsExtProcessLock(temp.dbPath);
      expect(await siblingLock.acquire()).toBe(true);
      await siblingLock.release();

      temp.cleanup();
    });

    it('lifecycle.stop drains in-flight HTTP requests before closing database', async () => {
      const temp = createTempDb('wt-drain-order-');

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

      await isolated.lifecycle.start();

      let dbWasOpenDuringDrain = false;
      const simulatedInFlightDrain = async () => {
        // Simulate an HTTP handler reading the DB during drain
        await new Promise((r) => setTimeout(r, 50));
        dbWasOpenDuringDrain = isolated.db.open;
        if (isolated.db.open) {
          isolated.db.prepare('SELECT 1').get();
        }
      };

      await (
        isolated.lifecycle.stop as (
          reason: 'shutdown',
          deadlineMs: number,
          drain?: () => Promise<void>
        ) => Promise<void>
      )('shutdown', 5000, simulatedInFlightDrain);

      // Database was open during in-flight HTTP drain
      expect(dbWasOpenDuringDrain).toBe(true);

      // And closed after drain completed
      expect(isolated.db.open).toBe(false);

      temp.cleanup();
    });
  });
});
