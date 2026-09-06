import { describe, expect, it } from 'vitest';
import {
  canonicalHeartbeatPayload,
  canonicalPayloadHash,
  canonicalizeDependencies,
  heartbeatSliceIdentities,
  normalizeEntity,
  normalizeSelectorValue,
  redact,
  redactPath,
  sha256Hex,
  sliceIntrinsicIdentities,
  stableStringify,
  toEpochMicroseconds,
  toIsoUtc
} from './canonical.js';

describe('canonicalizeDependencies', () => {
  it('sorts, deduplicates and trims', () => {
    expect(canonicalizeDependencies(['zod', 'vitest', 'zod', ' better-sqlite3 '])).toEqual([
      'better-sqlite3',
      'vitest',
      'zod'
    ]);
  });

  it('drops empty entries and preserves an empty array', () => {
    expect(canonicalizeDependencies(['', '   '])).toEqual([]);
    expect(canonicalizeDependencies([])).toEqual([]);
  });

  it('is order-insensitive, which is what makes reordered duplicates identical', () => {
    const a = canonicalizeDependencies(['b', 'a', 'c']);
    const b = canonicalizeDependencies(['c', 'b', 'a', 'c']);
    expect(a).toEqual(b);
  });

  it('sorts by code point rather than locale', () => {
    // A locale-aware sort would interleave these; the ordinal comparator must not.
    expect(canonicalizeDependencies(['b', 'A', 'a', 'B'])).toEqual(['A', 'B', 'a', 'b']);
  });

  it('rejects a non-string entry rather than coercing it', () => {
    expect(() => canonicalizeDependencies([42])).toThrow(TypeError);
  });
});

describe('stableStringify', () => {
  it('emits object keys in ordinal order at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('leaves array order alone', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('makes key order irrelevant to the hash', () => {
    expect(canonicalPayloadHash({ a: 1, b: 2 })).toBe(canonicalPayloadHash({ b: 2, a: 1 }));
  });

  it('still distinguishes genuinely different payloads', () => {
    expect(canonicalPayloadHash({ a: 1 })).not.toBe(canonicalPayloadHash({ a: 2 }));
  });
});

describe('canonicalHeartbeatPayload', () => {
  const base = { id: 'x', entity: '/a.ts', time: 1 };

  it('collapses dependency order and repeats into one hash', () => {
    const first = canonicalHeartbeatPayload({ ...base, dependencies: ['zod', 'vitest', 'zod'] });
    const second = canonicalHeartbeatPayload({ ...base, dependencies: ['vitest', 'zod'] });
    expect(canonicalPayloadHash(first)).toBe(canonicalPayloadHash(second));
  });

  it('keeps a differing core field distinguishable', () => {
    const first = canonicalHeartbeatPayload({ ...base, dependencies: [] });
    const second = canonicalHeartbeatPayload({ ...base, entity: '/b.ts', dependencies: [] });
    expect(canonicalPayloadHash(first)).not.toBe(canonicalPayloadHash(second));
  });

  it('preserves every source field losslessly', () => {
    const payload = canonicalHeartbeatPayload({ ...base, dependencies: [], odd_field: 'kept' });
    expect(payload.odd_field).toBe('kept');
  });
});

describe('normalizeEntity', () => {
  it('converts backslashes and strips a trailing slash for files', () => {
    expect(normalizeEntity('C:\\work\\repo\\', 'file')).toBe('c:/work/repo');
    expect(normalizeEntity('/work/repo/', 'file')).toBe('/work/repo');
  });

  it('leaves a POSIX path case alone', () => {
    expect(normalizeEntity('/Work/Repo/Index.ts', 'file')).toBe('/Work/Repo/Index.ts');
  });

  it('lowercases a domain but not an app name', () => {
    expect(normalizeEntity('Docs.Example.Invalid', 'domain')).toBe('docs.example.invalid');
    expect(normalizeEntity('Terminal', 'app')).toBe('Terminal');
  });

  it('keeps a bare root slash', () => {
    expect(normalizeEntity('/', 'file')).toBe('/');
  });
});

