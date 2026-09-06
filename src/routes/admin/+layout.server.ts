import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  return {
    admin: locals.admin
      ? {
          username: locals.admin.username,
          sessionExpiresAt: locals.admin.sessionExpiresAt
        }
      : null,
    csrfToken: locals.csrfToken
  };
};
