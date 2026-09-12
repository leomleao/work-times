import { describe, expect, it, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { runtime, createRuntime, getRuntime, FsExtProcessLock, InMemoryProcessLock } from './runtime';
import { openTestDatabase, openDatabase } from '$lib/server/db/connection';
import { parsePublicUrl } from '$lib/server/config';
import { LIFECYCLE_SYMBOL, type RunRequest } from '$lib/server/sync/contracts';

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

describe('server runtime singleton', () => {
  beforeAll(async () => {
    // Start runtime lifecycle to run migrations and recovery
    await runtime.lifecycle.start();
  });

  it('initializes module singleton with migrated database and services', () => {
    expect(runtime).toBeDefined();
    expect(runtime.config.databasePath).toBe(':memory:');
    expect(runtime.db).toBeDefined();
    expect(runtime.db.name).toBe(':memory:');
    expect(runtime.adminAuth).toBeDefined();
    expect(runtime.loginLimiter).toBeDefined();
    expect(runtime.registrationLimiter).toBeDefined();
    expect(runtime.apiKeys).toBeDefined();
    expect(runtime.oauthClients).toBeDefined();
    expect(runtime.oauthAuth).toBeDefined();
    expect(runtime.classification).toBeDefined();
    expect(runtime.analytics).toBeDefined();
    expect(runtime.tokenVerifier).toBeDefined();
    expect(runtime.mcpHandler).toBeDefined();
    expect(runtime.authenticatedMcpHandler).toBeDefined();
    expect(runtime.coordinator).toBeDefined();
    expect(runtime.scheduler).toBeDefined();
    expect(runtime.lifecycle).toBeDefined();
    expect(runtime.processLock).toBeDefined();
    expect(runtime.sessionSecret).toBeDefined();
    expect(runtime.sessionSecret.length).toBeGreaterThanOrEqual(32);

    // Database tables exist after lifecycle.start()
    const tables = runtime.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((t) => t.name));

    expect(tableNames.has('schema_migrations')).toBe(true);
    expect(tableNames.has('admin_sessions')).toBe(true);
    expect(tableNames.has('api_keys')).toBe(true);
    expect(tableNames.has('oauth_clients')).toBe(true);
    expect(tableNames.has('oauth_tokens')).toBe(true);
    expect(tableNames.has('classification_rules')).toBe(true);
    expect(tableNames.has('sync_runs')).toBe(true);
    expect(tableNames.has('sync_days')).toBe(true);
    expect(tableNames.has('sync_layer_state')).toBe(true);

    const readiness = runtime.lifecycle.getReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.migrationsComplete).toBe(true);
    expect(readiness.recoveryComplete).toBe(true);
    expect(readiness.serviceRegistered).toBe(true);
    expect(readiness.ownershipLockHeld).toBe(true);
  });

  it('can create an isolated runtime with custom test database', async () => {
    const testDb = openTestDatabase();
    const testRuntime = createRuntime(
      {
        databasePath: ':memory:',
        wakatimeOAuthClientId: null,
        wakatimeOAuthClientSecret: null,
        adminUsername: 'testadmin',
        adminPasswordHash: null,
        sessionSecret: '0123456789abcdef0123456789abcdef',
        publicUrl: parsePublicUrl('http://localhost:3002'),
        cookieSecure: false,
        maxDirectImportBytes: 10 * 1024 * 1024
      },
      testDb
    );

    expect(testRuntime.config.adminUsername).toBe('testadmin');
    const createdKey = await testRuntime.apiKeys.create({
      name: 'test-key',
      scopes: ['activity:read']
    });
    expect(createdKey.token.startsWith('wtk_')).toBe(true);

    const keys = await testRuntime.apiKeys.list();
    expect(keys.length).toBe(1);
    expect(keys[0].name).toBe('test-key');
  });

  it('rejects unauthorized MCP request through authenticatedMcpHandler', async () => {
    const request = new Request('http://localhost:3002/mcp', {
      method: 'POST',
      headers: {
        Host: 'localhost:3002',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 })
    });

    const response = await runtime.authenticatedMcpHandler(request);
    expect(response.status).toBe(401);
    const wwwAuth = response.headers.get('www-authenticate');
    expect(wwwAuth).toContain('Bearer');
    expect(wwwAuth).toContain('activity:read');
  });
});

