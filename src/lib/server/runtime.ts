import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { flockSync } from 'fs-ext';
import type Database from 'better-sqlite3';
import { localhostAllowedHostnames, localhostAllowedOrigins } from '@modelcontextprotocol/server';
import { getRuntimeConfig, type RuntimeConfig } from '$lib/server/config';
import { openDatabase, runMigrations } from '$lib/server/db/connection';
import {
  SqliteAdminSessionRepository,
  SqliteApiKeyRepository,
  SqliteOAuthAuthorizationRepository,
  SqliteOAuthClientRepository,
  SqliteWakaTimeOAuthConnectionRepository
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
import { RegistrationRateLimiter } from '$lib/server/oauth/rate-limit';
import { WakaTimeOAuthService } from '$lib/server/wakatime/oauth';
import { SqliteSyncRepository } from '$lib/server/sync/repository';
import { SyncCoordinator } from '$lib/server/sync/coordinator';
import { SyncScheduler } from '$lib/server/sync/scheduler';
import {
  LIFECYCLE_SYMBOL,
  SHUTDOWN_GRACE_PERIOD_MS,
  type LifecycleHandle,
  type ProcessLock,
  type RuntimeReadiness as ContractRuntimeReadiness
} from '$lib/server/sync/contracts';
import type { WakaTimeClient } from '$lib/server/wakatime/client';

export const RUNTIME_SYMBOL = Symbol.for('work-times.runtime');

/**
 * Nonblocking OS file lock on a stable sibling file of canonical DB path.
 * Retains file descriptor for runtime lifetime; never unlinks the file.
 */
export class FsExtProcessLock implements ProcessLock {
  private readonly lockFilePath: string;
  private fd: number | null = null;
  private held = false;

  constructor(databasePath: string) {
    const resolved = path.resolve(databasePath);
    this.lockFilePath = `${resolved}.lock`;
  }

  async acquire(): Promise<boolean> {
    if (this.held) return true;

    try {
      fs.mkdirSync(path.dirname(this.lockFilePath), { recursive: true });
      const fd = fs.openSync(this.lockFilePath, 'a');
      try {
        flockSync(fd, 'exnb');
        this.fd = fd;
        this.held = true;
        return true;
      } catch (err: unknown) {
        fs.closeSync(fd);
        const code = (err as { code?: string }).code;
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EBUSY') {
          return false;
        }
        throw err;
      }
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EBUSY') {
        return false;
      }
      throw err;
    }
  }

  async release(): Promise<void> {
    if (this.held && this.fd !== null) {
      try {
        flockSync(this.fd, 'un');
      } catch {
        // ignore unlock error on shutdown
      }
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore close error
      }
      this.fd = null;
      this.held = false;
    }
  }

  isHeld(): boolean {
    return this.held;
  }
}

/**
 * In-memory process lock for tests or memory-backed databases.
 */
export class InMemoryProcessLock implements ProcessLock {
  private held = false;
  public shouldFailAcquire = false;

  async acquire(): Promise<boolean> {
    if (this.shouldFailAcquire) return false;
    if (this.held) return false;
    this.held = true;
    return true;
  }

  async release(): Promise<void> {
    this.held = false;
  }

  isHeld(): boolean {
    return this.held;
  }
}

export type RuntimeState = 'unstarted' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface RuntimeReadiness {
  state: RuntimeState;
  ready: boolean;
  schedulingEnabled: boolean;
  sourceTimezone: string | null;
  nextDueAt: string | null;
  activeRunId: string | null;
  currentDate: string | null;
  lastProgressAt: string | null;
  errorCode: string | null;
  // Compatibility aliases matching contracts.ts:
  migrationsComplete: boolean;
  recoveryComplete: boolean;
  serviceRegistered: boolean;
  ownershipLockHeld: boolean;
}

export interface CreateRuntimeOptions {
  processLock?: ProcessLock;
  migrationsDir?: string;
  wakatimeClient?: WakaTimeClient;
  pinnedTimezone?: string;
  now?: () => Date;
}

