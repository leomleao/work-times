import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { ADMIN_SESSION_COOKIE, verifyCsrfToken } from '$lib/server/security/http';

export const load: PageServerLoad = async ({ locals }) => {
  if (locals.admin) {
    throw redirect(303, '/admin');
  }
  return {};
};

function safeAdminRedirect(target: unknown): string {
  if (
    typeof target === 'string' &&
    target.startsWith('/admin') &&
    !target.startsWith('//') &&
    !target.includes('\\')
  ) {
    return target;
  }
  return '/admin';
}

export const actions: Actions = {
  default: async ({ request, url, cookies, getClientAddress }) => {
    let clientIp = '127.0.0.1';
    try {
      clientIp = getClientAddress();
    } catch {}

    if (!runtime.loginLimiter.allow(clientIp)) {
      return fail(429, { error: 'Too many login attempts. Please try again later.' });
    }

    const formData = await request.formData();
    const username = String(formData.get('username') ?? '').trim();
    const password = String(formData.get('password') ?? '');

    if (!username || !password) {
      return fail(400, { error: 'Invalid username or password' });
    }

    const authResult = await runtime.adminAuth.login(username, password);
    if (!authResult) {
      return fail(400, { error: 'Invalid username or password' });
    }

    runtime.loginLimiter.clear(clientIp);

    cookies.set(ADMIN_SESSION_COOKIE, authResult.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: runtime.config.cookieSecure,
      maxAge: 30 * 24 * 60 * 60
    });

    const target = safeAdminRedirect(url.searchParams.get('redirectTo') ?? formData.get('redirectTo'));
    throw redirect(303, target);
  },

  logout: async ({ locals, cookies, request }) => {
    if (locals.sessionToken) {
      let submittedCsrf: string | null = request.headers.get('x-csrf-token');
      if (!submittedCsrf) {
        try {
          const formData = await request.formData();
          submittedCsrf = (formData.get('csrfToken') || formData.get('csrf_token')) as string | null;
        } catch {}
      }
      if (!verifyCsrfToken(submittedCsrf, locals.sessionToken, runtime.sessionSecret)) {
        return fail(403, { error: 'Invalid or missing CSRF token' });
      }
      await runtime.adminAuth.logout(locals.sessionToken);
    }
    cookies.delete(ADMIN_SESSION_COOKIE, { path: '/' });
    throw redirect(303, '/login');
  }
};
