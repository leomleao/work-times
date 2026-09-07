import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_SESSION_COOKIE = 'work_times_session';

function sameBytes(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Bind the browser CSRF token to the opaque, HttpOnly session without storing
 * another browser-readable secret in SQLite.
 */
export function csrfTokenForSession(sessionToken: string, sessionSecret: string): string {
  if (!sessionToken || !sessionSecret) throw new Error('Session and CSRF secrets are required');
  return createHmac('sha256', sessionSecret)
    .update('work-times:csrf:v1\0', 'utf8')
    .update(sessionToken, 'utf8')
    .digest('base64url');
}

export function verifyCsrfToken(
  submitted: string | null | undefined,
  sessionToken: string,
  sessionSecret: string
): boolean {
  if (!submitted) return false;
  return sameBytes(submitted, csrfTokenForSession(sessionToken, sessionSecret));
}

/** Require browser mutations to originate from the configured public origin. */
export function requestHasTrustedOrigin(request: Request, publicUrl: URL): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;

  try {
    return new URL(origin).origin === publicUrl.origin;
  } catch {
    return false;
  }
}

export function setSecurityHeaders(headers: Headers): void {
  // SvelteKit emits a nonce-bearing CSP for rendered pages. Preserve it so the
  // inline hydration bootstrap is allowed. Protocol/API responses do not pass
  // through page rendering, so give those a restrictive static fallback.
  if (!headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', [
      "default-src 'self'",
      "base-uri 'none'",
      "connect-src 'self'",
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'"
    ].join('; '));
  }
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  // `no-referrer` makes Chromium serialize the Origin header as `null` on a
  // same-origin HTML form POST, which defeats SvelteKit's origin-based CSRF
  // protection (and our own trusted-origin check). `same-origin` keeps
  // cross-origin navigation private while preserving the real origin for
  // same-origin mutations.
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}
