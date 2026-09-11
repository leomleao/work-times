import { z } from 'zod';
import {
  WakaTimeError,
  WakaTimeAuthError,
  CapabilityRestrictedError,
  WakaTimeThrottleError,
  WakaTimeDeferredRetryError,
  WakaTimeRequestTimeoutError,
  WakaTimeBudgetTimeoutError,
  WakaTimeResponseSizeExceededError,
  WakaTimeServerError,
  WakaTimeNetworkError,
  WakaTimeParseError,
  WakaTimeApiError,
  sanitizeEndpoint
} from './errors.js';
import {
  SummariesResponseSchema,
  type SummariesResponse,
  HeartbeatsResponseSchema,
  type HeartbeatsResponse,
  DurationsResponseSchema,
  type DurationsResponse,
  DumpListResponseSchema,
  type DumpListResponse,
  DumpStatusResponseSchema,
  type DumpStatusResponse,
  CurrentUserResponseSchema,
  type CurrentUserResponse,
  ProjectsResponseSchema,
  type ProjectsResponse,
  MachineNamesResponseSchema,
  type MachineNamesResponse,
  UserAgentsResponseSchema,
  type UserAgentsResponse,
  CreateDumpInputSchema,
  type DumpType
} from './schemas.js';
import { WakaTimeRequestGate, getApplicationRequestGate, type GatePermit } from './request-gate.js';
import {
  UPSTREAM_REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_PAYLOAD_BYTES,
  MAX_DAY_EXECUTION_BUDGET_MS,
  MIN_UPSTREAM_REQUEST_SPACING_MS
} from '../sync/contracts.js';

export interface WakaTimeClientOptions {
  /** Static OAuth access token, primarily useful for isolated probes and tests. */
  accessToken?: string;
  /** Refresh-capable server-side OAuth token provider. */
  tokenProvider?: WakaTimeAccessTokenProvider;
  /** Base URL for the WakaTime API (default: 'https://api.wakatime.com/api/v1'). */
  baseUrl?: string;
  /** Injectable fetch implementation for tests or custom dispatch. */
  fetch?: typeof fetch;
  /** Injectable sleep function for deterministic test execution (supports AbortSignal). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable random generator for deterministic jitter in tests. */
  random?: () => number;
  /** Injectable clock for deterministic time in tests (default: Date.now). */
  now?: () => number;
  /** Shared request gate for pacing and concurrency control. */
  gate?: WakaTimeRequestGate;
  /** Minimum spacing between request starts in milliseconds (default: 1000). */
  minSpacingMs?: number;
  /** Whole-request timeout in milliseconds (default: 30000). */
  requestTimeoutMs?: number;
  /** Maximum response body size in bytes (default: 16 MiB). */
  maxResponseSizeBytes?: number;
  /** Maximum retry wait budget for throttle retries (default: 30000). */
  budgetMs?: number;
  /** Max retries for eligible 5xx server errors (default: 3). */
  maxRetries5xx?: number;
  /** Max retries for 302 and 429 throttling (default: 3). */
  maxThrottleRetries?: number;
  /** Initial backoff delay in milliseconds (default: 1000). */
  baseBackoffMs?: number;
  /** Maximum backoff delay in milliseconds (default: 30000). */
  maxBackoffMs?: number;
  /** Maximum jitter in milliseconds (default: 500). */
  jitterMs?: number;
}

export interface WakaTimeAccessTokenProvider {
  getAccessToken(signal?: AbortSignal): Promise<string>;
  refreshAccessToken(signal?: AbortSignal): Promise<string>;
}

export interface RequestCancellationOptions {
  signal?: AbortSignal;
  budgetMs?: number;
}

export interface SummariesQueryOptions extends RequestCancellationOptions {
  start: string; // "YYYY-MM-DD"
  end: string; // "YYYY-MM-DD"
  project?: string;
  branches?: string;
  timezone?: string;
}

export interface HeartbeatsQueryOptions extends RequestCancellationOptions {
  date: string; // "YYYY-MM-DD"
  timezone?: string;
}

