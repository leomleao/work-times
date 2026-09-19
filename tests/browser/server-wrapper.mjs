import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDbPath = join(tmpdir(), 'work-times-p8b-playwright.sqlite');

if (process.env.DATABASE_PATH !== testDbPath) {
  throw new Error('Playwright database path is not the fixed test database');
}

for (const ext of ['', '-wal', '-shm', '-journal']) {
  rmSync(testDbPath + ext, { force: true });
}

await import('../../server/index.mjs');
