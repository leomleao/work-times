import { json, type RequestHandler } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';
import { parseScopes, type ApplicationScope } from '$lib/server/auth/scopes';
import { normalizeRedirectUri } from '$lib/server/oauth/redirect-uri';

const PROTOCOL_HEADERS = {
  'cache-control': 'no-store',
  pragma: 'no-cache'
};

const MAX_BODY_BYTES = 64 * 1024; // 64KB limit
const ALLOWED_GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  // Rate limiting per IP
  let clientIp = '127.0.0.1';
  try {
    clientIp = getClientAddress();
  } catch {}

  if (!runtime.registrationLimiter.allow(clientIp)) {
    return json(
      {
        error: 'slow_down',
        error_description: 'Too many registration requests. Please try again later.'
      },
      {
        status: 429,
        headers: {
          ...PROTOCOL_HEADERS,
          'retry-after': '60'
        }
      }
    );
  }

  // Strict Content-Type validation
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return json(
      {
        error: 'invalid_client_metadata',
        error_description: 'Content-Type must be application/json'
      },
      { status: 400, headers: PROTOCOL_HEADERS }
    );
  }

  // Strict body size limit
  const contentLength = request.headers.get('content-length');
  if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return json(
      {
        error: 'invalid_client_metadata',
        error_description: 'Request payload exceeds maximum allowed size'
      },
      { status: 400, headers: PROTOCOL_HEADERS }
    );
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return json(
      {
        error: 'invalid_client_metadata',
        error_description: 'Failed to read request payload'
      },
      { status: 400, headers: PROTOCOL_HEADERS }
    );
  }

  if (bodyText.length > MAX_BODY_BYTES) {
    return json(
      {
        error: 'invalid_client_metadata',
        error_description: 'Request payload exceeds maximum allowed size'
      },
      { status: 400, headers: PROTOCOL_HEADERS }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return json(
      {
        error: 'invalid_client_metadata',
        error_description: 'Invalid JSON payload'
      },
      { status: 400, headers: PROTOCOL_HEADERS }
    );
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(
      {
        error: 'invalid_client_metadata',
        error_description: 'Payload must be a JSON object'
      },
      { status: 400, headers: PROTOCOL_HEADERS }
    );
  }

  // Validate client_name: safe, bounded, 2-80 characters, printable
  if (typeof body.client_name !== 'string') {
    return json(
      {
        error: 'invalid_client_metadata',
        error_description: 'client_name is required and must be a string'
      },
      { status: 400, headers: PROTOCOL_HEADERS }
    );
  }

  const clientName = body.client_name.trim();
  if (clientName.length < 2 || clientName.length > 80 || /[\x00-\x1f\x7f]/.test(clientName)) {
    return json(
      {
        error: 'invalid_client_metadata',
        error_description: 'client_name must be between 2 and 80 printable characters'
      },
      { status: 400, headers: PROTOCOL_HEADERS }
    );
  }

  // Validate redirect_uris: 1-10 valid exact redirect URIs
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0 || body.redirect_uris.length > 10) {
    return json(
      {
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris must be an array of 1 to 10 valid URIs'
      },
      { status: 400, headers: PROTOCOL_HEADERS }
    );
  }

  let normalizedUris: string[];
  try {
    normalizedUris = body.redirect_uris.map((uri) => {
      if (typeof uri !== 'string') throw new Error('Each redirect URI must be a string');
      return normalizeRedirectUri(uri);
    });
  } catch (err) {
    return json(
      {
        error: 'invalid_redirect_uri',
        error_description: err instanceof Error ? err.message : 'Invalid redirect URI'
      },
      { status: 400, headers: PROTOCOL_HEADERS }
    );
  }

  const redirectUris = [...new Set(normalizedUris)];
  if (redirectUris.length === 0 || redirectUris.length > 10) {
    return json(
      {
        error: 'invalid_redirect_uri',
        error_description: 'Must provide between 1 and 10 unique redirect URIs'
      },
      { status: 400, headers: PROTOCOL_HEADERS }
    );
  }

  // Constrained to public clients only: token_endpoint_auth_method=none
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
    return json(
      {
        error: 'invalid_client_metadata',
        error_description: 'Dynamic registration only permits public clients (token_endpoint_auth_method=none)'
      },
      { status: 400, headers: PROTOCOL_HEADERS }
    );
  }

  // Grant types: authorization_code + refresh_token
  if (body.grant_types !== undefined) {
    if (!Array.isArray(body.grant_types) || body.grant_types.length === 0) {
      return json(
        {
          error: 'invalid_client_metadata',
          error_description: 'grant_types must be a non-empty array of strings'
        },
        { status: 400, headers: PROTOCOL_HEADERS }
      );
    }
    const hasInvalidGrant = body.grant_types.some(
      (gt) => typeof gt !== 'string' || !ALLOWED_GRANT_TYPES.has(gt)
    );
    if (hasInvalidGrant || !body.grant_types.includes('authorization_code')) {
      return json(
        {
          error: 'invalid_client_metadata',
          error_description: 'Unsupported grant_types: only authorization_code and refresh_token are supported'
        },
        { status: 400, headers: PROTOCOL_HEADERS }
      );
    }
  }

  // Response types: code
  if (body.response_types !== undefined) {
    if (
      !Array.isArray(body.response_types) ||
      body.response_types.length !== 1 ||
      body.response_types[0] !== 'code'
    ) {
      return json(
        {
          error: 'invalid_client_metadata',
          error_description: 'Unsupported response_types: only "code" is supported'
        },
        { status: 400, headers: PROTOCOL_HEADERS }
      );
    }
  }

  // Scope: supported scope subset
  let scopes: ApplicationScope[] = ['activity:read'];
  if (body.scope !== undefined) {
    if (typeof body.scope !== 'string') {
      return json(
        {
          error: 'invalid_client_metadata',
          error_description: 'scope must be a string'
        },
        { status: 400, headers: PROTOCOL_HEADERS }
      );
    }
    try {
      const parsed = parseScopes(body.scope);
      if (parsed.length > 0) {
        scopes = parsed;
      }
    } catch {
      return json(
        {
          error: 'invalid_client_metadata',
          error_description: 'Requested scope contains unsupported scopes'
        },
        { status: 400, headers: PROTOCOL_HEADERS }
      );
    }
  }

  // Register public client
  try {
    const registered = await runtime.oauthClients.register({
      name: clientName,
      publicClient: true,
      redirectUris,
      scopes
    });

    // Standards-shaped RFC 7591 201 response without client secret
    return json(
      {
        client_id: registered.metadata.clientId,
        client_name: registered.metadata.name,
        redirect_uris: registered.metadata.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: registered.metadata.scopes.join(' '),
        client_id_issued_at: Math.floor(new Date(registered.metadata.createdAt).getTime() / 1000)
      },
      {
        status: 201,
        headers: PROTOCOL_HEADERS
      }
    );
  } catch (err) {
    return json(
      {
        error: 'invalid_client_metadata',
        error_description: err instanceof Error ? err.message : 'Registration failed'
      },
      { status: 400, headers: PROTOCOL_HEADERS }
    );
  }
};
