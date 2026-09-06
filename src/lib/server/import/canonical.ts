import { createHash } from 'node:crypto';
import type { SliceSelectorType } from '../db/schema.js';

/**
 * Canonicalization and redaction helpers.
 *
 * Two properties matter here and are load-bearing for the whole importer:
 *
 *   1. Determinism. The canonical form of a heartbeat must not depend on JSON
 *      key order or dependency array order, so that the 42 duplicated
 *      heartbeat IDs in the export collapse to exact duplicates instead of
 *      looking like payload conflicts.
 *   2. Redaction. Entity paths, machine IDs, user-agent IDs and user IDs are
 *      PII (DUMP-DATA-CONTRACT §11) and must never reach a log line or an
 *      error message intact.
 */

/** Deterministic ordinal comparator, independent of host locale. */
function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Canonical dependency array: trimmed, empties dropped, deduplicated, sorted
 * by a fixed ordinal comparator.
 *
 * Dependencies are semantically a set in this archive, so array order carries
 * no information — collapsing it is what makes a re-ordered duplicate an exact
 * duplicate rather than a conflict.
 */
export function canonicalizeDependencies(dependencies: readonly unknown[]): string[] {
  const unique = new Set<string>();

  for (const dependency of dependencies) {
    if (typeof dependency !== 'string') {
      throw new TypeError(`Dependency entries must be strings, received ${typeof dependency}`);
    }
    const trimmed = dependency.trim().normalize('NFC');
    if (trimmed.length > 0) unique.add(trimmed);
  }

  return [...unique].sort(ordinal);
}

/**
 * Stable JSON serialization: object keys emitted in ordinal order at every
 * depth, arrays left in place. `undefined` members are dropped the way
 * JSON.stringify drops them.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(stabilize(value));
}

function stabilize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stabilize);
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(ordinal)) {
    if (source[key] === undefined) continue;
    result[key] = stabilize(source[key]);
  }
  return result;
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Canonical payload hash for a heartbeat: stable key order plus a canonical
 * dependency array. Two records with this same hash are the same record.
 */
export function canonicalPayloadHash(payload: Record<string, unknown>): string {
  return sha256Hex(stableStringify(payload));
}

/**
 * Build the canonical payload object for a raw heartbeat: every source field
 * preserved losslessly, with `dependencies` replaced by its canonical form.
 */
export function canonicalHeartbeatPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const dependencies = Array.isArray(raw.dependencies) ? raw.dependencies : [];
  return stabilize({ ...raw, dependencies: canonicalizeDependencies(dependencies) }) as Record<
    string,
    unknown
  >;
}

/**
 * Normalize an entity value.
 *
 * Files: backslashes to `/`, trailing slash stripped, NFC-normalized. Apps and
 * domains are opaque identifiers; only whitespace and Unicode form are touched,
 * and domains are lowercased since hostnames are case-insensitive.
 */
export function normalizeEntity(entity: string, entityType: string): string {
  const trimmed = entity.trim().normalize('NFC');

  if (entityType === 'domain') return trimmed.toLocaleLowerCase('en-US');
  if (entityType !== 'file') return trimmed;

  const slashed = trimmed.replaceAll('\\', '/');
  const withoutTrailing = slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
  // Windows drive letters are case-insensitive; POSIX paths are not.
  return /^[a-z]:\//i.test(withoutTrailing)
    ? withoutTrailing.toLocaleLowerCase('en-US')
    : withoutTrailing;
}

/**
 * Convert a WakaTime fractional epoch-seconds timestamp to integer epoch
 * microseconds, so ordering and equality are exact rather than float-fuzzy.
 */
export function toEpochMicroseconds(epochSeconds: number): number {
  if (!Number.isFinite(epochSeconds)) {
    throw new RangeError('Heartbeat time must be a finite number');
  }
  const micros = Math.round(epochSeconds * 1_000_000);
  if (!Number.isSafeInteger(micros)) {
    throw new RangeError('Heartbeat time is outside the safe integer microsecond range');
  }
  return micros;
}

