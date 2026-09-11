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
 * Per-date restriction record tracking historical retention limits.
 */
export interface DateRestrictionRecord {
  date: string;
  capability: SyncCapability;
  statusCode: 402 | 403;
  restrictedAt: string;
  nextReprobeAt: string;
}

/**
 * Serialized state representation of the capability policy.
 */
export interface CapabilityPolicyState {
  capabilities: Record<SyncCapability, CapabilityRecord>;
  dateRestrictions?: Record<string, Record<SyncCapability, DateRestrictionRecord>>;
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
 * - Date-aware capability evaluation: an old-date 402/403 records only that date/layer
 *   and does not globally disable recent summaries or heartbeats.
 * - Endpoint-wide restriction needs a recent probe (within the free-tier window).
 * - Infrequent reprobing: avoids hammering plan-restricted endpoints on every sync run.
 * - 7-day free tier window scheduling heuristics.
 */
export class CapabilityPolicy {
  private records: Map<SyncCapability, CapabilityRecord>;
  private dateRestrictions: Map<string, Map<SyncCapability, DateRestrictionRecord>>;
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
    this.dateRestrictions = new Map();

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
   * Retrieve date restriction record for a specific date and capability, if present.
   */
  getDateRestriction(date: string, capability: SyncCapability): DateRestrictionRecord | null {
    return this.dateRestrictions.get(date)?.get(capability) ?? null;
  }

  /**
   * Check if a capability is currently known to be available globally.
   */
  isAvailable(capability: SyncCapability): boolean {
    return this.records.get(capability)?.status === 'available';
  }

  /**
   * Check if a capability is restricted by account plan globally (HTTP 402/403).
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
   * Date-aware: checks date-specific restriction if date string is provided.
   */
  shouldReprobe(capability: SyncCapability, dateOrNow?: string | Date, maybeNow?: Date): boolean {
    let date: string | undefined;
    let now: Date;

    if (typeof dateOrNow === 'string') {
      date = dateOrNow;
      now = maybeNow ?? new Date();
    } else {
      date = undefined;
      now = dateOrNow ?? new Date();
    }

    // 1. If checking a specific date with a date restriction:
    if (date) {
      const dateRestr = this.dateRestrictions.get(date)?.get(capability);
      if (dateRestr) {
        return now.getTime() >= new Date(dateRestr.nextReprobeAt).getTime();
      }
    }

    // 2. Fall back to endpoint-wide record
    const record = this.records.get(capability);
    if (!record) return true;

    if (record.status === 'untested') {
      return true;
    }

    if (record.status === 'available') {
      return false;
    }

    if (record.status === 'restricted' || record.status === 'error') {
      if (!record.nextReprobeAt) return true;
      return now.getTime() >= new Date(record.nextReprobeAt).getTime();
    }

    return true;
  }

