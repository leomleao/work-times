import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtime } from '$lib/server/runtime';
import { csrfTokenForSession } from '$lib/server/security/http';
import { actions } from './+page.server.js';

const FIXTURES = resolve(import.meta.dirname, '../../../../tests/fixtures');
const dailyBytes = readFileSync(resolve(FIXTURES, 'synthetic-daily.json'));
const heartbeatBytes = readFileSync(resolve(FIXTURES, 'synthetic-heartbeats.json'));
const sessionToken = 'upload-test-admin-session';
const csrfToken = () => csrfTokenForSession(sessionToken, runtime.sessionSecret);

function event(options: { admin?: boolean; csrf?: string | null; files?: boolean; mode?: string } = {}) {
  const formData = new FormData();
  if (options.csrf !== null) formData.set('csrfToken', options.csrf ?? csrfToken());
  if (options.files !== false) {
    formData.set('daily', new File([dailyBytes], 'daily.json', { type: 'application/json' }));
    formData.set('heartbeats', new File([heartbeatBytes], 'heartbeats.json', { type: 'application/json' }));
  }
  formData.set('mode', options.mode ?? 'validate');

  return {
    request: new Request('http://localhost:3002/admin/imports?/upload', {
      method: 'POST',
      headers: { origin: 'http://localhost:3002' },
      body: formData
    }),
    locals: {
      admin: options.admin === false ? null : { username: 'admin', sessionExpiresAt: '2099-01-01T00:00:00Z' },
      sessionToken: options.admin === false ? null : sessionToken,
      csrfToken: options.admin === false ? null : csrfToken()
    }
  } as any;
}

describe('admin imports upload action', () => {
  it('requires an administrator session', async () => {
    const result = await (actions.upload as any)(event({ admin: false }));
    expect(result.status).toBe(401);
  });

  it('rejects a missing or invalid CSRF token', async () => {
    const missing = await (actions.upload as any)(event({ csrf: null }));
    const invalid = await (actions.upload as any)(event({ csrf: 'wrong' }));
    expect(missing.status).toBe(403);
    expect(invalid.status).toBe(403);
  });

  it('requires both JSON files', async () => {
    const result = await (actions.upload as any)(event({ files: false }));
    expect(result.status).toBe(400);
  });

  it('validates a matching pair without modifying the archive', async () => {
    const before = (runtime.db.prepare('SELECT COUNT(*) AS n FROM source_imports').get() as { n: number }).n;
    const result = await (actions.upload as any)(event());
    const after = (runtime.db.prepare('SELECT COUNT(*) AS n FROM source_imports').get() as { n: number }).n;

    expect(result.upload).toMatchObject({ dryRun: true, dayCount: 7 });
    expect(after).toBe(before);
  });
});
