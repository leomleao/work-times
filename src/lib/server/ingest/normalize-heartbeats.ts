/**
 * Pure normalization adapter for heartbeat observations (API and Dump).
 *
 * Implements Stage A of Milestone P3 (docs/NEXT-MILESTONE.md §2.1-2.5):
 * - Validates heartbeat envelopes, external UUIDs, and canonical dependency arrays.
 * - Detects conflicting payloads for duplicate external IDs; rejects with safe codes.
 * - Never infers duration or derives elapsed time from heartbeats.
 * - Computes deterministic canonical event hashes and layer content hashes.
 */

import {
  canonicalHeartbeatPayload,
  canonicalPayloadHash,
  canonicalizeDependencies,
  normalizeEntity,
  sha256Hex,
  stableStringify,
  toEpochMicroseconds,
  toIsoUtc
} from '../import/canonical.js';
import { getZonedDateString, isValidDateString } from '../sync/calendar.js';
import {
  MAX_RESPONSE_PAYLOAD_BYTES,
  RECONCILE_CODES,
  type HeartbeatCompleteness,
  type LayerResult,
  type NormalizedHeartbeatDay,
  type NormalizedHeartbeatEvent,
  type NormalizeHeartbeatOptions
} from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeHeartbeatDay(
  input: unknown,
  options: NormalizeHeartbeatOptions
): LayerResult<NormalizedHeartbeatDay> {
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_PAYLOAD_BYTES;
  const observedAt = options.observedAt ?? new Date().toISOString();
  const targetDate = options.date;

  // 1. Target date validation
  if (!isValidDateString(targetDate)) {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.MISSING_REQUESTED_DATE,
      retryAt: null
    };
  }

  // 2. Size & JSON parse guard
  let payload = input;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    const byteSize = Buffer.isBuffer(input) ? input.length : Buffer.byteLength(input, 'utf8');
    if (byteSize > maxBytes) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.RESPONSE_SIZE_EXCEEDED,
        retryAt: null
      };
    }
    const str = typeof input === 'string' ? input : input.toString('utf8');
    try {
      payload = JSON.parse(str);
    } catch {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
        retryAt: null
      };
    }
  }

  if (!payload || (typeof payload !== 'object' && !Array.isArray(payload))) {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
      retryAt: null
    };
  }

  // 3. Extract events array from envelope and resolve timezone
  let rawEvents: unknown[] | null = null;
  let dayTimezone: string | undefined;

  if (Array.isArray(payload)) {
    rawEvents = payload;
  } else {
    const obj = payload as Record<string, unknown>;
    const userObj = obj.user as Record<string, unknown> | undefined;
    if (typeof userObj?.timezone === 'string') {
      dayTimezone = userObj.timezone;
    }

    if (obj.days !== undefined) {
      if (!Array.isArray(obj.days)) {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
          retryAt: null
        };
      }
      let foundDay: Record<string, unknown> | null = null;
      for (const d of obj.days) {
        if (d && typeof d === 'object') {
          const dObj = d as Record<string, unknown>;
          if (dObj.date === targetDate) {
            foundDay = dObj;
            break;
          }
        }
      }
      if (!foundDay) {
        // Missing requested date in days array must fail
        return {
          kind: 'failed',
          code: RECONCILE_CODES.MISSING_REQUESTED_DATE,
          retryAt: null
        };
      }
      if (foundDay.heartbeats === undefined || foundDay.heartbeats === null || !Array.isArray(foundDay.heartbeats)) {
        // Matched day with omitted heartbeats field must fail
        return {
          kind: 'failed',
          code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
          retryAt: null
        };
      }
      rawEvents = foundDay.heartbeats;
      if (typeof foundDay.timezone === 'string') {
        dayTimezone = foundDay.timezone;
      }
    } else if (obj.data !== undefined) {
      if (!Array.isArray(obj.data)) {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
          retryAt: null
        };
      }
      rawEvents = obj.data;
    } else if (obj.heartbeats !== undefined) {
      if (!Array.isArray(obj.heartbeats)) {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
          retryAt: null
        };
      }
      rawEvents = obj.heartbeats;
    } else {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
        retryAt: null
      };
    }
  }

  // 4. Require verified response/account timezone (no silent UTC default)
  if (!options.timezone && !dayTimezone) {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.TIMEZONE_MISMATCH,
      retryAt: null
    };
  }

  if (options.timezone && dayTimezone && dayTimezone !== options.timezone) {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.TIMEZONE_MISMATCH,
      retryAt: null
    };
  }

  const timezone = options.timezone ?? dayTimezone!;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.TIMEZONE_MISMATCH,
      retryAt: null
    };
  }

  // 3. Process each heartbeat event
  const seenHeartbeats = new Map<string, string>(); // external ID -> canonical payload hash
  const events: NormalizedHeartbeatEvent[] = [];
  let conflictCount = 0;

  for (let idx = 0; idx < rawEvents.length; idx++) {
    const raw = rawEvents[idx];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
        retryAt: null
      };
    }

    const item = raw as Record<string, unknown>;

    // External ID validation: must be a valid RFC 4122 UUID
    const id = item.id;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ID,
        retryAt: null
      };
    }

    // Entity validation
    const entity = item.entity;
    if (typeof entity !== 'string' || entity.length === 0) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
        retryAt: null
      };
    }

    // Dependency array validation: must be string[] if provided
    let dependencies: string[] = [];
    if (item.dependencies !== undefined && item.dependencies !== null) {
      if (!Array.isArray(item.dependencies)) {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_DEPENDENCY,
          retryAt: null
        };
      }
      for (const dep of item.dependencies) {
        if (typeof dep !== 'string') {
          return {
            kind: 'failed',
            code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_DEPENDENCY,
            retryAt: null
          };
        }
      }
      try {
        dependencies = canonicalizeDependencies(item.dependencies);
      } catch {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_DEPENDENCY,
          retryAt: null
        };
      }
    }

    // Time validation: must be a finite numeric epoch timestamp in seconds
    const time = item.time;
    if (typeof time !== 'number' || !Number.isFinite(time)) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
        retryAt: null
      };
    }

    // Validate event timestamp is on targetDate in source timezone
    const eventLocalDate = getZonedDateString(timezone, new Date(time * 1000));
    if (eventLocalDate !== targetDate) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.TIMEZONE_MISMATCH,
        retryAt: null
      };
    }

    let occurredAtUs: number;
    let occurredAt: string;
    try {
      occurredAtUs = toEpochMicroseconds(time);
      occurredAt = toIsoUtc(occurredAtUs);
    } catch {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
        retryAt: null
      };
    }

    // Canonical payload & conflict detection
    const canonicalPayload = canonicalHeartbeatPayload(item);
    const canonicalHash = canonicalPayloadHash(canonicalPayload);

    const previousHash = seenHeartbeats.get(id);
    if (previousHash !== undefined) {
      if (previousHash === canonicalHash) {
        // Idempotent duplicate: skip redundant event instance
        continue;
      }

      // Conflicting heartbeat payloads must fail the layer
      return {
        kind: 'failed',
        code: RECONCILE_CODES.HEARTBEAT_PAYLOAD_CONFLICT,
        retryAt: null
      };
    }

    seenHeartbeats.set(id, canonicalHash);

    const rawType = item.type;
    if (rawType !== 'app' && rawType !== 'domain' && rawType !== 'file') {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
        retryAt: null
      };
    }
    const entityType: 'file' | 'app' | 'domain' = rawType;

    // Category validation: do not synthesize 'coding'
    const rawCategory = item.category;
    if (typeof rawCategory !== 'string' || rawCategory.trim().length === 0) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
        retryAt: null
      };
    }
    const category = rawCategory;

    // User agent validation: do not synthesize ''
    const rawUserAgent = item.user_agent_id;
    if (typeof rawUserAgent !== 'string' || rawUserAgent.trim().length === 0) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
        retryAt: null
      };
    }
    const userAgentId = rawUserAgent;

    let projectName: string | null = null;
    if (item.project !== undefined && item.project !== null) {
      if (typeof item.project !== 'string') {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
          retryAt: null
        };
      }
      projectName = item.project;
    }

    let branch: string | null = null;
    if (item.branch !== undefined && item.branch !== null) {
      if (typeof item.branch !== 'string') {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
          retryAt: null
        };
      }
      branch = item.branch;
    }

    let language: string | null = null;
    if (item.language !== undefined && item.language !== null) {
      if (typeof item.language !== 'string') {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
          retryAt: null
        };
      }
      language = item.language;
    }

    let isWrite = false;
    if (item.is_write !== undefined && item.is_write !== null) {
      if (typeof item.is_write !== 'boolean') {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
          retryAt: null
        };
      }
      isWrite = item.is_write;
    }

    let lines: number | null = null;
    if (item.lines !== undefined && item.lines !== null) {
      if (
        typeof item.lines !== 'number' ||
        !Number.isFinite(item.lines) ||
        !Number.isInteger(item.lines) ||
        item.lines < 0
      ) {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
          retryAt: null
        };
      }
      lines = item.lines;
    }

    let lineno: number | null = null;
    if (item.lineno !== undefined && item.lineno !== null) {
      if (
        typeof item.lineno !== 'number' ||
        !Number.isFinite(item.lineno) ||
        !Number.isInteger(item.lineno) ||
        item.lineno < 0
      ) {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
          retryAt: null
        };
      }
      lineno = item.lineno;
    }

    let cursorpos: number | null = null;
    if (item.cursorpos !== undefined && item.cursorpos !== null) {
      if (
        typeof item.cursorpos !== 'number' ||
        !Number.isFinite(item.cursorpos) ||
        !Number.isInteger(item.cursorpos) ||
        item.cursorpos < 0
      ) {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
          retryAt: null
        };
      }
      cursorpos = item.cursorpos;
    }

    let machineNameId: string | null = null;
    if (item.machine_name_id !== undefined && item.machine_name_id !== null) {
      if (typeof item.machine_name_id !== 'string') {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
          retryAt: null
        };
      }
      machineNameId = item.machine_name_id;
    }

    if (item.project_root_count !== undefined && item.project_root_count !== null) {
      if (
        typeof item.project_root_count !== 'number' ||
        !Number.isFinite(item.project_root_count) ||
        !Number.isInteger(item.project_root_count) ||
        item.project_root_count < 0
      ) {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE,
          retryAt: null
        };
      }
    }

    const normEntity = normalizeEntity(entity, entityType);

    events.push({
      id,
      occurredAtUs,
      occurredAt,
      localDate: targetDate,
      entity: normEntity,
      entityType,
      category,
      projectName,
      branch,
      language,
      dependencies,
      machineNameId,
      userAgentId,
      isWrite,
      lines,
      lineno,
      cursorpos,
      canonicalHash
    });
  }

  // Sort events deterministically by occurredAtUs ASC, id ASC
  events.sort((a, b) => {
    if (a.occurredAtUs !== b.occurredAtUs) return a.occurredAtUs - b.occurredAtUs;
    return a.id.localeCompare(b.id);
  });

  const completeness: HeartbeatCompleteness = {
    isComplete: true,
    eventCount: events.length,
    hasCanonicalPayloads: true,
    unsupportedEventCount: 0,
    conflictEventCount: 0
  };

  const normalizedHeartbeatDay: NormalizedHeartbeatDay = {
    date: targetDate,
    timezone,
    heartbeats: events,
    completeness
  };

  // Content hash covering every normalized accepted field
  const canonicalStructure = {
    date: targetDate,
    timezone,
    completeness,
    heartbeats: events.map((e) => ({
      id: e.id,
      occurredAtUs: e.occurredAtUs,
      occurredAt: e.occurredAt,
      localDate: e.localDate,
      entity: e.entity,
      entityType: e.entityType,
      category: e.category,
      projectName: e.projectName,
      branch: e.branch,
      language: e.language,
      dependencies: e.dependencies,
      machineNameId: e.machineNameId,
      userAgentId: e.userAgentId,
      isWrite: e.isWrite,
      lines: e.lines,
      lineno: e.lineno,
      cursorpos: e.cursorpos,
      canonicalHash: e.canonicalHash
    }))
  };

  const contentHash = sha256Hex(stableStringify(canonicalStructure));

  return {
    kind: 'complete',
    value: normalizedHeartbeatDay,
    contentHash,
    observedAt
  };
}