/** ISO 8601 UTC rendering of an epoch-microsecond value, second precision. */
export function toIsoUtc(epochMicroseconds: number): string {
  return new Date(Math.floor(epochMicroseconds / 1000)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Redact an identity-bearing value for logs and error messages.
 *
 * Keeps a short stable fingerprint so the same value is recognizably the same
 * across two log lines, without disclosing the value itself.
 */
export function redact(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '<empty>';
  return `<redacted:${sha256Hex(value).slice(0, 8)}>`;
}

/** Redact a filesystem path down to its extension and a fingerprint. */
export function redactPath(path: string): string {
  const extension = /\.[a-z0-9]+$/i.exec(path)?.[0] ?? '';
  return `<path${extension}:${sha256Hex(path).slice(0, 8)}>`;
}

/**
 * Normalize a selector value.
 *
 * Mirrors `normalizeSelectorValue` in the classification model so that an
 * identity written at import time compares equal to one an operator later
 * types into a rule.
 */
export function normalizeSelectorValue(type: SliceSelectorType, value: string): string {
  const trimmed = value.trim().normalize('NFC');

  switch (type) {
    case 'folder_prefix':
    case 'entity': {
      const normalized = trimmed.replaceAll('\\', '/').replace(/\/$/, '');
      return /^[a-z]:\//i.test(normalized) ? normalized.toLocaleLowerCase('en-US') : normalized;
    }
    case 'machine':
    case 'editor':
    case 'application':
    case 'domain':
      return trimmed.toLocaleLowerCase('en-US');
    case 'project':
      return trimmed;
  }
}

export interface SliceIdentity {
  selectorType: SliceSelectorType;
  value: string;
}

/**
 * Identities intrinsic to a day/project/entity slice, derivable from the daily
 * export alone: the project, and — for a file — its containing folder and its
 * exact path; for an app or domain, that identity.
 *
 * Machine and editor identities are NOT here: the daily export does not attach
 * them per entity. They arrive from matching heartbeats via
 * `heartbeatSliceIdentities`.
 */
export function sliceIntrinsicIdentities(slice: {
  projectName: string | null;
  entity: string;
  entityType: string;
}): SliceIdentity[] {
  const identities: SliceIdentity[] = [];

  if (slice.projectName) {
    identities.push({
      selectorType: 'project',
      value: normalizeSelectorValue('project', slice.projectName)
    });
  }

  if (slice.entityType === 'app') {
    identities.push({
      selectorType: 'application',
      value: normalizeSelectorValue('application', slice.entity)
    });
  } else if (slice.entityType === 'domain') {
    identities.push({
      selectorType: 'domain',
      value: normalizeSelectorValue('domain', slice.entity)
    });
  } else if (slice.entityType === 'file') {
    const exact = normalizeSelectorValue('entity', slice.entity);
    const lastSlash = exact.lastIndexOf('/');
    if (lastSlash > 0) {
      identities.push({ selectorType: 'folder_prefix', value: exact.slice(0, lastSlash) });
    }
    identities.push({ selectorType: 'entity', value: exact });
  }

  return identities;
}

/**
 * Identities a heartbeat contributes to the slice it belongs to: the observed
 * machine and the observed editor (carried by `user_agent_id`).
 */
export function heartbeatSliceIdentities(heartbeat: {
  machineNameId: string | null;
  userAgentId: string;
}): SliceIdentity[] {
  const identities: SliceIdentity[] = [];

  if (heartbeat.machineNameId) {
    identities.push({
      selectorType: 'machine',
      value: normalizeSelectorValue('machine', heartbeat.machineNameId)
    });
  }

  if (heartbeat.userAgentId) {
    identities.push({
      selectorType: 'editor',
      value: normalizeSelectorValue('editor', heartbeat.userAgentId)
    });
  }

  return identities;
}
