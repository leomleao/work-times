import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { hasRequiredScopes, parseScopes, type ApplicationScope } from '$lib/server/auth/scopes';
import { redirectUriMatches } from '$lib/server/oauth/redirect-uri';
import { normalizeResourceIdentifier } from '$lib/server/oauth/authorization';
import { verifyCsrfToken } from '$lib/server/security/http';
import type { OAuthClientRecord } from '$lib/server/oauth/clients';

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface AuthorizeParams {
  client: OAuthClientRecord;
  redirectUri: string;
  responseType: string;
  resource: string;
  scopes: ApplicationScope[];
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string | null;
}

type ValidationResult =
  | { ok: true; params: AuthorizeParams }
  | { ok: false; error: string };

async function validateAuthorizeParams(
  source: URLSearchParams | FormData,
  fallback?: URLSearchParams
): Promise<ValidationResult> {
  const getParam = (key: string): string | null => {
    const val = source.get(key);
    if (val !== null && typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
    if (fallback) {
      const fb = fallback.get(key);
      if (fb !== null && fb.trim().length > 0) {
        return fb.trim();
      }
    }
    return null;
  };

  const clientId = getParam('client_id');
  if (!clientId) {
    return { ok: false, error: 'Missing client_id parameter' };
  }

  const client = await runtime.oauthClients.findActive(clientId);
  if (!client) {
    return { ok: false, error: 'Unknown or inactive OAuth client' };
  }

  const redirectUri = getParam('redirect_uri');
  if (!redirectUri) {
    return { ok: false, error: 'Missing redirect_uri parameter' };
  }

  if (!redirectUriMatches(redirectUri, client.redirectUris)) {
    return { ok: false, error: 'Redirect URI does not match client registration' };
  }

  const responseType = getParam('response_type');
  if (responseType !== 'code') {
    return { ok: false, error: 'Unsupported response_type: only "code" is supported' };
  }

  const resource = getParam('resource');
  if (!resource) {
    return { ok: false, error: 'Missing resource parameter' };
  }

  let normalizedResource: string;
  try {
    normalizedResource = normalizeResourceIdentifier(resource);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid resource identifier' };
  }

  const expectedResource = normalizeResourceIdentifier(
    new URL('/mcp', runtime.config.publicUrl).href
  );
  if (normalizedResource !== expectedResource) {
    return { ok: false, error: 'Resource does not match configured MCP resource' };
  }

  const codeChallengeMethod = getParam('code_challenge_method');
  if (codeChallengeMethod !== 'S256') {
    return { ok: false, error: 'PKCE code_challenge_method must be S256' };
  }

  const codeChallenge = getParam('code_challenge');
  if (!codeChallenge || !CHALLENGE_PATTERN.test(codeChallenge)) {
    return { ok: false, error: 'Invalid PKCE code_challenge' };
  }

  const scopeParam = getParam('scope');
  if (!scopeParam) {
    return { ok: false, error: 'Missing scope parameter' };
  }

  let scopes: ApplicationScope[];
  try {
    scopes = parseScopes(scopeParam);
  } catch {
    return { ok: false, error: 'Invalid or unrecognized scope requested' };
  }

  if (scopes.length === 0) {
    return { ok: false, error: 'At least one scope must be requested' };
  }

  if (!hasRequiredScopes(client.scopes, scopes)) {
    return { ok: false, error: 'Requested scope is not registered for this client' };
  }

  const state = getParam('state');
  if (state && state.length > 1024) {
    return { ok: false, error: 'State parameter too long' };
  }

  return {
    ok: true,
    params: {
      client,
      redirectUri,
      responseType,
      resource: normalizedResource,
      scopes,
      codeChallenge,
      codeChallengeMethod,
      state: state || null
    }
  };
}

export const load: PageServerLoad = async ({ url, locals }) => {
  // Validate OAuth parameters before ANY redirect to prevent open redirect
  const validation = await validateAuthorizeParams(url.searchParams);
  if (!validation.ok) {
    throw error(400, { message: validation.error });
  }

  // If unauthenticated, redirect to /login preserving same-origin relative authorize target
  if (!locals.admin) {
    const returnTarget = url.pathname + url.search;
    throw redirect(303, `/login?redirectTo=${encodeURIComponent(returnTarget)}`);
  }

  return {
    client: {
      clientId: validation.params.client.clientId,
      name: validation.params.client.name,
      publicClient: validation.params.client.publicClient
    },
    redirectUri: validation.params.redirectUri,
    resource: validation.params.resource,
    scopes: validation.params.scopes,
    codeChallenge: validation.params.codeChallenge,
    codeChallengeMethod: validation.params.codeChallengeMethod,
    state: validation.params.state,
    csrfToken: locals.csrfToken,
    adminUsername: locals.admin.username
  };
};

export const actions: Actions = {
  approve: async ({ request, url, locals }) => {
    if (!locals.admin || !locals.sessionToken) {
      return fail(401, { error: 'Unauthorized' });
    }

    const formData = await request.formData();
    const submittedCsrf = (formData.get('csrfToken') || request.headers.get('x-csrf-token')) as string | null;
    if (!verifyCsrfToken(submittedCsrf, locals.sessionToken, runtime.sessionSecret)) {
      return fail(403, { error: 'Invalid or missing CSRF token' });
    }

    const validation = await validateAuthorizeParams(formData, url.searchParams);
    if (!validation.ok) {
      return fail(400, { error: validation.error });
    }

    const { client, redirectUri, resource, scopes, codeChallenge, state } = validation.params;
    const issued = await runtime.oauthAuth.issueAuthorizationCode({
      clientId: client.clientId,
      redirectUri,
      resource,
      scopes,
      codeChallenge,
      codeChallengeMethod: 'S256',
      state: state ?? undefined
    });

    throw redirect(303, issued.redirectTo);
  },

  deny: async ({ request, url, locals }) => {
    if (!locals.admin || !locals.sessionToken) {
      return fail(401, { error: 'Unauthorized' });
    }

    const formData = await request.formData();
    const submittedCsrf = (formData.get('csrfToken') || request.headers.get('x-csrf-token')) as string | null;
    if (!verifyCsrfToken(submittedCsrf, locals.sessionToken, runtime.sessionSecret)) {
      return fail(403, { error: 'Invalid or missing CSRF token' });
    }

    // Denial still requires a valid active client and exact registered redirect URI
    const clientId = (formData.get('client_id') as string | null)?.trim() || url.searchParams.get('client_id')?.trim();
    if (!clientId) {
      return fail(400, { error: 'Missing client_id parameter' });
    }
    const client = await runtime.oauthClients.findActive(clientId);
    if (!client) {
      return fail(400, { error: 'Unknown or inactive OAuth client' });
    }

    const redirectUri = (formData.get('redirect_uri') as string | null)?.trim() || url.searchParams.get('redirect_uri')?.trim();
    if (!redirectUri || !redirectUriMatches(redirectUri, client.redirectUris)) {
      return fail(400, { error: 'Redirect URI does not match client registration' });
    }

    const state = (formData.get('state') as string | null)?.trim() || url.searchParams.get('state')?.trim();

    const target = new URL(redirectUri);
    target.searchParams.set('error', 'access_denied');
    target.searchParams.set('error_description', 'The resource owner denied the authorization request');
    if (state) {
      target.searchParams.set('state', state);
    }

    throw redirect(303, target.href);
  },

  default: async (event) => {
    const formData = await event.request.clone().formData();
    const actionType = formData.get('action');
    if (actionType === 'deny') {
      return (actions.deny as any)(event);
    }
    return (actions.approve as any)(event);
  }
};
