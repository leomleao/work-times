import { describe, expect, it } from 'vitest';
import { hasRequiredScopes, parseScopes } from '$lib/server/auth/scopes';
import { createS256Challenge, isValidPkceVerifier, verifyS256Challenge } from './pkce';
import { normalizeRedirectUri, redirectUriMatches } from './redirect-uri';

describe('application scopes', () => {
  it('deduplicates and validates the read-only scope set', () => {
    expect(parseScopes('activity:read activity:detail activity:read')).toEqual([
      'activity:detail',
      'activity:read'
    ]);
    expect(() => parseScopes('archive:write')).toThrow('Unsupported scope');
    expect(hasRequiredScopes(['activity:read'], ['activity:read'])).toBe(true);
    expect(hasRequiredScopes(['activity:read'], ['activity:detail'])).toBe(false);
  });
});

describe('OAuth redirect URIs', () => {
  it('requires HTTPS except for exact loopback hosts', () => {
    expect(normalizeRedirectUri('https://agent.example/callback')).toBe(
      'https://agent.example/callback'
    );
    expect(normalizeRedirectUri('http://127.0.0.1:49152/callback')).toBe(
      'http://127.0.0.1:49152/callback'
    );
    expect(() => normalizeRedirectUri('http://agent.example/callback')).toThrow('HTTPS');
    expect(() => normalizeRedirectUri('http://127.0.0.1.example/callback')).toThrow('HTTPS');
  });

  it('rejects fragments, user info, wildcards, and non-exact matches', () => {
    expect(() => normalizeRedirectUri('https://agent.example/callback#fragment')).toThrow(
      'fragment'
    );
    expect(() => normalizeRedirectUri('https://user@agent.example/callback')).toThrow('user info');
    expect(() => normalizeRedirectUri('https://*.example/callback')).toThrow('wildcards');
    expect(
      redirectUriMatches('https://agent.example/callback/other', [
        'https://agent.example/callback'
      ])
    ).toBe(false);
  });
});

describe('PKCE S256', () => {
  const verifier = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

  it('accepts verifier lengths from 43 through 128 characters', () => {
    expect(verifier).toHaveLength(43);
    expect(isValidPkceVerifier(verifier)).toBe(true);
    expect(isValidPkceVerifier('short')).toBe(false);
  });

  it('verifies S256 challenges in constant-time comparison form', () => {
    const challenge = createS256Challenge(verifier);
    expect(challenge).toHaveLength(43);
    expect(verifyS256Challenge(verifier, challenge)).toBe(true);
    expect(verifyS256Challenge(`${verifier.slice(0, -1)}Z`, challenge)).toBe(false);
  });
});