export interface ServerRuntime {
  readonly config: RuntimeConfig;
  readonly db: Database.Database;
  readonly adminSessions: SqliteAdminSessionRepository;
  readonly adminAuth: AdminAuthenticator;
  readonly loginLimiter: LoginAttemptLimiter;
  readonly registrationLimiter: RegistrationRateLimiter;
  readonly apiKeys: ApiKeyService;
  readonly oauthClients: OAuthClientService;
  readonly oauthAuth: OAuthAuthorizationService;
  readonly wakatimeOAuth: WakaTimeOAuthService;
  readonly classification: SqliteClassificationService;
  readonly analytics: SqliteWorkOnlyAnalytics;
  readonly tokenVerifier: WorkTimesTokenVerifier;
  readonly mcpHandler: ReturnType<typeof createWorkTimesMcpHandler>;
  readonly authenticatedMcpHandler: AuthenticatedMcpHandler;
  readonly sessionSecret: string;
  readonly sync: SyncCoordinator; // frozen name
  readonly syncRepository: SqliteSyncRepository; // frozen name
  readonly coordinator: SyncCoordinator;
  readonly scheduler: SyncScheduler;
  readonly lifecycle: LifecycleHandle;
  readonly processLock: ProcessLock;
  getReadiness(): RuntimeReadiness;
}

let runtimeInstance: ServerRuntime | null = null;

