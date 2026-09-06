import { z } from 'zod';
import {
  WakaTimeError,
  WakaTimeAuthError,
  CapabilityRestrictedError,
  WakaTimeThrottleError,
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
  CreateDumpInputSchema,
  type DumpType
} from './schemas.js';

export interface WakaTimeClientOptions {
  /** WakaTime API key. Must not be empty. */
  apiKey: string;
  /** Base URL for the WakaTime API (default: 'https://api.wakatime.com/api/v1'). */
  baseUrl?: string;
  /** Injectable fetch implementation for tests or custom dispatch. */
  fetch?: typeof fetch;
  /** Injectable sleep function for deterministic test execution. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable random generator for deterministic jitter in tests. */
  random?: () => number;
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

export interface SummariesQueryOptions {
  start: string; // "YYYY-MM-DD"
  end: string; // "YYYY-MM-DD"
  project?: string;
  branches?: string;
  timezone?: string;
}

export interface HeartbeatsQueryOptions {
  date: string; // "YYYY-MM-DD"
  timezone?: string;
}

export interface DurationsQueryOptions {
  date: string; // "YYYY-MM-DD"
  project?: string;
  branches?: string;
  timezone?: string;
}

export type { DumpType } from './schemas.js';

export interface CreateDumpOptions {
  type: DumpType;
  email_when_finished?: boolean;
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
 * Dump-independent WakaTime HTTP Client.
 *
 * Enforces:
 * - Basic auth using base64 of the API key itself, never query-string auth.
 * - redirect: 'manual'
 * - Treating data-endpoint 302 and 429 as throttling with bounded exponential backoff/jitter and Retry-After.
 * - Retrying eligible 5xx up to 3 times.
 * - Treating 401 as non-retriable authentication failure.
 * - Surfacing 402/403 as non-retriable CapabilityRestrictedError.
 * - Absolute omission of API keys, PII, entity paths, and raw bodies in errors/logs.
 * - Injectable sleep/random/fetch for deterministic tests.
 */
export class WakaTimeClient {
  #apiKey: string;
  readonly baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly maxRetries5xx: number;
  readonly maxThrottleRetries: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly jitterMs: number;

