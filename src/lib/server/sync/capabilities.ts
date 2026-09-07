import {
  WakaTimeAuthError,
  CapabilityRestrictedError,
  type WakaTimeClient
} from '../wakatime/index.js';

/**
 * Standard sync capability types representing the WakaTime API features consumed by Work Times.
 */
export type SyncCapability = 'summaries' | 'durations' | 'heartbeats';

/**
 * Lifecycle state of a sync capability.
 */
export type CapabilityStatus = 'available' | 'restricted' | 'untested' | 'error';

/**
 * The policy window (in calendar days) for which WakaTime Free plan accounts
 * are expected to provide accessible summary and activity data.
 *
 * IMPORTANT ARCHITECTURAL & POLICY NOTE:
 * This constant represents a local scheduling policy and heuristic rather than
 * guaranteed upstream response semantics. Upstream account plans, trial periods,
 * or backend limits may change at any time. The sync engine uses capability
 * probing and HTTP 402/403 responses as the authoritative source of truth,
 * and uses this constant to guide sync prioritization (e.g., ensuring recent
 * days within the 7-day window are archived before rolling out of view).
 */
export const WAKATIME_FREE_TIER_WINDOW_DAYS = 7;

/**
 * Default interval (in milliseconds) before reprobing a capability that was previously
 * marked as restricted (HTTP 402/403) by account plan.
 * Conservative default: 24 hours.
 */
export const DEFAULT_REPROBE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Transient error reprobe interval (1 hour).
 */
export const DEFAULT_ERROR_RETRY_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Tracked status and reprobe metadata for a specific capability.
 */
export interface CapabilityRecord {
  capability: SyncCapability;
  status: CapabilityStatus;
  lastProbedAt: string | null; // ISO timestamp
  lastSuccessAt: string | null; // ISO timestamp
  nextReprobeAt: string | null; // ISO timestamp
  restrictionCode?: string; // e.g. "HTTP_402" or "HTTP_403"
  errorMessage?: string; // sanitized failure reason
}

/**
 * Serialized state representation of the capability policy.
 */
export interface CapabilityPolicyState {
  capabilities: Record<SyncCapability, CapabilityRecord>;
  updatedAt: string;
}

/**
 * Per-step execution result during a sync run.
 */
export interface SyncStepResult {
  capability: SyncCapability;
  attempted: boolean;
  skippedReason?: 'plan_restricted' | 'outside_window' | 'untested';
  success: boolean;
  error?: Error;
}

/**
 * Overall outcome of a sync run evaluated against capability policy.
 */
export interface SyncRunOutcome {
  outcome: 'succeeded' | 'partial' | 'failed';
  advisoryCodes: string[];
  summary: string;
  degradedCapabilities: SyncCapability[];
}

/**
 * Helper to test if a given "YYYY-MM-DD" date falls within the policy-defined free tier window.
 * A 7-calendar-day inclusive window including today starts at today minus 6.
 */
export function isDateWithinFreeWindow(
  dateStr: string,
  now: Date = new Date(),
  windowDays: number = WAKATIME_FREE_TIER_WINDOW_DAYS
): boolean {
  if (!dateStr || typeof dateStr !== 'string') {
    return false;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }
  const targetDate = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(targetDate.getTime()) || targetDate.toISOString().slice(0, 10) !== dateStr) {
    return false;
  }

  // Calculate midnight UTC of today
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const windowStartUtc = new Date(todayUtc);
  const daysToSubtract = Math.max(0, windowDays - 1);
  windowStartUtc.setUTCDate(todayUtc.getUTCDate() - daysToSubtract);

  return targetDate.getTime() >= windowStartUtc.getTime();
}

/**
 * Returns the earliest "YYYY-MM-DD" date covered by the free tier policy window relative to now.
 * A 7-calendar-day inclusive window including today starts at today minus 6.
 */
