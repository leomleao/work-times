import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDatabase } from '../db/connection.js';
import { StagedUploadManager, UPLOAD_CHUNK_BYTES } from './staged-upload.js';

const FIXTURES = resolve(import.meta.dirname, '../../../../tests/fixtures');
const dailyBytes = readFileSync(resolve(FIXTURES, 'synthetic-daily.json'));
const heartbeatBytes = readFileSync(resolve(FIXTURES, 'synthetic-heartbeats.json'));
const owner = 'admin-session-one';

describe('staged browser uploads', () => {
  let db: Database.Database;
  let root: string;
  let uploads: StagedUploadManager;

  beforeEach(async () => {
    db = openTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'work-times-stage-test-'));
    uploads = new StagedUploadManager(db, 5 * 1024 * 1024, { tempRoot: root });
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function appendBuffer(id: string, kind: 'daily' | 'heartbeats', bytes: Buffer, offset = 0) {
    const file = new File([new Uint8Array(bytes)], `${kind}.json`);
    return uploads.append(owner, id, kind, offset, file.stream(), bytes.length);
  }

  it('tracks chunks separately and imports validated files without reuploading', async () => {
    const { id } = await uploads.start(owner, dailyBytes.length, heartbeatBytes.length);
    const split = Math.floor(dailyBytes.length / 2);
    await appendBuffer(id, 'daily', dailyBytes.subarray(0, split));
    const dailyProgress = await appendBuffer(id, 'daily', dailyBytes.subarray(split), split);
    const heartbeatProgress = await appendBuffer(id, 'heartbeats', heartbeatBytes);
    expect(dailyProgress.received).toBe(dailyBytes.length);
    expect(heartbeatProgress.received).toBe(heartbeatBytes.length);

    const validation = await uploads.finish(owner, id, true);
    expect(validation.dayCount).toBe(7);
    expect((db.prepare('SELECT COUNT(*) AS n FROM source_imports').get() as { n: number }).n).toBe(0);
    expect(await readdir(root)).toHaveLength(1);

    const imported = await uploads.finish(owner, id, false);
    expect(imported.dayCount).toBe(7);
    expect((db.prepare('SELECT COUNT(*) AS n FROM source_imports').get() as { n: number }).n).toBe(2);
    expect(await readdir(root)).toEqual([]);
  });

  it('keeps sessions private and rejects incomplete or out-of-order uploads', async () => {
    const { id } = await uploads.start(owner, dailyBytes.length, heartbeatBytes.length);
    await expect(uploads.append('another-session', id, 'daily', 0, new File([dailyBytes], 'daily').stream(), dailyBytes.length))
      .rejects.toMatchObject({ status: 404 });
    await expect(appendBuffer(id, 'daily', dailyBytes, 1)).rejects.toMatchObject({ status: 409 });
    await expect(uploads.finish(owner, id, false)).rejects.toMatchObject({ status: 409 });
    await uploads.cancel(owner, id);
    expect(await readdir(root)).toEqual([]);
  });

  it('enforces the declared per-request chunk limit', async () => {
    const oversized = Buffer.alloc(UPLOAD_CHUNK_BYTES + 1);
    const { id } = await uploads.start(owner, oversized.length, heartbeatBytes.length);
    await expect(appendBuffer(id, 'daily', oversized)).rejects.toMatchObject({ status: 413 });
    await uploads.cancel(owner, id);
    expect(await readdir(root)).toEqual([]);
  });

  it('stops an undeclared oversized stream and removes its partial data', async () => {
    const oversized = Buffer.alloc(UPLOAD_CHUNK_BYTES + 1);
    const { id } = await uploads.start(owner, oversized.length, heartbeatBytes.length);
    const body = new File([new Uint8Array(oversized)], 'daily.json').stream();
    await expect(uploads.append(owner, id, 'daily', 0, body, null))
      .rejects.toMatchObject({ status: 413 });
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects a file over the configured per-file limit before staging', async () => {
    await expect(uploads.start(owner, 5 * 1024 * 1024 + 1, heartbeatBytes.length))
      .rejects.toMatchObject({ status: 413 });
    expect(await readdir(root)).toEqual([]);
  });

  it('removes staged files when validation fails', async () => {
    const invalidDaily = Buffer.from('{');
    const { id } = await uploads.start(owner, invalidDaily.length, heartbeatBytes.length);
    await appendBuffer(id, 'daily', invalidDaily);
    await appendBuffer(id, 'heartbeats', heartbeatBytes);
    await expect(uploads.finish(owner, id, true)).rejects.toMatchObject({ name: 'DumpValidationError' });
    expect(await readdir(root)).toEqual([]);
  });

  it('expires abandoned sessions without touching a new upload', async () => {
    let time = 1000;
    uploads = new StagedUploadManager(db, 5 * 1024 * 1024, {
      tempRoot: root,
      now: () => time,
      ttlMs: 60_000
    });
    const old = await uploads.start(owner, dailyBytes.length, heartbeatBytes.length);
    time += 60_001;
    const current = await uploads.start('another-admin-session', dailyBytes.length, heartbeatBytes.length);
    await expect(uploads.cancel(owner, old.id)).rejects.toMatchObject({ status: 404 });
    expect(await readdir(root)).toHaveLength(1);
    await uploads.cancel('another-admin-session', current.id);
  });
});
