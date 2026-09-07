import { timingSafeEqual } from 'node:crypto';
import { redirect, type RequestHandler } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';
import { WAKATIME_OAUTH_STATE_COOKIE } from '$lib/server/wakatime/oauth-state';

function statesMatch(expected: string | undefined, received: string | null): boolean {
  if (!expected || !received) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const GET: RequestHandler = async ({ locals, cookies, url }) => {
  const expectedState = cookies.get(WAKATIME_OAUTH_STATE_COOKIE);
  cookies.delete(WAKATIME_OAUTH_STATE_COOKIE, { path: '/oauth/wakatime' });

  if (!locals.admin) {
    throw redirect(303, '/login?redirectTo=%2Fintegrations%2Fwakatime');
  }

  if (url.searchParams.has('error')) {
    throw redirect(303, '/integrations/wakatime?result=denied');
  }

  if (!statesMatch(expectedState, url.searchParams.get('state'))) {
    throw redirect(303, '/integrations/wakatime?result=invalid-state');
  }

  const code = url.searchParams.get('code');
  if (!code) {
    throw redirect(303, '/integrations/wakatime?result=missing-code');
  }

  try {
    await runtime.wakatimeOAuth.exchangeCode(code);
    throw redirect(303, '/integrations/wakatime?result=connected');
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) throw error;
    throw redirect(303, '/integrations/wakatime?result=exchange-failed');
  }
};
