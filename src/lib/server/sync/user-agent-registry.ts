import {
  MAX_REGISTRY_BYTES,
  MAX_REGISTRY_PAGES,
  MAX_REGISTRY_ROWS,
  RECONCILE_CODES
} from './contracts.js';
import type {
  UserAgentRegistryEntry
} from './repository.js';
import type { UserAgentsResponse } from '../wakatime/schemas.js';

export {
  MAX_REGISTRY_BYTES,
  MAX_REGISTRY_PAGES,
  MAX_REGISTRY_ROWS
};

export class RegistryRefreshError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'RegistryRefreshError';
  }
}

export interface RegistryClient {
  getUserAgents(pageOrOptions?: number | {
    page?: number;
    signal?: AbortSignal;
    budgetMs?: number;
  }): Promise<UserAgentsResponse>;
}

export interface SyncRegistryRepository {
  clearRegistryStaging(): void;
  stageRegistryEntries(entries: UserAgentRegistryEntry[]): void;
  publishRegistryStaging(expectedConnectionGeneration: number): { publishedCount: number; historicalCount: number };
  getRegistryEntry(id: string): UserAgentRegistryEntry | null;
  listRegistryEntries(options?: { includeHistorical?: boolean }): UserAgentRegistryEntry[];
  getSyncSettings(): {
    schedulingEnabled: boolean;
    connectionGeneration: number;
    boundArchiveIdentity: string | null;
  };
}

export interface RegistryRefreshOptions {
  client: RegistryClient;
  repository: SyncRegistryRepository;
  classificationService?: {
    invalidateIdentityCaches(): void;
    clearCaches?(): void;
  };
  expectedConnectionGeneration?: number;
  signal?: AbortSignal;
  budgetMs?: number;
  now?: () => string;
}

export interface RegistryRefreshResult {
  publishedCount: number;
  historicalCount: number;
  pageCount: number;
  rowCount: number;
  refreshedAt: string;
}

/**
 * Extracts strictly allowlisted fields from raw user-agent item for privacy and persistence.
 *
 * Persists ONLY:
 * - id: canonical UUID
 * - editor: editor friendly name
 * - userAgentValue: raw user agent string
 * - os: operating system name
 * - version: optional version string
 * - aiModel: optional AI model name
 * - aiModelVersion: optional AI model version
 * - aiModelComplexity: optional AI model complexity
 * - isBrowserExtension: boolean flag
 * - isDesktopApp: boolean flag
 * - firstSeenAt: source first seen timestamp (from created_at or first_seen_at)
 * - lastSeenAt: source last seen timestamp
 * - refreshedAt: separate refresh execution timestamp
 *
 * All non-allowlisted properties (e.g. IP addresses, user IDs, internal tokens, emails) are discarded.
 */
