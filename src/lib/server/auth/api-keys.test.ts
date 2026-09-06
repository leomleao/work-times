import { describe, expect, it } from 'vitest';
import {
  ApiKeyService,
  type ApiKeyMetadata,
  type ApiKeyRecord,
  type ApiKeyRepository
} from './api-keys';

class MemoryApiKeys implements ApiKeyRepository {
  records = new Map<string, ApiKeyRecord>();

  insert(record: ApiKeyRecord): void {
    this.records.set(record.id, record);
  }

  list(): ApiKeyMetadata[] {
    return [...this.records.values()].map(({ tokenHash: _, ...record }) => record);
  }

  findByTokenHash(tokenHash: string): ApiKeyRecord | null {
    return [...this.records.values()].find((record) => record.tokenHash === tokenHash) ?? null;
  }

  touch(id: string, lastUsedAt: string): void {
    const record = this.records.get(id);
    if (record) record.lastUsedAt = lastUsedAt;
  }

  revoke(id: string, revokedAt: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    record.revokedAt = revokedAt;
    return true;
  }
}

describe('API key lifecycle', () => {
  it('shows the token once while persisting only a digest and short prefix', async () => {
    const repository = new MemoryApiKeys();
    const service = new ApiKeyService(repository);
    const created = await service.create({ name: 'Timesheet agent', scopes: ['activity:read'] });
    const stored = [...repository.records.values()][0];

    expect(created.token).toMatch(/^wtk_/);
    expect(stored?.tokenHash).not.toContain(created.token);
    expect(stored?.tokenPrefix).toBe(created.token.slice(0, 12));
    expect(JSON.stringify(await service.list())).not.toContain(created.token);
    expect(await service.authenticate(created.token, ['activity:read'])).toMatchObject({
      scopes: ['activity:read']
    });
  });

  it('fails closed for missing scopes, expiry, and revocation', async () => {
    const repository = new MemoryApiKeys();
    const service = new ApiKeyService(repository);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const created = await service.create({
      name: 'Summary only',
      scopes: ['activity:read'],
      expiresAt: new Date('2026-01-02T00:00:00.000Z'),
      now
    });

    await expect(service.authenticate(created.token, ['activity:detail'], now)).resolves.toBeNull();
    await expect(
      service.authenticate(created.token, ['activity:read'], new Date('2026-01-03T00:00:00.000Z'))
    ).resolves.toBeNull();
    expect(await service.revoke(created.metadata.id, now)).toBe(true);
    await expect(service.authenticate(created.token, ['activity:read'], now)).resolves.toBeNull();
  });

  it('rejects empty scopes and past expiries', async () => {
    const service = new ApiKeyService(new MemoryApiKeys());
    await expect(service.create({ name: 'No scope', scopes: [] })).rejects.toThrow('scope');
    await expect(
      service.create({
        name: 'Expired key',
        scopes: ['activity:read'],
        expiresAt: new Date(0),
        now: new Date(1)
      })
    ).rejects.toThrow('future');
  });
});
