import { describe, expect, it } from 'vitest';
import { getRuntimeConfig, parsePublicUrl } from './config';

describe('runtime configuration', () => {
  it('canonicalizes PUBLIC_URL to an origin', () => {
    expect(parsePublicUrl('https://work-times.home/').href).toBe('https://work-times.home/');
    expect(parsePublicUrl('http://localhost:3002').origin).toBe('http://localhost:3002');
  });

  it('rejects unsafe or ambiguous PUBLIC_URL values', () => {
    expect(() => parsePublicUrl('file:///tmp/archive')).toThrow('HTTP or HTTPS');
    expect(() => parsePublicUrl('https://user:pass@example.com')).toThrow('credentials');
    expect(() => parsePublicUrl('https://example.com/subpath')).toThrow('without a path');
    expect(() => parsePublicUrl('https://example.com/?return=evil')).toThrow('query');
  });

  it('preserves the special exact DATABASE_PATH=:memory: value', () => {
    const saved = process.env.DATABASE_PATH;
    try {
      process.env.DATABASE_PATH = ':memory:';
      const config = getRuntimeConfig();
      expect(config.databasePath).toBe(':memory:');
    } finally {
      process.env.DATABASE_PATH = saved;
    }
  });

  it('resolves relative file-backed database paths to absolute paths', () => {
    const saved = process.env.DATABASE_PATH;
    try {
      process.env.DATABASE_PATH = './data/custom.sqlite';
      const config = getRuntimeConfig();
      expect(config.databasePath).not.toBe(':memory:');
      expect(config.databasePath.endsWith('custom.sqlite')).toBe(true);
    } finally {
      process.env.DATABASE_PATH = saved;
    }
  });

  it('ensures Vitest test environment provides :memory: and local .env cannot override test env', () => {
    expect(process.env.DATABASE_PATH).toBe(':memory:');
    const config = getRuntimeConfig();
    expect(config.databasePath).toBe(':memory:');
  });
});
