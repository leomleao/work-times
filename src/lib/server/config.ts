import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

let localEnvironmentLoaded = false;

export function loadLocalEnvironment(path = resolve('.env')): void {
  if (localEnvironmentLoaded) return;
  localEnvironmentLoaded = true;

  if (path === resolve('.env') && (process.env.NODE_ENV === 'test' || process.env.VITEST)) {
    return;
  }

  if (existsSync(path)) loadEnvFile(path);
}

function optionalSecret(valueName: string, fileName: string): string | null {
  const secretFile = process.env[fileName]?.trim();
  if (secretFile) return readFileSync(secretFile, 'utf8').trim() || null;
  return process.env[valueName]?.trim() || null;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function parsePublicUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PUBLIC_URL must use HTTP or HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('PUBLIC_URL must not contain credentials, a query, or a fragment');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('PUBLIC_URL must be an origin without a path');
  }
  return new URL(url.origin);
}

function configuredBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

export interface RuntimeConfig {
  databasePath: string;
  wakatimeApiKey: string | null;
  wakatimeOAuthClientId: string | null;
  wakatimeOAuthClientSecret: string | null;
  adminUsername: string;
  adminPasswordHash: string | null;
  sessionSecret: string | null;
  publicUrl: URL;
  cookieSecure: boolean;
  maxDirectImportBytes: number;
}

export function getRuntimeConfig(): RuntimeConfig {
  loadLocalEnvironment();
  const publicUrl = parsePublicUrl(process.env.PUBLIC_URL?.trim() || 'http://localhost:3002');
  const sessionSecret = optionalSecret('SESSION_SECRET', 'SESSION_SECRET_FILE');
  if (sessionSecret && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters');
  }

  const rawDatabasePath = process.env.DATABASE_PATH?.trim() || './data/work-times.sqlite';
  const databasePath = rawDatabasePath === ':memory:' ? ':memory:' : resolve(rawDatabasePath);

  return {
    databasePath,
    wakatimeApiKey: optionalSecret('WAKATIME_API_KEY', 'WAKATIME_API_KEY_FILE'),
    wakatimeOAuthClientId: process.env.WAKATIME_OAUTH_CLIENT_ID?.trim() || null,
    wakatimeOAuthClientSecret: optionalSecret(
      'WAKATIME_OAUTH_CLIENT_SECRET',
      'WAKATIME_OAUTH_CLIENT_SECRET_FILE'
    ),
    adminUsername: process.env.ADMIN_USERNAME?.trim() || 'admin',
    adminPasswordHash: optionalSecret('ADMIN_PASSWORD_HASH', 'ADMIN_PASSWORD_HASH_FILE'),
    sessionSecret,
    publicUrl,
    cookieSecure: configuredBoolean('COOKIE_SECURE', publicUrl.protocol === 'https:'),
    maxDirectImportBytes: positiveInteger('MAX_DIRECT_IMPORT_BYTES', 96 * 1024 * 1024)
  };
}
