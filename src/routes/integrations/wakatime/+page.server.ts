import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';

const RESULT_MESSAGES: Record<string, { tone: 'safe' | 'danger' | 'info'; text: string }> = {
  connected: { tone: 'safe', text: 'WakaTime is connected and its tokens are stored encrypted.' },
  disconnected: { tone: 'info', text: 'The WakaTime connection was revoked and removed.' },
  denied: { tone: 'info', text: 'WakaTime authorization was cancelled.' },
  'invalid-state': { tone: 'danger', text: 'The OAuth response could not be verified. Start the connection again.' },
  'missing-code': { tone: 'danger', text: 'WakaTime did not return an authorization code.' },
  'exchange-failed': { tone: 'danger', text: 'WakaTime could not be connected. Check the registered callback and app credentials.' },
  'not-configured': { tone: 'danger', text: 'Configure the WakaTime App ID, App Secret, and persistent session secret first.' }
};

export const load: PageServerLoad = async ({ locals, url }) => {
  const status = runtime.wakatimeOAuth.status();
  return {
    status,
    isAdmin: Boolean(locals.admin),
    csrfToken: locals.csrfToken,
    result: RESULT_MESSAGES[url.searchParams.get('result') ?? ''] ?? null
  };
};

export const actions: Actions = {
  disconnect: async ({ locals }) => {
    if (!locals.admin) return fail(401, { error: 'Administrator sign-in required' });
    try {
      await runtime.wakatimeOAuth.disconnect();
    } catch {
      return fail(502, { error: 'WakaTime did not accept the revocation request. The local connection was kept.' });
    }
    throw redirect(303, '/integrations/wakatime?result=disconnected');
  }
};
