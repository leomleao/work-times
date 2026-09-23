import { describe, expect, it } from 'vitest';
import { runtime, getRuntime, createRuntime, RUNTIME_SYMBOL } from '$lib/server/runtime';
import { openTestDatabase } from '$lib/server/db/connection';
import { parsePublicUrl } from '$lib/server/config';
import { runNodeScript } from './helpers';

describe('P10A2 Process Evidence: Singleton Identity, Dev HMR, & Scheduling Guards', () => {
  it('guarantees one runtime and coordinator singleton across repeated calls', () => {
    const r1 = getRuntime();
    const r2 = getRuntime();

    // Identical runtime instance
    expect(r1).toBe(r2);

    // Coordinator and scheduler references are singular
    expect(r1.coordinator).toBe(r2.coordinator);
    expect(r1.sync).toBe(r1.coordinator);
    expect(r1.scheduler).toBe(r2.scheduler);
    expect(r1.lifecycle).toBe(r2.lifecycle);
    expect(r1.db).toBe(r2.db);

    // Global symbol holds the exact instance
    expect((globalThis as Record<symbol, unknown>)[RUNTIME_SYMBOL]).toBe(r1);
  });

  it('guarantees isolated createRuntime does not mutate or bleed into global singleton', () => {
    const globalInstanceBefore = getRuntime();
    const testDb = openTestDatabase();

    const isolated = createRuntime(
      {
        databasePath: ':memory:',
        wakatimeOAuthClientId: null,
        wakatimeOAuthClientSecret: null,
        adminUsername: 'isolated-admin',
        adminPasswordHash: null,
        sessionSecret: 'fedcba9876543210fedcba9876543210',
        publicUrl: parsePublicUrl('http://localhost:3999'),
        cookieSecure: false,
        maxDirectImportBytes: 5 * 1024 * 1024
      },
      testDb
    );

    // Isolated runtime must be a distinct object
    expect(isolated).not.toBe(globalInstanceBefore);
    expect(isolated.coordinator).not.toBe(globalInstanceBefore.coordinator);
    expect(isolated.scheduler).not.toBe(globalInstanceBefore.scheduler);
    expect(isolated.db).not.toBe(globalInstanceBefore.db);
    expect(isolated.config.adminUsername).toBe('isolated-admin');

    // Global singleton is completely untouched
    const globalInstanceAfter = getRuntime();
    expect(globalInstanceAfter).toBe(globalInstanceBefore);
    expect(globalInstanceAfter.config.adminUsername).toBe(globalInstanceBefore.config.adminUsername);

    testDb.close();
  });

  it('exercises actual ESM module re-evaluation/reload path and shows one runtime and coordinator survive', () => {
    // Child-process verification: prove top-level module re-execution in a clean Node environment
    // where mod1 and mod2 create separate module records and separate exported Proxy objects,
    // but share the exact same runtime and coordinator instances via Symbol.for('work-times.runtime').
    //
    // Untestable boundary note:
    // In production, Node does not run HMR (a process restart or signal is used). In development,
    // Vite dev HMR invalidates and re-executes module records with timestamped query parameters.
    // Inside Vitest's runner, Vite's AST plugin restricts arbitrary template-literal dynamic imports,
    // so we execute the actual ESM module re-evaluation via a dedicated child process script.
    // This faithfully exercises that exact re-execution path across distinct module evaluations.
    const childScript = `
      (async () => {
        const mod1 = await import('./src/lib/server/runtime.js');
        const r1 = mod1.getRuntime();
        const coord1 = r1.coordinator;
        const sched1 = r1.scheduler;
        const db1 = r1.db;

        // Force a second distinct ESM module evaluation by appending a unique query string
        const mod2 = await import('./src/lib/server/runtime.js?hmr-test-reload=' + Date.now());
        const r2 = mod2.getRuntime();
        const coord2 = r2.coordinator;
        const sched2 = r2.scheduler;
        const db2 = r2.db;

        console.log(JSON.stringify({
          distinctModuleRecords: mod1 !== mod2,
          distinctProxies: mod1.runtime !== mod2.runtime,
          sameRuntime: r1 === r2,
          sameCoordinator: coord1 === coord2,
          sameScheduler: sched1 === sched2,
          sameDb: db1 === db2,
          mod2ProxyCoordMatches: mod2.runtime.coordinator === coord1,
          mod2ProxySchedMatches: mod2.runtime.scheduler === sched1
        }));
      })().catch((err) => {
        console.error(err);
        process.exit(1);
      });
    `;

    const res = runNodeScript(childScript);
    expect(res.status).toBe(0);
    const result = JSON.parse(res.stdout.trim());

    // Both module records evaluated fresh
    expect(result.distinctModuleRecords).toBe(true);
    expect(result.distinctProxies).toBe(true);

    // One runtime and coordinator survived across the reload
    expect(result.sameRuntime).toBe(true);
    expect(result.sameCoordinator).toBe(true);
    expect(result.sameScheduler).toBe(true);
    expect(result.sameDb).toBe(true);
    expect(result.mod2ProxyCoordMatches).toBe(true);
    expect(result.mod2ProxySchedMatches).toBe(true);
  });

  it('verifies proxy export forwards all property reads, introspection, and methods to singleton', () => {
    // Property access through proxy
    expect(runtime.coordinator).toBe(getRuntime().coordinator);
    expect(runtime.scheduler).toBe(getRuntime().scheduler);
    expect(runtime.lifecycle).toBe(getRuntime().lifecycle);
    expect(runtime.config).toBe(getRuntime().config);
    expect(runtime.db).toBe(getRuntime().db);

    // In operator forwards properly
    expect('coordinator' in runtime).toBe(true);
    expect('scheduler' in runtime).toBe(true);
    expect('lifecycle' in runtime).toBe(true);
    expect('nonexistentProperty' in runtime).toBe(false);

    // OwnKeys forwards properly
    const keys = Reflect.ownKeys(runtime);
    expect(keys).toContain('coordinator');
    expect(keys).toContain('scheduler');
    expect(keys).toContain('lifecycle');
    expect(keys).toContain('db');

    // Property descriptor forwards properly
    const desc = Object.getOwnPropertyDescriptor(runtime, 'coordinator');
    expect(desc).toBeDefined();
  });

  describe('Dev Scheduling Guard (NODE_ENV=development)', () => {
    const savedEnv = { ...process.env };

    const restoreEnv = () => {
      process.env = { ...savedEnv };
    };

    it('dev guard: does NOT start scheduler in development by default even if schedulingEnabled is true', async () => {
      try {
        process.env.NODE_ENV = 'development';
        delete process.env.DEV_SCHEDULING;
        delete process.env.ENABLE_DEV_SCHEDULING;

        const testDb = openTestDatabase();
        // Enable scheduling in DB
        testDb.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('sync.scheduling_enabled', 'true', '2026-09-01T00:00:00.000Z')").run();

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

        // In dev without explicit opt-in, scheduler MUST NOT start automatically
        expect(isolated.scheduler.isRunning()).toBe(false);

        await isolated.lifecycle.stop('shutdown', 5000);
      } finally {
        restoreEnv();
      }
    });

    it('dev opt-in: starts scheduler in development when DEV_SCHEDULING=true', async () => {
      try {
        process.env.NODE_ENV = 'development';
        process.env.DEV_SCHEDULING = 'true';
        delete process.env.ENABLE_DEV_SCHEDULING;

        const testDb = openTestDatabase();
        testDb.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('sync.scheduling_enabled', 'true', '2026-09-01T00:00:00.000Z')").run();

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

        // Opted in via DEV_SCHEDULING=true
        expect(isolated.scheduler.isRunning()).toBe(true);

        await isolated.lifecycle.stop('shutdown', 5000);
      } finally {
        restoreEnv();
      }
    });

    it('production mode: starts scheduler when schedulingEnabled is true', async () => {
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.DEV_SCHEDULING;
        delete process.env.ENABLE_DEV_SCHEDULING;

        const testDb = openTestDatabase();
        testDb.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('sync.scheduling_enabled', 'true', '2026-09-01T00:00:00.000Z')").run();

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

        // In production, schedulingEnabled starts scheduler
        expect(isolated.scheduler.isRunning()).toBe(true);

        await isolated.lifecycle.stop('shutdown', 5000);
      } finally {
        restoreEnv();
      }
    });
  });
});
