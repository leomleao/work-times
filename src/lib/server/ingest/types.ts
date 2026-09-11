/**
 * Pure normalization and source fidelity types for the Work Times ingest engine.
 *
 * Implements Stage A of Milestone P3 (docs/NEXT-MILESTONE.md §2.1-2.3):
 * - Pure adapters for API responses and export dumps.
 * - Source fidelity preservation without manufacturing envelopes.
 * - Explicit entity detail presence vs coarse project totals.
 * - Non-lossless raw preservation and deterministic content hashing.
 */

import type {
  DayCandidate,
  EntityDetailState,
  HeartbeatCompleteness,
  LayerResult,
  NormalizedHeartbeatDay,
  NormalizedHeartbeatEvent,
  NormalizedProjectSummary,
  NormalizedScopedDimension,
  NormalizedSlice,
  NormalizedSummaryDay,
  ProjectScopeCompleteness,
  ReconcileCode,
  SliceKind,
  SummaryCompleteness,
  SummaryFidelity
} from '../sync/contracts.js';

export type {
  DayCandidate,
  EntityDetailState,
  HeartbeatCompleteness,
  LayerResult,
  NormalizedHeartbeatDay,
  NormalizedHeartbeatEvent,
  NormalizedProjectSummary,
  NormalizedScopedDimension,
  NormalizedSlice,
  NormalizedSummaryDay,
  ProjectScopeCompleteness,
  ReconcileCode,
  SliceKind,
  SummaryCompleteness,
  SummaryFidelity
};

export {
  DURATION_COMPARISON_TOLERANCE_SECONDS,
  MAX_RESPONSE_PAYLOAD_BYTES,
  RECONCILE_CODES,
  coversRetainedScopes
} from '../sync/contracts.js';

export interface NormalizeSummaryOptions {
  /** Target calendar date in YYYY-MM-DD format. */
  date: string;
  /** Verified/pinned account timezone (e.g. 'Europe/London'). */
  accountTimezone?: string;
  /** ISO 8601 UTC timestamp of observation. */
  observedAt?: string;
  /** Optional response size ceiling in bytes (default 16 MiB). */
  maxBytes?: number;
}

export interface NormalizeHeartbeatOptions {
  /** Target calendar date in YYYY-MM-DD format. */
  date: string;
  /** Enclosing day timezone. */
  timezone?: string;
  /** ISO 8601 UTC timestamp of observation. */
  observedAt?: string;
  /** Optional response size ceiling in bytes (default 16 MiB). */
  maxBytes?: number;
}

export interface NormalizedDurationEvent {
  project: string;
  time: number;
  duration: number;
  branch?: string | null;
  entity?: string | null;
  category?: string | null;
  createdAt?: string;
}

export interface DurationCompleteness {
  isComplete: boolean;
  eventCount: number;
}

export interface NormalizedDurationDay {
  date: string;
  timezone: string;
  totalSeconds: number;
  durations: NormalizedDurationEvent[];
  completeness: DurationCompleteness;
}

export interface NormalizeDurationsOptions {
  /** Target calendar date in YYYY-MM-DD format. */
  date: string;
  /** Enclosing day timezone. */
  timezone?: string;
  /** ISO 8601 UTC timestamp of observation. */
  observedAt?: string;
  /** Optional response size ceiling in bytes (default 16 MiB). */
  maxBytes?: number;
}
