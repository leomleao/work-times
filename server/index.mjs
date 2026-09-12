import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import polka from 'polka';

process.umask(0o077);

if (existsSync('.env')) loadEnvFile('.env');

// adapter-node needs the externally visible origin to validate form POSTs.
// PUBLIC_URL is already the application's canonical origin, so keep the
// adapter on the same source of truth unless an operator explicitly supplies
// its lower-level ORIGIN setting.
if (!process.env.ORIGIN && process.env.PUBLIC_URL) {
  process.env.ORIGIN = process.env.PUBLIC_URL;
}

const { handler } = await import('../build/handler.js');

const port = Number.parseInt(process.env.PORT ?? '3002', 10);
const host = process.env.HOST ?? '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

// Minimal process-local lifecycle bridge: mandatory prerequisite before listen
const LIFECYCLE_SYMBOL = Symbol.for('work-times.lifecycle');
const lifecycle = globalThis[LIFECYCLE_SYMBOL];

if (!lifecycle || typeof lifecycle.start !== 'function' || typeof lifecycle.getReadiness !== 'function') {
  process.stderr.write(`${JSON.stringify({ event: 'server.lifecycle_missing' })}\n`);
  throw new Error('Mandatory lifecycle bridge (Symbol.for("work-times.lifecycle")) is missing from runtime');
}

await lifecycle.start();
const readiness = lifecycle.getReadiness();
if (!readiness?.ready) {
  process.stderr.write(`${JSON.stringify({ event: 'server.readiness_failed' })}\n`);
  throw new Error('Server runtime failed to reach lifecycle readiness before listen');
}

const app = polka();
app.use(handler);

const server = app.listen(port, host, () => {
  process.stdout.write(
    `${JSON.stringify({ event: 'server.started', host, port })}\n`
  );
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`${JSON.stringify({ event: 'server.stopping', signal })}\n`);

  const SHUTDOWN_DEADLINE_MS = 20_000;
  const timeoutTimer = setTimeout(() => {
    process.stderr.write(`${JSON.stringify({ event: 'server.stop_timeout' })}\n`);
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  if (timeoutTimer.unref) timeoutTimer.unref();

  // Stop HTTP intake and define drain of genuinely in-flight HTTP requests
  const drainHttp = () =>
    new Promise((resolve) => {
      if (server?.server?.close) {
        if (typeof server.server.closeIdleConnections === 'function') {
          server.server.closeIdleConnections();
        }
        server.server.close((error) => {
          if (error) {
            process.stderr.write(`${JSON.stringify({ event: 'server.http_close_error' })}\n`);
          }
          resolve();
        });
      } else {
        resolve();
      }
    });

  // Signal ordering matching milestone 3.4:
  // 1. Stop HTTP intake & runtime work/timers (scheduler & coordinator stop, active run interrupted, queue preserved)
  // 2. Drain genuinely in-flight HTTP requests while DB remains open
  // 3. Close database after consumers stop
  // 4. Release ownership lock
  try {
    await lifecycle.stop('shutdown', SHUTDOWN_DEADLINE_MS - 4000, drainHttp);
    clearTimeout(timeoutTimer);
    process.stdout.write(`${JSON.stringify({ event: 'server.stopped' })}\n`);
    process.exit(0);
  } catch {
    clearTimeout(timeoutTimer);
    process.stderr.write(`${JSON.stringify({ event: 'server.runtime_stop_failed' })}\n`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