  constructor(options: WakaTimeClientOptions) {
    const trimmedKey = options.apiKey?.trim();
    if (!trimmedKey) {
      throw new WakaTimeError('API key is required for WakaTimeClient');
    }
    this.#apiKey = trimmedKey;
    this.baseUrl = (options.baseUrl || 'https://api.wakatime.com/api/v1').replace(/\/+$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
    this.maxRetries5xx = options.maxRetries5xx ?? 3;
    this.maxThrottleRetries = options.maxThrottleRetries ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.jitterMs = options.jitterMs ?? 500;
  }

  /**
   * Safe serialization to ensure credentials are never leaked.
   */
  toJSON(): Record<string, unknown> {
    return {
      baseUrl: this.baseUrl,
      maxRetries5xx: this.maxRetries5xx,
      maxThrottleRetries: this.maxThrottleRetries
    };
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
   * Internal request dispatcher with manual redirect, throttling, and retry policies.
   */
  private async request<T>(
    endpointPath: string,
    schema: z.ZodType<T>,
    init?: {
      method?: string;
      body?: unknown;
      searchParams?: Record<string, string | undefined>;
    }
  ): Promise<T> {
    // Build URL ensuring query params NEVER include api_key or secrets
    const url = new URL(`${this.baseUrl}${endpointPath.startsWith('/') ? '' : '/'}${endpointPath}`);
    if (init?.searchParams) {
      for (const [k, v] of Object.entries(init.searchParams)) {
        if (v !== undefined && k !== 'api_key' && k !== 'apiKey') {
          url.searchParams.set(k, v);
        }
      }
    }

    // Prepare Basic authorization: base64 of the API key itself (official docs requirement)
    const basicAuth = Buffer.from(this.#apiKey).toString('base64');
    const headers: Record<string, string> = {
      Authorization: `Basic ${basicAuth}`,
      Accept: 'application/json'
    };

    let requestBody: string | undefined;
    if (init?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(init.body);
    }

    let retries5xx = 0;
    let throttleRetries = 0;

    while (true) {
      let response: Response;
      try {
        response = await this.#fetch(url.toString(), {
          method: init?.method ?? 'GET',
          headers,
          body: requestBody,
          redirect: 'manual'
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Fetch failed';
        throw new WakaTimeNetworkError(msg, url.pathname, err);
      }

      const status = response.status;

      // 1. Success responses
      if (status >= 200 && status < 300) {
        let json: unknown;
        try {
          json = await response.json();
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
        if (throttleRetries >= this.maxThrottleRetries) {
          const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
          throw new WakaTimeThrottleError(status, throttleRetries, retryAfterMs ?? undefined, url.pathname);
        }

        const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
        const delay =
          retryAfterMs !== null && retryAfterMs > 0
            ? Math.min(this.maxBackoffMs, retryAfterMs)
            : this.computeBackoffDelay(throttleRetries);

        throttleRetries++;
        await this.#sleep(delay);
        continue;
      }

      // 3. Authentication failure: treat 401 as non-retriable authentication failure
      if (status === 401) {
        throw new WakaTimeAuthError(url.pathname);
      }

      // 4. Capability restriction: surface 402/403 as a non-retriable CapabilityRestrictedError
      if (status === 402 || status === 403) {
        const capability = inferCapability(url.pathname);
        throw new CapabilityRestrictedError(capability, status, url.pathname);
      }

      // 5. Server errors: retry eligible 5xx up to 3 times
      if (status >= 500 && status <= 599) {
        if (retries5xx >= this.maxRetries5xx) {
          throw new WakaTimeServerError(status, retries5xx, url.pathname);
        }

        const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
        const delay =
          retryAfterMs !== null && retryAfterMs > 0
            ? Math.min(this.maxBackoffMs, retryAfterMs)
            : this.computeBackoffDelay(retries5xx);

        retries5xx++;
        await this.#sleep(delay);
        continue;
      }

      // 6. Other non-success status codes (e.g. 400, 404)
      throw new WakaTimeApiError(status, response.statusText || 'API Request Failed', url.pathname);
    }
  }

  // ==========================================
  // Typed API Methods
  // ==========================================

  /**
   * Fetch daily summaries for a date range.
   * Supports either an options object or positional start/end strings.
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
      }
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
      }
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
      }
    });
  }

  /**
   * List existing data export dumps.
   */
  async listDumps(): Promise<DumpListResponse> {
    return this.request('/users/current/data_dumps', DumpListResponseSchema, {
      method: 'GET'
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
      body
    });
  }

  /**
   * Check status and download metadata of a specific data dump.
   *
   * Note: The official WakaTime API exposes only GET /users/current/data_dumps and
   * POST /users/current/data_dumps; it does not provide GET /data_dumps/:id.
   * This refetches the documented list and finds the matching dump ID locally.
   */
  async getDumpStatus(dumpId: string): Promise<DumpStatusResponse> {
    const trimmedId = dumpId?.trim();
    if (!trimmedId) {
      throw new WakaTimeError('dumpId is required for getDumpStatus');
    }
    const list = await this.listDumps();
    const item = list.data.find((d) => d.id === trimmedId);
    if (!item) {
      throw new WakaTimeApiError(404, `Data dump '${trimmedId}' not found`, '/users/current/data_dumps');
    }
    return { data: item };
  }

  /**
   * Fetch current authenticated user profile for account verification and discovery.
   */
  async getCurrentUser(): Promise<CurrentUserResponse> {
    return this.request('/users/current', CurrentUserResponseSchema, {
      method: 'GET'
    });
  }
}
