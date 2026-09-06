import { generateOpaqueToken, hashOpaqueToken } from '$lib/server/security/tokens';
import { timingSafeEqual } from 'node:crypto';
import { parseScopes, type ApplicationScope } from '$lib/server/auth/scopes';
import { normalizeRedirectUri } from './redirect-uri';

export interface OAuthClientRecord {
  clientId: string;
  name: string;
  publicClient: boolean;
  secretPrefix: string | null;
  secretHash: string | null;
  redirectUris: string[];
  scopes: ApplicationScope[];
  createdAt: string;
  revokedAt: string | null;
}

export type OAuthClientMetadata = Omit<OAuthClientRecord, 'secretHash'>;

export interface OAuthClientRepository {
  insert(record: OAuthClientRecord): void | Promise<void>;
  list(): OAuthClientMetadata[] | Promise<OAuthClientMetadata[]>;
  find(clientId: string): OAuthClientRecord | null | Promise<OAuthClientRecord | null>;
  revoke(clientId: string, revokedAt: string): boolean | Promise<boolean>;
}

export class OAuthClientService {
  constructor(private readonly repository: OAuthClientRepository) {}

  async register(input: {
    name: string;
    publicClient: boolean;
    redirectUris: readonly string[];
    scopes: string | readonly string[];
    now?: Date;
  }): Promise<{ metadata: OAuthClientMetadata; clientSecret: string | null }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 80) throw new Error('OAuth client name must be 2–80 characters');
    if (input.redirectUris.length === 0 || input.redirectUris.length > 10) {
      throw new Error('OAuth client requires between 1 and 10 redirect URIs');
    }

    const redirectUris = [...new Set(input.redirectUris.map(normalizeRedirectUri))];
    const scopes = parseScopes(input.scopes);
    if (scopes.length === 0) throw new Error('OAuth client requires at least one scope');

    const clientId = generateOpaqueToken('woc').token;
    const generatedSecret = input.publicClient ? null : generateOpaqueToken('wcs');
    const record: OAuthClientRecord = {
      clientId,
      name,
      publicClient: input.publicClient,
      secretPrefix: generatedSecret?.token.slice(0, 12) ?? null,
      secretHash: generatedSecret?.hash ?? null,
      redirectUris,
      scopes,
      createdAt: (input.now ?? new Date()).toISOString(),
      revokedAt: null
    };
    await this.repository.insert(record);
    const { secretHash: _, ...metadata } = record;
    return { metadata, clientSecret: generatedSecret?.token ?? null };
  }

  list(): Promise<OAuthClientMetadata[]> {
    return Promise.resolve(this.repository.list());
  }

  async findActive(clientId: string): Promise<OAuthClientRecord | null> {
    const record = await this.repository.find(clientId);
    return record && !record.revokedAt ? record : null;
  }

  async authenticate(clientId: string, clientSecret?: string): Promise<OAuthClientRecord | null> {
    const record = await this.repository.find(clientId);
    if (!record || record.revokedAt) return null;
    if (record.publicClient) return clientSecret ? null : record;
    if (!clientSecret || !record.secretHash) return null;
    const actual = Buffer.from(hashOpaqueToken(clientSecret), 'ascii');
    const expected = Buffer.from(record.secretHash, 'ascii');
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? record : null;
  }

  revoke(clientId: string, now = new Date()): Promise<boolean> {
    return Promise.resolve(this.repository.revoke(clientId, now.toISOString()));
  }
}
