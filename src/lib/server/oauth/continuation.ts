/**
 * Safe post-login continuation targets.
 *
 * A continuation is the relative path the browser is sent to once an admin has
 * authenticated. It is attacker-influenced (it arrives as `?redirectTo=`), so it is
 * validated against an allow-list of exactly two destinations rather than sanitised.
 */

const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f-\x9f]/;

/** Parsing base used only to reject anything that is not a strictly relative path. */
const RELATIVE_BASE = 'http://continuation.invalid';

/** Fallback destination for every rejected continuation. */
export const DEFAULT_CONTINUATION = '/admin';

/** Upper bound on a continuation target, in bytes. */
export const MAX_CONTINUATION_BYTES = 4096;

/**
 * Validates a post-login continuation target.
 *
 * Permits exactly:
 * - `/admin`, `/admin?<query>` and `/admin/<subpath>` (with optional query)
 * - `/oauth/authorize?<query>` — the authorization endpoint, which is meaningless
 *   without its request parameters
 *
 * Everything else resolves to `/admin`, including alternate origins and schemes,
 * protocol-relative and backslash authority tricks, embedded credentials, fragments,
 * control characters, `/oauth/authorize` subpaths, `/oauth/authorize` without a query,
 * and any traversal that escapes the permitted prefixes.
 *
 * A permitted target is returned byte-for-byte so that opaque query values (notably
 * the OAuth `state` parameter) survive the login round trip unchanged.
 */
export function safeLoginRedirect(target: unknown): string {
  if (typeof target !== 'string' || target.length === 0) {
    return DEFAULT_CONTINUATION;
  }

  if (Buffer.byteLength(target, 'utf8') > MAX_CONTINUATION_BYTES) {
    return DEFAULT_CONTINUATION;
  }

  // Authority overrides (`//host`, `/\host`), fragments, and control characters are
  // rejected before parsing: URL parsing would silently normalise some of them away.
  if (
    target.includes('\\') ||
    target.includes('//') ||
    target.includes('#') ||
    CONTROL_CHAR_PATTERN.test(target)
  ) {
    return DEFAULT_CONTINUATION;
  }

  const isAdminTarget =
    target === '/admin' || target.startsWith('/admin/') || target.startsWith('/admin?');
  // `/oauth/authorize` is only ever a continuation together with its request parameters,
  // so the bare path and every subpath below it are rejected.
  const isAuthorizeTarget = target.startsWith('/oauth/authorize?');

  if (!isAdminTarget && !isAuthorizeTarget) {
    return DEFAULT_CONTINUATION;
  }

  let parsed: URL;
  try {
    parsed = new URL(target, RELATIVE_BASE);
  } catch {
    return DEFAULT_CONTINUATION;
  }

  // An alternate origin, embedded credentials, or a fragment means the literal prefix
  // check above was satisfied by something that does not actually resolve there.
  if (parsed.origin !== RELATIVE_BASE || parsed.username || parsed.password || parsed.hash) {
    return DEFAULT_CONTINUATION;
  }

  const { pathname } = parsed;

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return target;
  }

  if (pathname === '/oauth/authorize' && parsed.search.length > 1) {
    return target;
  }

  return DEFAULT_CONTINUATION;
}
