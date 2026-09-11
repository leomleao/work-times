/**
 * WakaTime Client Error Hierarchy
 *
 * PRIVACY & REDACTION CONTRACT:
 * Errors must NEVER include:
 * - API keys, tokens, or authorization headers
 * - Response PII (emails, usernames, full names)
 * - File/entity paths
 * - Raw response bodies or SQL snippets
 */

/**
 * Strips host and query parameters from an endpoint URL or path,
 * returning only the safe pathname (e.g. "/users/current/summaries").
 */
export function sanitizeEndpoint(endpoint: string): string {
  if (!endpoint) return '';
  try {
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      const url = new URL(endpoint);
      return url.pathname;
    }
    const questionIdx = endpoint.indexOf('?');
    if (questionIdx !== -1) {
      return endpoint.substring(0, questionIdx);
    }
    const hashIdx = endpoint.indexOf('#');
    if (hashIdx !== -1) {
      return endpoint.substring(0, hashIdx);
    }
    return endpoint;
  } catch {
    return endpoint.split('?')[0].split('#')[0];
  }
}

/**
 * Sanitizes arbitrary text messages to ensure credentials, tokens, PII,
 * file paths, and raw payloads are completely redacted.
 */
export function sanitizeErrorMessage(message: string): string {
  if (!message) return '';
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]')
    .replace(/sec_[a-zA-Z0-9_-]+/g, '[REDACTED_SECRET]')
    .replace(/waka_[a-zA-Z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/(client_secret|client_id|secret|token|password)=[^&\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(/(?:\/[a-zA-Z0-9._-]+){2,}/g, '[REDACTED_PATH]')
    .replace(/(?:[a-zA-Z]:\\[a-zA-Z0-9._-]+(?:\\[a-zA-Z0-9._-]+)*)/g, '[REDACTED_PATH]')
    .replace(/\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b[\s\S]*?\b(?:FROM|INTO|TABLE|SET)\b[\s\S]*?(?:;|\n|$)/gi, '[REDACTED_SQL]')
    .replace(/['"]\s*OR\s*['"]?1['"]?\s*=\s*['"]?1/gi, '[REDACTED_SQL]')
    .replace(/\{[\s\S]*?\}/g, '[REDACTED_JSON]');
}

/**
 * Base error for all WakaTime client operations.
 */
export class WakaTimeError extends Error {
  readonly endpoint?: string;
  readonly status?: number;

  constructor(message: string, options?: { endpoint?: string; status?: number; cause?: unknown }) {
    super(sanitizeErrorMessage(message));
    this.name = 'WakaTimeError';
    this.endpoint = options?.endpoint ? sanitizeEndpoint(options.endpoint) : undefined;
    this.status = options?.status;
    if (options?.cause) {
      this.cause = options.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown on HTTP 401 Unauthorized.
 * Indicates invalid API key or revoked access. Non-retriable without refresh.
 */
export class WakaTimeAuthError extends WakaTimeError {
  constructor(endpoint?: string) {
    super('Authentication failed for WakaTime API (HTTP 401 Unauthorized)', {
      endpoint,
      status: 401
    });
    this.name = 'WakaTimeAuthError';
  }
}

/**
 * Thrown when authorization is permanently revoked (e.g. refresh token revoked/invalid).
 */
export class WakaTimeOAuthRevokedError extends WakaTimeAuthError {
  constructor(endpoint?: string) {
    super(endpoint);
    this.name = 'WakaTimeOAuthRevokedError';
  }
}

/**
 * Thrown on transient failures during token refresh (e.g. upstream 5xx or network outage).
 */
export class WakaTimeOAuthTransientError extends WakaTimeError {
  constructor(message: string, endpoint?: string, status?: number) {
    super(`Transient OAuth failure: ${message}`, { endpoint, status });
    this.name = 'WakaTimeOAuthTransientError';
  }
}

/**
 * Thrown on HTTP 402 Payment Required or HTTP 403 Forbidden on plan-gated endpoints.
 * Non-retriable. Signals capability degradation in the sync capability policy.
 */
export class CapabilityRestrictedError extends WakaTimeError {
  readonly capability: string;
  readonly statusCode: 402 | 403;

  constructor(capability: string, statusCode: 402 | 403 = 402, endpoint?: string) {
    const statusText = statusCode === 402 ? 'Payment Required' : 'Forbidden';
    super(
      `WakaTime capability '${capability}' is restricted by account plan (HTTP ${statusCode} ${statusText})`,
      { endpoint, status: statusCode }
    );
    this.name = 'CapabilityRestrictedError';
    this.capability = capability;
    this.statusCode = statusCode;
  }
}

/**
 * Thrown when data-endpoint 302 or 429 throttling exceeds maximum retry attempts.
 */
export class WakaTimeThrottleError extends WakaTimeError {
  readonly statusCode: number;
  readonly retryAfterMs?: number;
  readonly retryAt?: string;
  readonly attempts: number;

  constructor(
    statusCode: number,
    attempts: number,
    retryAfterMs?: number,
    endpoint?: string,
    retryAt?: string
  ) {
    const reason =
      statusCode === 302
        ? 'redirect throttle'
        : statusCode === 429
          ? 'rate limit'
          : `upstream error ${statusCode}`;
    super(
      `WakaTime API ${reason} exceeded (HTTP ${statusCode}) after ${attempts} attempts`,
      { endpoint, status: statusCode }
    );
    this.name = 'WakaTimeThrottleError';
    this.statusCode = statusCode;
    this.attempts = attempts;
    this.retryAfterMs = retryAfterMs;
    this.retryAt = retryAt;
  }
}

/**
 * Thrown when upstream Retry-After exceeds the current request or day budget.
 * Contains the complete, untruncated wait duration and target retry timestamp.
 */
export class WakaTimeDeferredRetryError extends WakaTimeThrottleError {
  readonly code = 'UPSTREAM_RETRY_AFTER_EXCEEDED';
  readonly isDeferred = true;
  override readonly retryAfterMs: number;
  override readonly retryAt: string;

  constructor(
    statusCode: number,
    retryAfterMs: number,
    retryAt: string,
    attempts: number,
    endpoint?: string
  ) {
    super(statusCode, attempts, retryAfterMs, endpoint, retryAt);
    this.name = 'WakaTimeDeferredRetryError';
    this.retryAfterMs = retryAfterMs;
    this.retryAt = retryAt;
  }
}

/**
 * Thrown when whole-request deadline (30s default) is exceeded.
 */
export class WakaTimeRequestTimeoutError extends WakaTimeError {
  readonly code = 'REQUEST_TIMEOUT';
  readonly timeoutMs: number;

  constructor(timeoutMs: number, endpoint?: string) {
    super(`WakaTime API request exceeded ${timeoutMs}ms deadline`, {
      endpoint,
      status: 408
    });
    this.name = 'WakaTimeRequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when the total client operation exceeds its budget deadline (5 minutes / 300,000ms default).
 */
export class WakaTimeBudgetTimeoutError extends WakaTimeError {
  readonly code = 'DAY_EXECUTION_TIMEOUT';
  readonly budgetMs: number;

  constructor(budgetMs: number, endpoint?: string) {
    super(`WakaTime API operation exceeded ${budgetMs}ms execution budget`, {
      endpoint,
      status: 408
    });
    this.name = 'WakaTimeBudgetTimeoutError';
    this.budgetMs = budgetMs;
  }
}

/**
 * Thrown when response body exceeds maximum response size (16 MiB).
 */
export class WakaTimeResponseSizeExceededError extends WakaTimeError {
  readonly code = 'RESPONSE_SIZE_EXCEEDED';
  readonly maxBytes: number;

  constructor(maxBytes: number, endpoint?: string) {
    super(`WakaTime API response exceeded maximum payload limit of ${maxBytes} bytes`, {
      endpoint,
      status: 413
    });
    this.name = 'WakaTimeResponseSizeExceededError';
    this.maxBytes = maxBytes;
  }
}

/**
 * Thrown when eligible 5xx server errors exceed maximum retry attempts (up to 3 retries).
 */
export class WakaTimeServerError extends WakaTimeError {
  readonly attempts: number;

  constructor(status: number, attempts: number, endpoint?: string) {
    super(
      `WakaTime API server error (HTTP ${status}) after ${attempts} attempts`,
      { endpoint, status }
    );
    this.name = 'WakaTimeServerError';
    this.attempts = attempts;
  }
}

/**
 * Thrown when a network transport failure occurs (e.g. connection refused, timeout).
 */
export class WakaTimeNetworkError extends WakaTimeError {
  constructor(message: string, endpoint?: string, cause?: unknown) {
    super(`WakaTime network error: ${sanitizeErrorMessage(message)}`, { endpoint, cause });
    this.name = 'WakaTimeNetworkError';
  }
}

/**
 * Thrown when an API response body fails JSON parsing or schema validation.
 * Raw bodies and entity paths are strictly omitted.
 */
export class WakaTimeParseError extends WakaTimeError {
  constructor(message: string, endpoint?: string) {
    super(`WakaTime response validation error: ${sanitizeErrorMessage(message)}`, { endpoint });
    this.name = 'WakaTimeParseError';
  }
}

/**
 * Thrown for other non-success HTTP status codes (e.g. 400 Bad Request, 404 Not Found).
 */
export class WakaTimeApiError extends WakaTimeError {
  constructor(status: number, statusText: string, endpoint?: string) {
    super(`WakaTime API error (HTTP ${status} ${sanitizeErrorMessage(statusText)})`, {
      endpoint,
      status
    });
    this.name = 'WakaTimeApiError';
  }
}
