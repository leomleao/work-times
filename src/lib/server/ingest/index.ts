/**
 * Ingestion and pure normalization adapters for Work Times.
 *
 * Implements Stage A of Milestone P3 (docs/NEXT-MILESTONE.md §2.1-2.3):
 * - Pure adapters for summary, heartbeat, and duration observations.
 * - Non-lossless source input and stable semantic identities/content hashes.
 * - Strict mathematical invariants, overcount tolerance guards, and zero-day fidelity.
 */

export * from './types.js';
export * from './normalize-summary.js';
export * from './normalize-heartbeats.js';
export * from './normalize-durations.js';
