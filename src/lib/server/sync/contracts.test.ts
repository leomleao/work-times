import { describe, it, expect } from 'vitest';
import {
  isValidRunTransition,
  assertValidRunTransition,
  isValidDateTransition,
  assertValidDateTransition,
  aggregateRunOutcome,
  computeRunRequestPayloadHash,
  sanitizeMcpDataQuality,
  evaluateDateFreshness,
  coversRetainedScopes,
  RECONCILE_CODES,
  DURATION_COMPARISON_TOLERANCE_SECONDS,
  MAX_ACTIVE_SYNC_RUNS,
  MAX_SYNC_QUEUE_SIZE,
  MIN_UPSTREAM_REQUEST_SPACING_MS,
  MAX_BACKFILL_RANGE_DAYS,
  MAX_CATCHUP_RUN_DATES,
  RECOMMENDED_MIGRATION_SEQUENCE,
  LIFECYCLE_SYMBOL,
  type RunRequest,
  type LayerFreshnessRecord,
  type SummaryCompleteness
} from './contracts.js';
import { SYNTHETIC_FIXTURES } from './fixtures/index.js';

describe('Sync Contracts and Lifecycle Engine', () => {
  describe('Constants and Limits', () => {
    it('defines frozen numeric limits and budgets', () => {
      expect(DURATION_COMPARISON_TOLERANCE_SECONDS).toBe(0.001);
      expect(MAX_ACTIVE_SYNC_RUNS).toBe(1);
      expect(MAX_SYNC_QUEUE_SIZE).toBe(10);
      expect(MIN_UPSTREAM_REQUEST_SPACING_MS).toBe(1000);
      expect(MAX_BACKFILL_RANGE_DAYS).toBe(366);
      expect(MAX_CATCHUP_RUN_DATES).toBe(31);
      expect(LIFECYCLE_SYMBOL).toBe(Symbol.for('work-times.lifecycle'));
    });

    it('defines orchestrator-frozen migration sequence with exact filenames 005 to 009', () => {
      expect(RECOMMENDED_MIGRATION_SEQUENCE).toHaveLength(5);

      expect(RECOMMENDED_MIGRATION_SEQUENCE[0].number).toBe('005');
      expect(RECOMMENDED_MIGRATION_SEQUENCE[0].filename).toBe('005-sync-lifecycle.sql');
      expect(RECOMMENDED_MIGRATION_SEQUENCE[0].name).toBe('sync-lifecycle');
      expect(RECOMMENDED_MIGRATION_SEQUENCE[0].rebuildRules.length).toBeGreaterThan(0);

      expect(RECOMMENDED_MIGRATION_SEQUENCE[1].number).toBe('006');
      expect(RECOMMENDED_MIGRATION_SEQUENCE[1].filename).toBe('006-reconciliation-overlay.sql');
      expect(RECOMMENDED_MIGRATION_SEQUENCE[1].name).toBe('reconciliation-overlay');
      expect(RECOMMENDED_MIGRATION_SEQUENCE[1].rebuildRules.length).toBeGreaterThan(0);

      expect(RECOMMENDED_MIGRATION_SEQUENCE[2].number).toBe('007');
      expect(RECOMMENDED_MIGRATION_SEQUENCE[2].filename).toBe('007-user-agent-registry.sql');
      expect(RECOMMENDED_MIGRATION_SEQUENCE[2].name).toBe('user-agent-registry');
      expect(RECOMMENDED_MIGRATION_SEQUENCE[2].rebuildRules.length).toBeGreaterThan(0);

      expect(RECOMMENDED_MIGRATION_SEQUENCE[3].number).toBe('008');
      expect(RECOMMENDED_MIGRATION_SEQUENCE[3].filename).toBe('008-connection-lifecycle.sql');
      expect(RECOMMENDED_MIGRATION_SEQUENCE[3].name).toBe('connection-lifecycle');
      expect(RECOMMENDED_MIGRATION_SEQUENCE[3].rebuildRules.length).toBeGreaterThan(0);

      expect(RECOMMENDED_MIGRATION_SEQUENCE[4].number).toBe('009');
      expect(RECOMMENDED_MIGRATION_SEQUENCE[4].filename).toBe('009-slice-semantic-identity.sql');
      expect(RECOMMENDED_MIGRATION_SEQUENCE[4].name).toBe('slice-semantic-identity');
      expect(RECOMMENDED_MIGRATION_SEQUENCE[4].purpose).toContain(
        '(date, project_id, entity, entity_type, kind)'
      );
      expect(RECOMMENDED_MIGRATION_SEQUENCE[4].rebuildRules).toContain(
        'Populate each legacy allocation only from exactly one matching current slice; fail and roll back missing or ambiguous mappings.'
      );
    });

    it('defines all required RECONCILE_CODES including bounds and limits', () => {
      expect(RECONCILE_CODES.DETAIL_DOWNGRADE).toBe('DETAIL_DOWNGRADE');
      expect(RECONCILE_CODES.CURRENT_DAY_PROVISIONAL).toBe('CURRENT_DAY_PROVISIONAL');
      expect(RECONCILE_CODES.TIMEZONE_CHANGED).toBe('TIMEZONE_CHANGED');
      expect(RECONCILE_CODES.TIMEZONE_MISMATCH).toBe('TIMEZONE_MISMATCH');
      expect(RECONCILE_CODES.NEGATIVE_RESIDUAL).toBe('NEGATIVE_RESIDUAL');
      expect(RECONCILE_CODES.OVERCOUNT_TOLERANCE_EXCEEDED).toBe('OVERCOUNT_TOLERANCE_EXCEEDED');
      expect(RECONCILE_CODES.MATHEMATICAL_INVARIANT_VIOLATION).toBe('MATHEMATICAL_INVARIANT_VIOLATION');
      expect(RECONCILE_CODES.MISSING_REQUESTED_DATE).toBe('MISSING_REQUESTED_DATE');
      expect(RECONCILE_CODES.INCOMPLETE_BODY).toBe('INCOMPLETE_BODY');
      expect(RECONCILE_CODES.VERIFIED_ZERO_ACCEPTED).toBe('VERIFIED_ZERO_ACCEPTED');
      expect(RECONCILE_CODES.STALE_CONNECTION_GENERATION).toBe('STALE_CONNECTION_GENERATION');
      expect(RECONCILE_CODES.STALE_SNAPSHOT_VERSION).toBe('STALE_SNAPSHOT_VERSION');
      expect(RECONCILE_CODES.RUN_CANCELLED).toBe('RUN_CANCELLED');
      expect(RECONCILE_CODES.NO_DATES_UPDATED).toBe('NO_DATES_UPDATED');
      expect(RECONCILE_CODES.SYNC_QUEUE_FULL).toBe('SYNC_QUEUE_FULL');
      expect(RECONCILE_CODES.RESPONSE_SIZE_EXCEEDED).toBe('RESPONSE_SIZE_EXCEEDED');
      expect(RECONCILE_CODES.STAGED_DAY_SIZE_EXCEEDED).toBe('STAGED_DAY_SIZE_EXCEEDED');
      expect(RECONCILE_CODES.REGISTRY_PAGE_LIMIT_EXCEEDED).toBe('REGISTRY_PAGE_LIMIT_EXCEEDED');
      expect(RECONCILE_CODES.REGISTRY_ROW_LIMIT_EXCEEDED).toBe('REGISTRY_ROW_LIMIT_EXCEEDED');
      expect(RECONCILE_CODES.REGISTRY_BYTE_LIMIT_EXCEEDED).toBe('REGISTRY_BYTE_LIMIT_EXCEEDED');
      expect(RECONCILE_CODES.DAY_EXECUTION_TIMEOUT).toBe('DAY_EXECUTION_TIMEOUT');
      expect(RECONCILE_CODES.REQUEST_TIMEOUT).toBe('REQUEST_TIMEOUT');
      expect(RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED).toBe('UPSTREAM_RETRY_AFTER_EXCEEDED');
      expect(RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ID).toBe('UNSUPPORTED_HEARTBEAT_ID');
      expect(RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE).toBe('UNSUPPORTED_HEARTBEAT_ENVELOPE');
      expect(RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_DEPENDENCY).toBe('UNSUPPORTED_HEARTBEAT_DEPENDENCY');
      expect(RECONCILE_CODES.HEARTBEAT_PAYLOAD_CONFLICT).toBe('HEARTBEAT_PAYLOAD_CONFLICT');
      expect(RECONCILE_CODES.REGISTRY_PAGE_REPETITION).toBe('REGISTRY_PAGE_REPETITION');
      expect(RECONCILE_CODES.REGISTRY_CONFLICTING_ID).toBe('REGISTRY_CONFLICTING_ID');
      expect(RECONCILE_CODES.REGISTRY_INVALID_PAGINATION).toBe('REGISTRY_INVALID_PAGINATION');
    });
  });

  describe('Run Lifecycle State Transitions', () => {
    it('allows valid state progressions from queued and running', () => {
      expect(isValidRunTransition('queued', 'running')).toBe(true);
      expect(isValidRunTransition('queued', 'cancelled')).toBe(true);
      expect(isValidRunTransition('queued', 'interrupted')).toBe(true);
      expect(isValidRunTransition('queued', 'queued')).toBe(true);

      expect(isValidRunTransition('running', 'succeeded')).toBe(true);
      expect(isValidRunTransition('running', 'partial')).toBe(true);
      expect(isValidRunTransition('running', 'failed')).toBe(true);
      expect(isValidRunTransition('running', 'cancelled')).toBe(true);
      expect(isValidRunTransition('running', 'interrupted')).toBe(true);
      expect(isValidRunTransition('running', 'running')).toBe(true);
    });

    it('rejects illegal transitions and transitions out of terminal states', () => {
      expect(isValidRunTransition('queued', 'succeeded')).toBe(false);
      expect(isValidRunTransition('queued', 'partial')).toBe(false);
      expect(isValidRunTransition('queued', 'failed')).toBe(false);

      expect(isValidRunTransition('succeeded', 'running')).toBe(false);
      expect(isValidRunTransition('succeeded', 'queued')).toBe(false);
      expect(isValidRunTransition('failed', 'running')).toBe(false);
      expect(isValidRunTransition('cancelled', 'running')).toBe(false);
      expect(isValidRunTransition('interrupted', 'running')).toBe(false);

      expect(() => assertValidRunTransition('succeeded', 'running')).toThrow(Error);
    });
  });

  describe('Per-Date Sync Lifecycle State Transitions', () => {
    it('allows valid date status transitions', () => {
      expect(isValidDateTransition('pending', 'running')).toBe(true);
      expect(isValidDateTransition('pending', 'cancelled')).toBe(true);
      expect(isValidDateTransition('pending', 'interrupted')).toBe(true);
      expect(isValidDateTransition('pending', 'skipped')).toBe(true);

      expect(isValidDateTransition('running', 'succeeded')).toBe(true);
      expect(isValidDateTransition('running', 'partial')).toBe(true);
      expect(isValidDateTransition('running', 'failed')).toBe(true);
      expect(isValidDateTransition('running', 'skipped')).toBe(true);
      expect(isValidDateTransition('running', 'cancelled')).toBe(true);
      expect(isValidDateTransition('running', 'interrupted')).toBe(true);
    });

    it('rejects illegal date transitions out of terminal states', () => {
      expect(isValidDateTransition('pending', 'succeeded')).toBe(false);
      expect(isValidDateTransition('succeeded', 'running')).toBe(false);
      expect(isValidDateTransition('skipped', 'running')).toBe(false);
      expect(isValidDateTransition('cancelled', 'running')).toBe(false);

      expect(() => assertValidDateTransition('failed', 'running')).toThrow(Error);
    });
  });

  describe('Truthful Multi-Date Run Outcome Aggregation', () => {
    it('rejects nonterminal date input (pending/running) with an explicit error', () => {
      expect(() =>
        aggregateRunOutcome([
          { date: '2026-09-08', status: 'pending' },
          { date: '2026-09-09', status: 'succeeded' }
        ])
      ).toThrow(/nonterminal date status "pending"/);

      expect(() =>
        aggregateRunOutcome([
          { date: '2026-09-08', status: 'running' }
        ])
      ).toThrow(/nonterminal date status "running"/);
    });

    it('never reports succeeded when any date has a preserved disposition', () => {
      const outcome = aggregateRunOutcome([
        { date: '2026-09-07', status: 'succeeded', disposition: 'updated' },
        { date: '2026-09-08', status: 'succeeded', disposition: 'preserved', codes: [RECONCILE_CODES.DETAIL_DOWNGRADE] }
      ]);
      expect(outcome.status).toBe('partial'); // MUST NOT be succeeded!
      expect(outcome.advisoryCodes).toContain(RECONCILE_CODES.DETAIL_DOWNGRADE);
    });

    it('never reports succeeded when any date has a rejected disposition', () => {
      const outcome = aggregateRunOutcome([
        { date: '2026-09-07', status: 'succeeded', disposition: 'updated' },
        { date: '2026-09-08', status: 'succeeded', disposition: 'rejected', codes: [RECONCILE_CODES.OVERCOUNT_TOLERANCE_EXCEEDED] }
      ]);
      expect(outcome.status).toBe('partial');
    });

    it('never reports succeeded when degraded capability or detail warning is present', () => {
      const outcome = aggregateRunOutcome([
        { date: '2026-09-08', status: 'succeeded', disposition: 'updated', codes: ['HEARTBEATS_PLAN_RESTRICTED'] }
      ]);
      expect(outcome.status).toBe('partial');
      expect(outcome.advisoryCodes).toContain('HEARTBEATS_PLAN_RESTRICTED');
    });

    it('evaluates explicit cancellation and interruption with highest priority', () => {
      const outcomeCancel = aggregateRunOutcome(
        [{ status: 'succeeded', disposition: 'updated' }],
        { isCancelled: true }
      );
      expect(outcomeCancel.status).toBe('cancelled');
      expect(outcomeCancel.advisoryCodes).toContain(RECONCILE_CODES.RUN_CANCELLED);

      const outcomeInterrupt = aggregateRunOutcome(
        [{ status: 'succeeded', disposition: 'updated' }],
        { isInterrupted: true }
      );
      expect(outcomeInterrupt.status).toBe('interrupted');
    });

    it('evaluates registry run outcomes', () => {
      const ok = aggregateRunOutcome([], { isRegistryRun: true, registrySuccess: true });
      expect(ok.status).toBe('succeeded');

      const fail = aggregateRunOutcome([], { isRegistryRun: true, registrySuccess: false });
      expect(fail.status).toBe('failed');
    });

    it('evaluates all-succeeded run as succeeded only when completely clean', () => {
      const outcome = aggregateRunOutcome([
        { status: 'succeeded', disposition: 'updated' },
        { status: 'succeeded', disposition: 'unchanged' }
      ]);
      expect(outcome.status).toBe('succeeded');
      expect(outcome.summary).toContain('Successfully synced 2 date(s)');
    });

    it('rejects succeeded run outcome when any succeeded date has missing disposition and returns partial', () => {
      // Date is marked succeeded but has no disposition -> missing disposition is not proof of success!
      const outcome = aggregateRunOutcome([
        { date: '2026-09-08', status: 'succeeded' }
      ]);
      expect(outcome.status).toBe('partial');
      expect(outcome.summary).toContain('partially completed');
    });

    it('rejects succeeded run outcome when succeeded dates have mixed missing and explicit dispositions', () => {
      const outcome = aggregateRunOutcome([
        { date: '2026-09-07', status: 'succeeded', disposition: 'updated' },
        { date: '2026-09-08', status: 'succeeded' } // missing disposition
      ]);
      expect(outcome.status).toBe('partial');
    });

    it('evaluates all-skipped run as partial with NO_DATES_UPDATED (never succeeded)', () => {
      const outcome = aggregateRunOutcome([
        { status: 'skipped', codes: ['SUMMARIES_PLAN_RESTRICTED'] },
        { status: 'skipped', codes: ['SUMMARIES_PLAN_RESTRICTED'] }
      ]);
      expect(outcome.status).toBe('partial');
      expect(outcome.advisoryCodes).toContain(RECONCILE_CODES.NO_DATES_UPDATED);
      expect(outcome.summary).toContain('no archive data updated');
    });

    it('evaluates complete failure when no dates updated and failures occur', () => {
      const outcome = aggregateRunOutcome([
        { status: 'failed', codes: [RECONCILE_CODES.MISSING_REQUESTED_DATE] },
        { status: 'failed', codes: [RECONCILE_CODES.INCOMPLETE_BODY] }
      ]);
      expect(outcome.status).toBe('failed');
      expect(outcome.summary).toContain('Sync run failed across all 2 date(s)');
    });

    it('evaluates mixed run across all dates accurately', () => {
      const outcome = aggregateRunOutcome([
        { status: 'succeeded', disposition: 'updated' },
        { status: 'partial', codes: [RECONCILE_CODES.DETAIL_DOWNGRADE], disposition: 'preserved' },
        { status: 'failed', codes: [RECONCILE_CODES.INCOMPLETE_BODY] }
      ]);
      expect(outcome.status).toBe('partial');
      expect(outcome.advisoryCodes).toContain(RECONCILE_CODES.DETAIL_DOWNGRADE);
      expect(outcome.advisoryCodes).toContain(RECONCILE_CODES.INCOMPLETE_BODY);
      expect(outcome.summary).toContain('1 succeeded, 1 partial, 1 failed');
    });
  });

  describe('Idempotency Hashing', () => {
    it('computes deterministic SHA-256 hash irrespective of key insertion order', () => {
      const req1: RunRequest = {
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'idem-1',
        rangeStartDate: '2026-01-01',
        rangeEndDate: '2026-01-05'
      };

      const req2: RunRequest = {
        trigger: 'manual',
        mode: 'backfill',
        rangeEndDate: '2026-01-05',
        rangeStartDate: '2026-01-01',
        idempotencyKey: 'idem-1'
      };

      const hash1 = computeRunRequestPayloadHash(req1);
      const hash2 = computeRunRequestPayloadHash(req2);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it('computes different hash when payload parameters differ', () => {
      const req1: RunRequest = {
        mode: 'backfill',
        trigger: 'manual',
        idempotencyKey: 'idem-1',
        rangeStartDate: '2026-01-01',
        rangeEndDate: '2026-01-05'
      };

      const reqDifferentDates: RunRequest = {
        ...req1,
        rangeEndDate: '2026-01-06'
      };

      expect(computeRunRequestPayloadHash(req1)).not.toBe(
        computeRunRequestPayloadHash(reqDifferentDates)
      );
    });
  });

  describe('MCP Data Quality Projection Contract', () => {
    it('scrubs disallowed codes and sets asOf to null when days are missing', () => {
      const rawQuality = {
        asOf: '2026-09-08T10:00:00Z',
        hasMissingDays: true,
        hasStaleDays: false,
        hasLimitedDetail: true,
        advisoryCodes: [
          'DETAIL_DOWNGRADE',
          'CURRENT_DAY_PROVISIONAL',
          'RAW_UPSTREAM_INTERNAL_ERROR',
          'INTERNAL_ACCOUNT_ID_LEAK',
          'TIMEZONE_CHANGED'
        ]
      };

      const sanitized = sanitizeMcpDataQuality(rawQuality);
      expect(sanitized.asOf).toBeNull();
      expect(sanitized.hasMissingDays).toBe(true);
      expect(sanitized.hasLimitedDetail).toBe(true);
      expect(sanitized.advisoryCodes).toEqual([
        'DETAIL_DOWNGRADE',
        'CURRENT_DAY_PROVISIONAL',
        'TIMEZONE_CHANGED'
      ]);
      expect(sanitized.advisoryCodes.includes('RAW_UPSTREAM_INTERNAL_ERROR')).toBe(false);
      expect(sanitized.advisoryCodes.includes('INTERNAL_ACCOUNT_ID_LEAK')).toBe(false);
    });

    it('preserves asOf timestamp when coverage is complete', () => {
      const rawQuality = {
        asOf: '2026-09-08T10:00:00Z',
        hasMissingDays: false,
        hasStaleDays: false,
        hasLimitedDetail: false,
        advisoryCodes: ['CURRENT_DAY_PROVISIONAL']
      };

      const sanitized = sanitizeMcpDataQuality(rawQuality);
      expect(sanitized.asOf).toBe('2026-09-08T10:00:00Z');
      expect(sanitized.hasMissingDays).toBe(false);
    });
  });

  describe('Truthful Freshness Evaluation', () => {
    const fixedNow = new Date('2026-09-09T12:00:00Z');

    const baseRecord: LayerFreshnessRecord = {
      lastAttemptAt: '2026-09-09T11:00:00Z',
      lastSuccessAt: '2026-09-09T11:00:00Z',
      lastAcceptedChangeAt: '2026-09-09T11:00:00Z',
      acceptedSourceReference: 'src-1',
      acceptedSnapshotVersion: 1,
      acceptedFidelity: 'entity_detail',
      acceptedContentHash: 'hash-1',
      verifiedTimezone: 'UTC',
      evidenceMatchesSummary: true,
      statusCode: '200',
      nextRetryAt: null,
      isStale: false
    };

    it('marks explicitly stale records as stale regardless of age', () => {
      const res = evaluateDateFreshness('2026-09-09', { ...baseRecord, isStale: true }, fixedNow);
      expect(res.isStale).toBe(true);
      expect(res.reasons).toContain('EXPLICITLY_MARKED_STALE');
    });

    it('marks records with unresolved restriction, failure, mismatch, or detail downgrade as stale regardless of age', () => {
      // Unresolved mismatch
      expect(
        evaluateDateFreshness('2026-09-08', { ...baseRecord, unresolvedMismatch: true }, fixedNow).isStale
      ).toBe(true);

      // Detail downgrade
      expect(
        evaluateDateFreshness('2026-09-08', { ...baseRecord, hasDetailDowngrade: true }, fixedNow).isStale
      ).toBe(true);

      // Unresolved restriction
      expect(
        evaluateDateFreshness('2026-09-08', { ...baseRecord, hasRestriction: true }, fixedNow).isStale
      ).toBe(true);

      // Unresolved failure
      expect(
        evaluateDateFreshness('2026-09-08', { ...baseRecord, hasFailure: true }, fixedNow).isStale
      ).toBe(true);
    });

    it('fails closed on missing, invalid, or future success timestamps', () => {
      expect(
        evaluateDateFreshness('2026-09-08', { ...baseRecord, lastSuccessAt: null }, fixedNow).isStale
      ).toBe(true);

      expect(
        evaluateDateFreshness('2026-09-08', { ...baseRecord, lastSuccessAt: 'not-a-timestamp' }, fixedNow).isStale
      ).toBe(true);

      expect(
        evaluateDateFreshness('2026-09-08', { ...baseRecord, lastSuccessAt: '2026-09-10T12:00:00Z' }, fixedNow).isStale
      ).toBe(true);
    });

    it('marks evidence-summary mismatch or verified timezone mismatch as stale', () => {
      expect(
        evaluateDateFreshness('2026-09-08', { ...baseRecord, evidenceMatchesSummary: false }, fixedNow).isStale
      ).toBe(true);

      expect(
        evaluateDateFreshness('2026-09-08', { ...baseRecord, verifiedTimezone: 'America/New_York' }, fixedNow, 'UTC').isStale
      ).toBe(true);
    });

    it('returns CURRENT_DAY_PROVISIONAL for today in source timezone', () => {
      const res = evaluateDateFreshness('2026-09-09', baseRecord, fixedNow, 'UTC');
      expect(res.isProvisional).toBe(true);
      expect(res.reasons).toContain(RECONCILE_CODES.CURRENT_DAY_PROVISIONAL);
      // But if it was checked 1h ago and no failure, not marked stale solely by provisional:
      expect(res.isStale).toBe(false);
    });

    it('enforces 2-hour threshold for today and yesterday', () => {
      // 3 hours ago: stale
      const staleRecord = { ...baseRecord, lastSuccessAt: '2026-09-09T09:00:00Z' };
      const res = evaluateDateFreshness('2026-09-08', staleRecord, fixedNow);
      expect(res.isStale).toBe(true);
      expect(res.reasons).toContain('RECENT_EXCEEDED_2H');
    });

    it('enforces 26-hour threshold for 14-day reconciliation window', () => {
      // 28 hours ago for date 5 days back
      const staleRecord = { ...baseRecord, lastSuccessAt: '2026-09-08T08:00:00Z' };
      const res = evaluateDateFreshness('2026-09-04', staleRecord, fixedNow);
      expect(res.isStale).toBe(true);
      expect(res.reasons).toContain('RECONCILE_EXCEEDED_26H');
    });

    it('does not mark newly accepted coarse_project record stale when recent and no downgrade occurred', () => {
      const coarseRecord = {
        ...baseRecord,
        acceptedFidelity: 'coarse_project' as const,
        hasDetailDowngrade: false,
        statusCode: '200'
      };
      // For yesterday (2026-09-08) synced 1h ago, without downgrade signal:
      const res = evaluateDateFreshness('2026-09-08', coarseRecord, fixedNow);
      expect(res.isStale).toBe(false);
      expect(res.reasons).not.toContain('DETAIL_DOWNGRADE_PRESERVED');
    });

    it('marks coarse_project record stale if hasDetailDowngrade is set or DETAIL_DOWNGRADE code is present', () => {
      const downgradeRecord1 = {
        ...baseRecord,
        acceptedFidelity: 'coarse_project' as const,
        hasDetailDowngrade: true
      };
      const res1 = evaluateDateFreshness('2026-09-08', downgradeRecord1, fixedNow);
      expect(res1.isStale).toBe(true);
      expect(res1.reasons).toContain('DETAIL_DOWNGRADE_PRESERVED');

      const downgradeRecord2 = {
        ...baseRecord,
        acceptedFidelity: 'coarse_project' as const,
        statusCode: RECONCILE_CODES.DETAIL_DOWNGRADE
      };
      const res2 = evaluateDateFreshness('2026-09-08', downgradeRecord2, fixedNow);
      expect(res2.isStale).toBe(true);
      expect(res2.reasons).toContain('DETAIL_DOWNGRADE_PRESERVED');
    });

    it('strictly validates requested date format and fails closed as stale on invalid date strings', () => {
      expect(evaluateDateFreshness('invalid-date', baseRecord, fixedNow).isStale).toBe(true);
      expect(evaluateDateFreshness('invalid-date', baseRecord, fixedNow).reasons).toContain('INVALID_DATE_STRING');
      expect(evaluateDateFreshness('2026-02-29', baseRecord, fixedNow).isStale).toBe(true); // 2026 is not leap year
      expect(evaluateDateFreshness('', baseRecord, fixedNow).isStale).toBe(true);
    });

    it('marks future requested dates stale and does not treat them as recent', () => {
      // today in UTC fixedNow is 2026-09-09; tomorrow is 2026-09-10
      const futureRes = evaluateDateFreshness('2026-09-10', baseRecord, fixedNow, 'UTC');
      expect(futureRes.isStale).toBe(true);
      expect(futureRes.reasons).toContain('FUTURE_REQUESTED_DATE');
      // Must NOT be marked with RECENT_EXCEEDED_2H or treated as recent today/yesterday
      expect(futureRes.reasons.some((r) => r.startsWith('RECENT_EXCEEDED'))).toBe(false);
      expect(futureRes.isProvisional).toBe(false);
    });
  });

  describe('Retained Project Scopes Validation', () => {
    it('detects when incoming summary covers vs downgrades accepted project scopes', () => {
      const accepted: SummaryCompleteness = {
        hasAccountTotals: true,
        hasProjectTotals: true,
        hasEntityDetail: true,
        isVerifiedZero: false,
        overallEntityDetailState: 'complete_detail',
        projectScopes: {
          'work-times': {
            projectName: 'work-times',
            totalSeconds: 3600,
            entityDetailState: 'present',
            entityCount: 2
          }
        },
        missingFields: []
      };

      // Case 1: Incoming covers accepted project with present entity detail
      const incomingCovered: SummaryCompleteness = {
        ...accepted,
        projectScopes: {
          'work-times': {
            projectName: 'work-times',
            totalSeconds: 3600,
            entityDetailState: 'present',
            entityCount: 3
          }
        }
      };
      expect(coversRetainedScopes(incomingCovered, accepted)).toBe(true);

      // Case 2: Incoming has absent entity detail for 'work-times' (detail downgrade)
      const incomingDowngrade: SummaryCompleteness = {
        ...accepted,
        overallEntityDetailState: 'coarse_only',
        projectScopes: {
          'work-times': {
            projectName: 'work-times',
            totalSeconds: 3600,
            entityDetailState: 'absent',
            entityCount: 0
          }
        }
      };
      expect(coversRetainedScopes(incomingDowngrade, accepted)).toBe(false);

      // Case 3: Retained project missing entirely from incoming replacement
      const incomingMissingProject: SummaryCompleteness = {
        ...accepted,
        projectScopes: {}
      };
      expect(coversRetainedScopes(incomingMissingProject, accepted)).toBe(false);
    });
  });

  describe('Synthetic Fixtures Matrix Verification', () => {
    it('1. Flat project totals with missing entity detail', () => {
      const f = SYNTHETIC_FIXTURES.flatProjectSummary;
      expect(f.expectedFidelity).toBe('coarse_project');
      expect(f.expectedCompleteness.hasProjectTotals).toBe(true);
      expect(f.expectedCompleteness.hasEntityDetail).toBe(false);
      expect(f.expectedCompleteness.overallEntityDetailState).toBe('coarse_only');
      expect(f.expectedCompleteness.projectScopes['work-times'].entityDetailState).toBe('absent');
      expect(f.expectedSliceCount).toBe(2);
      expect(f.expectedSliceKinds).toEqual(['project_summary', 'project_summary']);
    });

    it('2. Verified zero day', () => {
      const f = SYNTHETIC_FIXTURES.verifiedZeroDay;
      expect(f.expectedFidelity).toBe('verified_zero');
      expect(f.expectedCompleteness.isVerifiedZero).toBe(true);
      expect(f.expectedCompleteness.overallEntityDetailState).toBe('empty');
      expect(f.expectedSliceCount).toBe(0);
      expect(f.rawPayload.data[0].grand_total.total_seconds).toBe(0.0);
    });

    it('3. Missing requested date', () => {
      const f = SYNTHETIC_FIXTURES.missingRequestedDate;
      expect(f.expectedReconcileDisposition).toBe('rejected');
      expect(f.expectedDayStatus).toBe('failed');
      expect(f.expectedCode).toBe(RECONCILE_CODES.MISSING_REQUESTED_DATE);
    });

    it('4. Incomplete body', () => {
      const f = SYNTHETIC_FIXTURES.incompleteBody;
      expect(f.expectedCode).toBe(RECONCILE_CODES.INCOMPLETE_BODY);
      expect(f.expectedDayStatus).toBe('failed');
      expect(f.expectedReconcileDisposition).toBe('rejected');
    });

    it('5. Detail downgrade scenario', () => {
      const s = SYNTHETIC_FIXTURES.detailDowngrade;
      expect(s.expectedReconcileDisposition).toBe('preserved');
      expect(s.expectedDayStatus).toBe('partial');
      expect(s.expectedCode).toBe(RECONCILE_CODES.DETAIL_DOWNGRADE);
      expect(s.existingAcceptedDay.fidelity).toBe('entity_detail');
      expect(s.incomingObservation.fidelity).toBe('coarse_project');
    });

    it('6. Unsupported heartbeat IDs, envelopes, and dependencies', () => {
      const f = SYNTHETIC_FIXTURES.unsupportedHeartbeats;
      expect(f.expectedCodes.invalidId).toBe(RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ID);
      expect(f.expectedCodes.invalidDependencies).toBe(
        RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_DEPENDENCY
      );
      expect(f.expectedCodes.invalidEnvelope).toBe(RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE);
      expect(f.expectedCodes.conflict).toBe(RECONCILE_CODES.HEARTBEAT_PAYLOAD_CONFLICT);
    });

    it('7. Registry pagination ambiguity, repetition, and conflict', () => {
      const f = SYNTHETIC_FIXTURES.registryPagination;
      expect(f.expectedCodes.repetition).toBe(RECONCILE_CODES.REGISTRY_PAGE_REPETITION);
      expect(f.expectedCodes.conflict).toBe(RECONCILE_CODES.REGISTRY_CONFLICTING_ID);
      expect(f.expectedCodes.invalidEnvelope).toBe(RECONCILE_CODES.REGISTRY_INVALID_PAGINATION);
    });

    it('8. Timezone mismatch', () => {
      const f = SYNTHETIC_FIXTURES.timezoneMismatch;
      expect(f.expectedCode).toBe(RECONCILE_CODES.TIMEZONE_MISMATCH);
      expect(f.expectedDayStatus).toBe('failed');
      expect(f.expectedReconcileDisposition).toBe('rejected');
    });

    it('9. Overcount exceeding tolerance', () => {
      const f = SYNTHETIC_FIXTURES.overcountDay;
      expect(f.expectedCode).toBe(RECONCILE_CODES.OVERCOUNT_TOLERANCE_EXCEEDED);
      expect(f.expectedDayStatus).toBe('failed');
      expect(f.expectedReconcileDisposition).toBe('rejected');
      expect(f.discrepancySeconds).toBeGreaterThan(DURATION_COMPARISON_TOLERANCE_SECONDS);
    });

    it('10. Tiny positive residual captured in unattributed slice', () => {
      const f = SYNTHETIC_FIXTURES.tinyPositiveResidual;
      expect(f.expectedResidualSeconds).toBe(0.005);
      expect(f.expectedUnattributedSlice.entity).toBe('__unattributed__');
      expect(f.expectedUnattributedSlice.isUnattributed).toBe(1);
    });

    it('11. Connection generation CAS guard', () => {
      const f = SYNTHETIC_FIXTURES.connectionGeneration;
      expect(f.activeConnection.generation).toBe(2);
      expect(f.staleWorkerCandidate.assumedGeneration).toBe(1);
      expect(f.expectedStaleCode).toBe(RECONCILE_CODES.STALE_CONNECTION_GENERATION);
    });
  });
});
