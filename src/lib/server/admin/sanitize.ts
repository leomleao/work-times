import type {
  CapabilityPolicyState,
  CapabilityRecord,
  SyncCapability
} from '../sync/capabilities.js';

/**
 * Bounds and allowlists for values the admin view models read back out of SQLite.
 *
 * Rows in `source_imports`, `sync_runs`, `sync_days` and `app_settings` are
 * written from WakaTime payloads and from sync/import failure paths, so their
 * free-text and JSON columns are untrusted from the admin UI's point of view:
 * a `CHECK` constraint can be dropped by a future migration, and a diagnostic
 * string can be arbitrarily long. Every value that reaches a view model passes
 * through one of these helpers so the page renders a bounded, known-shaped
 * payload rather than whatever happens to be on the row.
 */

/** Status values `source_imports.status` is constrained to (migration 001). */
export const SOURCE_IMPORT_STATUSES = ['running', 'completed', 'failed'] as const;
export type SourceImportStatus = (typeof SOURCE_IMPORT_STATUSES)[number];

/** Source kinds `source_imports.source_type` is constrained to (migration 001). */
export const SOURCE_IMPORT_TYPES = [
  'daily_dump',
  'heartbeat_dump',
  'api_summaries',
  'api_heartbeats'
] as const;
export type SourceImportType = (typeof SOURCE_IMPORT_TYPES)[number];

/** Status values `sync_runs.status` is constrained to (migration 002). */
export const SYNC_RUN_STATUSES = ['running', 'succeeded', 'partial', 'failed'] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

/** Trigger values `sync_runs.trigger` is constrained to (migration 002). */
export const SYNC_RUN_TRIGGERS = ['manual', 'scheduled', 'startup', 'catchup'] as const;
export type SyncRunTrigger = (typeof SYNC_RUN_TRIGGERS)[number];

/** Status values `sync_days.status` is constrained to (migration 002). */
export const SYNC_DAY_STATUSES = [
  'pending',
  'succeeded',
  'partial',
  'failed',
  'skipped'
] as const;
export type SyncDayStatus = (typeof SYNC_DAY_STATUSES)[number];

/** Status values the per-capability `sync_days.*_status` columns are constrained to. */
export const SYNC_STEP_STATUSES = ['succeeded', 'failed', 'restricted', 'skipped'] as const;
export type SyncStepStatus = (typeof SYNC_STEP_STATUSES)[number];

/** Capabilities tracked by the persisted capability policy state. */
export const SYNC_CAPABILITIES: readonly SyncCapability[] = [
  'summaries',
  'durations',
  'heartbeats'
] as const;

/** Lifecycle states a capability record may report. */
export const CAPABILITY_STATUSES = ['available', 'restricted', 'untested', 'error'] as const;

/**
 * Fallback substituted for a persisted status outside its allowlist. Rendering
 * `unknown` is truthful; guessing a real status would not be.
 */
export const UNKNOWN_STATUS = 'unknown';

/** Maximum length for a persisted diagnostic string (summary, error, warning). */
export const MAX_DIAGNOSTIC_LENGTH = 500;
/** Maximum length for a short persisted label (timestamp, name, code, plan). */
export const MAX_LABEL_LENGTH = 120;
/** Maximum number of entries kept from a persisted string list. */
export const MAX_LIST_ITEMS = 25;
/** Number of leading hex characters disclosed from a content hash. */
export const SOURCE_HASH_PREFIX_LENGTH = 12;

/**
 * Coerce to a member of `allowed`, or to `fallback`.
 *
 * Non-strings and unrecognized strings both collapse to the fallback: a status
 * the UI cannot map to a badge is reported as unknown rather than passed
 * through for the template to style arbitrarily.
 */