describe('Lifecycle and Ownership Contracts (P7)', () => {
  it('enforces import/build no effects: createRuntime constructs without running migrations, recovery, or timers', () => {
    const rawDb = openDatabase({ path: ':memory:', migrate: false });

    // Verify rawDb has no tables before runtime construction
    const tablesBefore = rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tablesBefore).toHaveLength(0);

    const isolatedRuntime = createRuntime(
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
      rawDb
    );

    // After construction ONLY: NO migrations have run
    const tablesAfterConstruction = rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tablesAfterConstruction).toHaveLength(0);

    // Readiness is false; no timers running
    const readiness = isolatedRuntime.lifecycle.getReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.migrationsComplete).toBe(false);
    expect(readiness.recoveryComplete).toBe(false);
    expect(readiness.serviceRegistered).toBe(false);
    expect(readiness.ownershipLockHeld).toBe(false);
    expect(isolatedRuntime.scheduler.isRunning()).toBe(false);
    expect(isolatedRuntime.coordinator.isRunning()).toBe(false);

    rawDb.close();
  });

  it('proves fresh child-process module import has zero config/DB/timer/network side effects', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-import-side-effects-'));
    const targetDb = path.join(tempDir, 'nonexistent.db');

    const childScript = `
      import fs from 'node:fs';
      import path from 'node:path';

      const dbPath = process.argv[1];
      process.env.DATABASE_PATH = dbPath;

      import('./src/lib/server/runtime.js').then(() => {
        const dbCreated = fs.existsSync(dbPath);
        const lockCreated = fs.existsSync(dbPath + '.lock');
        const bridge = globalThis[Symbol.for('work-times.lifecycle')];
        const hasBridge = typeof bridge?.start === 'function' && typeof bridge?.getReadiness === 'function';
        const readiness = bridge ? bridge.getReadiness() : null;

        console.log(JSON.stringify({
          dbCreated,
          lockCreated,
          hasBridge,
          ready: readiness?.ready ?? null
        }));
        process.exit(0);
      });
    `;

    try {
      const res = spawnSync('./node_modules/.bin/tsx', ['-e', childScript, targetDb], {
        encoding: 'utf8',
        timeout: 15_000
      });

      expect(res.status).toBe(0);
      const data = JSON.parse(res.stdout.trim());
      expect(data.dbCreated).toBe(false);
      expect(data.lockCreated).toBe(false);
      expect(data.hasBridge).toBe(true);
      expect(data.ready).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 25_000);

  it('registers minimal lifecycle bridge on Symbol.for(work-times.lifecycle) without credentials or DB access', () => {
    const bridge = (globalThis as Record<symbol, unknown>)[LIFECYCLE_SYMBOL] as {
      start: () => Promise<void>;
      stop: (reason?: 'shutdown', deadlineMs?: number) => Promise<void>;
      getReadiness: () => { ready: boolean };
    };

    expect(bridge).toBeDefined();
    expect(typeof bridge.start).toBe('function');
    expect(typeof bridge.stop).toBe('function');
    expect(typeof bridge.getReadiness).toBe('function');

    // Bridge MUST NOT expose credentials, database, or arbitrary config
    const bridgeObj = bridge as Record<string, unknown>;
    expect(bridgeObj.config).toBeUndefined();
    expect(bridgeObj.db).toBeUndefined();
    expect(bridgeObj.sessionSecret).toBeUndefined();
    expect(bridgeObj.adminAuth).toBeUndefined();
    expect(bridgeObj.apiKeys).toBeUndefined();
    expect(bridgeObj.prepare).toBeUndefined();
  });

  it('achieves lifecycle readiness without upstream WakaTime availability', async () => {
    const testDb = openTestDatabase();
    const isolatedRuntime = createRuntime(
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
        // No wakatimeClient provided (upstream unavailable)
        wakatimeClient: undefined
      }
    );

    // Upstream unavailability must not prevent serving the app or reaching readiness
    await isolatedRuntime.lifecycle.start();

    const readiness = isolatedRuntime.lifecycle.getReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.migrationsComplete).toBe(true);
    expect(readiness.recoveryComplete).toBe(true);
    expect(readiness.serviceRegistered).toBe(true);
    expect(readiness.ownershipLockHeld).toBe(true);

    await isolatedRuntime.lifecycle.stop('shutdown', 20_000);
  });

  it('guarantees dev HMR singleton: getRuntime returns identical instance without duplicating coordinators', () => {
    const instance1 = getRuntime();
    const instance2 = getRuntime();

    expect(instance1).toBe(instance2);
    expect(instance1.coordinator).toBe(instance2.coordinator);
    expect(instance1.scheduler).toBe(instance2.scheduler);
    expect(instance1.lifecycle).toBe(instance2.lifecycle);
  });

  describe('Process Lock Ownership Contention & Release', () => {
    it('enforces nonblocking fs-ext flock exnb contention and release on file database', async () => {
      const tempDir = path.join(os.tmpdir(), `wt-lock-test-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      const dbPath = path.join(tempDir, 'test.db');

      const lock1 = new FsExtProcessLock(dbPath);
      const lock2 = new FsExtProcessLock(dbPath);

      // Process 1 acquires lock
      const acquired1 = await lock1.acquire();
      expect(acquired1).toBe(true);
      expect(lock1.isHeld()).toBe(true);

      // Process 2 attempts acquire and fails nonblocking (EAGAIN/EWOULDBLOCK)
      const acquired2 = await lock2.acquire();
      expect(acquired2).toBe(false);
      expect(lock2.isHeld()).toBe(false);

      // Process 1 releases lock
      await lock1.release();
      expect(lock1.isHeld()).toBe(false);

      // Lock file is NEVER unlinked while processes may use it
      expect(fs.existsSync(`${path.resolve(dbPath)}.lock`)).toBe(true);

      // Process 2 can now acquire lock
      const acquired2AfterRelease = await lock2.acquire();
      expect(acquired2AfterRelease).toBe(true);
      expect(lock2.isHeld()).toBe(true);

      // Process 2 releases lock
      await lock2.release();
      expect(lock2.isHeld()).toBe(false);

      // Clean up temp directory
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('enforces real child-process nonblocking flock contention and subsequent acquisition', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-child-flock-'));
      const dbPath = path.join(tempDir, 'test.db');
      const parentLock = new FsExtProcessLock(dbPath);

      try {
        const parentAcquired = await parentLock.acquire();
        expect(parentAcquired).toBe(true);

        const childScript = `
          import { FsExtProcessLock } from './src/lib/server/runtime';
          const lock = new FsExtProcessLock(process.argv[1]);
          lock.acquire().then(ok => {
            process.exit(ok ? 0 : 42);
          });
        `;

        // 1. Child process rejected while parent holds lock
        const res1 = spawnSync('./node_modules/.bin/tsx', ['-e', childScript, dbPath], {
          encoding: 'utf8',
          timeout: 15_000
        });
        expect(res1.status).toBe(42);

        // 2. Parent releases lock
        await parentLock.release();
        expect(parentLock.isHeld()).toBe(false);

        // Lock file is never unlinked
        expect(fs.existsSync(`${path.resolve(dbPath)}.lock`)).toBe(true);

        // 3. Child process now acquires lock successfully
        const res2 = spawnSync('./node_modules/.bin/tsx', ['-e', childScript, dbPath], {
          encoding: 'utf8',
          timeout: 15_000
        });
        expect(res2.status).toBe(0);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }, 25_000);

    it('supports injected InMemoryProcessLock with contention simulation', async () => {
      const lock = new InMemoryProcessLock();
      expect(await lock.acquire()).toBe(true);
      expect(lock.isHeld()).toBe(true);

      // Second acquire while held fails
      expect(await lock.acquire()).toBe(false);

      await lock.release();
      expect(lock.isHeld()).toBe(false);

      // Simulated failure
      lock.shouldFailAcquire = true;
      expect(await lock.acquire()).toBe(false);
    });

    it('rejects runtime startup if ownership lock cannot be acquired', async () => {
      const testDb = openTestDatabase();
      const failingLock = new InMemoryProcessLock();
      failingLock.shouldFailAcquire = true;

      const isolatedRuntime = createRuntime(
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
          processLock: failingLock
        }
      );

      await expect(isolatedRuntime.lifecycle.start()).rejects.toThrow(
        /Failed to acquire process ownership lock/
      );
      expect(isolatedRuntime.lifecycle.getReadiness().ready).toBe(false);
      expect(isolatedRuntime.lifecycle.getReadiness().ownershipLockHeld).toBe(false);
    });
  });

  describe('Bounded Signal Shutdown & Queue Preservation', () => {
    it('stops intake and timers, interrupts active work, closes DB, and preserves queue within 20 seconds', async () => {
      const tempDir = path.join(os.tmpdir(), `wt-shutdown-test-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      const dbPath = path.join(tempDir, 'test-shutdown.db');

      const isolatedRuntime = createRuntime(
        {
          databasePath: dbPath,
          wakatimeOAuthClientId: null,
          wakatimeOAuthClientSecret: null,
          adminUsername: 'admin',
          adminPasswordHash: null,
          sessionSecret: '0123456789abcdef0123456789abcdef',
          publicUrl: parsePublicUrl('http://localhost:3002'),
          cookieSecure: false,
          maxDirectImportBytes: 10 * 1024 * 1024
        }
      );

      await isolatedRuntime.lifecycle.start();
      expect(isolatedRuntime.lifecycle.getReadiness().ready).toBe(true);

      // Enqueue a queued run in SQLite
      const req: RunRequest = {
        mode: 'recent',
        trigger: 'manual',
        idempotencyKey: 'shutdown-test-queue-1',
        rangeStartDate: '2026-09-10',
        rangeEndDate: '2026-09-11'
      };
      const { runId } = await isolatedRuntime.coordinator.enqueue(req);

      const startTime = Date.now();
      // Invoke graceful stop with 20 second deadline
      await isolatedRuntime.lifecycle.stop('shutdown', 20_000);
      const elapsed = Date.now() - startTime;

      // Completed well within 20s grace period
      expect(elapsed).toBeLessThan(20_000);

      // Intake is rejected
      await expect(isolatedRuntime.coordinator.enqueue(req)).rejects.toThrow(/stopped/);

      // Readiness is cleared
      const readiness = isolatedRuntime.lifecycle.getReadiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.ownershipLockHeld).toBe(false);

      // Timers stopped
      expect(isolatedRuntime.scheduler.isRunning()).toBe(false);
      expect(isolatedRuntime.coordinator.isRunning()).toBe(false);

      // Re-open DB to verify queued run survived and was preserved across shutdown
      const checkDb = openDatabase({ path: dbPath, migrate: false });
      const runRow = checkDb.prepare('SELECT id, status, mode FROM sync_runs WHERE id = ?').get(runId) as { id: number; status: string; mode: string } | undefined;
      expect(runRow).toBeDefined();
      expect(runRow?.id).toBe(runId);
      expect(['queued', 'interrupted']).toContain(runRow?.status);
      checkDb.close();

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('Custom Server (server/index.mjs) Lifecycle, Signals, & HTTP Drain', () => {
    it('achieves readiness before listen, serves HTTP, drains connections, and exits cleanly on SIGTERM', async () => {
      const port = await getAvailablePort();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-srv-sigterm-'));
      const testDb = path.join(tempDir, 'server.db');

      const child = spawn('node', ['server/index.mjs'], {
        env: {
          ...process.env,
          DATABASE_PATH: testDb,
          PORT: String(port),
          HOST: '127.0.0.1',
          SESSION_SECRET: '0123456789abcdef0123456789abcdef',
          PUBLIC_URL: `http://127.0.0.1:${port}`,
          ORIGIN: `http://127.0.0.1:${port}`
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Timeout waiting for server to start. Stderr: ${stderr}`)), 15_000);
          child.stdout.on('data', (d) => {
            if (d.toString().includes('server.started')) {
              clearTimeout(timeout);
              resolve();
            }
          });
          child.on('exit', (code) => reject(new Error(`Server exited prematurely with code ${code}. Stderr: ${stderr}`)));
        });

        const statusCode = await new Promise<number>((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${port}/login`, (res) => resolve(res.statusCode ?? 0));
          req.on('error', reject);
        });
        expect(statusCode).toBe(200);

        // Send SIGTERM for graceful shutdown
        child.kill('SIGTERM');

        const exitCode = await new Promise<number | null>((resolve) => {
          child.on('exit', (code) => resolve(code));
        });

        expect(exitCode).toBe(0);
        expect(stdout).toContain('server.stopping');
        expect(stdout).toContain('server.stopped');
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }, 25_000);

    it('custom server exits cleanly on SIGINT', async () => {
      const port = await getAvailablePort();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-srv-sigint-'));
      const testDb = path.join(tempDir, 'server.db');

      const child = spawn('node', ['server/index.mjs'], {
        env: {
          ...process.env,
          DATABASE_PATH: testDb,
          PORT: String(port),
          HOST: '127.0.0.1',
          SESSION_SECRET: '0123456789abcdef0123456789abcdef',
          PUBLIC_URL: `http://127.0.0.1:${port}`,
          ORIGIN: `http://127.0.0.1:${port}`
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Timeout waiting for server to start. Stderr: ${stderr}`)), 15_000);
          child.stdout.on('data', (d) => {
            if (d.toString().includes('server.started')) {
              clearTimeout(timeout);
              resolve();
            }
          });
          child.on('exit', (code) => reject(new Error(`Server exited prematurely with code ${code}. Stderr: ${stderr}`)));
        });

        const statusCode = await new Promise<number>((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${port}/login`, (res) => resolve(res.statusCode ?? 0));
          req.on('error', reject);
        });
        expect(statusCode).toBe(200);

        // Send SIGINT
        child.kill('SIGINT');

        const exitCode = await new Promise<number | null>((resolve) => {
          child.on('exit', (code) => resolve(code));
        });

        expect(exitCode).toBe(0);
        expect(stdout).toContain('server.stopping');
        expect(stdout).toContain('server.stopped');
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }, 25_000);

    it('custom server aborts startup before listen if process ownership lock is held by another process', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-srv-contention-'));
      const testDb = path.join(tempDir, 'test.db');
      const parentLock = new FsExtProcessLock(testDb);

      try {
        const acquired = await parentLock.acquire();
        expect(acquired).toBe(true);

        const port = await getAvailablePort();
        const res = spawnSync('node', ['server/index.mjs'], {
          env: {
            ...process.env,
            DATABASE_PATH: testDb,
            PORT: String(port),
            HOST: '127.0.0.1',
            SESSION_SECRET: '0123456789abcdef0123456789abcdef',
            PUBLIC_URL: `http://127.0.0.1:${port}`,
            ORIGIN: `http://127.0.0.1:${port}`
          },
          encoding: 'utf8',
          timeout: 10_000
        });

        expect(res.status).toBe(1);
        expect(res.stderr).toContain('ownership lock');
      } finally {
        await parentLock.release();
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});