describe('epoch conversion', () => {
  it('converts fractional seconds to exact microseconds', () => {
    expect(toEpochMicroseconds(1_700_000_000.123456)).toBe(1_700_000_000_123_456);
  });

  it('renders second-precision ISO UTC', () => {
    expect(toIsoUtc(1_700_000_000_123_456)).toBe('2023-11-14T22:13:20Z');
  });

  it('rejects a non-finite time rather than storing NaN', () => {
    expect(() => toEpochMicroseconds(Number.NaN)).toThrow(RangeError);
    expect(() => toEpochMicroseconds(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('redaction', () => {
  it('never echoes the value back', () => {
    const secret = '/Users/someone/private/thing.ts';
    expect(redact(secret)).not.toContain('someone');
    expect(redactPath(secret)).not.toContain('someone');
  });

  it('is stable, so the same value is recognizable across log lines', () => {
    expect(redact('abc')).toBe(redact('abc'));
    expect(redact('abc')).not.toBe(redact('abd'));
  });

  it('keeps only the extension from a path', () => {
    expect(redactPath('/Users/someone/private/thing.ts')).toBe(
      `<path.ts:${sha256Hex('/Users/someone/private/thing.ts').slice(0, 8)}>`
    );
  });

  it('reports an absent value without inventing a fingerprint', () => {
    expect(redact(null)).toBe('<empty>');
    expect(redact('')).toBe('<empty>');
  });
});

describe('normalizeSelectorValue', () => {
  it('lowercases identity values that are case-insensitive in practice', () => {
    expect(normalizeSelectorValue('machine', ' Machine-A ')).toBe('machine-a');
    expect(normalizeSelectorValue('domain', 'GitHub.COM')).toBe('github.com');
  });

  it('preserves project name case, which is meaningful', () => {
    expect(normalizeSelectorValue('project', ' Alpha ')).toBe('Alpha');
  });

  it('normalizes paths the same way for prefixes and exact entities', () => {
    expect(normalizeSelectorValue('folder_prefix', '/work/repo/')).toBe('/work/repo');
    expect(normalizeSelectorValue('entity', 'C:\\work\\a.ts')).toBe('c:/work/a.ts');
  });
});

describe('slice identities', () => {
  it('derives project, folder and exact-path identities from a file slice', () => {
    expect(
      sliceIntrinsicIdentities({
        projectName: 'alpha',
        entity: '/fixtures/alpha/src/index.ts',
        entityType: 'file'
      })
    ).toEqual([
      { selectorType: 'project', value: 'alpha' },
      { selectorType: 'folder_prefix', value: '/fixtures/alpha/src' },
      { selectorType: 'entity', value: '/fixtures/alpha/src/index.ts' }
    ]);
  });

  it('derives an application identity from an app slice', () => {
    expect(
      sliceIntrinsicIdentities({ projectName: null, entity: 'Terminal', entityType: 'app' })
    ).toEqual([{ selectorType: 'application', value: 'terminal' }]);
  });

  it('never derives a language, category or branch identity', () => {
    const identities = sliceIntrinsicIdentities({
      projectName: 'alpha',
      entity: '/a/b.ts',
      entityType: 'file'
    });
    for (const identity of identities) {
      expect(['language', 'category', 'branch', 'dependency']).not.toContain(identity.selectorType);
    }
  });

  it('takes machine and editor identity from the heartbeat, not the slice', () => {
    expect(
      heartbeatSliceIdentities({ machineNameId: 'Machine-A', userAgentId: 'Editor/1.0' })
    ).toEqual([
      { selectorType: 'machine', value: 'machine-a' },
      { selectorType: 'editor', value: 'editor/1.0' }
    ]);
  });

  it('omits the machine identity when the heartbeat has none', () => {
    expect(heartbeatSliceIdentities({ machineNameId: null, userAgentId: 'Editor/1.0' })).toEqual([
      { selectorType: 'editor', value: 'editor/1.0' }
    ]);
  });
});
