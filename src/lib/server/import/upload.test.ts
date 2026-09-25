import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDatabase } from '../db/connection.js';
import { DumpValidationError } from './parse.js';
import { importUploadedDumps } from './upload.js';

const FIXTURES = resolve(import.meta.dirname, '../../../../tests/fixtures');
const dailyBytes = readFileSync(resolve(FIXTURES, 'synthetic-daily.json'));
const heartbeatBytes = readFileSync(resolve(FIXTURES, 'synthetic-heartbeats.json'));

const dailyFile = () => new File([dailyBytes], 'daily.json', { type: 'application/json' });
const heartbeatFile = () => new File([heartbeatBytes], 'heartbeats.json', { type: 'application/json' });
const count = (db: Database.Database) =>
  (db.prepare('SELECT COUNT(*) AS n FROM source_imports').get() as { n: number }).n;
const temporaryUploads = () => readdirSync(tmpdir()).filter((name) => name.startsWith('work-times-upload-'));

describe('browser dump upload', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('validates both files without writing and removes temporary copies', async () => {
    const before = temporaryUploads();
    const report = await importUploadedDumps(db, dailyFile(), heartbeatFile(), {
      maxBytes: 1024 * 1024,
      dryRun: true
    });

    expect(report.dryRun).toBe(true);
    expect(report.dayCount).toBe(7);
    expect(count(db)).toBe(0);
    expect(temporaryUploads()).toEqual(before);
  });

  it('imports the pair atomically and treats a repeat as a no-op', async () => {
    const before = temporaryUploads();
    const options = { maxBytes: 1024 * 1024 };
    const first = await importUploadedDumps(db, dailyFile(), heartbeatFile(), options);
    const second = await importUploadedDumps(db, dailyFile(), heartbeatFile(), options);

    expect(first.dayCount).toBe(7);
    expect(second.alreadyImported).toBe(true);
    expect(count(db)).toBe(2);
    expect(temporaryUploads()).toEqual(before);
  });

  it('rejects an oversized file before writing a temporary copy', async () => {
    const before = temporaryUploads();
    await expect(importUploadedDumps(db, dailyFile(), heartbeatFile(), { maxBytes: 1 }))
      .rejects.toMatchObject({ name: 'UploadValidationError', status: 413 });
    expect(count(db)).toBe(0);
    expect(temporaryUploads()).toEqual(before);
  });

  it('rejects an empty file as a bad upload', async () => {
    const emptyDaily = new File([], 'empty.json', { type: 'application/json' });
    await expect(importUploadedDumps(db, emptyDaily, heartbeatFile(), { maxBytes: 1024 * 1024 }))
      .rejects.toMatchObject({ name: 'UploadValidationError', status: 400 });
    expect(count(db)).toBe(0);
  });

  it('rejects invalid JSON without leaving source files or database rows', async () => {
    const before = temporaryUploads();
    const invalidDaily = new File(['{'], 'invalid.json', { type: 'application/json' });
    await expect(importUploadedDumps(db, invalidDaily, heartbeatFile(), { maxBytes: 1024 * 1024 }))
      .rejects.toBeInstanceOf(DumpValidationError);
    expect(count(db)).toBe(0);
    expect(temporaryUploads()).toEqual(before);
  });
});
