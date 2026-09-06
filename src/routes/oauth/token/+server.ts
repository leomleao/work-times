import { json, type RequestHandler } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';
import { authenticateOAuthClient } from '$lib/server/oauth/client-auth';
import { OAuthTokenReuseError } from '$lib/server/oauth/authorization';
import { readAndValidateFormBody, PROTOCOL_HEADERS } from '$lib/server/oauth/form';

export const POST: RequestHandler = async ({ request }) => {
  const parsedForm = await readAndValidateFormBody(request);
  if (!parsedForm.ok) {
    return parsedForm.response;
  }

  const formParams = parsedForm.params;

  // Authenticate the client (public or confidential: client_secret_post / client_secret_basic)
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

  const grantType = formParams.get('grant_type');

  if (grantType === 'authorization_code') {
    const code = formParams.get('code')?.trim();
    const redirectUri = formParams.get('redirect_uri')?.trim();
    const codeVerifier = formParams.get('code_verifier')?.trim();
    const resource = formParams.get('resource')?.trim() || new URL('/mcp', runtime.config.publicUrl).href;

    if (!code || !redirectUri || !codeVerifier) {
      return json(
        {
          error: 'invalid_request',
          error_description: 'Missing required parameters for authorization_code grant'
        },
        { status: 400, headers: PROTOCOL_HEADERS }
      );
    }

    try {
      const tokens = await runtime.oauthAuth.exchangeAuthorizationCode({
        code,
        clientId: auth.client.clientId,
        clientSecret: auth.clientSecret,
        redirectUri,
        resource,
        codeVerifier
      });

      if (!tokens) {
        return json(
          {
            error: 'invalid_grant',
            error_description: 'Invalid, expired, or revoked authorization code'
          },
          { status: 400, headers: PROTOCOL_HEADERS }
        );
      }

      return json(
        {
          access_token: tokens.accessToken,
          token_type: tokens.tokenType,
          expires_in: tokens.expiresIn,
          refresh_token: tokens.refreshToken,
          scope: tokens.scope
        },
        { status: 200, headers: PROTOCOL_HEADERS }
      );
    } catch {
      return json(
        {
          error: 'invalid_grant',
          error_description: 'Invalid, expired, or revoked authorization code'
        },
        { status: 400, headers: PROTOCOL_HEADERS }
      );
    }
  }

  if (grantType === 'refresh_token') {
    const refreshToken = formParams.get('refresh_token')?.trim();
    const resource = formParams.get('resource')?.trim() || new URL('/mcp', runtime.config.publicUrl).href;

    if (!refreshToken) {
      return json(
        {
          error: 'invalid_request',
          error_description: 'Missing refresh_token parameter'
        },
        { status: 400, headers: PROTOCOL_HEADERS }
      );
    }

    try {
      const tokens = await runtime.oauthAuth.refresh({
        refreshToken,
        clientId: auth.client.clientId,
        clientSecret: auth.clientSecret,
        resource
      });

      if (!tokens) {
        return json(
          {
            error: 'invalid_grant',
            error_description: 'Invalid, expired, or revoked refresh token'
          },
          { status: 400, headers: PROTOCOL_HEADERS }
        );
      }

      return json(
        {
          access_token: tokens.accessToken,
          token_type: tokens.tokenType,
          expires_in: tokens.expiresIn,
          refresh_token: tokens.refreshToken,
          scope: tokens.scope
        },
        { status: 200, headers: PROTOCOL_HEADERS }
      );
    } catch (err) {
      if (err instanceof OAuthTokenReuseError) {
        return json(
          {
            error: 'invalid_grant',
            error_description: 'Invalid, expired, or revoked refresh token'
          },
          { status: 400, headers: PROTOCOL_HEADERS }
        );
      }
      return json(
        {
          error: 'invalid_grant',
          error_description: 'Invalid, expired, or revoked refresh token'
        },
        { status: 400, headers: PROTOCOL_HEADERS }
      );
    }
  }

  return json(
    {
      error: 'unsupported_grant_type',
      error_description: 'The authorization grant type is not supported'
    },
    { status: 400, headers: PROTOCOL_HEADERS }
  );
};
