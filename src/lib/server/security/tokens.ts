import { createHash, randomBytes } from 'node:crypto';

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export function generateOpaqueToken(prefix: string): { token: string; hash: string } {
  if (!/^[a-z][a-z0-9_]{1,15}$/.test(prefix)) throw new Error('Invalid token prefix');
  const token = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashOpaqueToken(token) };
}