export function allowlistedValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: string = UNKNOWN_STATUS
): T | string {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** As `allowlistedValue`, but preserves SQL `NULL` instead of reporting unknown. */
export function allowlistedNullableValue<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T | string | null {
  if (value === null || value === undefined) return null;
  return allowlistedValue(value, allowed);
}

/**
 * Render an untrusted value as a bounded single-line string.
 *
 * Control characters are stripped so a persisted diagnostic cannot smuggle
 * newlines or terminal escapes into the page, and the result is hard-truncated
 * with an ellipsis so one oversized row cannot dominate the response.
 */
export function truncateText(value: unknown, maxLength = MAX_DIAGNOSTIC_LENGTH): string {
  if (value === null || value === undefined) return '';
  const cleaned = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/** As `truncateText`, but maps an absent or empty value to `null`. */
export function truncateNullableText(
  value: unknown,
  maxLength = MAX_DIAGNOSTIC_LENGTH
): string | null {
  if (value === null || value === undefined) return null;
  const text = truncateText(value, maxLength);
  return text.length > 0 ? text : null;
}

/** Clamp a persisted counter to a non-negative safe integer. */
export function clampCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);
}

/** Clamp a persisted duration to a non-negative finite number of seconds. */
export function clampSeconds(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/**
 * Bound an untrusted list: drop empties, truncate each entry, cap the count.
 */
export function boundedStringList(
  values: readonly unknown[],
  maxItems = MAX_LIST_ITEMS,
  maxLength = MAX_LABEL_LENGTH
): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (out.length >= maxItems) break;
    const text = truncateText(value, maxLength);
    if (text.length > 0) out.push(text);
  }
  return out;
}

/** Split a persisted comma-separated code list into a bounded string list. */
export function boundedCsvList(
  value: unknown,
  maxItems = MAX_LIST_ITEMS,
  maxLength = MAX_LABEL_LENGTH
): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  return boundedStringList(value.split(','), maxItems, maxLength);
}

/**
 * Disclose only the leading hex characters of a content hash.
 *
 * The full SHA-256 of an import payload is a stable fingerprint of the exact
 * bytes ingested; the prefix is enough to correlate rows in the ledger, so the
 * remainder never reaches the page. A value that is not lowercase hex is
 * reported as unknown rather than partially echoed.
 */
export function sourceHashPrefix(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/.test(value)) return UNKNOWN_STATUS;
  return value.slice(0, SOURCE_HASH_PREFIX_LENGTH);
}

/**
 * Validate a persisted capability policy state before the sync page reads it.
 *
 * `app_settings.capability_policy_state` and `sync_runs.policy_state_json` hold
 * opaque JSON. Parsing alone would let an arbitrary object be cast to
 * `CapabilityPolicyState`; this rebuilds the record field by field so the page
 * only ever sees known capabilities with allowlisted statuses and bounded
 * strings, and returns `null` when the payload is not that shape.
 */
export function parseCapabilityPolicyState(raw: unknown): CapabilityPolicyState | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const rawCapabilities = source.capabilities;
  if (typeof rawCapabilities !== 'object' || rawCapabilities === null) return null;

  const capabilityRecords = rawCapabilities as Record<string, unknown>;
  const capabilities = {} as Record<SyncCapability, CapabilityRecord>;
  let recognized = 0;

  for (const capability of SYNC_CAPABILITIES) {
    const record = capabilityRecords[capability];
    if (typeof record !== 'object' || record === null) continue;
    const fields = record as Record<string, unknown>;

    const entry: CapabilityRecord = {
      capability,
      status: allowlistedValue(
        fields.status,
        CAPABILITY_STATUSES,
        'untested'
      ) as CapabilityRecord['status'],
      lastProbedAt: truncateNullableText(fields.lastProbedAt, MAX_LABEL_LENGTH),
      lastSuccessAt: truncateNullableText(fields.lastSuccessAt, MAX_LABEL_LENGTH),
      nextReprobeAt: truncateNullableText(fields.nextReprobeAt, MAX_LABEL_LENGTH)
    };

    const restrictionCode = truncateNullableText(fields.restrictionCode, MAX_LABEL_LENGTH);
    if (restrictionCode) entry.restrictionCode = restrictionCode;
    const errorMessage = truncateNullableText(fields.errorMessage, MAX_DIAGNOSTIC_LENGTH);
    if (errorMessage) entry.errorMessage = errorMessage;

    capabilities[capability] = entry;
    recognized += 1;
  }

  if (recognized === 0) return null;

  return {
    capabilities,
    updatedAt: truncateText(source.updatedAt, MAX_LABEL_LENGTH)
  };
}
