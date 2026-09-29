import type { AdminPrincipal } from '$lib/server/auth/admin-auth';

declare global {
  namespace App {
    interface Locals {
      admin: AdminPrincipal | null;
      sessionToken: string | null;
      csrfToken: string | null;
      oauthRedirectOrigin?: string;
    }

    interface PageData {
      admin?: AdminPrincipal | null;
      csrfToken?: string | null;
    }
  }
}

export {};
