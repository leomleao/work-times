import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { parseScopes } from '$lib/server/auth/scopes';
import { verifyCsrfToken } from '$lib/server/security/http';

export const load: PageServerLoad = async () => {
  const rawClients = await runtime.oauthClients.list();
  const clients = rawClients.map((c) => ({
    id: c.clientId,
    clientId: c.clientId,
    name: c.name,
    clientType: (c.publicClient ? 'public' : 'confidential') as 'public' | 'confidential',
    redirectUris: c.redirectUris,
    scopes: c.scopes,
    createdAt: c.createdAt,
    status: (c.revokedAt ? 'revoked' : 'active') as 'active' | 'revoked'
  }));
  return { clients };
};

export const actions: Actions = {
  registerClient: async ({ request, locals }) => {
    if (!locals.admin || !locals.sessionToken) {
      return fail(401, { error: 'Unauthorized' });
    }

    const formData = await request.formData();
    const submitted = (formData.get('csrfToken') || request.headers.get('x-csrf-token')) as string | null;
    if (!verifyCsrfToken(submitted, locals.sessionToken, runtime.sessionSecret)) {
      return fail(403, { error: 'Invalid or missing CSRF token' });
    }

    const name = String(formData.get('name') ?? '').trim();
    const rawClientType = formData.get('clientType');
    if (rawClientType !== 'public' && rawClientType !== 'confidential') {
      return fail(400, { error: "Client type must be either 'public' or 'confidential'" });
    }
    const clientType = rawClientType;

    const redirectUrisRaw = String(formData.get('redirectUris') ?? '')
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean);
    const scopesRaw = formData.getAll('scopes');

    if (name.length < 2 || name.length > 80) {
      return fail(400, { error: 'Application name must be 2–80 characters' });
    }
    if (redirectUrisRaw.length === 0 || redirectUrisRaw.length > 10) {
      return fail(400, { error: 'OAuth client requires between 1 and 10 redirect URIs' });
    }

    let scopes: ReturnType<typeof parseScopes>;
    try {
      scopes = parseScopes(scopesRaw.length > 0 ? scopesRaw.map(String) : ['activity:read']);
    } catch (err) {
      return fail(400, { error: err instanceof Error ? err.message : 'Invalid scopes' });
    }

    try {
      const { metadata, clientSecret } = await runtime.oauthClients.register({
        name,
        publicClient: clientType === 'public',
        redirectUris: redirectUrisRaw,
        scopes
      });
      return {
        clientId: metadata.clientId,
        clientSecret: clientSecret ?? undefined,
        client: {
          id: metadata.clientId,
          clientId: metadata.clientId,
          name: metadata.name,
          clientType: (metadata.publicClient ? 'public' : 'confidential') as 'public' | 'confidential',
          redirectUris: metadata.redirectUris,
          scopes: metadata.scopes,
          createdAt: metadata.createdAt,
          status: 'active' as const
        }
      };
    } catch (err) {
      return fail(400, { error: err instanceof Error ? err.message : 'Failed to register client' });
    }
  },

  revokeClient: async ({ request, locals }) => {
    if (!locals.admin || !locals.sessionToken) {
      return fail(401, { error: 'Unauthorized' });
    }

    const formData = await request.formData();
    const submitted = (formData.get('csrfToken') || request.headers.get('x-csrf-token')) as string | null;
    if (!verifyCsrfToken(submitted, locals.sessionToken, runtime.sessionSecret)) {
      return fail(403, { error: 'Invalid or missing CSRF token' });
    }

    const clientId = String(formData.get('clientId') ?? '').trim();
    if (!clientId) {
      return fail(400, { error: 'Missing client ID' });
    }

    const revoked = await runtime.oauthClients.revoke(clientId);
    if (!revoked) {
      return fail(404, { error: 'OAuth client not found' });
    }
    return { revokedClientId: clientId };
  }
};
