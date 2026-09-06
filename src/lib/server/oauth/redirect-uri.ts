const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function normalizeRedirectUri(value: string): string {
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error('Redirect URI must be an absolute URL');
  }

  if (uri.username || uri.password) throw new Error('Redirect URI must not contain user info');
  if (uri.hash) throw new Error('Redirect URI must not contain a fragment');
  if (uri.hostname.includes('*')) throw new Error('Redirect URI must not contain wildcards');

  const isLoopback = LOOPBACK_HOSTS.has(uri.hostname);
  if (uri.protocol !== 'https:' && !(uri.protocol === 'http:' && isLoopback)) {
    throw new Error('Redirect URI must use HTTPS, except for loopback development clients');
  }

  return uri.href;
}

export function redirectUriMatches(requested: string, registered: readonly string[]): boolean {
  let normalized: string;
  try {
    normalized = normalizeRedirectUri(requested);
  } catch {
    return false;
  }

  return registered.some((candidate) => {
    try {
      return normalizeRedirectUri(candidate) === normalized;
    } catch {
      return false;
    }
  });
}
