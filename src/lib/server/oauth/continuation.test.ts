import { describe, expect, it } from 'vitest';
import { MAX_CONTINUATION_BYTES, safeLoginRedirect } from './continuation';

describe('safeLoginRedirect', () => {
  it('permits /admin and its subpaths, with or without a query', () => {
    expect(safeLoginRedirect('/admin')).toBe('/admin');
    expect(safeLoginRedirect('/admin/oauth-clients')).toBe('/admin/oauth-clients');
    expect(safeLoginRedirect('/admin/api-keys?sort=name')).toBe('/admin/api-keys?sort=name');
    expect(safeLoginRedirect('/admin?tab=activity')).toBe('/admin?tab=activity');
  });

  it('permits /oauth/authorize only when it carries a query string', () => {
    const target = '/oauth/authorize?client_id=abc&response_type=code';
    expect(safeLoginRedirect(target)).toBe(target);

    expect(safeLoginRedirect('/oauth/authorize')).toBe('/admin');
    expect(safeLoginRedirect('/oauth/authorize?')).toBe('/admin');
  });

  it('rejects /oauth/authorize subpaths even when they carry a query', () => {
    expect(safeLoginRedirect('/oauth/authorize/callback?client_id=abc')).toBe('/admin');
    expect(safeLoginRedirect('/oauth/authorize/')).toBe('/admin');
    expect(safeLoginRedirect('/oauth/token?client_id=abc')).toBe('/admin');
    expect(safeLoginRedirect('/oauth/register?x=1')).toBe('/admin');
  });

  it('returns the permitted target byte-for-byte so opaque state survives', () => {
    const state = 'aB+/=%20 ünïcode~!*()';
    const target = `/oauth/authorize?client_id=abc&state=${encodeURIComponent(state)}`;
    expect(safeLoginRedirect(target)).toBe(target);

    // Percent-encoding is neither normalised nor re-encoded.
    expect(safeLoginRedirect('/admin/x?a=%2Fb%2Bc')).toBe('/admin/x?a=%2Fb%2Bc');
  });

  it('rejects alternate origins, schemes, and embedded credentials', () => {
    expect(safeLoginRedirect('https://evil.com/admin')).toBe('/admin');
    expect(safeLoginRedirect('http://localhost:3002/admin')).toBe('/admin');
    expect(safeLoginRedirect('https://evil.com/oauth/authorize?x=1')).toBe('/admin');
    expect(safeLoginRedirect('javascript:alert(1)')).toBe('/admin');
    expect(safeLoginRedirect('data:text/html,<script>')).toBe('/admin');
    expect(safeLoginRedirect('http://user:pass@localhost:3002/admin')).toBe('/admin');
  });

  it('rejects authority overrides spelled with slashes or backslashes', () => {
    expect(safeLoginRedirect('//evil.com')).toBe('/admin');
    expect(safeLoginRedirect('//evil.com/admin')).toBe('/admin');
    expect(safeLoginRedirect('/\\evil.com')).toBe('/admin');
    expect(safeLoginRedirect('\\\\evil.com')).toBe('/admin');
    expect(safeLoginRedirect('/admin\\evil')).toBe('/admin');
    expect(safeLoginRedirect('/oauth/authorize\\evil?x=1')).toBe('/admin');
    expect(safeLoginRedirect('/admin//evil')).toBe('/admin');
  });

  it('rejects fragments, including one appended to an otherwise valid target', () => {
    expect(safeLoginRedirect('/admin#frag')).toBe('/admin');
    expect(safeLoginRedirect('/admin/settings?a=1#frag')).toBe('/admin');
    expect(safeLoginRedirect('/oauth/authorize?client_id=abc#frag')).toBe('/admin');
  });

  it('rejects control characters used to split or truncate the target', () => {
    for (const control of ['\u0000', '\r', '\n', '\t', '\u001f', '\u007f', '\u009f']) {
      expect(safeLoginRedirect(`/admin${control}evil`)).toBe('/admin');
      expect(safeLoginRedirect(`/oauth/authorize?a=1${control}`)).toBe('/admin');
    }
  });

  it('rejects traversal that escapes the permitted prefixes', () => {
    expect(safeLoginRedirect('/admin/../../evil')).toBe('/admin');
    expect(safeLoginRedirect('/admin/..')).toBe('/admin');
    expect(safeLoginRedirect('/oauth/authorize/../../evil?x=1')).toBe('/admin');
    expect(safeLoginRedirect('/admin%2f..%2fevil')).toBe('/admin');
  });

  it('rejects unrelated paths and non-string or empty input', () => {
    expect(safeLoginRedirect('/')).toBe('/admin');
    expect(safeLoginRedirect('/api/health')).toBe('/admin');
    expect(safeLoginRedirect('/mcp')).toBe('/admin');
    expect(safeLoginRedirect('/administrator')).toBe('/admin');
    expect(safeLoginRedirect('admin')).toBe('/admin');
    expect(safeLoginRedirect('')).toBe('/admin');
    expect(safeLoginRedirect(null)).toBe('/admin');
    expect(safeLoginRedirect(undefined)).toBe('/admin');
    expect(safeLoginRedirect(42)).toBe('/admin');
    expect(safeLoginRedirect(['/admin'])).toBe('/admin');
  });

  it('bounds the target by bytes, not characters', () => {
    const atBound = `/admin?q=${'a'.repeat(MAX_CONTINUATION_BYTES - '/admin?q='.length)}`;
    expect(Buffer.byteLength(atBound, 'utf8')).toBe(MAX_CONTINUATION_BYTES);
    expect(safeLoginRedirect(atBound)).toBe(atBound);

    expect(safeLoginRedirect(`${atBound}a`)).toBe('/admin');
    // Multi-byte characters count for their encoded size.
    expect(safeLoginRedirect(`/admin?q=${'é'.repeat(MAX_CONTINUATION_BYTES)}`)).toBe('/admin');
  });
});
