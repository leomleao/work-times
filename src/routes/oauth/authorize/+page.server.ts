import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { hasRequiredScopes, parseScopes, type ApplicationScope } from '$lib/server/auth/scopes';
import { redirectUriMatches } from '$lib/server/oauth/redirect-uri';
import { normalizeResourceIdentifier } from '$lib/server/oauth/authorization';
import { verifyCsrfToken } from '$lib/server/security/http';
import type { OAuthClientRecord } from '$lib/server/oauth/clients';

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Upper bound on the opaque `state` parameter, in bytes.
 *
 * `state` is the client's own value and is never interpreted here, so it is bounded by
 * size alone — never trimmed, normalised, or inspected.
 */
const MAX_STATE_BYTES = 1024;

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

/**
 * Validates one authorization request.
 *
 * The single `source` is always the request URL's query string — the authorization
 * request is defined by the URL the consent screen was rendered for, and nothing else.
 * Consent submissions re-validate that same URL rather than trusting anything the POST
 * body carries, so a tampered body cannot swap the client, redirect target, resource,
 * scopes, PKCE challenge, or state out from under an approval the operator saw.
 */
async function validateAuthorizeParams(source: URLSearchParams): Promise<ValidationResult> {
  const getParam = (key: string): string | null => {
    const value = source.get(key);
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
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

  // `state` is read raw: present-but-empty stays present, and surrounding whitespace is
  // part of the client's value. Only its size is our business.
  const state = source.get('state');
  if (state !== null && Buffer.byteLength(state, 'utf8') > MAX_STATE_BYTES) {
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
      state
    }
  };
}

/**
 * Re-validates the authorization request a consent submission refers to, and checks the
 * session-bound CSRF token carried in the POST body.
 *
 * The body contributes the CSRF token and nothing else.
 */
async function authorizeConsent(event: {
  request: Request;
  url: URL;
  locals: App.Locals;
}): Promise<{ ok: true; params: AuthorizeParams } | { ok: false; failure: ReturnType<typeof fail> }> {
  if (!event.locals.admin || !event.locals.sessionToken) {
    return { ok: false, failure: fail(401, { error: 'Unauthorized' }) };
  }

  let submittedCsrf = event.request.headers.get('x-csrf-token');
  if (!submittedCsrf) {
    try {
      const formData = await event.request.formData();
      submittedCsrf = (formData.get('csrfToken') as string | null) ?? null;
    } catch {
      submittedCsrf = null;
    }
  }

  if (!verifyCsrfToken(submittedCsrf, event.locals.sessionToken, runtime.sessionSecret)) {
    return { ok: false, failure: fail(403, { error: 'Invalid or missing CSRF token' }) };
  }

  const validation = await validateAuthorizeParams(event.url.searchParams);
  if (!validation.ok) {
    return { ok: false, failure: fail(400, { error: validation.error }) };
  }

  return { ok: true, params: validation.params };
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
    // The consent forms post back to this exact query string, which is what binds the
    // approval to the request the operator was shown.
    requestQuery: url.search,
    csrfToken: locals.csrfToken,
    adminUsername: locals.admin.username
  };
};

export const actions: Actions = {
  approve: async ({ request, url, locals }) => {
    const consent = await authorizeConsent({ request, url, locals });
    if (!consent.ok) {
      return consent.failure;
    }

    const { client, redirectUri, resource, scopes, codeChallenge, state } = consent.params;
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
    // Denial is bound to the same validated request as approval: a denial that redirected
    // on weaker checks would itself be an open redirect.
    const consent = await authorizeConsent({ request, url, locals });
    if (!consent.ok) {
      return consent.failure;
    }

    const { redirectUri, state } = consent.params;

    const target = new URL(redirectUri);
    target.searchParams.set('error', 'access_denied');
    target.searchParams.set('error_description', 'The resource owner denied the authorization request');
    if (state !== null) {
      target.searchParams.set('state', state);
    }

    throw redirect(303, target.href);
  }
};
