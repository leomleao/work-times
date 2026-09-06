import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { localhostAllowedHostnames, localhostAllowedOrigins } from '@modelcontextprotocol/server';
import { getRuntimeConfig, type RuntimeConfig } from '$lib/server/config';
import { openDatabase } from '$lib/server/db/connection';
import {
  SqliteAdminSessionRepository,
  SqliteApiKeyRepository,
  SqliteOAuthAuthorizationRepository,
  SqliteOAuthClientRepository
} from '$lib/server/db/repositories';
import { AdminAuthenticator, LoginAttemptLimiter } from '$lib/server/auth/admin-auth';
import { ApiKeyService } from '$lib/server/auth/api-keys';
import { OAuthClientService } from '$lib/server/oauth/clients';
import { OAuthAuthorizationService } from '$lib/server/oauth/authorization';
import { SqliteClassificationService } from '$lib/server/classification/sqlite';
import { SqliteWorkOnlyAnalytics } from '$lib/server/analytics/sqlite';
import { WorkTimesTokenVerifier } from '$lib/server/mcp/token-verifier';
import { createWorkTimesMcpHandler } from '$lib/server/mcp/server';
import { createAuthenticatedMcpHandler, type AuthenticatedMcpHandler } from '$lib/server/mcp/http';

export interface ServerRuntime {
  readonly config: RuntimeConfig;
  readonly db: Database.Database;
  readonly adminSessions: SqliteAdminSessionRepository;
  readonly adminAuth: AdminAuthenticator;
  readonly loginLimiter: LoginAttemptLimiter;
  readonly apiKeys: ApiKeyService;
  readonly oauthClients: OAuthClientService;
  readonly oauthAuth: OAuthAuthorizationService;
  readonly classification: SqliteClassificationService;
  readonly analytics: SqliteWorkOnlyAnalytics;
  readonly tokenVerifier: WorkTimesTokenVerifier;
  readonly mcpHandler: ReturnType<typeof createWorkTimesMcpHandler>;
  readonly authenticatedMcpHandler: AuthenticatedMcpHandler;
  readonly sessionSecret: string;
}

let runtimeInstance: ServerRuntime | null = null;

export function createRuntime(customConfig?: RuntimeConfig, customDb?: Database.Database): ServerRuntime {
  const config = customConfig ?? getRuntimeConfig();
  const db = customDb ?? openDatabase({ path: config.databasePath });

  const adminSessions = new SqliteAdminSessionRepository(db);
  const apiKeyRepo = new SqliteApiKeyRepository(db);
  const oauthClientRepo = new SqliteOAuthClientRepository(db);
  const oauthAuthRepo = new SqliteOAuthAuthorizationRepository(db);

  const adminAuth = new AdminAuthenticator({
    username: config.adminUsername,
    passwordHash: config.adminPasswordHash,
    sessions: adminSessions
  });

  const loginLimiter = new LoginAttemptLimiter(5, 15 * 60 * 1000);

  const apiKeys = new ApiKeyService(apiKeyRepo);
  const oauthClients = new OAuthClientService(oauthClientRepo);
  const oauthAuth = new OAuthAuthorizationService(oauthClients, oauthAuthRepo);

  const classification = new SqliteClassificationService(db);
  const analytics = new SqliteWorkOnlyAnalytics(db, classification);

  const mcpResource = new URL('/mcp', config.publicUrl);
  const tokenVerifier = new WorkTimesTokenVerifier({
    apiKeys,
    oauth: oauthAuth,
    resource: mcpResource
  });

  const mcpHandler = createWorkTimesMcpHandler(analytics);

  const allowedHosts = [...new Set([config.publicUrl.hostname, ...localhostAllowedHostnames()])];
  const allowedOrigins = [...new Set([config.publicUrl.hostname, ...localhostAllowedOrigins()])];

  const authenticatedMcpHandler = createAuthenticatedMcpHandler({
    handler: mcpHandler,
    verifier: tokenVerifier,
    resource: mcpResource,
    allowedHosts,
    allowedOrigins,
    requiredScopes: ['activity:read']
  });

  const sessionSecret = config.sessionSecret ?? randomBytes(32).toString('hex');

  return {
    config,
    db,
    adminSessions,
    adminAuth,
    loginLimiter,
    apiKeys,
    oauthClients,
    oauthAuth,
    classification,
    analytics,
    tokenVerifier,
    mcpHandler,
    authenticatedMcpHandler,
    sessionSecret
  };
}

export function getRuntime(): ServerRuntime {
  if (!runtimeInstance) {
    runtimeInstance = createRuntime();
  }
  return runtimeInstance;
}

export const runtime = getRuntime();
