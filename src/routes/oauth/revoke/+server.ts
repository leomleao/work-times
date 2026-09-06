import { json, type RequestHandler } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';
import { authenticateOAuthClient } from '$lib/server/oauth/client-auth';

const PROTOCOL_HEADERS = {
  'cache-control': 'no-store',
  pragma: 'no-cache'
};

export const POST: RequestHandler = async ({ request }) => {
  let formParams = new URLSearchParams();
  const contentType = request.headers.get('content-type') ?? '';

  try {
    if (contentType.toLowerCase().includes('application/json')) {
      const jsonBody = await request.json();
      if (jsonBody && typeof jsonBody === 'object') {
        for (const [key, value] of Object.entries(jsonBody)) {
          if (typeof value === 'string') {
            formParams.set(key, value);
          }
        }
      }
    } else {
      const text = await request.text();
      formParams = new URLSearchParams(text);
    }
  } catch {
    return json(
      {
        error: 'invalid_request',
        error_description: 'Failed to parse request payload'
      },
      { status: 400, headers: PROTOCOL_HEADERS }
    );
  }

  // RFC 7009 Section 2.1: Client authentication is required
  const auth = await authenticateOAuthClient(request, formParams, runtime.oauthClients);
  if (!auth.ok) {
    return json(
      {
        error: auth.error,
        error_description: auth.errorDescription
      },
      {
        status: auth.status,
        headers: {
          ...PROTOCOL_HEADERS,
          ...(auth.headers ?? {})
        }
      }
    );
  }

  const token = formParams.get('token')?.trim();
  if (!token) {
    return json(
      {
        error: 'invalid_request',
        error_description: 'Missing required parameter: token'
      },
      { status: 400, headers: PROTOCOL_HEADERS }
    );
  }

  // Transactionally revoke matching token family; never logs token
  await runtime.oauthAuth.revokeToken({
    token,
    clientId: auth.client.clientId,
    clientSecret: auth.clientSecret
  });

  // RFC 7009 Section 2.2: 200 OK even for unknown or already revoked token
  return new Response(null, {
    status: 200,
    headers: PROTOCOL_HEADERS
  });
};