export function extractAllowlistedRegistryEntry(
  raw: unknown,
  refreshedAt: string
): UserAgentRegistryEntry {
  if (!raw || typeof raw !== 'object') {
    throw new RegistryRefreshError(
      RECONCILE_CODES.REGISTRY_INVALID_PAGINATION,
      'Invalid registry entry payload: expected object'
    );
  }

  const item = raw as Record<string, unknown>;

  const id = typeof item.id === 'string' ? item.id.trim() : '';
  if (!id) {
    throw new RegistryRefreshError(
      RECONCILE_CODES.REGISTRY_INVALID_PAGINATION,
      'Registry item missing canonical id'
    );
  }

  const editor = typeof item.editor === 'string' ? item.editor.trim() : '';
  if (!editor) {
    throw new RegistryRefreshError(
      RECONCILE_CODES.REGISTRY_INVALID_PAGINATION,
      `Registry item ${id} missing editor name`
    );
  }

  const userAgentValue =
    typeof item.value === 'string'
      ? item.value
      : typeof item.user_agent_value === 'string'
        ? item.user_agent_value
        : '';

  const os = typeof item.os === 'string' ? item.os : '';

  const version = typeof item.version === 'string' ? item.version : null;
  const aiModel = typeof item.ai_model === 'string' ? item.ai_model : null;
  const aiModelVersion =
    typeof item.ai_model_version === 'string' ? item.ai_model_version : null;
  const aiModelComplexity =
    typeof item.ai_model_complexity === 'string' ? item.ai_model_complexity : null;

  const rawBrowserExt =
    item.is_browser_extension !== undefined ? item.is_browser_extension : item.isBrowserExtension;
  let isBrowserExtension = false;
  if (rawBrowserExt !== undefined && rawBrowserExt !== null) {
    if (typeof rawBrowserExt !== 'boolean') {
      throw new RegistryRefreshError(
        RECONCILE_CODES.REGISTRY_INVALID_PAGINATION,
        `Registry item ${id} has malformed is_browser_extension flag: expected boolean, got ${typeof rawBrowserExt}`
      );
    }
    isBrowserExtension = rawBrowserExt;
  }

  const rawDesktopApp =
    item.is_desktop_app !== undefined ? item.is_desktop_app : item.isDesktopApp;
  let isDesktopApp = false;
  if (rawDesktopApp !== undefined && rawDesktopApp !== null) {
    if (typeof rawDesktopApp !== 'boolean') {
      throw new RegistryRefreshError(
        RECONCILE_CODES.REGISTRY_INVALID_PAGINATION,
        `Registry item ${id} has malformed is_desktop_app flag: expected boolean, got ${typeof rawDesktopApp}`
      );
    }
    isDesktopApp = rawDesktopApp;
  }

  const firstSeenAt =
    typeof item.created_at === 'string'
      ? item.created_at
      : typeof item.first_seen_at === 'string'
        ? item.first_seen_at
        : null;

  const lastSeenAt = typeof item.last_seen_at === 'string' ? item.last_seen_at : null;

  return {
    id,
    editor,
    userAgentValue,
    os,
    version,
    aiModel,
    aiModelVersion,
    aiModelComplexity,
    isBrowserExtension,
    isDesktopApp,
    firstSeenAt,
    lastSeenAt,
    isHistorical: false,
    refreshedAt
  };
}

function isSafePositiveInteger(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 1;
}

function isSafeNonNegativeInteger(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0;
}

/**
 * Refreshes user-agent registry authoritatively from upstream WakaTime API:
 * 1. Bounded retrieval: max 100 pages, 10,000 rows, 16 MiB payload budget.
 * 2. Strict pagination validation: detects repeated pages, loops, invalid envelope ranges,
 *    and duplicate conflicting UUID attributes.
 * 3. Atomic publication: stages all validated pages in memory first, then writes and publishes
 *    in a single database transaction.
 * 4. Failure preservation: on any error (final-page failure, cancellation, limits, network,
 *    stale generation), staging is cleared and previously published registry remains unchanged.
 * 5. Historical retention: absent UUIDs are marked is_historical = 1 and preserved.
 * 6. Cache invalidation: invalidates classification identity caches (editor and machine) after commit.
 */