export interface DurationsQueryOptions extends RequestCancellationOptions {
  date: string; // "YYYY-MM-DD"
  project?: string;
  branches?: string;
  timezone?: string;
}

export type { DumpType } from './schemas.js';

export interface CreateDumpOptions extends RequestCancellationOptions {
  type: DumpType;
  email_when_finished?: boolean;
}

export interface RegistryQueryOptions extends RequestCancellationOptions {
  page?: number;
}

/**
 * Standard abortable sleep helper.
 */
async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Sleep aborted');
  }

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new Error('Sleep aborted'));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Parse standard HTTP Retry-After header into milliseconds.
 * Supports both integer seconds and HTTP date format.
 */
export function parseRetryAfter(header: string | null, nowMs = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    const delta = parsedDate - nowMs;
    return delta > 0 ? delta : 0;
  }
  return null;
}

/**
 * Infer capability name from endpoint pathname for error categorization.
 */
function inferCapability(pathname: string): string {
  const sanitized = sanitizeEndpoint(pathname);
  if (sanitized.includes('/summaries')) return 'summaries';
  if (sanitized.includes('/durations')) return 'durations';
  if (sanitized.includes('/heartbeats')) return 'heartbeats';
  if (sanitized.includes('/data_dumps') || sanitized.includes('/dumps')) return 'dumps';
  return 'unknown';
}

/**
 * Dump-independent WakaTime OAuth HTTP Client.
 *
 * Enforces:
 * - OAuth Bearer authentication, never query-string authentication.
 * - Redirect: 'manual' (treats data-endpoint 302 and 429 as throttling).
 * - Shared Request Gate: strictly 1 concurrent in-flight upstream request and
 *   at least 1000ms between request starts.
 * - Token acquisition occurs outside of permit hold so refresh cannot deadlock.
 * - Abortable 30s whole-request deadline covering fetch and streaming body consumption.
 * - 16 MiB maximum response body limit enforced during streaming read.
 * - Cancellation propagation across permit queue waiting, body reads, and backoff sleeps.
 * - Full Retry-After honored (seconds or HTTP date); if wait exceeds current budget,
 *   returns an explicit WakaTimeDeferredRetryError without truncating wait.
 * - Single refresh retry on 401; distinguished revoked vs transient refresh failures.
 * - Sanitized, privacy-preserving errors omitting tokens, secrets, PII, and entity paths.
 */
export class WakaTimeClient {
  readonly #accessToken: string | null;
  readonly #tokenProvider: WakaTimeAccessTokenProvider | null;
  readonly baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #gate: WakaTimeRequestGate;
  readonly requestTimeoutMs: number;
  readonly maxResponseSizeBytes: number;
  readonly budgetMs: number;
  readonly maxRetries5xx: number;
  readonly maxThrottleRetries: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly jitterMs: number;