export function getFreeWindowStartDate(
  now: Date = new Date(),
  windowDays: number = WAKATIME_FREE_TIER_WINDOW_DAYS
): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysToSubtract = Math.max(0, windowDays - 1);
  date.setUTCDate(date.getUTCDate() - daysToSubtract);
  return date.toISOString().slice(0, 10);
}

/**
 * Returns yesterday's "YYYY-MM-DD" date relative to now in UTC.
 */
export function getYesterdayDate(now: Date = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Capability Policy Engine.
 *
 * Governs:
 * - Treating summaries as required baseline.
 * - Plan-aware capability degradation: heartbeats and durations can degrade gracefully
 *   to a 'partial' sync outcome while summaries remain useful.
 * - Infrequent reprobing: avoids hammering plan-restricted endpoints on every sync run.
 * - 7-day free tier window scheduling heuristics.
 */
export class CapabilityPolicy {
  private records: Map<SyncCapability, CapabilityRecord>;
  private readonly reprobeIntervalMs: number;
  private readonly errorRetryIntervalMs: number;

  constructor(options?: {
    initialState?: CapabilityPolicyState;
    reprobeIntervalMs?: number;
    errorRetryIntervalMs?: number;
  }) {
    this.reprobeIntervalMs = options?.reprobeIntervalMs ?? DEFAULT_REPROBE_INTERVAL_MS;
    this.errorRetryIntervalMs = options?.errorRetryIntervalMs ?? DEFAULT_ERROR_RETRY_INTERVAL_MS;
    this.records = new Map();

    const capabilities: SyncCapability[] = ['summaries', 'durations', 'heartbeats'];
    for (const cap of capabilities) {
      this.records.set(cap, {
        capability: cap,
        status: 'untested',
        lastProbedAt: null,
        lastSuccessAt: null,
        nextReprobeAt: null
      });
    }

    if (options?.initialState) {
      this.loadState(options.initialState);
    }
  }

  /**
   * Retrieve the record for a capability.
   */
  getRecord(capability: SyncCapability): CapabilityRecord {
    const record = this.records.get(capability);
    if (!record) {
      throw new Error(`Unknown capability: ${capability}`);
    }
    return { ...record };
  }

  /**
   * Check if a capability is currently known to be available.
   */
  isAvailable(capability: SyncCapability): boolean {
    return this.records.get(capability)?.status === 'available';
  }

  /**
   * Check if a capability is restricted by account plan (HTTP 402/403).
   */
  isRestricted(capability: SyncCapability): boolean {
    return this.records.get(capability)?.status === 'restricted';
  }

  /**
   * Check if the policy has degraded optional capabilities while summaries remain active.
   */
  isDegraded(): boolean {
    const summariesAvailable = this.isAvailable('summaries');
    const durationsRestricted = this.isRestricted('durations');
    const heartbeatsRestricted = this.isRestricted('heartbeats');
    return summariesAvailable && (durationsRestricted || heartbeatsRestricted);
  }

  /**
   * Determine whether a capability should be probed or reprobed.
   */
  shouldReprobe(capability: SyncCapability, now: Date = new Date()): boolean {
    const record = this.records.get(capability);
    if (!record) return true;

    if (record.status === 'untested') {
      return true;
    }

    if (record.status === 'available') {
      return false;
    }

    if (record.status === 'restricted') {
      if (!record.nextReprobeAt) return true;
      return now.getTime() >= new Date(record.nextReprobeAt).getTime();
    }

    if (record.status === 'error') {
      if (!record.nextReprobeAt) return true;
      return now.getTime() >= new Date(record.nextReprobeAt).getTime();
    }

    return true;
  }

  /**
   * Determine whether an endpoint request should be attempted during sync.
   * Skips restricted endpoints unless reprobe time has arrived.
   */
  shouldAttempt(capability: SyncCapability, now: Date = new Date()): boolean {
    const record = this.records.get(capability);
    if (!record) return false;

    if (record.status === 'available' || record.status === 'untested') {
      return true;
    }

    if (record.status === 'restricted' || record.status === 'error') {
      return this.shouldReprobe(capability, now);
    }

    return false;
  }

  /**
   * Record a successful capability call or probe.
   */
  recordSuccess(capability: SyncCapability, now: Date = new Date()): void {
    const record = this.records.get(capability);
    if (!record) return;

    record.status = 'available';
    record.lastProbedAt = now.toISOString();
    record.lastSuccessAt = now.toISOString();
    record.nextReprobeAt = null;
    record.restrictionCode = undefined;
    record.errorMessage = undefined;
  }

  /**
   * Record a plan-level restriction (HTTP 402 or 403). Schedules an infrequent reprobe.
   */
  recordRestriction(
    capability: SyncCapability,
    statusCode: 402 | 403,
    now: Date = new Date(),
    customReprobeIntervalMs?: number
  ): void {
    const record = this.records.get(capability);
    if (!record) return;

    const interval = customReprobeIntervalMs ?? this.reprobeIntervalMs;
    const nextReprobe = new Date(now.getTime() + interval);

    record.status = 'restricted';
    record.lastProbedAt = now.toISOString();
    record.nextReprobeAt = nextReprobe.toISOString();
    record.restrictionCode = `HTTP_${statusCode}`;
    record.errorMessage = `Plan restricted (HTTP ${statusCode})`;
  }

  /**
   * Record an operational or network error for a capability.
   */
  recordError(
    capability: SyncCapability,
    error: Error,
    now: Date = new Date(),
    customRetryIntervalMs?: number
  ): void {
    const record = this.records.get(capability);
    if (!record) return;

    const interval = customRetryIntervalMs ?? this.errorRetryIntervalMs;
    const nextReprobe = new Date(now.getTime() + interval);

    record.status = 'error';
    record.lastProbedAt = now.toISOString();
    record.nextReprobeAt = nextReprobe.toISOString();
    record.errorMessage = error.name || 'Request Failed';
  }

  /**
   * Evaluate the overall sync run outcome based on the step results.
   *
   * Rules:
   * 1. Summaries is the required baseline: if summaries fails or is restricted, the run outcome is 'failed'.
   * 2. If summaries succeeds, but durations or heartbeats are restricted/degraded, the run outcome
   *    is 'partial' with advisory codes rather than 'failed'.
   * 3. If all attempted capabilities succeed, the run outcome is 'succeeded'.
   */
  evaluateSyncRun(stepResults: SyncStepResult[]): SyncRunOutcome {
    const summariesResult = stepResults.find((r) => r.capability === 'summaries');
    const advisoryCodes: string[] = [];
    const degradedCaps: SyncCapability[] = [];

    // Check summaries baseline
    if (!summariesResult || !summariesResult.success) {
      if (summariesResult?.error instanceof CapabilityRestrictedError) {
        advisoryCodes.push('SUMMARIES_PLAN_RESTRICTED');
      } else {
        advisoryCodes.push('SUMMARIES_FAILED');
      }
      return {
        outcome: 'failed',
        advisoryCodes,
        summary: 'Sync failed: required baseline summaries endpoint was unsuccessful',
        degradedCapabilities: ['summaries']
      };
    }

    // Check optional capabilities
    for (const res of stepResults) {
      if (res.capability === 'summaries') continue;

      if (!res.attempted && res.skippedReason === 'plan_restricted') {
        const code = `${res.capability.toUpperCase()}_PLAN_RESTRICTED`;
        advisoryCodes.push(code);
        degradedCaps.push(res.capability);
      } else if (res.error instanceof CapabilityRestrictedError) {
        const code = `${res.capability.toUpperCase()}_PLAN_RESTRICTED`;
        advisoryCodes.push(code);
        degradedCaps.push(res.capability);
      } else if (!res.success && res.error) {
        const code = `${res.capability.toUpperCase()}_ERROR`;
        advisoryCodes.push(code);
        degradedCaps.push(res.capability);
      }
    }

    if (degradedCaps.length > 0) {
      const capList = degradedCaps.join(', ');
      return {
        outcome: 'partial',
        advisoryCodes,
        summary: `Sync completed with degraded capabilities (${capList}): summaries saved successfully`,
        degradedCapabilities: degradedCaps
      };
    }

    return {
      outcome: 'succeeded',
      advisoryCodes: [],
      summary: 'Sync completed successfully across all configured capabilities',
      degradedCapabilities: []
    };
  }

  /**
   * Export policy state as JSON-serializable object.
   */
  toJSON(): CapabilityPolicyState {
    const caps: Record<string, CapabilityRecord> = {};
    for (const [k, v] of this.records.entries()) {
      caps[k] = { ...v };
    }
    return {
      capabilities: caps as Record<SyncCapability, CapabilityRecord>,
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * Load policy state from a serialized representation.
   */
  loadState(state: CapabilityPolicyState): void {
    if (!state?.capabilities) return;
    for (const [k, v] of Object.entries(state.capabilities)) {
      if (this.records.has(k as SyncCapability)) {
        this.records.set(k as SyncCapability, { ...v });
      }
    }
  }

  /**
   * Factory method to restore policy from state.
   */
  static fromJSON(state: CapabilityPolicyState): CapabilityPolicy {
    return new CapabilityPolicy({ initialState: state });
  }
}

/**
 * Probe live capabilities against WakaTime API.
 *
 * Probes:
 * 1. Summaries range (baseline and OAuth verification).
 * 2. Durations (optional).
 * 3. Heartbeats (optional).
 *
 * Returns updated CapabilityPolicy reflecting discovered capability boundaries.
 */
export async function probeCapabilities(
  client: WakaTimeClient,
  options?: {
    probeDate?: string;
    now?: Date;
    force?: boolean;
    policy?: CapabilityPolicy;
  }
): Promise<CapabilityPolicy> {
  const policy = options?.policy ?? new CapabilityPolicy();
  const now = options?.now ?? new Date();
  const probeDate = options?.probeDate ?? getYesterdayDate(now); // Yesterday

  // 1. Probe Summaries (baseline). Avoid /users/current because that endpoint's
  // documented OAuth scope is `email`, which Work Times does not request.
  if (options?.force || policy.shouldReprobe('summaries', now)) {
    try {
      await client.getSummaries(probeDate, probeDate);
      policy.recordSuccess('summaries', now);
    } catch (err) {
      if (err instanceof WakaTimeAuthError) {
        policy.recordError('summaries', err, now);
        policy.recordError('durations', err, now);
        policy.recordError('heartbeats', err, now);
        throw err;
      }
      if (err instanceof CapabilityRestrictedError) {
        policy.recordRestriction('summaries', err.statusCode, now);
      } else {
        policy.recordError('summaries', err as Error, now);
      }
    }
  }

  // 2. Probe Durations
  if (options?.force || policy.shouldReprobe('durations', now)) {
    try {
      await client.getDurations(probeDate);
      policy.recordSuccess('durations', now);
    } catch (err) {
      if (err instanceof CapabilityRestrictedError) {
        policy.recordRestriction('durations', err.statusCode, now);
      } else {
        policy.recordError('durations', err as Error, now);
      }
    }
  }

  // 3. Probe Heartbeats
  if (options?.force || policy.shouldReprobe('heartbeats', now)) {
    try {
      await client.getHeartbeats(probeDate);
      policy.recordSuccess('heartbeats', now);
    } catch (err) {
      if (err instanceof CapabilityRestrictedError) {
        policy.recordRestriction('heartbeats', err.statusCode, now);
      } else {
        policy.recordError('heartbeats', err as Error, now);
      }
    }
  }

  return policy;
}
