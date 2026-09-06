import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';
import { generateOpaqueToken, hashOpaqueToken } from './tokens';

describe('credential security', () => {
  it('hashes and verifies an admin password without retaining it', () => {
    const encoded = hashPassword('a-correct-horse-battery-staple');

    expect(encoded).not.toContain('correct-horse');
    expect(verifyPassword('a-correct-horse-battery-staple', encoded)).toBe(true);
    expect(verifyPassword('a-wrong-horse-battery-staple', encoded)).toBe(false);
  });

  it('rejects malformed password hashes without throwing', () => {
    expect(verifyPassword('anything-at-all', 'not-a-valid-hash')).toBe(false);
  });

  it('returns an opaque token only alongside its deterministic digest', () => {
    const generated = generateOpaqueToken('wtk');

    expect(generated.token).toMatch(/^wtk_[A-Za-z0-9_-]+$/);
    expect(generated.hash).toBe(hashOpaqueToken(generated.token));
    expect(generated.hash).not.toContain(generated.token);
  });
});
