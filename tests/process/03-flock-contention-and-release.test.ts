import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createTempDb, getAvailablePort, runNodeScript, spawnServer } from './helpers';
import { FsExtProcessLock, InMemoryProcessLock, createRuntime } from '$lib/server/runtime';
import { parsePublicUrl } from '$lib/server/config';

describe('P10A2 Process Evidence: Same-Database Flock Rejection, Release, & Kernel Cleanup', () => {
  it('enforces nonblocking fs-ext flock exnb rejection and later acquisition on file database', async () => {
    const temp = createTempDb('wt-flock-basic-');

    try {
      const lock1 = new FsExtProcessLock(temp.dbPath);
      const lock2 = new FsExtProcessLock(temp.dbPath);

      // Lock 1 acquires
      expect(await lock1.acquire()).toBe(true);
      expect(lock1.isHeld()).toBe(true);

      // Lock 2 rejected nonblocking (EAGAIN/EWOULDBLOCK)
      expect(await lock2.acquire()).toBe(false);
      expect(lock2.isHeld()).toBe(false);

      // Lock 1 releases
      await lock1.release();
      expect(lock1.isHeld()).toBe(false);

      // Lock file is NEVER unlinked
      expect(fs.existsSync(temp.lockPath)).toBe(true);

      // Lock 2 now acquires successfully
      expect(await lock2.acquire()).toBe(true);
      expect(lock2.isHeld()).toBe(true);

      await lock2.release();
      expect(lock2.isHeld()).toBe(false);
    } finally {
      temp.cleanup();
    }
  });

  it('proves cross-process flock contention and subsequent acquisition with separate OS processes', async () => {
    const temp = createTempDb('wt-flock-child-');

    try {
      const parentLock = new FsExtProcessLock(temp.dbPath);
      const parentAcquired = await parentLock.acquire();
      expect(parentAcquired).toBe(true);

      const childScript = `
        import { FsExtProcessLock } from './src/lib/server/runtime.js';
        const lock = new FsExtProcessLock(process.argv[1]);
        lock.acquire().then((ok) => {
          process.exit(ok ? 0 : 42);
        });
      `;

      // 1. Child process rejected while parent holds lock
      const res1 = runNodeScript(childScript, [temp.dbPath]);
      expect(res1.status).toBe(42);

      // 2. Parent releases lock
      await parentLock.release();
      expect(parentLock.isHeld()).toBe(false);

      // Lock file is retained on disk
      expect(fs.existsSync(temp.lockPath)).toBe(true);

      // 3. Child process now acquires lock cleanly
      const res2 = runNodeScript(childScript, [temp.dbPath]);
      expect(res2.status).toBe(0);
    } finally {
      temp.cleanup();
    }
  });

  it('rejects second server startup before listen on same database, then allows startup after first terminates', async () => {
    const temp = createTempDb('wt-srv-contention-');
    const port1 = await getAvailablePort();
    const port2 = await getAvailablePort();

    const server1 = await spawnServer({
      dbPath: temp.dbPath,
      port: port1
    });

    try {
      // 1. Wait for server 1 to achieve readiness and listen
      await server1.waitForStarted();

      // 2. Attempt to spawn server 2 against the exact same database
      const server2 = await spawnServer({
        dbPath: temp.dbPath,
        port: port2
      });

      // Server 2 must abort startup before listen with non-zero exit code
      const exit2 = await server2.waitForExit();
      expect(exit2).toBe(1);
      expect(server2.getStderr()).toContain('ownership lock');

      // 3. Stop server 1 gracefully
      server1.kill('SIGTERM');
      const exit1 = await server1.waitForExit();
      expect(exit1).toBe(0);
      expect(server1.getStdout()).toContain('server.stopped');

      // 4. Spawn server 3 (replacement) on the same database now that server 1 released the lock
      const server3 = await spawnServer({
        dbPath: temp.dbPath,
        port: port2
      });

      try {
        await server3.waitForStarted();
        expect(server3.getStdout()).toContain('server.started');
      } finally {
        server3.kill('SIGTERM');
        await server3.waitForExit();
      }
    } finally {
      server1.kill('SIGKILL');
      temp.cleanup();
    }
  }, 30_000);

  it('guarantees OS kernel releases flock on ungraceful child termination (SIGKILL) without deadlocks', async () => {
    const temp = createTempDb('wt-flock-sigkill-');

    const lockerScript = `
      const fs = require('fs');
      const { flockSync } = require('fs-ext');
      const fd = fs.openSync(process.argv[1], 'a');
      flockSync(fd, 'exnb');
      process.stdout.write('LOCKED\\n');
      setInterval(() => {}, 1000);
    `;

    const child = spawn('node', ['-e', lockerScript, temp.lockPath], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    try {
      // Wait for child to acquire lock
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for child to lock')), 10_000);
        child.stdout.on('data', (d) => {
          if (d.toString().includes('LOCKED')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.on('exit', (code) => reject(new Error(`Child exited prematurely with code ${code}`)));
      });

      // Child holds lock; verify sibling cannot acquire
      const siblingLockBefore = new FsExtProcessLock(temp.dbPath);
      expect(await siblingLockBefore.acquire()).toBe(false);

      // Kill child abruptly with SIGKILL (no userland release)
      child.kill('SIGKILL');
      await new Promise((resolve) => child.on('exit', resolve));

      // Lock file still exists
      expect(fs.existsSync(temp.lockPath)).toBe(true);

      // OS kernel closed the fd and released the flock: sibling can acquire immediately
      const siblingLockAfter = new FsExtProcessLock(temp.dbPath);
      expect(await siblingLockAfter.acquire()).toBe(true);
      expect(siblingLockAfter.isHeld()).toBe(true);
      await siblingLockAfter.release();
    } finally {
      child.kill('SIGKILL');
      temp.cleanup();
    }
  });

  it('rejects runtime startup if processLock is held or fails to acquire', async () => {
    const mockLock = new InMemoryProcessLock();
    mockLock.shouldFailAcquire = true;

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
      undefined,
      { processLock: mockLock }
    );

    await expect(isolated.lifecycle.start()).rejects.toThrow(
      /Failed to acquire process ownership lock/
    );

    const readiness = isolated.getReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.ownershipLockHeld).toBe(false);
    expect(readiness.errorCode).toBe('LOCK_CONTENTION');
  });
});