export function createRuntime(
  customConfig?: RuntimeConfig,
  customDb?: Database.Database,
  options?: CreateRuntimeOptions
): ServerRuntime {
  const config = customConfig ?? getRuntimeConfig();

  // createRuntime constructs only: migrate: false by default to prevent import-time side effects
  const db = customDb ?? openDatabase({ path: config.databasePath, migrate: false });

  const readinessInternal: {
    state: RuntimeState;
    ready: boolean;
    migrationsComplete: boolean;
    recoveryComplete: boolean;
    serviceRegistered: boolean;
    ownershipLockHeld: boolean;
    errorCode: string | null;
  } = {
    state: 'unstarted',
    ready: false,
    migrationsComplete: false,
    recoveryComplete: false,
    serviceRegistered: false,
    ownershipLockHeld: false,
    errorCode: null
  };

  let migrationsRan = false;
  function ensureMigrated(): void {
    if (!migrationsRan && db.open) {
      runMigrations(db, options?.migrationsDir);
      migrationsRan = true;
      readinessInternal.migrationsComplete = true;
    }
  }

  const dbProxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare' || prop === 'exec' || prop === 'transaction') {
        ensureMigrated();
      }
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === 'function') {
        return val.bind(target);
      }
      return val;
    }
  });

  const syncRepo = new SqliteSyncRepository(dbProxy);

  let _adminSessions: SqliteAdminSessionRepository | null = null;
  const getAdminSessions = () => {
    ensureMigrated();
    if (!_adminSessions) _adminSessions = new SqliteAdminSessionRepository(dbProxy);
    return _adminSessions;
  };

  let _apiKeyRepo: SqliteApiKeyRepository | null = null;
  const getApiKeyRepo = () => {
    ensureMigrated();
    if (!_apiKeyRepo) _apiKeyRepo = new SqliteApiKeyRepository(dbProxy);
    return _apiKeyRepo;
  };

  let _oauthClientRepo: SqliteOAuthClientRepository | null = null;
  const getOAuthClientRepo = () => {
    ensureMigrated();
    if (!_oauthClientRepo) _oauthClientRepo = new SqliteOAuthClientRepository(dbProxy);
    return _oauthClientRepo;
  };

  let _oauthAuthRepo: SqliteOAuthAuthorizationRepository | null = null;
  const getOAuthAuthRepo = () => {
    ensureMigrated();
    if (!_oauthAuthRepo) _oauthAuthRepo = new SqliteOAuthAuthorizationRepository(dbProxy);
    return _oauthAuthRepo;
  };

  let _wakatimeOAuthRepo: SqliteWakaTimeOAuthConnectionRepository | null = null;
  const getWakaTimeOAuthRepo = () => {
    ensureMigrated();
    if (!_wakatimeOAuthRepo) _wakatimeOAuthRepo = new SqliteWakaTimeOAuthConnectionRepository(dbProxy);
    return _wakatimeOAuthRepo;
  };

  let _adminAuth: AdminAuthenticator | null = null;
  const getAdminAuth = () => {
    if (!_adminAuth) {
      _adminAuth = new AdminAuthenticator({
        username: config.adminUsername,
        passwordHash: config.adminPasswordHash,
        sessions: getAdminSessions()
      });
    }
    return _adminAuth;
  };

  const loginLimiter = new LoginAttemptLimiter(5, 15 * 60 * 1000);
  const registrationLimiter = new RegistrationRateLimiter(10, 10 * 60 * 1000);

  let _apiKeys: ApiKeyService | null = null;
  const getApiKeys = () => {
    if (!_apiKeys) _apiKeys = new ApiKeyService(getApiKeyRepo());
    return _apiKeys;
  };

  let _oauthClients: OAuthClientService | null = null;
  const getOAuthClients = () => {
    if (!_oauthClients) _oauthClients = new OAuthClientService(getOAuthClientRepo());
    return _oauthClients;
  };

  let _oauthAuth: OAuthAuthorizationService | null = null;
  const getOAuthAuth = () => {
    if (!_oauthAuth) _oauthAuth = new OAuthAuthorizationService(getOAuthClients(), getOAuthAuthRepo());
    return _oauthAuth;
  };

  let _wakatimeOAuth: WakaTimeOAuthService | null = null;
  const getWakaTimeOAuth = () => {
    if (!_wakatimeOAuth) {
      _wakatimeOAuth = new WakaTimeOAuthService({
        repository: getWakaTimeOAuthRepo(),
        clientId: config.wakatimeOAuthClientId,
        clientSecret: config.wakatimeOAuthClientSecret,
        publicUrl: config.publicUrl,
        encryptionSecret: config.sessionSecret
      });
    }
    return _wakatimeOAuth;
  };

  let _classification: SqliteClassificationService | null = null;
  const getClassification = () => {
    ensureMigrated();
    if (!_classification) _classification = new SqliteClassificationService(dbProxy);
    return _classification;
  };

  let _analytics: SqliteWorkOnlyAnalytics | null = null;
  const getAnalytics = () => {
    ensureMigrated();
    if (!_analytics) _analytics = new SqliteWorkOnlyAnalytics(dbProxy, getClassification());
    return _analytics;
  };

  const mcpResource = new URL('/mcp', config.publicUrl);
  let _tokenVerifier: WorkTimesTokenVerifier | null = null;
  const getTokenVerifier = () => {
    if (!_tokenVerifier) {
      _tokenVerifier = new WorkTimesTokenVerifier({
        apiKeys: getApiKeys(),
        oauth: getOAuthAuth(),
        resource: mcpResource
      });
    }
    return _tokenVerifier;
  };

  let _mcpHandler: ReturnType<typeof createWorkTimesMcpHandler> | null = null;
  const getMcpHandler = () => {
    if (!_mcpHandler) _mcpHandler = createWorkTimesMcpHandler(getAnalytics());
    return _mcpHandler;
  };

  const allowedHosts = [...new Set([config.publicUrl.hostname, ...localhostAllowedHostnames()])];
  const allowedOrigins = [...new Set([config.publicUrl.hostname, ...localhostAllowedOrigins()])];

  let _authenticatedMcpHandler: AuthenticatedMcpHandler | null = null;
  const getAuthenticatedMcpHandler = () => {
    if (!_authenticatedMcpHandler) {
      _authenticatedMcpHandler = createAuthenticatedMcpHandler({
        handler: getMcpHandler(),
        verifier: getTokenVerifier(),
        resource: mcpResource,
        allowedHosts,
        allowedOrigins,
        requiredScopes: ['activity:read']
      });
    }
    return _authenticatedMcpHandler;
  };

  const sessionSecret = config.sessionSecret ?? randomBytes(32).toString('hex');

  const coordinator = new SyncCoordinator({
    db: dbProxy,
    repository: syncRepo,
    client: options?.wakatimeClient,
    classification: {
      invalidateIdentityCaches: () => getClassification().invalidateIdentityCaches(),
      clearCaches: () => getClassification().clearCaches()
    },
    pinnedTimezone: options?.pinnedTimezone,
    now: options?.now
  });

  const scheduler = new SyncScheduler({
    db: dbProxy,
    coordinator,
    repository: syncRepo,
    pinnedTimezone: options?.pinnedTimezone,
    now: options?.now
  });

  const processLock =
    options?.processLock ??
    (config.databasePath === ':memory:'
      ? new InMemoryProcessLock()
      : new FsExtProcessLock(config.databasePath));

  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  function getReadiness(): RuntimeReadiness {
    let schedulingEnabled = false;
    let sourceTimezone: string | null = null;
    let nextDueAt: string | null = null;
    let activeRunId: string | null = null;
    let currentDate: string | null = null;
    let lastProgressAt: string | null = null;
    let readinessErrorCode: string | null = readinessInternal.errorCode;
    let schemaQueryFailed = false;

    if (readinessInternal.migrationsComplete && db.open) {
      try {
        const settings = syncRepo.getSyncSettings();
        schedulingEnabled = Boolean(settings.schedulingEnabled);
        sourceTimezone = scheduler.getEffectiveTimezone();
        const schedState = scheduler.getScheduleState();
        nextDueAt = schedState.nextDue.recent ?? schedState.nextDue.reconcile ?? null;

        const activeRow = db
          .prepare("SELECT id, started_at FROM sync_runs WHERE status = 'running' LIMIT 1")
          .get() as { id: number; started_at: string } | undefined;

        if (activeRow) {
          activeRunId = String(activeRow.id);
          lastProgressAt = activeRow.started_at;
          const dayRow = db
            .prepare("SELECT date FROM sync_days WHERE sync_run_id = ? AND status = 'running' LIMIT 1")
            .get(activeRow.id) as { date: string } | undefined;
          if (dayRow) {
            currentDate = dayRow.date;
          }
        } else {
          const lastRow = db
            .prepare("SELECT started_at, finished_at FROM sync_runs ORDER BY id DESC LIMIT 1")
            .get() as { started_at: string; finished_at: string | null } | undefined;
          if (lastRow?.finished_at) {
            lastProgressAt = lastRow.finished_at;
          } else if (lastRow?.started_at) {
            lastProgressAt = lastRow.started_at;
          }
        }
      } catch (err) {
        // If the service was running, repository or schema detail failure must NEVER be silently
        // treated as healthy empty state. Mark ready false with sanitized allowlisted error code.
        if (readinessInternal.state === 'running') {
          schemaQueryFailed = true;
          readinessErrorCode = 'SCHEMA_QUERY_FAILED';
        }
      }
    }

    const isReady =
      !schemaQueryFailed &&
      readinessInternal.state === 'running' &&
      readinessInternal.ownershipLockHeld &&
      readinessInternal.migrationsComplete &&
      readinessInternal.recoveryComplete &&
      readinessInternal.serviceRegistered;

    return {
      state: readinessInternal.state,
      ready: isReady,
      schedulingEnabled,
      sourceTimezone,
      nextDueAt,
      activeRunId,
      currentDate,
      lastProgressAt,
      errorCode: readinessErrorCode,
      migrationsComplete: readinessInternal.migrationsComplete,
      recoveryComplete: readinessInternal.recoveryComplete,
      serviceRegistered: readinessInternal.serviceRegistered,
      ownershipLockHeld: readinessInternal.ownershipLockHeld
    };
  }

  const lifecycle: LifecycleHandle = {
    async start(): Promise<void> {
      if (readinessInternal.ready) return;
      if (startPromise) return startPromise;

      readinessInternal.state = 'starting';
      startPromise = (async () => {
        try {
          // 1. Acquire ownership lock before migrations and recovery
          const acquired = await processLock.acquire();
          if (!acquired) {
            readinessInternal.errorCode = 'LOCK_CONTENTION';
            throw new Error(
              `Failed to acquire process ownership lock for database "${config.databasePath}": another process is running`
            );
          }
          readinessInternal.ownershipLockHeld = true;

          // 2. Run migrations
          try {
            ensureMigrated();
          } catch (err) {
            readinessInternal.errorCode = 'MIGRATION_FAILED';
            throw err;
          }

          // 3. Run crash recovery
          try {
            await coordinator.runRecovery();
            readinessInternal.recoveryComplete = true;
          } catch (err) {
            readinessInternal.errorCode = 'RECOVERY_FAILED';
            throw err;
          }

          // 4. Start coordinator
          try {
            await coordinator.start();
            readinessInternal.serviceRegistered = true;
          } catch (err) {
            readinessInternal.errorCode = 'COORDINATOR_FAILED';
            throw err;
          }

          // 5. Start scheduler if scheduling is enabled (dev opt-in guard)
          try {
            const settings = syncRepo.getSyncSettings();
            const isDev = process.env.NODE_ENV === 'development';
            const devSchedulingOptIn =
              process.env.DEV_SCHEDULING === 'true' ||
              process.env.ENABLE_DEV_SCHEDULING === 'true';

            if (settings.schedulingEnabled && (!isDev || devSchedulingOptIn)) {
              await scheduler.start();
            }
          } catch (err) {
            readinessInternal.errorCode = 'SCHEDULER_FAILED';
            throw err;
          }

          // 6. Mark ready only after all prerequisites succeed
          readinessInternal.state = 'running';
          readinessInternal.ready = true;
          readinessInternal.errorCode = null;
        } catch (startupError) {
          // Any startup failure after lock acquisition:
          // 1. Quiesce services
          try {
            await scheduler.stop();
          } catch {}
          try {
            await coordinator.stop('shutdown', 5000);
          } catch {}

          // 2. Close owned DB resources safely
          try {
            if (db.open) {
              db.close();
            }
          } catch {}

          // 3. Release process lock so a later process can acquire
          try {
            await processLock.release();
          } catch {}

          // 4. Clear readiness and set allowlisted error code
          readinessInternal.state = 'failed';
          readinessInternal.ready = false;
          readinessInternal.ownershipLockHeld = false;
          readinessInternal.serviceRegistered = false;
          if (!readinessInternal.errorCode) {
            readinessInternal.errorCode = 'STARTUP_FAILED';
          }

          // 5. Reset startPromise so we do not leave a permanently rejected start promise
          startPromise = null;

          throw startupError;
        }
      })();

      return startPromise;
    },

    async stop(
      reason: 'shutdown' = 'shutdown',
      deadlineMs: number = SHUTDOWN_GRACE_PERIOD_MS,
      drain?: () => Promise<void>
    ): Promise<void> {
      if (stopPromise) return stopPromise;

      readinessInternal.state = 'stopping';
      stopPromise = (async () => {
        // 1. Stop scheduler timers immediately
        try {
          await scheduler.stop();
        } catch {}

        // 2. Stop coordinator: aborts active reads/waits, interrupts active run, preserves queue
        try {
          await coordinator.stop(reason, deadlineMs);
        } catch {}
        readinessInternal.ready = false;
        readinessInternal.serviceRegistered = false;

        // 3. Drain in-flight HTTP requests while DB is still open
        if (drain) {
          try {
            await drain();
          } catch {}
        }

        // 4. Close database after consumers and in-flight HTTP requests stop
        try {
          if (db.open) {
            db.close();
          }
        } catch {
          // ignore if already closed
        }

        // 5. Release ownership lock
        try {
          await processLock.release();
        } catch {
          // ignore
        }
        readinessInternal.ownershipLockHeld = false;
        readinessInternal.state = 'stopped';
      })();

      return stopPromise;
    },

    getReadiness(): RuntimeReadiness {
      return getReadiness();
    }
  };

  const instance: ServerRuntime = {
    config,
    db: dbProxy,
    get adminSessions() { return getAdminSessions(); },
    get adminAuth() { return getAdminAuth(); },
    loginLimiter,
    registrationLimiter,
    get apiKeys() { return getApiKeys(); },
    get oauthClients() { return getOAuthClients(); },
    get oauthAuth() { return getOAuthAuth(); },
    get wakatimeOAuth() { return getWakaTimeOAuth(); },
    get classification() { return getClassification(); },
    get analytics() { return getAnalytics(); },
    get tokenVerifier() { return getTokenVerifier(); },
    get mcpHandler() { return getMcpHandler(); },
    get authenticatedMcpHandler() { return getAuthenticatedMcpHandler(); },
    sessionSecret,
    sync: coordinator,
    syncRepository: syncRepo,
    coordinator,
    scheduler,
    lifecycle,
    processLock,
    getReadiness
  };

  return instance;
}

