import { describe, expect, it } from 'vitest';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata';

describe('OAuth discovery metadata', () => {
  const publicUrl = new URL('https://work-times.home');

  it('describes the path-specific MCP protected resource', () => {
    expect(protectedResourceMetadata(publicUrl)).toEqual({
      resource: 'https://work-times.home/mcp',
      authorization_servers: ['https://work-times.home'],
      scopes_supported: ['activity:read', 'activity:detail', 'operations:read'],
      bearer_methods_supported: ['header']
    });
  });

  it('advertises authorization code plus refresh with S256 only', () => {
    const metadata = authorizationServerMetadata(publicUrl);
    expect(metadata.issuer).toBe('https://work-times.home');
    expect(metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.token_endpoint_auth_methods_supported).toContain('none');
  });
});