  /**
   * Determine whether an endpoint request should be attempted during sync.
   * Date-aware:
   * - If an old date received 402/403, only that date is skipped.
   * - A recent date is attempted unless endpoint-wide restriction was established by a recent probe.
   */
  shouldAttempt(capability: SyncCapability, dateOrNow?: string | Date, maybeNow?: Date): boolean {
    let date: string | undefined;
    let now: Date;

    if (typeof dateOrNow === 'string') {
      date = dateOrNow;
      now = maybeNow ?? new Date();
    } else {
      date = undefined;
      now = dateOrNow ?? new Date();
    }

    // 1. If checking a specific date
    if (date) {
      const dateRestr = this.dateRestrictions.get(date)?.get(capability);
      if (dateRestr) {
        return this.shouldReprobe(capability, date, now);
      }
    }

    // 2. Check global record
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
  recordSuccess(capability: SyncCapability, dateOrNow?: string | Date, maybeNow?: Date): void {
    let date: string | undefined;
    let now: Date;

    if (typeof dateOrNow === 'string') {
      date = dateOrNow;
      now = maybeNow ?? new Date();
    } else {
      date = undefined;
      now = dateOrNow ?? new Date();
    }

    if (date) {
      this.dateRestrictions.get(date)?.delete(capability);
    }

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
   * Record a plan-level restriction (HTTP 402 or 403).
   *
   * DATE-AWARE POLICY INVARIANT:
   * - An old date's 402/403 records only that date/layer and does NOT globally restrict recent work.
   * - An endpoint-wide restriction is only recorded when the restriction is observed
   *   from a recent probe (within WAKATIME_FREE_TIER_WINDOW_DAYS) or an un-dated probe.
   */
  recordRestriction(
    capability: SyncCapability,
    statusCode: 402 | 403,
    dateOrNow?: string | Date,
    maybeNow?: Date,
    customReprobeIntervalMs?: number
  ): void {
    let date: string | undefined;
    let now: Date;

    if (typeof dateOrNow === 'string') {
      date = dateOrNow;
      now = maybeNow ?? new Date();
    } else {
      date = undefined;
      now = dateOrNow ?? new Date();
    }

    const interval = customReprobeIntervalMs ?? this.reprobeIntervalMs;
    const nextReprobe = new Date(now.getTime() + interval);

    // 1. If date is provided, always record date-specific restriction
    if (date) {
      let dateMap = this.dateRestrictions.get(date);
      if (!dateMap) {
        dateMap = new Map();
        this.dateRestrictions.set(date, dateMap);
      }
      dateMap.set(capability, {
        date,
        capability,
        statusCode,
        restrictedAt: now.toISOString(),
        nextReprobeAt: nextReprobe.toISOString()
      });

      // Check if probe was on a recent date within free window
      const isRecent = isDateWithinFreeWindow(date, now);
      if (!isRecent) {
        // Old date: do NOT mark the endpoint globally restricted!
        return;
      }
    }

    // 2. Global / recent probe restriction
    const record = this.records.get(capability);
    if (!record) return;

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

    const dateRestrs: Record<string, Record<SyncCapability, DateRestrictionRecord>> = {};
    for (const [date, capMap] of this.dateRestrictions.entries()) {
      dateRestrs[date] = {} as Record<SyncCapability, DateRestrictionRecord>;
      for (const [cap, rec] of capMap.entries()) {
        dateRestrs[date][cap] = { ...rec };
      }
    }

    return {
      capabilities: caps as Record<SyncCapability, CapabilityRecord>,
      dateRestrictions: dateRestrs,
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * Load policy state from a serialized representation.
   */
  loadState(state: CapabilityPolicyState): void {
    if (state?.capabilities) {
      for (const [k, v] of Object.entries(state.capabilities)) {
        if (this.records.has(k as SyncCapability)) {
          this.records.set(k as SyncCapability, { ...v });
        }
      }
    }

    if (state?.dateRestrictions) {
      this.dateRestrictions.clear();
      for (const [date, capMap] of Object.entries(state.dateRestrictions)) {
        const m = new Map<SyncCapability, DateRestrictionRecord>();
        for (const [cap, rec] of Object.entries(capMap)) {
          m.set(cap as SyncCapability, { ...rec });
        }
        this.dateRestrictions.set(date, m);
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
  const probeDate = options?.probeDate ?? getYesterdayDate(now);

  // 1. Probe Summaries (baseline)
  if (options?.force || policy.shouldReprobe('summaries', probeDate, now)) {
    try {
      await client.getSummaries(probeDate, probeDate);
      policy.recordSuccess('summaries', probeDate, now);
    } catch (err) {
      if (err instanceof WakaTimeAuthError) {
        policy.recordError('summaries', err, now);
        policy.recordError('durations', err, now);
        policy.recordError('heartbeats', err, now);
        throw err;
      }
      if (err instanceof CapabilityRestrictedError) {
        policy.recordRestriction('summaries', err.statusCode, probeDate, now);
      } else {
        policy.recordError('summaries', err as Error, now);
      }
    }
  }

  // 2. Probe Durations
  if (options?.force || policy.shouldReprobe('durations', probeDate, now)) {
    try {
      await client.getDurations(probeDate);
      policy.recordSuccess('durations', probeDate, now);
    } catch (err) {
      if (err instanceof CapabilityRestrictedError) {
        policy.recordRestriction('durations', err.statusCode, probeDate, now);
      } else {
        policy.recordError('durations', err as Error, now);
      }
    }
  }

  // 3. Probe Heartbeats
  if (options?.force || policy.shouldReprobe('heartbeats', probeDate, now)) {
    try {
      await client.getHeartbeats(probeDate);
      policy.recordSuccess('heartbeats', probeDate, now);
    } catch (err) {
      if (err instanceof CapabilityRestrictedError) {
        policy.recordRestriction('heartbeats', err.statusCode, probeDate, now);
      } else {
        policy.recordError('heartbeats', err as Error, now);
      }
    }
  }

  return policy;
}