// Minimal process-local lifecycle bridge: registered lazily without side effects
if (!(globalThis as Record<symbol, unknown>)[LIFECYCLE_SYMBOL]) {
  (globalThis as Record<symbol, unknown>)[LIFECYCLE_SYMBOL] = {
    start: () => getRuntime().lifecycle.start(),
    stop: (
      reason: 'shutdown' = 'shutdown',
      deadlineMs: number = SHUTDOWN_GRACE_PERIOD_MS,
      drain?: () => Promise<void>
    ) =>
      (
        getRuntime().lifecycle.stop as (
          reason: 'shutdown',
          deadlineMs: number,
          drain?: () => Promise<void>
        ) => Promise<void>
      )(reason, deadlineMs, drain),
    getReadiness: () => getRuntime().lifecycle.getReadiness()
  };
}

export function getRuntime(): ServerRuntime {
  const globalRuntime = (globalThis as Record<symbol, unknown>)[RUNTIME_SYMBOL] as ServerRuntime | undefined;
  if (globalRuntime) {
    return globalRuntime;
  }

  if (!runtimeInstance) {
    runtimeInstance = createRuntime();
    (globalThis as Record<symbol, unknown>)[RUNTIME_SYMBOL] = runtimeInstance;
  }
  return runtimeInstance;
}

export const runtime: ServerRuntime = new Proxy({} as ServerRuntime, {
  get(_target, prop, receiver) {
    const target = getRuntime();
    return Reflect.get(target, prop, receiver);
  },
  has(_target, prop) {
    const target = getRuntime();
    return Reflect.has(target, prop);
  },
  ownKeys(_target) {
    const target = getRuntime();
    return Reflect.ownKeys(target);
  },
  getOwnPropertyDescriptor(_target, prop) {
    const target = getRuntime();
    return Reflect.getOwnPropertyDescriptor(target, prop);
  }
});

