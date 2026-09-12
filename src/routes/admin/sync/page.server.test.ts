import { describe, it, expect } from 'vitest';
import { _createLoadHandler } from './+page.server.js';
import { runtime } from '$lib/server/runtime';
import Database from 'better-sqlite3';

describe('/admin/sync +page.server load', () => {
  it('returns sync data when runtime is ready and queries succeed', async () => {
    const handler = _createLoadHandler(runtime);
    const result = (await handler({ locals: { csrfToken: 'test-token' } } as any)) as any;

    expect(result).toHaveProperty('sync');
    expect(result.unavailable).toBe(false);
    expect(result.csrfToken).toBe('test-token');
  });

  it('returns explicit unavailable code when db or scheduler fails', async () => {
    const brokenRuntime = {
      ...runtime,
      db: new Database(':memory:'),
      scheduler: undefined as any
    };

    const handler = _createLoadHandler(brokenRuntime);
    const result = (await handler({ locals: { csrfToken: 'test-token' } } as any)) as any;

    expect(result.sync).toBeNull();
    expect(result.unavailable).toBe(true);
    expect(result.code).toBe('SYNC_STATE_UNAVAILABLE');
    expect(result.csrfToken).toBe('test-token');
  });
});
