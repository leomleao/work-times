/**
 * WakaTime Client Error Hierarchy
 *
 * PRIVACY & REDACTION CONTRACT:
 * Errors must NEVER include:
 * - API keys, tokens, or authorization headers
 * - Response PII (emails, usernames, full names)
 * - File/entity paths
 * - Raw response bodies
 */

/**
 * Strips host and query parameters from an endpoint URL or path,
 * returning only the safe pathname (e.g. "/users/current/summaries").
 */
export function sanitizeEndpoint(endpoint: string): string {
  if (!endpoint) return '';
  try {
    // If it's a full URL
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      const url = new URL(endpoint);
      return url.pathname;
    }
    // If it's a relative path with query
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
    // Fallback: strip after ? or #
    return endpoint.split('?')[0].split('#')[0];
  }
}

/**
 * Base error for all WakaTime client operations.
 */
export class WakaTimeError extends Error {
  readonly endpoint?: string;
  readonly status?: number;

  constructor(message: string, options?: { endpoint?: string; status?: number; cause?: unknown }) {
    super(message);
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
 * Indicates invalid API key or revoked access. Non-retriable.
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
  readonly statusCode: 302 | 429;
  readonly retryAfterMs?: number;
  readonly attempts: number;

  constructor(statusCode: 302 | 429, attempts: number, retryAfterMs?: number, endpoint?: string) {
    const reason = statusCode === 302 ? 'redirect throttle' : 'rate limit';
    super(
      `WakaTime API ${reason} exceeded (HTTP ${statusCode}) after ${attempts} attempts`,
      { endpoint, status: statusCode }
    );
    this.name = 'WakaTimeThrottleError';
    this.statusCode = statusCode;
    this.attempts = attempts;
    this.retryAfterMs = retryAfterMs;
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
    // Sanitize network message to avoid leaking any sensitive tokens or full urls with query params
    const sanitizedMsg = message
      .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]');
    super(`WakaTime network error: ${sanitizedMsg}`, { endpoint, cause });
    this.name = 'WakaTimeNetworkError';
  }
}

/**
 * Thrown when an API response body fails JSON parsing or schema validation.
 * Raw bodies and entity paths are strictly omitted.
 */
export class WakaTimeParseError extends WakaTimeError {
  constructor(message: string, endpoint?: string) {
    super(`WakaTime response validation error: ${message}`, { endpoint });
    this.name = 'WakaTimeParseError';
  }
}

/**
 * Thrown for other non-success HTTP status codes (e.g. 400 Bad Request, 404 Not Found).
 */
export class WakaTimeApiError extends WakaTimeError {
  constructor(status: number, statusText: string, endpoint?: string) {
    super(`WakaTime API error (HTTP ${status} ${statusText})`, {
      endpoint,
      status
    });
    this.name = 'WakaTimeApiError';
  }
}
