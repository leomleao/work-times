import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createTempDb, runNodeScript } from './helpers';
import { openDatabase } from '$lib/server/db/connection';
import { createRuntime } from '$lib/server/runtime';
import { parsePublicUrl } from '$lib/server/config';
import { LIFECYCLE_SYMBOL } from '$lib/server/sync/contracts';

describe('P10A2 Process Evidence: Fresh Import Safety & Side-Effect Freedom', () => {
  it('proves fresh child-process import produces zero network calls, active timers, or filesystem side effects', () => {
    const temp = createTempDb('wt-import-safety-');

    const script = `
      import fs from 'node:fs';
      import http from 'node:http';
      import https from 'node:https';
      import net from 'node:net';
      import dgram from 'node:dgram';

      const dbPath = process.argv[1];
      process.env.DATABASE_PATH = dbPath;

      // Track all network activities
      const networkCalls = [];
      const origHttpRequest = http.request;
      http.request = function(...args) {
        networkCalls.push({ type: 'http.request', args: args[0] });
        return origHttpRequest.apply(this, args);
      };
      const origHttpsRequest = https.request;
      https.request = function(...args) {
        networkCalls.push({ type: 'https.request', args: args[0] });
        return origHttpsRequest.apply(this, args);
      };
      const origFetch = globalThis.fetch;
      globalThis.fetch = function(...args) {
        networkCalls.push({ type: 'fetch', url: String(args[0]) });
        return origFetch ? origFetch.apply(this, args) : Promise.reject(new Error('no fetch'));
      };
      const origNetConnect = net.connect;
      net.connect = function(...args) {
        networkCalls.push({ type: 'net.connect' });
        return origNetConnect.apply(this, args);
      };
      const origDgram = dgram.createSocket;
      dgram.createSocket = function(...args) {
        networkCalls.push({ type: 'dgram.createSocket' });
        return origDgram.apply(this, args);
      };

      // Import the server runtime
      import('./src/lib/server/runtime.js').then((runtimeModule) => {
        // Check files on disk
        const dbCreated = fs.existsSync(dbPath);
        const lockCreated = fs.existsSync(dbPath + '.lock');

        // Check active timers/resources
        // process.getActiveResourcesInfo is available in modern Node (>=17.3)
        const activeResources = typeof process.getActiveResourcesInfo === 'function'
          ? process.getActiveResourcesInfo()
          : [];
        const timerResources = activeResources.filter(r => r === 'Timeout' || r === 'Immediate' || r === 'Interval');

        // Check lifecycle bridge
        const lifecycleKey = Symbol.for('work-times.lifecycle');
        const bridge = globalThis[lifecycleKey];
        const hasBridge = Boolean(bridge && typeof bridge.start === 'function' && typeof bridge.getReadiness === 'function');
        const readiness = bridge ? bridge.getReadiness() : null;

        // Bridge security inspection: must not expose credentials, DB, or config
        const exposedKeys = bridge ? Object.keys(bridge) : [];

        console.log(JSON.stringify({
          networkCalls,
          timerCount: timerResources.length,
          dbCreated,
          lockCreated,
          hasBridge,
          exposedKeys,
          readiness
        }));
        process.exit(0);
      }).catch((err) => {
        console.error(err);
        process.exit(1);
      });
    `;

    try {
      const res = runNodeScript(script, [temp.dbPath]);
      expect(res.status).toBe(0);

      const report = JSON.parse(res.stdout.trim());
      expect(report.networkCalls).toHaveLength(0);
      expect(report.timerCount).toBe(0);
      expect(report.dbCreated).toBe(false);
      expect(report.lockCreated).toBe(false);
      expect(report.hasBridge).toBe(true);

      // Readiness is unstarted / false
      expect(report.readiness).toBeDefined();
      expect(report.readiness.ready).toBe(false);
      expect(report.readiness.state).toBe('unstarted');
      expect(report.readiness.ownershipLockHeld).toBe(false);
      expect(report.readiness.migrationsComplete).toBe(false);
      expect(report.readiness.recoveryComplete).toBe(false);
      expect(report.readiness.serviceRegistered).toBe(false);

      // Bridge surface contains ONLY lifecycle methods, no sensitive internals
      expect(report.exposedKeys.sort()).toEqual(['getReadiness', 'start', 'stop'].sort());
    } finally {
      temp.cleanup();
    }
  });

  it('verifies createRuntime constructs purely in-memory without running migrations or timers', () => {
    const rawDb = openDatabase({ path: ':memory:', migrate: false });

    // Prove 0 tables before createRuntime
    const tablesBefore = rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
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

    // After construction, tables still do NOT exist
    const tablesAfter = rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    expect(tablesAfter).toHaveLength(0);

    // Readiness is false; coordinator and scheduler are idle
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

  it('guarantees lifecycle bridge has no secrets, admin auth, or database queries', () => {
    const bridge = (globalThis as Record<symbol, unknown>)[LIFECYCLE_SYMBOL] as Record<string, unknown>;
    expect(bridge).toBeDefined();

    expect(typeof bridge.start).toBe('function');
    expect(typeof bridge.stop).toBe('function');
    expect(typeof bridge.getReadiness).toBe('function');

    // Reject leak of internal references
    expect(bridge.db).toBeUndefined();
    expect(bridge.config).toBeUndefined();
    expect(bridge.sessionSecret).toBeUndefined();
    expect(bridge.adminAuth).toBeUndefined();
    expect(bridge.apiKeys).toBeUndefined();
    expect(bridge.prepare).toBeUndefined();
    expect(bridge.exec).toBeUndefined();
    expect(bridge.transaction).toBeUndefined();
  });
});
