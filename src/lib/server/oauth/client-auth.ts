import type { OAuthClientRecord, OAuthClientService } from './clients';

export type ClientAuthResult =
  | {
      readonly ok: true;
      readonly client: OAuthClientRecord;
      readonly clientSecret?: string;
      readonly authMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly errorDescription: string;
      readonly headers?: Record<string, string>;
    };

const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Decodes one `application/x-www-form-urlencoded` component of a Basic credential
 * (RFC 6749 Section 2.3.1), returning `null` rather than a best-effort value.
 *
 * Malformed percent escapes are refused instead of being passed through literally: a
 * lenient decoder lets the same credential be spelled several ways.
 */
function strictFormUrlDecode(raw: string): string | null {
  // Every '%' must introduce exactly two hex digits — this also covers a trailing '%'.
  if (/%(?![0-9A-Fa-f]{2})/.test(raw)) {
    return null;
  }

  try {
    const decoded = decodeURIComponent(raw.replace(/\+/g, ' '));
    if (CONTROL_CHAR_PATTERN.test(decoded)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export async function authenticateOAuthClient(
  request: Request,
  bodyParams: URLSearchParams,
  clientService: OAuthClientService
): Promise<ClientAuthResult> {
  const authHeader = request.headers.get('authorization');
  const hasBasicHeader = Boolean(authHeader && /^\s*Basic\s+/i.test(authHeader));

  const bodyClientId = bodyParams.get('client_id')?.trim();
  const bodyClientSecret = bodyParams.get('client_secret');

  // RFC 6749 Section 2.3: The client MUST NOT use more than one authentication method in each request.
  if (hasBasicHeader && (bodyClientId || bodyClientSecret !== null)) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_client',
      errorDescription: 'Multiple client authentication methods attempted'
    };
  }

  let clientId: string | null = null;
  let clientSecret: string | undefined = undefined;
  let authMethod: 'none' | 'client_secret_post' | 'client_secret_basic' = 'none';

  if (hasBasicHeader && authHeader) {
    authMethod = 'client_secret_basic';
    const match = authHeader.match(/^\s*Basic\s+(.+)$/i);
    if (!match) {
      return {
        ok: false,
        status: 401,
        error: 'invalid_client',
        errorDescription: 'Invalid Basic authentication header',
        headers: { 'www-authenticate': 'Basic realm="OAuth"' }
      };
    }

    // Canonical Base64 only: the standard alphabet, correct padding, and no internal
    // whitespace. Node's decoder accepts all three deviations and would let one credential
    // be spelled many ways; the round-trip check below rejects the rest.
    const credentials = match[1].trim();
    if (
      credentials.length === 0 ||
      credentials.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(credentials)
    ) {
      return {
        ok: false,
        status: 401,
        error: 'invalid_client',
        errorDescription: 'Invalid Basic authentication header',
        headers: { 'www-authenticate': 'Basic realm="OAuth"' }
      };
    }

    const buf = Buffer.from(credentials, 'base64');
    if (buf.toString('base64') !== credentials) {
      return {
        ok: false,
        status: 401,
        error: 'invalid_client',
        errorDescription: 'Invalid Basic authentication header',
        headers: { 'www-authenticate': 'Basic realm="OAuth"' }
      };
    }

    const decoded = buf.toString('utf-8');
    if (CONTROL_CHAR_PATTERN.test(decoded)) {
      return {
        ok: false,
        status: 401,
        error: 'invalid_client',
        errorDescription: 'Invalid client credentials',
        headers: { 'www-authenticate': 'Basic realm="OAuth"' }
      };
    }

    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
      return {
        ok: false,
        status: 401,
        error: 'invalid_client',
        errorDescription: 'Invalid Basic authentication format',
        headers: { 'www-authenticate': 'Basic realm="OAuth"' }
      };
    }

    const rawId = decoded.slice(0, colonIndex);
    const rawSecret = decoded.slice(colonIndex + 1);

    const parsedId = strictFormUrlDecode(rawId);
    const parsedSecret = strictFormUrlDecode(rawSecret);

    if (parsedId === null || parsedSecret === null || parsedId.length === 0) {
      return {
        ok: false,
        status: 401,
        error: 'invalid_client',
        errorDescription: 'Invalid client credentials',
        headers: { 'www-authenticate': 'Basic realm="OAuth"' }
      };
    }

    clientId = parsedId;
    clientSecret = parsedSecret;
  } else if (bodyClientId) {
    if (CONTROL_CHAR_PATTERN.test(bodyClientId) || (bodyClientSecret && CONTROL_CHAR_PATTERN.test(bodyClientSecret))) {
      return {
        ok: false,
        status: 401,
        error: 'invalid_client',
        errorDescription: 'Invalid client credentials'
      };
    }
    clientId = bodyClientId;
    if (bodyClientSecret !== null) {
      clientSecret = bodyClientSecret;
      authMethod = 'client_secret_post';
    } else {
      authMethod = 'none';
    }
  }

  if (!clientId) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_client',
      errorDescription: 'Missing client credentials',
      headers: authMethod === 'client_secret_basic' ? { 'www-authenticate': 'Basic realm="OAuth"' } : undefined
    };
  }

  const client = await clientService.findActive(clientId);
  if (!client) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_client',
      errorDescription: 'Client authentication failed',
      headers: authMethod === 'client_secret_basic' ? { 'www-authenticate': 'Basic realm="OAuth"' } : undefined
    };
  }

  // Public clients must NOT have a secret
  if (client.publicClient) {
    if (clientSecret !== undefined && clientSecret !== '') {
      return {
        ok: false,
        status: 401,
        error: 'invalid_client',
        errorDescription: 'Public clients must not provide a client_secret',
        headers: authMethod === 'client_secret_basic' ? { 'www-authenticate': 'Basic realm="OAuth"' } : undefined
      };
    }
    return {
      ok: true,
      client,
      authMethod: 'none'
    };
  }

  // Confidential clients MUST provide a matching secret
  if (!clientSecret) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_client',
      errorDescription: 'Missing client secret for confidential client',
      headers: authMethod === 'client_secret_basic' ? { 'www-authenticate': 'Basic realm="OAuth"' } : undefined
    };
  }

  const authenticated = await clientService.authenticate(clientId, clientSecret);
  if (!authenticated) {
    return {
      ok: false,
      status: 401,
      error: 'invalid_client',
      errorDescription: 'Client authentication failed',
      headers: authMethod === 'client_secret_basic' ? { 'www-authenticate': 'Basic realm="OAuth"' } : undefined
    };
  }

  return {
    ok: true,
    client: authenticated,
    clientSecret,
    authMethod
  };
}