  constructor(options: WakaTimeClientOptions) {
    const accessToken = options.accessToken?.trim() || null;
    if ((!accessToken && !options.tokenProvider) || (accessToken && options.tokenProvider)) {
      throw new WakaTimeError('Provide exactly one OAuth access token source for WakaTimeClient');
    }
    this.#accessToken = accessToken;
    this.#tokenProvider = options.tokenProvider ?? null;
    this.baseUrl = (options.baseUrl || 'https://api.wakatime.com/api/v1').replace(/\/+$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? (() => Date.now());
    this.requestTimeoutMs = options.requestTimeoutMs ?? UPSTREAM_REQUEST_TIMEOUT_MS;
    this.maxResponseSizeBytes = options.maxResponseSizeBytes ?? MAX_RESPONSE_PAYLOAD_BYTES;
    this.budgetMs = options.budgetMs ?? MAX_DAY_EXECUTION_BUDGET_MS;
    this.maxRetries5xx = options.maxRetries5xx ?? 3;
    this.maxThrottleRetries = options.maxThrottleRetries ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.jitterMs = options.jitterMs ?? 500;

    this.#gate =
      options.gate ??
      (options.minSpacingMs !== undefined
        ? new WakaTimeRequestGate({
            now: options.now ?? (() => Date.now()),
            delay: options.sleep ?? defaultSleep,
            minSpacingMs: options.minSpacingMs
          })
        : getApplicationRequestGate());
  }

  /**
   * Safe serialization ensuring credentials are never leaked.
   */
  toJSON(): Record<string, unknown> {
    return {
      baseUrl: this.baseUrl,
      maxRetries5xx: this.maxRetries5xx,
      maxThrottleRetries: this.maxThrottleRetries,
      requestTimeoutMs: this.requestTimeoutMs,
      maxResponseSizeBytes: this.maxResponseSizeBytes
    };
  }

  get gate(): WakaTimeRequestGate {
    return this.#gate;
  }

  /**
   * Calculate bounded exponential backoff delay with jitter.
   */
  private computeBackoffDelay(attempt: number): number {
    const expDelay = Math.min(this.maxBackoffMs, this.baseBackoffMs * Math.pow(2, attempt));
    const jitter = Math.floor(this.#random() * this.jitterMs);
    return Math.min(this.maxBackoffMs, expDelay + jitter);
  }

  /**
   * Stream response body enforcing max payload size and cancellation.
   */
  private async readResponseBody(
    response: Response,
    options: { signal?: AbortSignal; endpoint?: string; maxBytes: number }
  ): Promise<string> {
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const bytes = Number.parseInt(contentLength, 10);
      if (!Number.isNaN(bytes) && bytes > options.maxBytes) {
        throw new WakaTimeResponseSizeExceededError(options.maxBytes, options.endpoint);
      }
    }

    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      try {
        while (true) {
          if (options.signal?.aborted) {
            await reader.cancel(options.signal.reason).catch(() => {});
            throw options.signal.reason ?? new Error('Request aborted');
          }

          let readPromise = reader.read();
          if (options.signal) {
            let abortListener: (() => void) | undefined;
            const abortPromise = new Promise<never>((_, reject) => {
              if (options.signal?.aborted) {
                reject(options.signal.reason ?? new Error('Request aborted'));
                return;
              }
              abortListener = () => {
                reader.cancel(options.signal?.reason).catch(() => {});
                reject(options.signal?.reason ?? new Error('Request aborted'));
              };
              options.signal?.addEventListener('abort', abortListener, { once: true });
            });

            try {
              const { done, value } = await Promise.race([readPromise, abortPromise]);
              if (abortListener) {
                options.signal.removeEventListener('abort', abortListener);
              }
              if (options.signal?.aborted) {
                throw options.signal.reason ?? new Error('Request aborted');
              }
              if (done) break;

              if (value) {
                totalBytes += value.byteLength;
                if (totalBytes > options.maxBytes) {
                  await reader.cancel('Response payload size limit exceeded').catch(() => {});
                  throw new WakaTimeResponseSizeExceededError(options.maxBytes, options.endpoint);
                }
                chunks.push(value);
              }
            } catch (err) {
              if (abortListener) {
                options.signal?.removeEventListener('abort', abortListener);
              }
              throw err;
            }
          } else {
            const { done, value } = await readPromise;
            if (done) break;

            if (value) {
              totalBytes += value.byteLength;
              if (totalBytes > options.maxBytes) {
                await reader.cancel('Response payload size limit exceeded').catch(() => {});
                throw new WakaTimeResponseSizeExceededError(options.maxBytes, options.endpoint);
              }
              chunks.push(value);
            }
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Ignore lock release error if reader was already cancelled
        }
      }

      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error('Request aborted');
      }

      const totalBuffer = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        totalBuffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(totalBuffer);
    }

    const text = await response.text();
    const byteLength = Buffer.byteLength(text, 'utf8');
    if (byteLength > options.maxBytes) {
      throw new WakaTimeResponseSizeExceededError(options.maxBytes, options.endpoint);
    }
    return text;
  }

