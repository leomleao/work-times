import { APPLICATION_SCOPES } from '$lib/server/auth/scopes';

function endpoint(base: URL, path: string): string {
  return new URL(path, base).href;
}

export function protectedResourceMetadata(publicUrl: URL) {
  return {
    resource: endpoint(publicUrl, '/mcp'),
    authorization_servers: [publicUrl.origin],
    scopes_supported: [...APPLICATION_SCOPES],
    bearer_methods_supported: ['header']
  };
}

export function authorizationServerMetadata(publicUrl: URL) {
  return {
    issuer: publicUrl.origin,
    authorization_endpoint: endpoint(publicUrl, '/oauth/authorize'),
    token_endpoint: endpoint(publicUrl, '/oauth/token'),
    registration_endpoint: endpoint(publicUrl, '/oauth/register'),
    revocation_endpoint: endpoint(publicUrl, '/oauth/revoke'),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [...APPLICATION_SCOPES]
  };
}