export async function refreshUserAgentRegistry(
  options: RegistryRefreshOptions
): Promise<RegistryRefreshResult> {
  const nowFn = options.now ?? (() => new Date().toISOString());
  const refreshTimestamp = nowFn();

  // 1. Check early cancellation
  if (options.signal?.aborted) {
    throw new RegistryRefreshError(
      RECONCILE_CODES.RUN_CANCELLED,
      'Registry refresh cancelled before start'
    );
  }

  // 2. Validate initial connection generation
  const initialSettings = options.repository.getSyncSettings();
  const initialGen = initialSettings.connectionGeneration;
  const targetGen = options.expectedConnectionGeneration ?? initialGen;
  if (initialGen !== targetGen) {
    throw new RegistryRefreshError(
      RECONCILE_CODES.STALE_CONNECTION_GENERATION,
      `Stale connection generation before refresh: current=${initialGen}, expected=${targetGen}`
    );
  }

  const visitedPages = new Set<number>();
  const seenEntriesById = new Map<string, UserAgentRegistryEntry>();
  let currentPage = 1;
  let totalBytes = 0;
  let totalRows = 0;

  // 3. Paged retrieval and whole-publication validation outside write transaction
  while (true) {
    if (options.signal?.aborted) {
      throw new RegistryRefreshError(
        RECONCILE_CODES.RUN_CANCELLED,
        'Registry refresh cancelled during page fetch'
      );
    }

    if (currentPage > MAX_REGISTRY_PAGES) {
      throw new RegistryRefreshError(
        RECONCILE_CODES.REGISTRY_PAGE_LIMIT_EXCEEDED,
        `Registry page limit exceeded: page ${currentPage} > ${MAX_REGISTRY_PAGES}`
      );
    }

    if (visitedPages.has(currentPage)) {
      throw new RegistryRefreshError(
        RECONCILE_CODES.REGISTRY_PAGE_REPETITION,
        `Registry page repetition: page ${currentPage} already visited`
      );
    }

    let response: UserAgentsResponse;
    try {
      response = await options.client.getUserAgents({
        page: currentPage,
        signal: options.signal,
        budgetMs: options.budgetMs
      });
    } catch (err: unknown) {
      if (options.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new RegistryRefreshError(
          RECONCILE_CODES.RUN_CANCELLED,
          'Registry refresh cancelled during request'
        );
      }
      throw err;
    }

    // Measure JSON payload bytes
    const pageBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
    totalBytes += pageBytes;
    if (totalBytes > MAX_REGISTRY_BYTES) {
      throw new RegistryRefreshError(
        RECONCILE_CODES.REGISTRY_BYTE_LIMIT_EXCEEDED,
        `Registry byte limit exceeded: total ${totalBytes} bytes > ${MAX_REGISTRY_BYTES} bytes`
      );
    }

    // Validate pagination envelope numbers
    if (
      typeof response !== 'object' ||
      response === null ||
      !isSafePositiveInteger(response.page) ||
      !isSafeNonNegativeInteger(response.total_pages) ||
      !isSafeNonNegativeInteger(response.total)
    ) {
      throw new RegistryRefreshError(
        RECONCILE_CODES.REGISTRY_INVALID_PAGINATION,
        `Invalid registry response envelope pagination: page=${response?.page}, total_pages=${response?.total_pages}, total=${response?.total}`
      );
    }

    if (response.page !== currentPage) {
      throw new RegistryRefreshError(
        RECONCILE_CODES.REGISTRY_INVALID_PAGINATION,
        `Pagination page mismatch: requested page ${currentPage}, response indicated page ${response.page}`
      );
    }

    if (response.total_pages > MAX_REGISTRY_PAGES) {
      throw new RegistryRefreshError(
        RECONCILE_CODES.REGISTRY_PAGE_LIMIT_EXCEEDED,
        `Registry total_pages ${response.total_pages} exceeds limit ${MAX_REGISTRY_PAGES}`
      );
    }

    if (response.page > response.total_pages && !(response.total_pages === 0 && (!response.data || response.data.length === 0))) {
      throw new RegistryRefreshError(
        RECONCILE_CODES.REGISTRY_INVALID_PAGINATION,
        `Registry page ${response.page} exceeds total_pages ${response.total_pages}`
      );
    }

    visitedPages.add(response.page);

    // Validate next_page pointer
    if (response.next_page !== null && response.next_page !== undefined) {
      if (!isSafePositiveInteger(response.next_page)) {
        throw new RegistryRefreshError(
          RECONCILE_CODES.REGISTRY_INVALID_PAGINATION,
          `Invalid next_page pointer: ${response.next_page}`
        );
      }

      if (visitedPages.has(response.next_page)) {
        throw new RegistryRefreshError(
          RECONCILE_CODES.REGISTRY_PAGE_REPETITION,
          `Registry page repetition loop: next_page ${response.next_page} was already visited`
        );
      }

      if (response.next_page <= response.page) {
        throw new RegistryRefreshError(
          RECONCILE_CODES.REGISTRY_PAGE_REPETITION,
          `Registry page repetition: next_page ${response.next_page} does not advance past current page ${response.page}`
        );
      }

      if (response.next_page > response.total_pages) {
        throw new RegistryRefreshError(
          RECONCILE_CODES.REGISTRY_INVALID_PAGINATION,
          `Registry next_page ${response.next_page} exceeds total_pages ${response.total_pages}`
        );
      }
    }

    if (response.prev_page !== null && response.prev_page !== undefined) {
      if (!isSafePositiveInteger(response.prev_page)) {
        throw new RegistryRefreshError(
          RECONCILE_CODES.REGISTRY_INVALID_PAGINATION,
          `Invalid prev_page pointer: ${response.prev_page}`
        );
      }
    }

    if (response.page < response.total_pages && (response.next_page === null || response.next_page === undefined)) {
      throw new RegistryRefreshError(
        RECONCILE_CODES.REGISTRY_INVALID_PAGINATION,
        `Registry missing next_page when page ${response.page} < total_pages ${response.total_pages}`
      );
    }

    // Process rows
    if (!Array.isArray(response.data)) {
      throw new RegistryRefreshError(
        RECONCILE_CODES.REGISTRY_INVALID_PAGINATION,
        'Expected response.data to be an array'
      );
    }

    for (const rawItem of response.data) {
      totalRows++;
      if (totalRows > MAX_REGISTRY_ROWS) {
        throw new RegistryRefreshError(
          RECONCILE_CODES.REGISTRY_ROW_LIMIT_EXCEEDED,
          `Registry row limit exceeded: ${totalRows} rows > ${MAX_REGISTRY_ROWS}`
        );
      }

      const entry = extractAllowlistedRegistryEntry(rawItem, refreshTimestamp);

      if (seenEntriesById.has(entry.id)) {
        const existing = seenEntriesById.get(entry.id)!;
        const hasConflict =
          existing.editor !== entry.editor ||
          existing.userAgentValue !== entry.userAgentValue ||
          existing.os !== entry.os ||
          existing.version !== entry.version ||
          existing.aiModel !== entry.aiModel ||
          existing.aiModelVersion !== entry.aiModelVersion ||
          existing.aiModelComplexity !== entry.aiModelComplexity ||
          existing.isBrowserExtension !== entry.isBrowserExtension ||
          existing.isDesktopApp !== entry.isDesktopApp;

        if (hasConflict) {
          throw new RegistryRefreshError(
            RECONCILE_CODES.REGISTRY_CONFLICTING_ID,
            `Conflicting attributes for user agent ID ${entry.id}`
          );
        }

        // Consistent duplicate: merge timestamps
        if (entry.lastSeenAt && (!existing.lastSeenAt || entry.lastSeenAt > existing.lastSeenAt)) {
          existing.lastSeenAt = entry.lastSeenAt;
        }
        if (entry.firstSeenAt && (!existing.firstSeenAt || entry.firstSeenAt < existing.firstSeenAt)) {
          existing.firstSeenAt = entry.firstSeenAt;
        }
      } else {
        seenEntriesById.set(entry.id, entry);
      }
    }

    // Advance or break
    if (response.page < response.total_pages && response.next_page) {
      currentPage = response.next_page;
    } else {
      break;
    }
  }

  // 4. Pre-publication checks: cancellation and connection generation CAS
  if (options.signal?.aborted) {
    throw new RegistryRefreshError(
      RECONCILE_CODES.RUN_CANCELLED,
      'Registry refresh cancelled before atomic publication'
    );
  }

  const postSettings = options.repository.getSyncSettings();
  if (postSettings.connectionGeneration !== targetGen) {
    throw new RegistryRefreshError(
      RECONCILE_CODES.STALE_CONNECTION_GENERATION,
      `Stale connection generation before commit: current=${postSettings.connectionGeneration}, expected=${targetGen}`
    );
  }

  // 5. Atomic publication: stage entries and commit atomically
  try {
    options.repository.clearRegistryStaging();
    const entriesToPublish = Array.from(seenEntriesById.values());
    options.repository.stageRegistryEntries(entriesToPublish);
    const publishStats = options.repository.publishRegistryStaging(targetGen);

    // 6. Invalidate identity caches after commit
    options.classificationService?.invalidateIdentityCaches();

    return {
      publishedCount: publishStats.publishedCount,
      historicalCount: publishStats.historicalCount,
      pageCount: visitedPages.size,
      rowCount: entriesToPublish.length,
      refreshedAt: refreshTimestamp
    };
  } catch (err: unknown) {
    // Ensure staging is cleaned up so no partial state survives
    try {
      options.repository.clearRegistryStaging();
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}
