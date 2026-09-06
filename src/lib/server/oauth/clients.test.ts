import { describe, expect, it } from 'vitest';
import {
  OAuthClientService,
  type OAuthClientMetadata,
  type OAuthClientRecord,
  type OAuthClientRepository
} from './clients';

class MemoryClients implements OAuthClientRepository {
  records = new Map<string, OAuthClientRecord>();

  insert(record: OAuthClientRecord): void {
    this.records.set(record.clientId, record);
  }

  list(): OAuthClientMetadata[] {
    return [...this.records.values()].map(({ secretHash: _, ...record }) => record);
  }

  find(clientId: string): OAuthClientRecord | null {
    return this.records.get(clientId) ?? null;
  }

  revoke(clientId: string, revokedAt: string): boolean {
    const record = this.records.get(clientId);
    if (!record) return false;
    record.revokedAt = revokedAt;
    return true;
  }
}

describe('OAuth client lifecycle', () => {
  it('returns a confidential secret once and stores only its digest', async () => {
    const repository = new MemoryClients();
    const service = new OAuthClientService(repository);
    const created = await service.register({
      name: 'Desktop timesheet agent',
      publicClient: false,
      redirectUris: ['https://agent.example/oauth/callback'],
      scopes: ['activity:read']
    });
    const stored = repository.records.get(created.metadata.clientId);

    expect(created.clientSecret).toMatch(/^wcs_/);
    expect(stored?.secretHash).not.toContain(created.clientSecret);
    expect(JSON.stringify(await service.list())).not.toContain(created.clientSecret);
    await expect(
      service.authenticate(created.metadata.clientId, created.clientSecret ?? undefined)
    ).resolves.toMatchObject({ clientId: created.metadata.clientId });
    await expect(service.authenticate(created.metadata.clientId, 'wrong-secret')).resolves.toBeNull();
  });

  it('supports public PKCE clients without issuing a client secret', async () => {
    const service = new OAuthClientService(new MemoryClients());
    const created = await service.register({
      name: 'Local agent',
      publicClient: true,
      redirectUris: ['http://127.0.0.1:49152/callback'],
      scopes: 'activity:read operations:read'
    });

    expect(created.clientSecret).toBeNull();
    await expect(service.authenticate(created.metadata.clientId)).resolves.toMatchObject({
      publicClient: true
    });
    await expect(service.authenticate(created.metadata.clientId, 'unexpected')).resolves.toBeNull();
  });

  it('validates redirects and prevents revoked client authentication', async () => {
    const service = new OAuthClientService(new MemoryClients());
    await expect(
      service.register({
        name: 'Unsafe client',
        publicClient: true,
        redirectUris: ['http://agent.example/callback'],
        scopes: ['activity:read']
      })
    ).rejects.toThrow('HTTPS');

    const created = await service.register({
      name: 'Safe client',
      publicClient: true,
      redirectUris: ['https://agent.example/callback'],
      scopes: ['activity:read']
    });
    expect(await service.revoke(created.metadata.clientId)).toBe(true);
    await expect(service.authenticate(created.metadata.clientId)).resolves.toBeNull();
  });
});
