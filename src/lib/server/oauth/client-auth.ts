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

export async function authenticateOAuthClient(
  request: Request,
  bodyParams: URLSearchParams,
  clientService: OAuthClientService
): Promise<ClientAuthResult> {
  const authHeader = request.headers.get('authorization');
  const hasBasicHeader = Boolean(authHeader && authHeader.trim().toLowerCase().startsWith('basic '));

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
    const credentials = authHeader.trim().slice(6).trim();
    let decoded: string;
    try {
      decoded = Buffer.from(credentials, 'base64').toString('utf-8');
    } catch {
      return {
        ok: false,
        status: 401,
        error: 'invalid_client',
        errorDescription: 'Invalid Basic authentication header',
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
    try {
      clientId = decodeURIComponent(rawId);
    } catch {
      clientId = rawId;
    }
    try {
      clientSecret = decodeURIComponent(rawSecret);
    } catch {
      clientSecret = rawSecret;
    }
  } else if (bodyClientId) {
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
