import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const COST = 32_768;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 64 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must contain at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
    maxmem: MAX_MEMORY
  });

  return [
    'scrypt',
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString('base64url'),
    digest.toString('base64url')
  ].join('$');
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const [algorithm, cost, blockSize, parallelization, salt, expected] = encoded.split('$');
    if (algorithm !== 'scrypt' || !cost || !blockSize || !parallelization || !salt || !expected) {
      return false;
    }

    const expectedBytes = Buffer.from(expected, 'base64url');
    if (expectedBytes.length !== KEY_LENGTH) return false;

    const actual = scryptSync(password, Buffer.from(salt, 'base64url'), KEY_LENGTH, {
      N: Number.parseInt(cost, 10),
      r: Number.parseInt(blockSize, 10),
      p: Number.parseInt(parallelization, 10),
      maxmem: MAX_MEMORY
    });

    return timingSafeEqual(actual, expectedBytes);
  } catch {
    return false;
  }
}
