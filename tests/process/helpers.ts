import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export interface TempDbFixture {
  dir: string;
  dbPath: string;
  lockPath: string;
  cleanup: () => void;
}

export function createTempDb(prefix = 'wt-proc-'): TempDbFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`));
  const dbPath = path.join(dir, 'test.db');
  const lockPath = `${path.resolve(dbPath)}.lock`;

  return {
    dir,
    dbPath,
    lockPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors in tests
      }
    }
  };
}

export function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on('error', reject);
  });
}

export interface SpawnServerOptions {
  dbPath: string;
  port?: number;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SpawnedServer {
  child: ChildProcess;
  port: number;
  waitForStarted: (timeoutMs?: number) => Promise<void>;
  waitForOutput: (pattern: string | RegExp, stream?: 'stdout' | 'stderr' | 'both', timeoutMs?: number) => Promise<void>;
  waitForExit: (timeoutMs?: number) => Promise<number | null>;
  kill: (signal?: NodeJS.Signals) => void;
  getStdout: () => string;
  getStderr: () => string;
}

export async function spawnServer(options: SpawnServerOptions): Promise<SpawnedServer> {
  const port = options.port ?? (await getAvailablePort());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_PATH: options.dbPath,
    PORT: String(port),
    HOST: '127.0.0.1',
    SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    ORIGIN: `http://127.0.0.1:${port}`,
    NODE_ENV: 'production',
    ...options.env
  };

  const child = spawn('node', ['server/index.mjs'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const waitForOutput = (
    pattern: string | RegExp,
    stream: 'stdout' | 'stderr' | 'both' = 'both',
    timeoutMs = options.timeoutMs ?? 15_000
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const check = () => {
        const text = stream === 'stdout' ? stdout : stream === 'stderr' ? stderr : `${stdout}\n${stderr}`;
        const matched = typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
        if (matched) {
          return resolve();
        }
        if (child.exitCode !== null) {
          return reject(
            new Error(
              `Child process exited with code ${child.exitCode} before matching pattern "${pattern}".\nStderr: ${stderr}\nStdout: ${stdout}`
            )
          );
        }
        if (Date.now() - startTime > timeoutMs) {
          return reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for pattern "${pattern}".\nStderr: ${stderr}\nStdout: ${stdout}`
            )
          );
        }
        setTimeout(check, 50);
      };
      check();
    });
  };

  const waitForStarted = (timeoutMs = 15_000): Promise<void> => {
    return waitForOutput('server.started', 'stdout', timeoutMs);
  };

  const waitForExit = (timeoutMs = 15_000): Promise<number | null> => {
    return new Promise((resolve, reject) => {
      if (child.exitCode !== null) {
        return resolve(child.exitCode);
      }
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for process exit.\nStderr: ${stderr}\nStdout: ${stdout}`
          )
        );
      }, timeoutMs);

      child.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
  };

  const kill = (signal: NodeJS.Signals = 'SIGKILL') => {
    if (child.exitCode === null) {
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    }
  };

  return {
    child,
    port,
    waitForStarted,
    waitForOutput,
    waitForExit,
    kill,
    getStdout: () => stdout,
    getStderr: () => stderr
  };
}

export function runNodeScript(
  script: string,
  args: string[] = [],
  env: Record<string, string> = {},
  timeoutMs = 15_000
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('./node_modules/.bin/tsx', ['-e', script, ...args], {
    env: {
      ...process.env,
      ...env
    },
    encoding: 'utf8',
    timeout: timeoutMs
  });

  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? ''
  };
}