  /**
   * Internal request dispatcher protected by request gate and whole-request deadline.
   */
  private async request<T>(
    endpointPath: string,
    schema: z.ZodType<T>,
    init?: {
      method?: string;
      body?: unknown;
      searchParams?: Record<string, string | undefined>;
      signal?: AbortSignal;
      budgetMs?: number;
    }
  ): Promise<T> {
    const callerSignal = init?.signal;
    if (callerSignal?.aborted) {
      throw callerSignal.reason ?? new Error('Request aborted before start');
    }

    const url = new URL(`${this.baseUrl}${endpointPath.startsWith('/') ? '' : '/'}${endpointPath}`);
    if (init?.searchParams) {
      for (const [k, v] of Object.entries(init.searchParams)) {
        if (v !== undefined && !['api_key', 'apiKey', 'access_token', 'token'].includes(k)) {
          url.searchParams.set(k, v);
        }
      }
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    let requestBody: string | undefined;
    if (init?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(init.body);
    }

    const requestBudgetMs = init?.budgetMs ?? this.budgetMs;
    const requestStartTime = this.#now();

    if (requestBudgetMs <= 0) {
      throw new WakaTimeBudgetTimeoutError(requestBudgetMs, url.pathname);
    }

    // Step 0: Derive one combined caller-plus-budget AbortSignal for the entire client request
    const operationController = new AbortController();

    const onCallerAbort = () => {
      operationController.abort(callerSignal?.reason ?? new Error('Request aborted by caller'));
    };
    if (callerSignal) {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const triggerBudgetTimeout = () => {
      if (!operationController.signal.aborted) {
        operationController.abort(new WakaTimeBudgetTimeoutError(requestBudgetMs, url.pathname));
      }
    };

    const budgetTimer = setTimeout(triggerBudgetTimeout, requestBudgetMs);

    const checkBudgetOrCallerAbort = () => {
      if (callerSignal?.aborted) {
        throw callerSignal.reason ?? new Error('Request aborted by caller');
      }
      const elapsed = this.#now() - requestStartTime;
      if (elapsed >= requestBudgetMs || operationController.signal.aborted) {
        triggerBudgetTimeout();
        if (callerSignal?.aborted) {
          throw callerSignal.reason ?? new Error('Request aborted by caller');
        }
        const reason = operationController.signal.reason;
        if (reason instanceof WakaTimeError) throw reason;
        throw new WakaTimeBudgetTimeoutError(requestBudgetMs, url.pathname);
      }
    };

    try {
      checkBudgetOrCallerAbort();

      // Step 1: Initial token acquisition occurs BEFORE taking permit from request gate
      let accessToken: string;
      try {
        accessToken =
          this.#accessToken ??
          (await this.#tokenProvider!.getAccessToken(operationController.signal));
      } catch (tokenErr) {
        if (callerSignal?.aborted) {
          throw callerSignal.reason ?? new Error('Request aborted by caller');
        }
        if (operationController.signal.aborted) {
          const reason = operationController.signal.reason;
          if (reason instanceof WakaTimeError) throw reason;
          throw new WakaTimeBudgetTimeoutError(requestBudgetMs, url.pathname);
        }
        const elapsed = this.#now() - requestStartTime;
        if (elapsed >= requestBudgetMs) {
          throw new WakaTimeBudgetTimeoutError(requestBudgetMs, url.pathname);
        }
        throw tokenErr;
      }

      checkBudgetOrCallerAbort();

      let retries5xx = 0;
      let throttleRetries = 0;
      let authenticationRetried = false;
      let lastStatus: number | undefined;

      while (true) {
        checkBudgetOrCallerAbort();

        // Step 2: Acquire permit from shared request gate (abortable)
        let permit: GatePermit;
        try {
          permit = await this.#gate.acquire({ signal: operationController.signal });
        } catch (gateErr) {
          if (callerSignal?.aborted) {
            throw callerSignal.reason ?? new Error('Request aborted by caller');
          }
          if (operationController.signal.aborted) {
            const reason = operationController.signal.reason;
            if (reason instanceof WakaTimeError) throw reason;
            throw new WakaTimeBudgetTimeoutError(requestBudgetMs, url.pathname);
          }
          const elapsed = this.#now() - requestStartTime;
          if (elapsed >= requestBudgetMs) {
            throw new WakaTimeBudgetTimeoutError(requestBudgetMs, url.pathname);
          }
          throw gateErr;
        }

        // Recheck budget AFTER acquiring request gate (gate wait may have consumed budget)
        const elapsedAfterGate = this.#now() - requestStartTime;
        if (elapsedAfterGate >= requestBudgetMs || operationController.signal.aborted) {
          permit.release();
          checkBudgetOrCallerAbort();
        }

        // Step 3: Enforce per-attempt deadline capped at min(requestTimeoutMs, remainingBudget)
        const remainingBudget = requestBudgetMs - (this.#now() - requestStartTime);
        if (remainingBudget <= 0) {
          permit.release();
          checkBudgetOrCallerAbort();
        }

        const attemptTimeoutMs = Math.min(this.requestTimeoutMs, remainingBudget);
        const isBudgetBounded = attemptTimeoutMs < this.requestTimeoutMs;

        const attemptController = new AbortController();
        const onOperationAbort = () => {
          attemptController.abort(operationController.signal.reason);
        };
        operationController.signal.addEventListener('abort', onOperationAbort, { once: true });

        const attemptTimer = setTimeout(() => {
          if (isBudgetBounded) {
            attemptController.abort(
              new WakaTimeBudgetTimeoutError(requestBudgetMs, url.pathname)
            );
          } else {
            attemptController.abort(
              new WakaTimeRequestTimeoutError(this.requestTimeoutMs, url.pathname)
            );
          }
        }, attemptTimeoutMs);

        let response: Response;
        let responseBodyText: string;

        try {
          headers.Authorization = `Bearer ${accessToken}`;
          response = await this.#fetch(url.toString(), {
            method: init?.method ?? 'GET',
            headers,
            body: requestBody,
            redirect: 'manual',
            signal: attemptController.signal
          });

          responseBodyText = await this.readResponseBody(response, {
            signal: attemptController.signal,
            endpoint: url.pathname,
            maxBytes: this.maxResponseSizeBytes
          });
        } catch (err) {
          if (callerSignal?.aborted) {
            throw callerSignal.reason ?? new Error('Request aborted by caller');
          }
          if (attemptController.signal.aborted) {
            const reason = attemptController.signal.reason;
            if (reason instanceof WakaTimeBudgetTimeoutError) {
              throw reason;
            }
            if (reason instanceof WakaTimeRequestTimeoutError) {
              throw reason;
            }
            if (reason instanceof WakaTimeError) {
              throw reason;
            }
          }
          if (operationController.signal.aborted) {
            const opReason = operationController.signal.reason;
            if (opReason instanceof WakaTimeError) throw opReason;
          }
          const elapsed = this.#now() - requestStartTime;
          if (elapsed >= requestBudgetMs) {
            throw new WakaTimeBudgetTimeoutError(requestBudgetMs, url.pathname);
          }
          if (err instanceof WakaTimeError) throw err;
          const msg = err instanceof Error ? err.message : 'Fetch failed';
          throw new WakaTimeNetworkError(msg, url.pathname, err);
        } finally {
          clearTimeout(attemptTimer);
          operationController.signal.removeEventListener('abort', onOperationAbort);
          permit.release();
        }

        const status = response.status;

        // 1. Success responses (2xx)
        if (status >= 200 && status < 300) {
          let json: unknown;
          try {
            json = JSON.parse(responseBodyText);
          } catch {
            throw new WakaTimeParseError('Failed to parse JSON response', url.pathname);
          }

          const parseResult = schema.safeParse(json);
          if (!parseResult.success) {
            const issueSummary = parseResult.error.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .slice(0, 3)
              .join('; ');
            throw new WakaTimeParseError(issueSummary, url.pathname);
          }

          return parseResult.data;
        }

        // 2. Throttling: treat data-endpoint 302 and 429 as throttle
        if (status === 302 || status === 429) {
          lastStatus = status;
          const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'), this.#now());
          const elapsedSoFar = this.#now() - requestStartTime;
          const remainingBudgetAfter = requestBudgetMs - elapsedSoFar;

          // Honor complete Retry-After; if beyond budget return explicit deferred retry without truncating
          if (retryAfterMs !== null && retryAfterMs > remainingBudgetAfter) {
            const retryAt = new Date(this.#now() + retryAfterMs).toISOString();
            throw new WakaTimeDeferredRetryError(
              status,
              retryAfterMs,
              retryAt,
              throttleRetries,
              url.pathname
            );
          }

          if (throttleRetries >= this.maxThrottleRetries) {
            const retryAt =
              retryAfterMs !== null ? new Date(this.#now() + retryAfterMs).toISOString() : undefined;
            throw new WakaTimeThrottleError(
              status,
              throttleRetries,
              retryAfterMs ?? undefined,
              url.pathname,
              retryAt
            );
          }

          const delay =
            retryAfterMs !== null && retryAfterMs > 0
              ? retryAfterMs
              : this.computeBackoffDelay(throttleRetries);

          // Before sleeping: check if delay would exceed remaining budget
          if (delay > remainingBudgetAfter || remainingBudgetAfter <= 0) {
            if (retryAfterMs !== null) {
              const retryAt = new Date(this.#now() + retryAfterMs).toISOString();
              throw new WakaTimeDeferredRetryError(
                status,
                retryAfterMs,
                retryAt,
                throttleRetries,
                url.pathname
              );
            }
            // Computed backoff without Retry-After: truthful terminal error without inventing upstream facts
            throw new WakaTimeThrottleError(
              status,
              throttleRetries,
              undefined,
              url.pathname
            );
          }

          throttleRetries++;
          try {
            await this.#sleep(delay, operationController.signal);
          } catch (sleepErr) {
            if (callerSignal?.aborted) {
              throw callerSignal.reason ?? new Error('Request aborted by caller');
            }
            if (operationController.signal.aborted) {
              const reason = operationController.signal.reason;
              if (reason instanceof WakaTimeError) throw reason;
              throw new WakaTimeBudgetTimeoutError(requestBudgetMs, url.pathname);
            }
            const elapsed = this.#now() - requestStartTime;
            if (elapsed >= requestBudgetMs) {
              throw new WakaTimeBudgetTimeoutError(requestBudgetMs, url.pathname);
            }
            throw sleepErr;
          }
          checkBudgetOrCallerAbort();
          continue;
        }

        // 3. Authentication failure: 401 gets one refresh retry
        if (status === 401) {
          lastStatus = status;
          if (this.#tokenProvider && !authenticationRetried) {
            authenticationRetried = true;
            checkBudgetOrCallerAbort();
            try {
              accessToken = await this.#tokenProvider.refreshAccessToken(operationController.signal);
            } catch (refreshErr) {
              if (callerSignal?.aborted) {
                throw callerSignal.reason ?? new Error('Request aborted by caller');
              }
              if (operationController.signal.aborted) {
                const reason = operationController.signal.reason;
                if (reason instanceof WakaTimeError) throw reason;
                throw new WakaTimeBudgetTimeoutError(requestBudgetMs, url.pathname);
              }
              const elapsed = this.#now() - requestStartTime;
              if (elapsed >= requestBudgetMs) {
                throw new WakaTimeBudgetTimeoutError(requestBudgetMs, url.pathname);
              }
              throw refreshErr;
            }
            checkBudgetOrCallerAbort();
            continue;
          }
          throw new WakaTimeAuthError(url.pathname);
        }

        // 4. Capability restriction: surface 402/403 as non-retriable CapabilityRestrictedError
        if (status === 402 || status === 403) {
          const capability = inferCapability(url.pathname);
          throw new CapabilityRestrictedError(capability, status, url.pathname);
        }

        // 5. Server errors: retry eligible 5xx up to maxRetries5xx
        if (status >= 500 && status <= 599) {
          lastStatus = status;
          const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'), this.#now());
          const elapsedSoFar = this.#now() - requestStartTime;
          const remainingBudgetAfter = requestBudgetMs - elapsedSoFar;

          if (retryAfterMs !== null && retryAfterMs > remainingBudgetAfter) {
            const retryAt = new Date(this.#now() + retryAfterMs).toISOString();
            throw new WakaTimeDeferredRetryError(
              status,
              retryAfterMs,
              retryAt,
              retries5xx,
              url.pathname
            );
          }

          if (retries5xx >= this.maxRetries5xx) {
            throw new WakaTimeServerError(status, retries5xx, url.pathname);
          }

          const delay =
            retryAfterMs !== null && retryAfterMs > 0
              ? retryAfterMs
              : this.computeBackoffDelay(retries5xx);

          // Before sleeping: check if delay would exceed remaining budget
          if (delay > remainingBudgetAfter || remainingBudgetAfter <= 0) {
            if (retryAfterMs !== null) {
              const retryAt = new Date(this.#now() + retryAfterMs).toISOString();
              throw new WakaTimeDeferredRetryError(
                status,
                retryAfterMs,
                retryAt,
                retries5xx,
                url.pathname
              );
            }
            // Computed backoff without Retry-After: truthful terminal error without inventing upstream facts
            throw new WakaTimeServerError(status, retries5xx, url.pathname);
          }

          retries5xx++;
          try {
            await this.#sleep(delay, operationController.signal);
          } catch (sleepErr) {
            if (callerSignal?.aborted) {
              throw callerSignal.reason ?? new Error('Request aborted by caller');
            }
            if (operationController.signal.aborted) {
              const reason = operationController.signal.reason;
              if (reason instanceof WakaTimeError) throw reason;
              throw new WakaTimeBudgetTimeoutError(requestBudgetMs, url.pathname);
            }
            const elapsed = this.#now() - requestStartTime;
            if (elapsed >= requestBudgetMs) {
              throw new WakaTimeBudgetTimeoutError(requestBudgetMs, url.pathname);
            }
            throw sleepErr;
          }
          checkBudgetOrCallerAbort();
          continue;
        }

        // 6. Other non-success status codes (e.g. 400, 404)
        throw new WakaTimeApiError(status, response.statusText || 'API Request Failed', url.pathname);
      }
    } finally {
      clearTimeout(budgetTimer);
      if (callerSignal) {
        callerSignal.removeEventListener('abort', onCallerAbort);
      }
    }
  }

  // ==========================================
  // Typed API Methods
  // ==========================================

  /**
   * Fetch daily summaries for a date range.
   * Supports options object or positional start/end strings.
   */
  async getSummaries(
    startOrOptions: string | SummariesQueryOptions,
    maybeEnd?: string
  ): Promise<SummariesResponse> {
    const opts: SummariesQueryOptions =
      typeof startOrOptions === 'string'
        ? { start: startOrOptions, end: maybeEnd ?? startOrOptions }
        : startOrOptions;

    return this.request('/users/current/summaries', SummariesResponseSchema, {
      method: 'GET',
      searchParams: {
        start: opts.start,
        end: opts.end,
        project: opts.project,
        branches: opts.branches,
        timezone: opts.timezone
      },
      signal: opts.signal,
      budgetMs: opts.budgetMs
    });
  }

  /**
   * Fetch raw heartbeats for a single day.
   */
  async getHeartbeats(dateOrOptions: string | HeartbeatsQueryOptions): Promise<HeartbeatsResponse> {
    const opts: HeartbeatsQueryOptions =
      typeof dateOrOptions === 'string' ? { date: dateOrOptions } : dateOrOptions;

    return this.request('/users/current/heartbeats', HeartbeatsResponseSchema, {
      method: 'GET',
      searchParams: {
        date: opts.date,
        timezone: opts.timezone
      },
      signal: opts.signal,
      budgetMs: opts.budgetMs
    });
  }

  /**
   * Fetch calculated durations for a single day.
   */
  async getDurations(dateOrOptions: string | DurationsQueryOptions): Promise<DurationsResponse> {
    const opts: DurationsQueryOptions =
      typeof dateOrOptions === 'string' ? { date: dateOrOptions } : dateOrOptions;

    return this.request('/users/current/durations', DurationsResponseSchema, {
      method: 'GET',
      searchParams: {
        date: opts.date,
        project: opts.project,
        branches: opts.branches,
        timezone: opts.timezone
      },
      signal: opts.signal,
      budgetMs: opts.budgetMs
    });
  }

  /**
   * List existing data export dumps.
   */
  async listDumps(options?: RequestCancellationOptions): Promise<DumpListResponse> {
    return this.request('/users/current/data_dumps', DumpListResponseSchema, {
      method: 'GET',
      signal: options?.signal,
      budgetMs: options?.budgetMs
    });
  }

  /**
   * Request generation of a new data dump (type: 'daily' | 'heartbeats').
   */
  async createDump(options: CreateDumpOptions): Promise<DumpStatusResponse> {
    const parseResult = CreateDumpInputSchema.safeParse(options);
    if (!parseResult.success) {
      const issueSummary = parseResult.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      throw new WakaTimeError(`Invalid dump options: ${issueSummary}`);
    }
    const validated = parseResult.data;
    const body: Record<string, unknown> = { type: validated.type };
    if (validated.email_when_finished !== undefined) {
      body.email_when_finished = validated.email_when_finished;
    }
    return this.request('/users/current/data_dumps', DumpStatusResponseSchema, {
      method: 'POST',
      body,
      signal: options?.signal,
      budgetMs: options?.budgetMs
    });
  }

  /**
   * Check status and download metadata of a specific data dump.
   */
  async getDumpStatus(
    dumpId: string,
    options?: RequestCancellationOptions
  ): Promise<DumpStatusResponse> {
    const trimmedId = dumpId?.trim();
    if (!trimmedId) {
      throw new WakaTimeError('dumpId is required for getDumpStatus');
    }
    const list = await this.listDumps(options);
    const item = list.data.find((d) => d.id === trimmedId);
    if (!item) {
      throw new WakaTimeApiError(404, `Data dump '${trimmedId}' not found`, '/users/current/data_dumps');
    }
    return { data: item };
  }

  /**
   * Fetch current authenticated user profile for account verification and discovery.
   */
  async getCurrentUser(options?: RequestCancellationOptions): Promise<CurrentUserResponse> {
    return this.request('/users/current', CurrentUserResponseSchema, {
      method: 'GET',
      signal: options?.signal,
      budgetMs: options?.budgetMs
    });
  }

  /** Fetch one documented page of the project identity registry. */
  async getProjects(
    pageOrOptions?: number | RegistryQueryOptions
  ): Promise<ProjectsResponse> {
    const opts: RegistryQueryOptions =
      typeof pageOrOptions === 'number' ? { page: pageOrOptions } : pageOrOptions ?? {};
    const page = opts.page ?? 1;

    return this.request('/users/current/projects', ProjectsResponseSchema, {
      method: 'GET',
      searchParams: { page: String(page) },
      signal: opts.signal,
      budgetMs: opts.budgetMs
    });
  }

  /** Fetch one documented page of stable machine metadata. */
  async getMachineNames(
    pageOrOptions?: number | RegistryQueryOptions
  ): Promise<MachineNamesResponse> {
    const opts: RegistryQueryOptions =
      typeof pageOrOptions === 'number' ? { page: pageOrOptions } : pageOrOptions ?? {};
    const page = opts.page ?? 1;

    return this.request('/users/current/machine_names', MachineNamesResponseSchema, {
      method: 'GET',
      searchParams: { page: String(page) },
      signal: opts.signal,
      budgetMs: opts.budgetMs
    });
  }

  /** Fetch one documented page of user-agent/editor metadata. */
  async getUserAgents(
    pageOrOptions?: number | RegistryQueryOptions
  ): Promise<UserAgentsResponse> {
    const opts: RegistryQueryOptions =
      typeof pageOrOptions === 'number' ? { page: pageOrOptions } : pageOrOptions ?? {};
    const page = opts.page ?? 1;

    return this.request('/users/current/user_agents', UserAgentsResponseSchema, {
      method: 'GET',
      searchParams: { page: String(page) },
      signal: opts.signal,
      budgetMs: opts.budgetMs
    });
  }
}
