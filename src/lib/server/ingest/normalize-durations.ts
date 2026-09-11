/**
 * Pure normalization adapter for duration observations (API durations endpoint).
 *
 * Implements Stage A of Milestone P3 (docs/NEXT-MILESTONE.md §2.1-2.2):
 * - Normalizes official duration observations from the API.
 * - Invariant: Never reconstructs or derives duration from heartbeats.
 * - Rejects nonfinite and negative durations; enforces whole-request limits.
 */

import { sha256Hex, stableStringify } from '../import/canonical.js';
import { getZonedDateString, isValidDateString } from '../sync/calendar.js';
import {
  MAX_RESPONSE_PAYLOAD_BYTES,
  RECONCILE_CODES,
  type LayerResult,
  type NormalizeDurationsOptions,
  type NormalizedDurationDay,
  type NormalizedDurationEvent
} from './types.js';

export function normalizeDurationsDay(
  input: unknown,
  options: NormalizeDurationsOptions
): LayerResult<NormalizedDurationDay> {
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

  // 2. Require verified response/account timezone (no silent UTC default)
  if (!options.timezone) {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.TIMEZONE_MISMATCH,
      retryAt: null
    };
  }

  const timezone = options.timezone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.TIMEZONE_MISMATCH,
      retryAt: null
    };
  }

  // 3. Size & JSON parse guard
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
        code: RECONCILE_CODES.INCOMPLETE_BODY,
        retryAt: null
      };
    }
  }

  if (!payload || (typeof payload !== 'object' && !Array.isArray(payload))) {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.INCOMPLETE_BODY,
      retryAt: null
    };
  }

  // 2. Extract durations array
  let rawList: unknown[] | null = null;
  if (Array.isArray(payload)) {
    rawList = payload;
  } else {
    const obj = payload as Record<string, unknown>;
    if (obj.data !== undefined) {
      if (!Array.isArray(obj.data)) {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.INCOMPLETE_BODY,
          retryAt: null
        };
      }
      rawList = obj.data;
    } else {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY,
        retryAt: null
      };
    }
  }

  const durations: NormalizedDurationEvent[] = [];
  let totalSeconds = 0;

  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i];
    if (!item || typeof item !== 'object') {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY,
        retryAt: null
      };
    }

    const rec = item as Record<string, unknown>;
    const project = rec.project;
    if (typeof project !== 'string' || project.trim().length === 0) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY,
        retryAt: null
      };
    }

    const time = rec.time;
    const duration = rec.duration;

    if (typeof time !== 'number' || !Number.isFinite(time)) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY,
        retryAt: null
      };
    }

    const eventLocalDate = getZonedDateString(timezone, new Date(time * 1000));
    if (eventLocalDate !== targetDate) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.TIMEZONE_MISMATCH,
        retryAt: null
      };
    }

    if (typeof duration !== 'number' || !Number.isFinite(duration)) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY,
        retryAt: null
      };
    }

    if (duration < 0) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.MATHEMATICAL_INVARIANT_VIOLATION,
        retryAt: null
      };
    }

    let branch: string | null = null;
    if (Object.prototype.hasOwnProperty.call(rec, 'branch')) {
      if (typeof rec.branch !== 'string') {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.INCOMPLETE_BODY,
          retryAt: null
        };
      }
      branch = rec.branch;
    }

    let entity: string | null = null;
    if (Object.prototype.hasOwnProperty.call(rec, 'entity')) {
      if (typeof rec.entity !== 'string') {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.INCOMPLETE_BODY,
          retryAt: null
        };
      }
      entity = rec.entity;
    }

    let category: string | null = null;
    if (Object.prototype.hasOwnProperty.call(rec, 'category')) {
      if (typeof rec.category !== 'string') {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.INCOMPLETE_BODY,
          retryAt: null
        };
      }
      category = rec.category;
    }

    let createdAt: string | undefined = undefined;
    const hasCreatedAtSnake = Object.prototype.hasOwnProperty.call(rec, 'created_at');
    const hasCreatedAtCamel = Object.prototype.hasOwnProperty.call(rec, 'createdAt');
    if (hasCreatedAtSnake) {
      if (typeof rec.created_at !== 'string') {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.INCOMPLETE_BODY,
          retryAt: null
        };
      }
      createdAt = rec.created_at;
    }
    if (hasCreatedAtCamel) {
      if (typeof (rec as any).createdAt !== 'string') {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.INCOMPLETE_BODY,
          retryAt: null
        };
      }
      if (createdAt === undefined) {
        createdAt = (rec as any).createdAt;
      }
    }

    totalSeconds += duration;
    durations.push({
      project,
      time,
      duration,
      branch,
      entity,
      category,
      createdAt
    });
  }

  // Sort durations deterministically across all tie fields
  durations.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    const pComp = a.project.localeCompare(b.project);
    if (pComp !== 0) return pComp;
    const bComp = (a.branch ?? '').localeCompare(b.branch ?? '');
    if (bComp !== 0) return bComp;
    const eComp = (a.entity ?? '').localeCompare(b.entity ?? '');
    if (eComp !== 0) return eComp;
    const cComp = (a.category ?? '').localeCompare(b.category ?? '');
    if (cComp !== 0) return cComp;
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  });

  const normalizedDurationDay: NormalizedDurationDay = {
    date: targetDate,
    timezone,
    totalSeconds,
    durations,
    completeness: {
      isComplete: true,
      eventCount: durations.length
    }
  };

  const canonicalStructure = {
    date: targetDate,
    timezone,
    totalSeconds,
    completeness: normalizedDurationDay.completeness,
    durations: durations.map((d) => ({
      project: d.project,
      time: d.time,
      duration: d.duration,
      branch: d.branch ?? null,
      entity: d.entity ?? null,
      category: d.category ?? null,
      createdAt: d.createdAt ?? null
    }))
  };

  const contentHash = sha256Hex(stableStringify(canonicalStructure));

  return {
    kind: 'complete',
    value: normalizedDurationDay,
    contentHash,
    observedAt
  };
}
