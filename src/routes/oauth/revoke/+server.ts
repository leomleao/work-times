import { json, type RequestHandler } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';
import { authenticateOAuthClient } from '$lib/server/oauth/client-auth';
import { readAndValidateFormBody, PROTOCOL_HEADERS } from '$lib/server/oauth/form';

export const POST: RequestHandler = async ({ request }) => {
  const parsedForm = await readAndValidateFormBody(request);
  if (!parsedForm.ok) {
    return parsedForm.response;
  }

  const formParams = parsedForm.params;

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

  const token = formParams.get('token');
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
