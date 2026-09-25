import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type Database from 'better-sqlite3';
import { importDumps, type ImportReport } from './importer.js';

export class UploadValidationError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message);
    this.name = 'UploadValidationError';
  }
}

export async function importUploadedDumps(
  db: Database.Database,
  dailyFile: File,
  heartbeatFile: File,
  options: { maxBytes: number; dryRun?: boolean }
): Promise<ImportReport> {
  for (const [label, file] of [
    ['Daily', dailyFile],
    ['Heartbeat', heartbeatFile]
  ] as const) {
    if (file.size === 0) throw new UploadValidationError(`${label} JSON file is empty.`);
    if (file.size > options.maxBytes) {
      throw new UploadValidationError(`${label} JSON file exceeds the configured per-file limit.`, 413);
    }
  }

  const directory = await mkdtemp(join(tmpdir(), 'work-times-upload-'));
  const dailyPath = join(directory, 'daily.json');
  const heartbeatPath = join(directory, 'heartbeats.json');

  try {
    await saveUpload(dailyFile, dailyPath);
    await saveUpload(heartbeatFile, heartbeatPath);
    return await importDumps(db, {
      dailyDumpPath: dailyPath,
      heartbeatDumpPath: heartbeatPath,
      maxBytes: options.maxBytes,
      dryRun: options.dryRun
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function saveUpload(file: File, path: string): Promise<void> {
  await pipeline(
    Readable.fromWeb(file.stream() as import('node:stream/web').ReadableStream),
    createWriteStream(path, { flags: 'wx', mode: 0o600 })
  );
}
