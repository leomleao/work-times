import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { parseScopes } from '$lib/server/auth/scopes';
import { verifyCsrfToken } from '$lib/server/security/http';

export const load: PageServerLoad = async () => {
  const rawKeys = await runtime.apiKeys.list();
  const keys = rawKeys.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.tokenPrefix,
    scopes: k.scopes,
    createdAt: k.createdAt,
    expiresAt: k.expiresAt,
    lastUsedAt: k.lastUsedAt,
    status: (k.revokedAt ? 'revoked' : 'active') as 'active' | 'revoked'
  }));
  return { keys };
};

export const actions: Actions = {
  createKey: async ({ request, locals }) => {
    if (!locals.admin || !locals.sessionToken) {
      return fail(401, { error: 'Unauthorized' });
    }

    const formData = await request.formData();
    const submitted = (formData.get('csrfToken') || request.headers.get('x-csrf-token')) as string | null;
    if (!verifyCsrfToken(submitted, locals.sessionToken, runtime.sessionSecret)) {
      return fail(403, { error: 'Invalid or missing CSRF token' });
    }

    const name = String(formData.get('name') ?? '').trim();
    const scopesRaw = formData.getAll('scopes');

    if (name.length < 2 || name.length > 80) {
      return fail(400, { error: 'API key name must be 2–80 characters' });
    }

    let scopes: ReturnType<typeof parseScopes>;
    try {
      scopes = parseScopes(scopesRaw.length > 0 ? scopesRaw.map(String) : ['activity:read']);
    } catch (err) {
      return fail(400, { error: err instanceof Error ? err.message : 'Invalid scopes' });
    }

    try {
      const { token, metadata } = await runtime.apiKeys.create({
        name,
        scopes
      });
      return {
        secret: token,
        key: {
          id: metadata.id,
          name: metadata.name,
          prefix: metadata.tokenPrefix,
          scopes: metadata.scopes,
          createdAt: metadata.createdAt,
          expiresAt: metadata.expiresAt,
          lastUsedAt: metadata.lastUsedAt,
          status: 'active' as const
        }
      };
    } catch (err) {
      return fail(500, { error: err instanceof Error ? err.message : 'Failed to create API key' });
    }
  },

  revokeKey: async ({ request, locals }) => {
    if (!locals.admin || !locals.sessionToken) {
      return fail(401, { error: 'Unauthorized' });
    }

    const formData = await request.formData();
    const submitted = (formData.get('csrfToken') || request.headers.get('x-csrf-token')) as string | null;
    if (!verifyCsrfToken(submitted, locals.sessionToken, runtime.sessionSecret)) {
      return fail(403, { error: 'Invalid or missing CSRF token' });
    }

    const keyId = String(formData.get('keyId') ?? '').trim();
    if (!keyId) {
      return fail(400, { error: 'Missing key ID' });
    }

    const revoked = await runtime.apiKeys.revoke(keyId);
    if (!revoked) {
      return fail(404, { error: 'API key not found' });
    }
    return { revokedKeyId: keyId };
  }
};
