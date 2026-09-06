import { randomUUID } from 'node:crypto';
import { generateOpaqueToken, hashOpaqueToken } from '$lib/server/security/tokens';
import { hasRequiredScopes, parseScopes, type ApplicationScope } from './scopes';

export interface ApiKeyRecord {
  id: string;
  name: string;
  tokenPrefix: string;
  tokenHash: string;
  scopes: ApplicationScope[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type ApiKeyMetadata = Omit<ApiKeyRecord, 'tokenHash'>;

export interface ApiKeyRepository {
  insert(record: ApiKeyRecord): void | Promise<void>;
  list(): ApiKeyMetadata[] | Promise<ApiKeyMetadata[]>;
  findByTokenHash(tokenHash: string): ApiKeyRecord | null | Promise<ApiKeyRecord | null>;
  touch(id: string, lastUsedAt: string): void | Promise<void>;
  revoke(id: string, revokedAt: string): boolean | Promise<boolean>;
}

export interface ApiKeyPrincipal {
  clientId: string;
  scopes: ApplicationScope[];
  expiresAt: number;
}

export class ApiKeyService {
  constructor(private readonly repository: ApiKeyRepository) {}

  async create(input: {
    name: string;
    scopes: string | readonly string[];
    expiresAt?: Date | null;
    now?: Date;
  }): Promise<{ token: string; metadata: ApiKeyMetadata }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 80) throw new Error('API key name must be 2–80 characters');
    const scopes = parseScopes(input.scopes);
    if (scopes.length === 0) throw new Error('At least one scope is required');

    const now = input.now ?? new Date();
    if (input.expiresAt && input.expiresAt <= now) throw new Error('API key expiry must be in the future');

    const generated = generateOpaqueToken('wtk');
    const record: ApiKeyRecord = {
      id: randomUUID(),
      name,
      tokenPrefix: generated.token.slice(0, 12),
      tokenHash: generated.hash,
      scopes,
      createdAt: now.toISOString(),
      expiresAt: input.expiresAt?.toISOString() ?? null,
      lastUsedAt: null,
      revokedAt: null
    };
    await this.repository.insert(record);
    const { tokenHash: _, ...metadata } = record;
    return { token: generated.token, metadata };
  }

  list(): Promise<ApiKeyMetadata[]> {
    return Promise.resolve(this.repository.list());
  }

  async authenticate(
    token: string,
    requiredScopes: readonly ApplicationScope[],
    now = new Date()
  ): Promise<ApiKeyPrincipal | null> {
    const record = await this.repository.findByTokenHash(hashOpaqueToken(token));
    if (!record || record.revokedAt) return null;
    if (record.expiresAt && record.expiresAt <= now.toISOString()) return null;
    if (!hasRequiredScopes(record.scopes, requiredScopes)) return null;

    await this.repository.touch(record.id, now.toISOString());
    return {
      clientId: record.id,
      scopes: [...record.scopes],
      // The MCP SDK requires an explicit expiry. Non-expiring local keys get a
      // bounded verifier horizon and are rechecked against SQLite per request.
      expiresAt: record.expiresAt
        ? Math.floor(new Date(record.expiresAt).getTime() / 1000)
        : Math.floor(now.getTime() / 1000) + 300
    };
  }

  revoke(id: string, now = new Date()): Promise<boolean> {
    return Promise.resolve(this.repository.revoke(id, now.toISOString()));
  }
}
