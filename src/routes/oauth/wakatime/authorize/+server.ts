import { randomBytes } from 'node:crypto';
import { redirect, type RequestHandler } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';
import { WAKATIME_OAUTH_STATE_COOKIE } from '$lib/server/wakatime/oauth-state';

export const GET: RequestHandler = async ({ locals, cookies }) => {
  if (!locals.admin) {
    throw redirect(303, '/login?redirectTo=%2Foauth%2Fwakatime%2Fauthorize');
  }

  if (!runtime.wakatimeOAuth.ready) {
    throw redirect(303, '/integrations/wakatime?result=not-configured');
  }

  const state = randomBytes(32).toString('base64url');
  cookies.set(WAKATIME_OAUTH_STATE_COOKIE, state, {
    path: '/oauth/wakatime',
    httpOnly: true,
    sameSite: 'lax',
    secure: runtime.config.cookieSecure,
    maxAge: 10 * 60
  });

  throw redirect(303, runtime.wakatimeOAuth.authorizationUrl(state));
};
