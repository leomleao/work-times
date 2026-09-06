import { createHash, timingSafeEqual } from 'node:crypto';

const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isValidPkceVerifier(value: string): boolean {
  return VERIFIER_PATTERN.test(value);
}

export function createS256Challenge(verifier: string): string {
  if (!isValidPkceVerifier(verifier)) throw new Error('Invalid PKCE code verifier');
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function verifyS256Challenge(verifier: string, challenge: string): boolean {
  if (!isValidPkceVerifier(verifier) || !CHALLENGE_PATTERN.test(challenge)) return false;
  const actual = Buffer.from(createS256Challenge(verifier), 'ascii');
  const expected = Buffer.from(challenge, 'ascii');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
