import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase } from '../db/connection.js';
import { SqliteClassificationService } from '../classification/sqlite.js';
import { HeartbeatConflictError, importDumps, type ImportReport } from './importer.js';
import { DumpTooLargeError, DumpValidationError } from './parse.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../tests/fixtures');
const DAILY = join(FIXTURES, 'synthetic-daily.json');
const HEARTBEATS = join(FIXTURES, 'synthetic-heartbeats.json');
const CONFLICT_DAILY = join(FIXTURES, 'conflict-daily.json');
const CONFLICT_HEARTBEATS = join(FIXTURES, 'conflict-heartbeats.json');

let db: Database.Database;
const temporaryDirectories: string[] = [];

beforeEach(() => {
  db = openTestDatabase();
});

afterEach(() => {
  db.close();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'work-times-import-'));
  temporaryDirectories.push(dir);
  return dir;
}

function importFixtures(overrides: Partial<Parameters<typeof importDumps>[1]> = {}): Promise<ImportReport> {
  return importDumps(db, {
    dailyDumpPath: DAILY,
    heartbeatDumpPath: HEARTBEATS,
    ...overrides
  });
}

/** Await a promise that must reject, and hand back the rejection reason. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to fail, but it succeeded');
}

function count(sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

describe('importDumps', () => {
  it('imports the whole fixture matrix and reports what it wrote', async () => {
    const report = await importFixtures();

    expect(report.dryRun).toBe(false);
    expect(report.dayCount).toBe(7);
    expect(report.rangeStartDate).toBe('2026-01-01');
    expect(report.rangeEndDate).toBe('2026-01-07');
    // 2026-01-01 and 2026-01-02 both report zero official seconds.
    expect(report.activeDayCount).toBe(5);
    expect(report.projectCount).toBe(3);
    expect(count('SELECT COUNT(*) AS n FROM daily_totals')).toBe(7);
  });

  it('activates dump heartbeat evidence for machine and editor suggestions', async () => {
    await importFixtures();

    expect(count('SELECT COUNT(*) AS n FROM heartbeat_memberships WHERE active = 1'))
      .toBe(count('SELECT COUNT(*) AS n FROM heartbeats'));

    const suggestions = new SqliteClassificationService(db).getUnclassifiedSuggestions({ limitPerType: 10 });
    expect(suggestions.some((suggestion) => suggestion.selectorType === 'machine')).toBe(true);
    expect(suggestions.some((suggestion) => suggestion.selectorType === 'editor')).toBe(true);
  });

  it('takes every official second from the daily dump, never from heartbeats', async () => {
    await importFixtures();

    const total = (
      db.prepare('SELECT SUM(total_seconds) AS n FROM daily_totals').get() as { n: number }
    ).n;
    expect(total).toBe(0 + 0 + 3600 + 5400 + 7200 + 1000 + 1800);

    // The near-zero day records heartbeats but zero official time; a
    // heartbeat-derived duration would show up here.
    const nearZero = db.prepare('SELECT total_seconds FROM daily_totals WHERE date = ?').get('2026-01-02');
    expect(nearZero).toEqual({ total_seconds: 0 });
    expect(count('SELECT COUNT(*) AS n FROM heartbeats WHERE local_date = ?', '2026-01-02')).toBe(2);
  });

  it('stores account and project dimension rows under distinct scopes', async () => {
    const report = await importFixtures();

    expect(report.accountDimensionRows).toBeGreaterThan(0);
    expect(report.projectDimensionRows).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM daily_dimension_totals WHERE scope = 'account' AND project_id IS NOT NULL")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM daily_dimension_totals WHERE scope = 'project' AND project_id IS NULL")).toBe(0);
  });

  it('keeps the two scopes from double-counting the same day', async () => {
    await importFixtures();

    // The two scopes are separate views of the same 3600 seconds. Summing both
    // would report 7200; each on its own must report 3600.
    const accountSum = db
      .prepare(
        "SELECT SUM(total_seconds) AS n FROM daily_dimension_totals WHERE date = ? AND scope = 'account' AND dimension = 'project'"
      )
      .get('2026-01-03') as { n: number };
    const projectSum = db
      .prepare(
        "SELECT SUM(total_seconds) AS n FROM daily_dimension_totals WHERE date = ? AND scope = 'project' AND dimension = 'entity'"
      )
      .get('2026-01-03') as { n: number };

    expect(accountSum.n).toBe(3600);
    expect(projectSum.n).toBe(3600);
    expect(accountSum.n + projectSum.n).toBe(7200); // exactly the double-count to avoid
  });

  it('creates one official slice per daily project entity row', async () => {
    await importFixtures();

    const slices = db
      .prepare(
        `SELECT entity, entity_type, total_seconds
         FROM day_project_entity_slices
         WHERE date = ? AND is_unattributed = 0
         ORDER BY entity`
      )
      .all('2026-01-03');

    expect(slices).toEqual([
      { entity: '/fixtures/alpha/src/index.ts', entity_type: 'file', total_seconds: 3000 },
      { entity: 'Terminal', entity_type: 'app', total_seconds: 600 }
    ]);
  });

  it('gives the divergent day an unattributed slice holding the residual', async () => {
    const report = await importFixtures();

    const residual = db
      .prepare(
        `SELECT total_seconds FROM day_project_entity_slices
         WHERE date = ? AND is_unattributed = 1`
      )
      .get('2026-01-06') as { total_seconds: number };

    // Daily grand_total is 1000s; the single project entity accounts for 100s.
    expect(residual.total_seconds).toBe(900);
    expect(report.divergentDays).toBe(1);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('2026-01-06');
  });

  it('tolerates the divergence rather than failing, keeping the daily total authoritative', async () => {
    await importFixtures();

    const row = db
      .prepare('SELECT total_seconds, project_sum_seconds, project_sum_delta FROM daily_totals WHERE date = ?')
      .get('2026-01-06');

    expect(row).toEqual({ total_seconds: 1000, project_sum_seconds: 100, project_sum_delta: 900 });
  });

  it('never records a negative unattributed residual', async () => {
    await importFixtures();
    expect(count('SELECT COUNT(*) AS n FROM day_project_entity_slices WHERE total_seconds < 0')).toBe(0);
  });

  it('makes each day self-consistent: slices sum to the authoritative daily total', async () => {
    await importFixtures();

    const rows = db
      .prepare(
        `SELECT t.date, t.total_seconds AS official, COALESCE(SUM(s.total_seconds), 0) AS sliced
         FROM daily_totals t
         LEFT JOIN day_project_entity_slices s ON s.date = t.date
         GROUP BY t.date`
      )
      .all() as Array<{ date: string; official: number; sliced: number }>;

    for (const row of rows) {
      expect(Math.abs(row.official - row.sliced)).toBeLessThanOrEqual(1);
    }
  });
});

describe('dependency canonicalization', () => {
  it('sorts and deduplicates dependency relationships', async () => {
    const report = await importFixtures();

    const names = db
      .prepare(
        `SELECT d.name FROM heartbeat_dependencies d
         JOIN heartbeats h ON h.id = d.heartbeat_id
         WHERE h.external_id = ?
         ORDER BY d.position`
      )
      .all('hb-duplicate-0007') as Array<{ name: string }>;

    // Source array was ['zod','vitest','zod','better-sqlite3'].
    expect(names.map((row) => row.name)).toEqual(['better-sqlite3', 'vitest', 'zod']);
    expect(report.dependencyRelationships).toBeGreaterThan(report.canonicalDependencyRows);
  });

  it('makes a reordered duplicate id idempotent instead of a conflict', async () => {
    const report = await importFixtures();

    expect(report.duplicateOccurrences).toBe(1);
    expect(report.duplicateHeartbeatIds).toBe(1);
    expect(report.conflictingHeartbeatIds).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM heartbeats WHERE external_id = ?', 'hb-duplicate-0007')).toBe(1);
  });

  it('counts the repeat as an occurrence rather than discarding it silently', async () => {
    await importFixtures();

    expect(
      db.prepare('SELECT occurrence_count FROM heartbeats WHERE external_id = ?').get('hb-duplicate-0007')
    ).toEqual({ occurrence_count: 2 });
    expect(
      db
        .prepare('SELECT occurrence_count, conflict_state FROM heartbeat_variants WHERE external_id = ?')
        .get('hb-duplicate-0007')
    ).toEqual({ occurrence_count: 2, conflict_state: 'canonical' });
  });
});

describe('conflicting duplicate payloads', () => {
  it('fails the whole import closed by default', async () => {
    await expect(
      importDumps(db, { dailyDumpPath: CONFLICT_DAILY, heartbeatDumpPath: CONFLICT_HEARTBEATS })
    ).rejects.toThrow(HeartbeatConflictError);
  });

  it('leaves nothing behind when it fails closed', async () => {
    await importDumps(db, {
      dailyDumpPath: CONFLICT_DAILY,
      heartbeatDumpPath: CONFLICT_HEARTBEATS
    }).catch(() => undefined);

    expect(count('SELECT COUNT(*) AS n FROM daily_totals')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM heartbeats')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM source_imports')).toBe(0);
  });

  it('does not disclose the heartbeat id in the error message', async () => {
    const error = await rejection(
      importDumps(db, { dailyDumpPath: CONFLICT_DAILY, heartbeatDumpPath: CONFLICT_HEARTBEATS })
    );

    expect(error.message).not.toContain('hb-conflict-0001');
    expect(error.message).toContain('<redacted:');
  });

  it('quarantines the conflicting variant when explicitly allowed', async () => {
    const report = await importDumps(db, {
      dailyDumpPath: CONFLICT_DAILY,
      heartbeatDumpPath: CONFLICT_HEARTBEATS,
      allowConflicts: true
    });

    expect(report.conflictingHeartbeatIds).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM heartbeat_variants WHERE conflict_state = 'conflict'")).toBe(1);
    // The first-seen payload is still the one row in `heartbeats`; the conflict
    // never overwrites it.
    expect(count('SELECT COUNT(*) AS n FROM heartbeats')).toBe(1);
    expect(
      db.prepare('SELECT entity FROM heartbeats').get()
    ).toEqual({ entity: '/fixtures/alpha/src/index.ts' });
  });
});

describe('slice identity associations', () => {
  it('attaches the heartbeat machine and editor to the matching slice', async () => {
    await importFixtures();

    const identities = db
      .prepare(
        `SELECT i.selector_type, i.value, i.source, i.observed_heartbeats
         FROM slice_identities i
         JOIN day_project_entity_slices s ON s.id = i.slice_id
         WHERE s.date = ? AND s.entity = ?
         ORDER BY i.selector_type, i.value`
      )
      .all('2026-01-03', '/fixtures/alpha/src/index.ts');

    expect(identities).toEqual([
      {
        selector_type: 'editor',
        value: 'agent/1.0 (fixture) vscode/1.0 vscode-wakatime/1.0',
        source: 'heartbeat',
        observed_heartbeats: 1
      },
      {
        selector_type: 'entity',
        value: '/fixtures/alpha/src/index.ts',
        source: 'slice',
        observed_heartbeats: 0
      },
      {
        selector_type: 'folder_prefix',
        value: '/fixtures/alpha/src',
        source: 'slice',
        observed_heartbeats: 0
      },
      { selector_type: 'machine', value: 'machine-aaaa', source: 'heartbeat', observed_heartbeats: 1 },
      { selector_type: 'project', value: 'alpha', source: 'slice', observed_heartbeats: 0 }
    ]);
  });

  it('routes a heartbeat with no matching entity row to the unattributed slice', async () => {
    await importFixtures();

    // hb-nearzero-0002 has project null and an entity the daily dump never lists.
    const identities = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM slice_identities i
         JOIN day_project_entity_slices s ON s.id = i.slice_id
         WHERE s.date = ? AND s.is_unattributed = 1 AND i.source = 'heartbeat'`
      )
      .get('2026-01-02') as { n: number };

    expect(identities.n).toBeGreaterThan(0);
  });

  it('never stores a language, category, branch or dependency identity', async () => {
    await importFixtures();

    expect(
      count(
        "SELECT COUNT(*) AS n FROM slice_identities WHERE selector_type IN ('language','category','branch','dependency')"
      )
    ).toBe(0);
  });
});

describe('privacy', () => {
  it('stores only the non-PII account settings', async () => {
    await importFixtures();

    const columns = db.prepare('PRAGMA table_info(account_settings)').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);

    for (const forbidden of ['email', 'display_name', 'full_name', 'photo', 'profile_url', 'username']) {
      expect(names).not.toContain(forbidden);
    }
    expect(db.prepare('SELECT timezone, plan FROM account_settings').get()).toEqual({
      timezone: 'Europe/Lisbon',
      plan: 'premium'
    });
  });

  it('does not carry the PII fields into the retained daily payloads', async () => {
    await importFixtures();

    const payloads = db.prepare('SELECT payload_json FROM source_payloads').all() as Array<{
      payload_json: string;
    }>;
    for (const payload of payloads) {
      expect(payload.payload_json).not.toContain('fixture@example.invalid');
    }
  });
});

describe('dry run', () => {
  it('reports the same counts a real import would produce', async () => {
    const dry = await importFixtures({ dryRun: true });
    const real = await importFixtures();

    expect(dry.dryRun).toBe(true);
    expect(dry.dayCount).toBe(real.dayCount);
    expect(dry.sliceCount).toBe(real.sliceCount);
    expect(dry.heartbeatCount).toBe(real.heartbeatCount);
    expect(dry.canonicalDependencyRows).toBe(real.canonicalDependencyRows);
    expect(dry.sliceIdentityRows).toBe(real.sliceIdentityRows);
    expect(dry.warnings).toEqual(real.warnings);
  });

  it('leaves the database untouched', async () => {
    await importFixtures({ dryRun: true });

    expect(count('SELECT COUNT(*) AS n FROM daily_totals')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM heartbeats')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM source_imports')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM account_settings')).toBe(0);
  });

  it('surfaces a validation failure instead of reporting success', async () => {
    const dir = temporaryDir();
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, JSON.stringify({ user: { id: 'x' }, range: { start: 0, end: 1 } }));

    await expect(
      importDumps(db, { dailyDumpPath: broken, heartbeatDumpPath: HEARTBEATS, dryRun: true })
    ).rejects.toThrow(DumpValidationError);
  });
});

describe('re-import', () => {
  it('is a reported no-op for the same bytes rather than a duplicate-key crash', async () => {
    const first = await importFixtures();
    const second = await importFixtures();

    expect(first.alreadyImported).toBe(false);
    expect(second.alreadyImported).toBe(true);
    expect(second.dayCount).toBe(first.dayCount);
    expect(second.heartbeatCount).toBe(first.heartbeatCount);
    expect(count('SELECT COUNT(*) AS n FROM daily_totals')).toBe(7);
  });

  it('reports the stored counts, not zeroes, on the no-op path', async () => {
    const first = await importFixtures();
    const second = await importFixtures();

    expect(second.sliceCount).toBe(first.sliceCount);
    expect(second.sliceIdentityRows).toBe(first.sliceIdentityRows);
    expect(second.divergentDays).toBe(first.divergentDays);
    expect(second.projectCount).toBe(first.projectCount);
  });

  it('a dry run after a real import still short-circuits', async () => {
    await importFixtures();
    expect((await importFixtures({ dryRun: true })).alreadyImported).toBe(true);
  });

  it('does not treat a different dump pair as already imported', async () => {
    await importFixtures();
    // The conflict fixtures are different bytes, so the guard must not fire;
    // reaching the conflict proves the import actually ran.
    await expect(
      importDumps(db, { dailyDumpPath: CONFLICT_DAILY, heartbeatDumpPath: CONFLICT_HEARTBEATS })
    ).rejects.toThrow(HeartbeatConflictError);
  });

  it('forcing a re-import surfaces the real duplicate-key failure instead of hiding it', async () => {
    await importFixtures();
    // Nothing merges day rows across imports yet, so a forced repeat must fail
    // loudly rather than write a second copy of every day.
    await expect(importFixtures({ force: true })).rejects.toThrow(/UNIQUE constraint failed/);
    expect(count('SELECT COUNT(*) AS n FROM daily_totals')).toBe(7);
  });
});

describe('atomicity', () => {
  it('writes nothing at all when a later day fails validation', async () => {
    const dir = temporaryDir();
    const daily = JSON.parse(readFileSync(DAILY, 'utf8')) as {
      days: Array<Record<string, unknown>>;
    };
    // Day 0-4 validate; day 5 does not. Without one enclosing transaction the
    // earlier days would already be committed by the time this throws.
    delete daily.days[5].grand_total;

    const brokenPath = join(dir, 'broken-daily.json');
    writeFileSync(brokenPath, JSON.stringify(daily));

    await expect(
      importDumps(db, { dailyDumpPath: brokenPath, heartbeatDumpPath: HEARTBEATS })
    ).rejects.toThrow(DumpValidationError);

    expect(count('SELECT COUNT(*) AS n FROM daily_totals')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM heartbeats')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM source_imports')).toBe(0);
  });
});

describe('guards', () => {
  it('rejects a file above the direct-parse limit before reading it', async () => {
    await expect(importFixtures({ maxBytes: 1024 })).rejects.toThrow(DumpTooLargeError);
  });

  it('does not put the dump path in the too-large error', async () => {
    const error = await rejection(importFixtures({ maxBytes: 1024 }));
    expect(error.message).not.toContain('synthetic-daily');
    expect(error.message).toContain('<path.json:');
  });

  it('refuses two dumps from different accounts', async () => {
    const dir = temporaryDir();
    const daily = JSON.parse(readFileSync(DAILY, 'utf8')) as { user: { id: string } };
    daily.user.id = 'someone-else';
    const path = join(dir, 'other-account.json');
    writeFileSync(path, JSON.stringify(daily));

    await expect(
      importDumps(db, { dailyDumpPath: path, heartbeatDumpPath: HEARTBEATS })
    ).rejects.toThrow(/different accounts/);
  });

  it('refuses dumps whose days do not line up', async () => {
    const dir = temporaryDir();
    const daily = JSON.parse(readFileSync(DAILY, 'utf8')) as { days: unknown[] };
    daily.days.pop();
    const path = join(dir, 'short.json');
    writeFileSync(path, JSON.stringify(daily));

    await expect(
      importDumps(db, { dailyDumpPath: path, heartbeatDumpPath: HEARTBEATS })
    ).rejects.toThrow(/different day counts/);
  });

  it('refuses to overwrite existing daily rows showing live API, sync, or dump provenance', async () => {
    // Stage an existing daily import, daily total, and sync layer state for 2026-01-03
    const importId = (
      db.prepare(`
        INSERT INTO source_imports (source_type, source_hash, byte_size, status, range_start_date, range_end_date)
        VALUES ('api_summaries', 'fake-hash-123', 100, 'completed', '2026-01-03', '2026-01-03')
      `).run()
    ).lastInsertRowid;

    db.prepare(`
      INSERT INTO daily_totals (
        date, timezone, total_seconds, grand_total_json, project_sum_seconds, project_sum_delta, source_import_id, source_hash
      ) VALUES (
        '2026-01-03', 'UTC', 3600.0, '{}', 3600.0, 0.0, ?, 'fake-hash-123'
      )
    `).run(importId);

    db.prepare(`
      INSERT INTO sync_layer_state (
        date, layer, last_attempt_at, last_success_at, last_accepted_change_at,
        accepted_source_reference, accepted_snapshot_version, accepted_fidelity,
        accepted_content_hash, verified_timezone, updated_at
      ) VALUES (
        '2026-01-03', 'summaries', '2026-01-03T12:00:00Z', '2026-01-03T12:00:00Z', '2026-01-03T12:00:00Z',
        'api:live-session-123', 2, 'entity_detail', 'some-hash', 'UTC', '2026-01-03T12:00:00Z'
      )
    `).run();

    // Importing fixture that includes 2026-01-03 must fail conservatively
    await expect(importFixtures()).rejects.toThrow(/Cannot overwrite existing data for 2026-01-03/);
  });
});
