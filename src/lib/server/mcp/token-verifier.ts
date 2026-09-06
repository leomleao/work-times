import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier
} from '@modelcontextprotocol/server';
import type { ApiKeyService } from '$lib/server/auth/api-keys';
import type { OAuthAuthorizationService } from '$lib/server/oauth/authorization';

export class WorkTimesTokenVerifier implements OAuthTokenVerifier {
  constructor(
    private readonly options: {
      apiKeys: ApiKeyService;
      oauth: OAuthAuthorizationService;
      resource: URL;
      now?: () => Date;
    }
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const now = this.options.now?.() ?? new Date();
    const principal = token.startsWith('wtk_')
      ? await this.options.apiKeys.authenticate(token, [], now)
      : token.startsWith('wat_')
        ? await this.options.oauth.verifyAccessToken(token, [], now, this.options.resource.href)
        : null;

    if (!principal) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token is invalid or expired');
    }

    return {
      token,
      clientId: principal.clientId,
      scopes: [...principal.scopes],
      expiresAt: principal.expiresAt,
      resource: this.options.resource
    };
  }
}
