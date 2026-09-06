import { json, redirect, type Handle } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';
import {
  ADMIN_SESSION_COOKIE,
  csrfTokenForSession,
  requestHasTrustedOrigin,
  setSecurityHeaders,
  verifyCsrfToken
} from '$lib/server/security/http';
import { _safeRedirect as safeRedirect } from './routes/login/+page.server';

export const handle: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;
  const method = event.request.method.toUpperCase();

  // 1. Session authentication via cookie
  const sessionToken = event.cookies.get(ADMIN_SESSION_COOKIE);
  if (sessionToken) {
    const principal = await runtime.adminAuth.authenticate(sessionToken);
    if (principal) {
      event.locals.admin = principal;
      event.locals.sessionToken = sessionToken;
      event.locals.csrfToken = csrfTokenForSession(sessionToken, runtime.sessionSecret);
    } else {
      event.locals.admin = null;
      event.locals.sessionToken = null;
      event.locals.csrfToken = null;
      event.cookies.delete(ADMIN_SESSION_COOKIE, { path: '/' });
    }
  } else {
    event.locals.admin = null;
    event.locals.sessionToken = null;
    event.locals.csrfToken = null;
  }

  // 2. Route protection for /admin and /api/admin
  const isAdminApi = pathname === '/api/admin' || pathname.startsWith('/api/admin/');
  const isAdminPage = pathname === '/admin' || pathname.startsWith('/admin/');

  if (!event.locals.admin) {
    if (isAdminApi) {
      const response = json({ error: 'Unauthorized' }, { status: 401 });
      setSecurityHeaders(response.headers);
      return response;
    }
    if (isAdminPage) {
      throw redirect(303, '/login');
    }
  }

  // Redirect authenticated user navigating to /login back to safe redirectTo or /admin
  if (event.locals.admin && pathname === '/login' && method === 'GET') {
    const target = safeRedirect(event.url.searchParams.get('redirectTo'));
    throw redirect(303, target);
  }

  // 3. Browser mutation validation
  // Validate exact PUBLIC_URL Origin for every browser mutation and require the HMAC session-bound CSRF token.
  // Exempt non-browser protocol endpoints (token, revoke, register) and MCP from browser Origin/CSRF enforcement.
  const isMcp = pathname === '/mcp' || pathname.startsWith('/mcp/');
  const isOAuthProtocol =
    pathname === '/oauth/token' ||
    pathname === '/oauth/revoke' ||
    pathname === '/oauth/register';
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  if (isMutation && !isMcp && !isOAuthProtocol) {
    if (!requestHasTrustedOrigin(event.request, runtime.config.publicUrl)) {
      const response = json({ error: 'Cross-origin request rejected' }, { status: 403 });
      setSecurityHeaders(response.headers);
      return response;
    }

    if (event.locals.sessionToken) {
      let submittedCsrf: string | null = event.request.headers.get('x-csrf-token');
      if (!submittedCsrf) {
        try {
          const contentType = event.request.headers.get('content-type') || '';
          if (
            contentType.includes('application/x-www-form-urlencoded') ||
            contentType.includes('multipart/form-data')
          ) {
            const formData = await event.request.clone().formData();
            submittedCsrf = (formData.get('csrfToken') || formData.get('csrf_token') || formData.get('_csrf')) as string | null;
          } else if (contentType.includes('application/json')) {
            const body = await event.request.clone().json();
            submittedCsrf = body?.csrfToken || body?.csrf_token;
          }
        } catch {}
      }

      if (!verifyCsrfToken(submittedCsrf, event.locals.sessionToken, runtime.sessionSecret)) {
        const response = json({ error: 'Invalid or missing CSRF token' }, { status: 403 });
        setSecurityHeaders(response.headers);
        return response;
      }
    }
  }

  const response = await resolve(event);
  setSecurityHeaders(response.headers);
  return response;
};
