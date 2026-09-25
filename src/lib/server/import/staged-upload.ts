import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type Database from 'better-sqlite3';
import { importDumps, type ImportReport } from './importer.js';

export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const SESSION_TTL_MS = 60 * 60 * 1000;
const DIRECTORY_PREFIX = 'work-times-staged-';

export type UploadKind = 'daily' | 'heartbeats';

export class StagedUploadError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 = 400) {
    super(message);
    this.name = 'StagedUploadError';
  }
}

type UploadSession = {
  id: string;
  ownerHash: Buffer;
  directory: string;
  expected: Record<UploadKind, number>;
  received: Record<UploadKind, number>;
  touchedAt: number;
  busy: boolean;
  expiryTimer?: NodeJS.Timeout;
};

export class StagedUploadManager {
  private readonly sessions = new Map<string, UploadSession>();
  private readonly tempRoot: string;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(
    private readonly db: Database.Database,
    private readonly maxFileBytes: number,
    options: { tempRoot?: string; now?: () => number; ttlMs?: number } = {}
  ) {
    this.tempRoot = options.tempRoot ?? tmpdir();
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  }

  async start(owner: string, dailySize: number, heartbeatSize: number): Promise<{ id: string; chunkBytes: number }> {
    for (const size of [dailySize, heartbeatSize]) {
      if (!Number.isSafeInteger(size) || size <= 0) {
        throw new StagedUploadError('Select two non-empty JSON files.');
      }
      if (size > this.maxFileBytes) {
        throw new StagedUploadError('A JSON file exceeds the configured per-file limit.', 413);
      }
    }

    await this.cleanExpired();
    const ownerHash = fingerprint(owner);
    for (const session of this.sessions.values()) {
      if (!timingSafeEqual(session.ownerHash, ownerHash)) continue;
      if (session.busy) throw new StagedUploadError('An upload is already in progress.', 409);
      await this.remove(session);
    }

    const directory = await mkdtemp(join(this.tempRoot, DIRECTORY_PREFIX));
    const id = randomUUID();
    const session: UploadSession = {
      id,
      ownerHash,
      directory,
      expected: { daily: dailySize, heartbeats: heartbeatSize },
      received: { daily: 0, heartbeats: 0 },
      touchedAt: this.now(),
      busy: false
    };
    this.sessions.set(id, session);
    this.scheduleExpiry(session);
    return { id, chunkBytes: UPLOAD_CHUNK_BYTES };
  }

  async append(
    owner: string,
    id: string,
    kind: UploadKind,
    offset: number,
    body: ReadableStream<Uint8Array> | null,
    contentLength: number | null
  ): Promise<{ received: number }> {
    const session = this.get(owner, id);
    if (session.busy) throw new StagedUploadError('An upload operation is already in progress.', 409);
    if (!Number.isSafeInteger(offset) || offset !== session.received[kind]) {
      throw new StagedUploadError('Upload offset mismatch. Restart the upload.', 409);
    }
    if (!body) throw new StagedUploadError('Missing upload chunk.');
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength <= 0)) {
      throw new StagedUploadError('Invalid upload chunk size.');
    }
    if (contentLength !== null &&
      (contentLength > UPLOAD_CHUNK_BYTES || offset + contentLength > session.expected[kind])) {
      throw new StagedUploadError('Upload chunk exceeds the allowed size.', 413);
    }

    session.busy = true;
    session.touchedAt = this.now();
    let written = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        if (written > UPLOAD_CHUNK_BYTES || offset + written > session.expected[kind]) {
          callback(new StagedUploadError('Upload chunk exceeds the allowed size.', 413));
        } else {
          callback(null, chunk);
        }
      }
    });

    try {
      await pipeline(
        Readable.fromWeb(body as import('node:stream/web').ReadableStream),
        limiter,
        createWriteStream(join(session.directory, `${kind}.json`), {
          flags: offset === 0 ? 'w' : 'r+',
          start: offset,
          mode: 0o600
        })
      );
      if (written === 0 || (contentLength !== null && written !== contentLength)) {
        throw new StagedUploadError('Upload chunk was incomplete. Restart the upload.');
      }
      session.received[kind] += written;
      session.touchedAt = this.now();
      this.scheduleExpiry(session);
      return { received: session.received[kind] };
    } catch (error) {
      await this.remove(session);
      throw error;
    } finally {
      session.busy = false;
    }
  }

  async finish(owner: string, id: string, dryRun: boolean): Promise<ImportReport> {
    const session = this.get(owner, id);
    if (session.busy) throw new StagedUploadError('An upload operation is already in progress.', 409);
    if (session.received.daily !== session.expected.daily ||
      session.received.heartbeats !== session.expected.heartbeats) {
      throw new StagedUploadError('Both JSON files must finish uploading first.', 409);
    }

    session.busy = true;
    session.touchedAt = this.now();
    let keepValidatedFiles = false;
    try {
      const report = await importDumps(this.db, {
        dailyDumpPath: join(session.directory, 'daily.json'),
        heartbeatDumpPath: join(session.directory, 'heartbeats.json'),
        maxBytes: this.maxFileBytes,
        dryRun
      });
      keepValidatedFiles = dryRun;
      return report;
    } finally {
      session.busy = false;
      if (keepValidatedFiles) this.scheduleExpiry(session);
      else await this.remove(session);
    }
  }

  async cancel(owner: string, id: string): Promise<void> {
    const session = this.get(owner, id);
    if (session.busy) throw new StagedUploadError('An upload operation is already in progress.', 409);
    await this.remove(session);
  }

  private get(owner: string, id: string): UploadSession {
    const session = this.sessions.get(id);
    if (!session || !timingSafeEqual(session.ownerHash, fingerprint(owner))) {
      throw new StagedUploadError('Upload session not found. Start again.', 404);
    }
    return session;
  }

  private async remove(session: UploadSession): Promise<void> {
    this.sessions.delete(session.id);
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    await rm(session.directory, { recursive: true, force: true });
  }

  private scheduleExpiry(session: UploadSession): void {
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    session.expiryTimer = setTimeout(() => {
      if (session.busy) {
        this.scheduleExpiry(session);
      } else {
        void this.remove(session).catch(() => {});
      }
    }, this.ttlMs);
    session.expiryTimer.unref();
  }

  private async cleanExpired(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (!session.busy && this.now() - session.touchedAt > this.ttlMs) await this.remove(session);
    }

    // Recover temporary directories left behind by a process restart.
    const activeDirectories = new Set([...this.sessions.values()].map((session) => session.directory));
    for (const entry of await readdir(this.tempRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(DIRECTORY_PREFIX)) continue;
      const path = join(this.tempRoot, entry.name);
      if (activeDirectories.has(path)) continue;
      try {
        if (this.now() - (await stat(path)).mtimeMs > this.ttlMs) {
          await rm(path, { recursive: true, force: true });
        }
      } catch {
        // A concurrently removed temporary directory needs no further cleanup.
      }
    }
  }
}

function fingerprint(owner: string): Buffer {
  return createHash('sha256').update(owner).digest();
}
