import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DumpTooLargeError,
  DumpValidationError,
  hashFile,
  parseDumpFile,
  validateDailyDay,
  validateEnvelope,
  validateHeartbeat,
  validateHeartbeatDay
} from './parse.js';

const temporaryDirectories: string[] = [];

function writeTemp(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'work-times-parse-'));
  temporaryDirectories.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe('parseDumpFile', () => {
  it('returns the parsed data with its size and content hash', async () => {
    const path = writeTemp('small.json', '{"a":1}');
    const result = await parseDumpFile(path);

    expect(result.data).toEqual({ a: 1 });
    expect(result.byteSize).toBe(7);
    expect(result.sourceHash).toBe(await hashFile(path));
  });

  it('rejects a file above the limit without reading it', async () => {
    const path = writeTemp('big.json', JSON.stringify({ padding: 'x'.repeat(2000) }));
    await expect(parseDumpFile(path, 100)).rejects.toThrow(DumpTooLargeError);
  });

  it('reports the limit and the actual size so the operator can act', async () => {
    const path = writeTemp('big.json', JSON.stringify({ padding: 'x'.repeat(2000) }));
    let error!: DumpTooLargeError;
    try {
      await parseDumpFile(path, 100);
    } catch (cause) {
      error = cause as DumpTooLargeError;
    }

    expect(error.limitBytes).toBe(100);
    expect(error.byteSize).toBeGreaterThan(100);
  });

  it('names the file only by fingerprint when the JSON is malformed', async () => {
    const path = writeTemp('bad.json', '{ not json');
    let error!: Error;
    try {
      await parseDumpFile(path);
    } catch (cause) {
      error = cause as Error;
    }

    expect(error).toBeInstanceOf(DumpValidationError);
    expect(error.message).not.toContain('bad.json');
    expect(error.message).toContain('<path.json:');
  });
});

describe('validateEnvelope', () => {
  const valid = {
    user: { id: 'u1', timezone: 'UTC', timeout: 15, weekday_start: 1, plan: 'free' },
    range: { start: 0, end: 100 },
    days: []
  };

  it('extracts only the non-PII account settings', () => {
    const envelope = validateEnvelope({ ...valid, user: { ...valid.user, email: 'a@b.c' } }, 'daily');
    expect(Object.keys(envelope.user).sort()).toEqual([
      'has_premium_features',
      'id',
      'plan',
      'timeout',
      'timezone',
      'weekday_start',
      'writes_only'
    ]);
  });

  it('rejects a missing user id', () => {
    expect(() => validateEnvelope({ ...valid, user: {} }, 'daily')).toThrow(/user.id/);
  });

  it('rejects a non-array days', () => {
    expect(() => validateEnvelope({ ...valid, days: {} }, 'daily')).toThrow(/'days' must be an array/);
  });

  it('rejects a backwards range', () => {
    expect(() => validateEnvelope({ ...valid, range: { start: 10, end: 1 } }, 'daily')).toThrow(
      /ends before it starts/
    );
  });
});

describe('validateDailyDay', () => {
  const day = { date: '2026-01-01', grand_total: { total_seconds: 10 } };

  it('defaults every absent breakdown array to empty', () => {
    const parsed = validateDailyDay(day, 0);
    expect(parsed.categories).toEqual([]);
    expect(parsed.projects).toEqual([]);
    expect(parsed.grandTotal.total_seconds).toBe(10);
  });

  it('zero-fills AI counters the export omits on a quiet day', () => {
    expect(validateDailyDay(day, 0).grandTotal.ai_sessions).toBe(0);
  });

  it('keeps the raw grand_total for lossless retention', () => {
    const parsed = validateDailyDay({ ...day, grand_total: { total_seconds: 10, odd: 'kept' } }, 0);
    expect(parsed.grandTotal.raw.odd).toBe('kept');
  });

  it('rejects a malformed date rather than storing it', () => {
    expect(() => validateDailyDay({ ...day, date: '01/01/2026' }, 0)).toThrow(/YYYY-MM-DD/);
  });

  it('rejects a project without a name', () => {
    expect(() =>
      validateDailyDay({ ...day, projects: [{ grand_total: { total_seconds: 1 } }] }, 0)
    ).toThrow(/missing or empty 'name'/);
  });

  it('rejects an entity with an unknown type', () => {
    expect(() =>
      validateDailyDay(
        {
          ...day,
          projects: [
            {
              name: 'p',
              grand_total: { total_seconds: 1 },
              entities: [{ name: 'e', total_seconds: 1, percent: 100, type: 'widget' }]
            }
          ]
        },
        0
      )
    ).toThrow(/unknown entity type/);
  });
});

describe('validateHeartbeat', () => {
  const beat = {
    id: 'hb1',
    entity: '/a/b.ts',
    type: 'file',
    category: 'Coding',
    time: 1_700_000_000,
    user_agent_id: 'editor/1'
  };

  it('accepts every documented-nullable field as null', () => {
    const parsed = validateHeartbeat(
      { ...beat, project: null, branch: null, language: null, lines: null, machine_name_id: null },
      '2026-01-01',
      0
    );
    expect(parsed.project).toBeNull();
    expect(parsed.machine_name_id).toBeNull();
  });

  it('treats an absent optional field as null rather than undefined', () => {
    expect(validateHeartbeat(beat, '2026-01-01', 0).branch).toBeNull();
  });

  it('rejects a wrong non-null type instead of coercing it', () => {
    expect(() => validateHeartbeat({ ...beat, project: 42 }, '2026-01-01', 0)).toThrow(
      /must be a string or null/
    );
    expect(() => validateHeartbeat({ ...beat, lines: '12' }, '2026-01-01', 0)).toThrow(
      /must be an integer or null/
    );
    expect(() => validateHeartbeat({ ...beat, dependencies: 'zod' }, '2026-01-01', 0)).toThrow(
      /non-array 'dependencies'/
    );
    expect(() => validateHeartbeat({ ...beat, is_write: 'yes' }, '2026-01-01', 0)).toThrow(
      /non-boolean 'is_write'/
    );
  });

  it('rejects a heartbeat with no id or an unknown type', () => {
    expect(() => validateHeartbeat({ ...beat, id: '' }, '2026-01-01', 0)).toThrow(/'id'/);
    expect(() => validateHeartbeat({ ...beat, type: 'widget' }, '2026-01-01', 0)).toThrow(/'type'/);
  });

  it('accepts URL heartbeat evidence without changing summary entity types', () => {
    const parsed = validateHeartbeat({ ...beat, type: 'url', entity: 'https://Example.com/Path' }, '2026-01-01', 0);
    expect(parsed.type).toBe('url');
    expect(parsed.entity).toBe('https://Example.com/Path');
  });

  it('zero-fills the AI token counters', () => {
    const parsed = validateHeartbeat(beat, '2026-01-01', 0);
    expect(parsed.ai_input_tokens).toBe(0);
    expect(parsed.ai_output_tokens).toBe(0);
  });
});

describe('validateHeartbeatDay', () => {
  it('accepts a day with no heartbeats', () => {
    expect(validateHeartbeatDay({ date: '2026-01-01' }, 0).heartbeats).toEqual([]);
  });

  it('rejects a non-array heartbeats field', () => {
    expect(() => validateHeartbeatDay({ date: '2026-01-01', heartbeats: {} }, 0)).toThrow(
      /non-array 'heartbeats'/
    );
  });
});
