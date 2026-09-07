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
  server.server.close((error) => {
    if (error) {
      process.stderr.write(`${JSON.stringify({ event: 'server.stop_failed' })}\n`);
      process.exitCode = 1;
    }
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
