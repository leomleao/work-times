import { describe, it, expect, vi } from 'vitest';
import { fetchDay, createRecordingFetch } from './fetch-day.js';
import { WakaTimeClient } from '../wakatime/client.js';
import {
  CapabilityRestrictedError,
  WakaTimeAuthError,
  WakaTimeDeferredRetryError,
  WakaTimeRequestTimeoutError,
  WakaTimeResponseSizeExceededError
} from '../wakatime/errors.js';
import { CapabilityPolicy } from './capabilities.js';
import { RECONCILE_CODES } from './contracts.js';
import {
  FLAT_PROJECT_SUMMARY_RAW,
  VERIFIED_ZERO_DAY_RAW,
  MISSING_REQUESTED_DATE_RAW
} from './fixtures/index.js';

describe('fetchDay (Single-Date Fetcher)', () => {
  const fixedNow = new Date('2026-09-10T12:00:00.000Z');
  const dummyToken = 'test_token_123';

  const validDetailedSummaryRaw = {
    data: [
      {
        date: '2026-09-08',
        range: {
          date: '2026-09-08',
          start: '2026-09-08T00:00:00Z',
          end: '2026-09-08T23:59:59Z',
          timezone: 'Europe/London'
        },
        grand_total: {
          total_seconds: 3600,
          human_additions: 10,
          human_deletions: 5,
          ai_additions: 0,
          ai_deletions: 0,
          ai_sessions: 0
        },
        projects: [
          {
            name: 'work-times',
            total_seconds: 3600,
            percent: 100,
            entities: [
              {
                name: 'src/lib/app.ts',
                type: 'file',
                total_seconds: 3600,
                percent: 100
              }
            ]
          }
        ]
      }
    ]
  };

  const validHeartbeatsRaw = {
    data: [
      {
        id: '123e4567-e89b-12d3-a456-426614174000',
        entity: 'src/lib/app.ts',
        type: 'file',
        time: 1788868800, // 2026-09-08T12:00:00Z
        project: 'work-times',
        branch: 'main',
        language: 'TypeScript',
        category: 'coding',
        dependencies: ['vitest', 'svelte'],
        user_agent_id: 'ua_1'
      }
    ]
  };

  it('rejects invalid calendar date immediately without network requests', async () => {
    const fetchSpy = vi.fn();
    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: fetchSpy as any });

    const result = await fetchDay({
      date: '2026-02-31', // invalid date
      client,
      connectionGeneration: 1,
      now: () => fixedNow
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.candidate.summaries.kind).toBe('failed');
    if (result.candidate.summaries.kind === 'failed') {
      expect(result.candidate.summaries.code).toBe(RECONCILE_CODES.MISSING_REQUESTED_DATE);
    }
    expect(result.candidate.heartbeats.kind).toBe('skipped');
    expect(result.advisoryCodes).toContain(RECONCILE_CODES.MISSING_REQUESTED_DATE);
  });

  it('aborts immediately when cancellation signal is already triggered', async () => {
    const fetchSpy = vi.fn();
    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: fetchSpy as any });
    const controller = new AbortController();
    controller.abort(new Error('User cancelled'));

    const result = await fetchDay({
      date: '2026-09-08',
      client,
      connectionGeneration: 1,
      signal: controller.signal,
      now: () => fixedNow
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.candidate.summaries.kind).toBe('failed');
    if (result.candidate.summaries.kind === 'failed') {
      expect(result.candidate.summaries.code).toBe(RECONCILE_CODES.RUN_CANCELLED);
    }
    expect(result.candidate.heartbeats.kind).toBe('skipped');
    expect(result.advisoryCodes).toContain(RECONCILE_CODES.RUN_CANCELLED);
  });

  it('fetches and normalizes a complete detailed day with exact rawSources lineage', async () => {
    const summaryJson = JSON.stringify(validDetailedSummaryRaw);
    const heartbeatsJson = JSON.stringify(validHeartbeatsRaw);

    const baseFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('/summaries')) {
        return new Response(summaryJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/heartbeats')) {
        return new Response(heartbeatsJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    };

    const recording = createRecordingFetch(baseFetch);
    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: recording.fetch });

    const result = await fetchDay({
      date: '2026-09-08',
      client,
      pinnedTimezone: 'Europe/London',
      connectionGeneration: 1,
      recordingFetch: recording,
      now: () => fixedNow
    });

    expect(result.candidate.summaries.kind).toBe('complete');
    expect(result.candidate.heartbeats.kind).toBe('complete');
    if (result.candidate.summaries.kind === 'complete') {
      expect(result.candidate.summaries.value.fidelity).toBe('entity_detail');
      expect(result.candidate.summaries.value.totalSeconds).toBe(3600);
      expect(result.candidate.summaries.value.slices.length).toBe(1);
    }
    if (result.candidate.heartbeats.kind === 'complete') {
      expect(result.candidate.heartbeats.value.heartbeats.length).toBe(1);
      expect(result.candidate.heartbeats.value.heartbeats[0].id).toBe('123e4567-e89b-12d3-a456-426614174000');
    }

    // Exact rawSources lineage handoff
    expect(result.rawSources.summaries?.rawJson).toBe(summaryJson);
    expect(result.rawSources.heartbeats?.rawJson).toBe(heartbeatsJson);
    expect(result.rawSources.heartbeats?.events?.length).toBe(1);
    expect(result.rawSources.heartbeats?.events?.[0].externalId).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(result.rawSources.heartbeats?.events?.[0].rawJson).toContain('123e4567-e89b-12d3-a456-426614174000');
  });

  it('handles verified zero day: completes summary with 0 seconds and truthful skipped heartbeats without synthetic raw source', async () => {
    const zeroSummaryJson = JSON.stringify(VERIFIED_ZERO_DAY_RAW);
    const requestedUrls: string[] = [];

    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      requestedUrls.push(url);
      if (url.includes('/summaries')) {
        return new Response(zeroSummaryJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    };

    const recording = createRecordingFetch(mockFetch);
    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: recording.fetch });

    const result = await fetchDay({
      date: '2026-09-07',
      client,
      pinnedTimezone: 'Europe/London',
      connectionGeneration: 1,
      recordingFetch: recording,
      now: () => fixedNow
    });

    expect(result.candidate.summaries.kind).toBe('complete');
    if (result.candidate.summaries.kind === 'complete') {
      expect(result.candidate.summaries.value.fidelity).toBe('verified_zero');
      expect(result.candidate.summaries.value.totalSeconds).toBe(0);
      expect(result.candidate.summaries.value.completeness.isVerifiedZero).toBe(true);
    }
    // Heartbeats must be truthful: skipped, no network call, no synthetic raw source
    expect(result.candidate.heartbeats.kind).toBe('skipped');
    expect(result.rawSources.heartbeats).toBeUndefined();
    expect(requestedUrls.some((u) => u.includes('/heartbeats'))).toBe(false);
  });

  it('detects timezone mismatch against pinned account timezone', async () => {
    const mismatchSummary = {
      data: [
        {
          date: '2026-09-08',
          range: {
            date: '2026-09-08',
            timezone: 'America/New_York' // Mismatches pinned Europe/London!
          },
          grand_total: { total_seconds: 100, human_additions: 0, human_deletions: 0, ai_additions: 0, ai_deletions: 0, ai_sessions: 0 },
          projects: []
        }
      ]
    };

    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify(mismatchSummary), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: mockFetch });

    const result = await fetchDay({
      date: '2026-09-08',
      client,
      pinnedTimezone: 'Europe/London',
      connectionGeneration: 1,
      now: () => fixedNow
    });

    expect(result.candidate.summaries.kind).toBe('failed');
    if (result.candidate.summaries.kind === 'failed') {
      expect(result.candidate.summaries.code).toBe(RECONCILE_CODES.TIMEZONE_MISMATCH);
    }
    expect(result.candidate.heartbeats.kind).toBe('skipped');
    expect(result.advisoryCodes).toContain(RECONCILE_CODES.TIMEZONE_MISMATCH);
  });

  it('detects missing requested date from returned summaries', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify(MISSING_REQUESTED_DATE_RAW), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };

    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: mockFetch });

    const result = await fetchDay({
      date: '2026-09-08', // Looking for 2026-09-08, but raw has 2026-09-01
      client,
      pinnedTimezone: 'Europe/London',
      connectionGeneration: 1,
      now: () => fixedNow
    });

    expect(result.candidate.summaries.kind).toBe('failed');
    if (result.candidate.summaries.kind === 'failed') {
      expect(result.candidate.summaries.code).toBe(RECONCILE_CODES.MISSING_REQUESTED_DATE);
    }
    expect(result.candidate.heartbeats.kind).toBe('skipped');
    expect(result.advisoryCodes).toContain(RECONCILE_CODES.MISSING_REQUESTED_DATE);
  });

  it('handles 401 revoked auth on summaries as terminal failure', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(null, { status: 401 });
    };

    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: mockFetch });

    const result = await fetchDay({
      date: '2026-09-08',
      client,
      connectionGeneration: 1,
      now: () => fixedNow
    });

    expect(result.candidate.summaries.kind).toBe('failed');
    if (result.candidate.summaries.kind === 'failed') {
      expect(result.candidate.summaries.code).toBe('AUTH_FAILED');
    }
    expect(result.candidate.heartbeats.kind).toBe('skipped');
    expect(result.advisoryCodes).toContain('AUTH_FAILED');
  });

  it('records old-date 402 restriction only on that date without globally disabling recent endpoint', async () => {
    const oldDate = '2026-08-01'; // Outside 7-day free window relative to 2026-09-10
    const policy = new CapabilityPolicy();

    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes(oldDate)) {
        return new Response(JSON.stringify({ error: 'Upgrade required' }), {
          status: 402,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify(validDetailedSummaryRaw), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };

    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: mockFetch });

    const result = await fetchDay({
      date: oldDate,
      client,
      connectionGeneration: 1,
      policy,
      now: () => fixedNow
    });

    expect(result.candidate.summaries.kind).toBe('restricted');
    if (result.candidate.summaries.kind === 'restricted') {
      expect(result.candidate.summaries.code).toBe('HTTP_402');
    }
    expect(result.candidate.heartbeats.kind).toBe('skipped');

    // Policy check: old date is restricted, but global endpoint remains available
    expect(policy.isRestricted('summaries')).toBe(false);
    expect(policy.shouldAttempt('summaries', '2026-09-09', fixedNow)).toBe(true);
    expect(policy.shouldAttempt('summaries', oldDate, fixedNow)).toBe(false);
  });

  it('honors untruncated deferred Retry-After when upstream rate limit exceeds budget', async () => {
    const retryAtIso = '2026-09-11T12:00:00.000Z';
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'Retry-After': '86400' // 24 hours
        }
      });
    };

    // Budget of 5 seconds is much smaller than 86400s -> throws WakaTimeDeferredRetryError
    const client = new WakaTimeClient({
      accessToken: dummyToken,
      fetch: mockFetch,
      budgetMs: 5000,
      now: () => fixedNow.getTime()
    });
    const policy = new CapabilityPolicy();

    const result = await fetchDay({
      date: '2026-09-08',
      client,
      connectionGeneration: 1,
      policy,
      now: () => fixedNow
    });

    expect(result.candidate.summaries.kind).toBe('restricted');
    if (result.candidate.summaries.kind === 'restricted') {
      expect(result.candidate.summaries.code).toBe(RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED);
      expect(result.candidate.summaries.retryAt).toBeTruthy();
      const expectedRetryAt = new Date(fixedNow.getTime() + 86400 * 1000).toISOString();
      expect(result.candidate.summaries.retryAt).toBe(expectedRetryAt);
    }
    expect(result.advisoryCodes).toContain(RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED);
  });

  it('degrades cleanly when summaries succeeds but heartbeats is restricted (403)', async () => {
    const summaryJson = JSON.stringify(validDetailedSummaryRaw);
    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('/summaries')) {
        return new Response(summaryJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/heartbeats')) {
        return new Response(JSON.stringify({ error: 'Heartbeats forbidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(null, { status: 404 });
    };

    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: mockFetch });
    const policy = new CapabilityPolicy();

    const result = await fetchDay({
      date: '2026-09-08',
      client,
      pinnedTimezone: 'Europe/London',
      connectionGeneration: 1,
      policy,
      now: () => fixedNow
    });

    expect(result.candidate.summaries.kind).toBe('complete');
    expect(result.candidate.heartbeats.kind).toBe('restricted');
    if (result.candidate.heartbeats.kind === 'restricted') {
      expect(result.candidate.heartbeats.code).toBe('HTTP_403');
    }
    expect(result.advisoryCodes).toContain('HEARTBEATS_PLAN_RESTRICTED');
  });

  it('degrades cleanly when optional durations endpoint is requested and restricted', async () => {
    const summaryJson = JSON.stringify(validDetailedSummaryRaw);
    const heartbeatsJson = JSON.stringify(validHeartbeatsRaw);

    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('/summaries')) {
        return new Response(summaryJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/heartbeats')) {
        return new Response(heartbeatsJson, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/durations')) {
        return new Response(JSON.stringify({ error: 'Upgrade required' }), {
          status: 402,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(null, { status: 404 });
    };

    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: mockFetch });

    const result = await fetchDay({
      date: '2026-09-08',
      client,
      pinnedTimezone: 'Europe/London',
      connectionGeneration: 1,
      attemptDurations: true,
      now: () => fixedNow
    });

    expect(result.candidate.summaries.kind).toBe('complete');
    expect(result.candidate.heartbeats.kind).toBe('complete');
    expect(result.durationsResult.attempted).toBe(true);
    expect(result.durationsResult.status).toBe('restricted');
    expect(result.durationsResult.code).toBe('HTTP_402');
    expect(result.advisoryCodes).toContain('DURATIONS_PLAN_RESTRICTED');
  });

  it('records sequential dates reliably with distinct raw formatting/content on the same recorder', async () => {
    // Date A: 2026-09-08 with indented formatting
    const rawWireDateA = JSON.stringify(validDetailedSummaryRaw, null, 2);
    // Date B: 2026-09-09 with compact formatting
    const rawWireDateB = JSON.stringify({
      data: [
        {
          date: '2026-09-09',
          range: { date: '2026-09-09', timezone: 'Europe/London' },
          grand_total: { total_seconds: 1800, human_additions: 2, human_deletions: 1, ai_additions: 0, ai_deletions: 0, ai_sessions: 0 },
          projects: []
        }
      ]
    });

    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes('2026-09-08')) {
        return new Response(rawWireDateA, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('2026-09-09')) {
        return new Response(rawWireDateB, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    };

    const recording = createRecordingFetch(mockFetch);
    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: recording.fetch });

    // Fetch Date A
    const resultA = await fetchDay({
      date: '2026-09-08',
      client,
      pinnedTimezone: 'Europe/London',
      connectionGeneration: 1,
      recordingFetch: recording,
      now: () => fixedNow
    });

    // Fetch Date B on the SAME recorder
    const resultB = await fetchDay({
      date: '2026-09-09',
      client,
      pinnedTimezone: 'Europe/London',
      connectionGeneration: 1,
      recordingFetch: recording,
      now: () => fixedNow
    });

    expect(resultA.rawSources.summaries?.rawJson).toBe(rawWireDateA);
    expect(resultB.rawSources.summaries?.rawJson).toBe(rawWireDateB);
    expect(resultB.rawSources.summaries?.rawJson).not.toBe(rawWireDateA);
  });

  it('bounds response capture at configured limit without weakening client response-size failure', async () => {
    // 200 bytes of response
    const largePayload = JSON.stringify({ data: 'x'.repeat(200) });

    const mockFetch: typeof fetch = async () => {
      return new Response(largePayload, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(largePayload.length) }
      });
    };

    // Inject small limit of 50 bytes into both recorder and client
    const recording = createRecordingFetch(mockFetch, { maxBytes: 50 });
    const client = new WakaTimeClient({
      accessToken: dummyToken,
      fetch: recording.fetch,
      maxResponseSizeBytes: 50
    });

    const result = await fetchDay({
      date: '2026-09-08',
      client,
      connectionGeneration: 1,
      recordingFetch: recording,
      now: () => fixedNow
    });

    expect(result.candidate.summaries.kind).toBe('failed');
    if (result.candidate.summaries.kind === 'failed') {
      expect(result.candidate.summaries.code).toBe(RECONCILE_CODES.RESPONSE_SIZE_EXCEEDED);
    }
    // Recorder did not store oversized response
    expect(recording.getRawText('/summaries')).toBeUndefined();
  });

  it('distinguishes cached old-date 403, cached Retry-After, and cached transient error', async () => {
    const policy = new CapabilityPolicy();
    const oldDate = '2026-08-01'; // Outside free window relative to 2026-09-10
    const retryAt = '2026-09-12T12:00:00.000Z';

    const client = new WakaTimeClient({
      accessToken: dummyToken,
      fetch: (async () => new Response(null, { status: 404 })) as any
    });

    // 1. Cached old-date 403
    policy.recordRestriction('summaries', 403, oldDate, fixedNow);
    const resultOld403 = await fetchDay({
      date: oldDate,
      client,
      connectionGeneration: 1,
      policy,
      now: () => fixedNow
    });
    expect(resultOld403.candidate.summaries.kind).toBe('restricted');
    if (resultOld403.candidate.summaries.kind === 'restricted') {
      expect(resultOld403.candidate.summaries.code).toBe('HTTP_403');
    }
    expect(resultOld403.advisoryCodes).toContain('SUMMARIES_PLAN_RESTRICTED');

    // 2. Cached Retry-After hold
    const policyRetry = new CapabilityPolicy();
    policyRetry.recordDeferredRetry('summaries', retryAt, fixedNow);
    const resultRetry = await fetchDay({
      date: '2026-09-09',
      client,
      connectionGeneration: 1,
      policy: policyRetry,
      now: () => fixedNow
    });
    expect(resultRetry.candidate.summaries.kind).toBe('restricted');
    if (resultRetry.candidate.summaries.kind === 'restricted') {
      expect(resultRetry.candidate.summaries.code).toBe(RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED);
      expect(resultRetry.candidate.summaries.retryAt).toBe(retryAt);
    }
    expect(resultRetry.advisoryCodes).toContain(RECONCILE_CODES.UPSTREAM_RETRY_AFTER_EXCEEDED);
    expect(resultRetry.advisoryCodes).not.toContain('SUMMARIES_PLAN_RESTRICTED');
    expect(resultRetry.advisoryCodes).not.toContain('HTTP_403');

    // 3. Cached transient error hold
    const policyError = new CapabilityPolicy();
    policyError.recordError('summaries', new Error('ETIMEDOUT'), fixedNow);
    const resultError = await fetchDay({
      date: '2026-09-09',
      client,
      connectionGeneration: 1,
      policy: policyError,
      now: () => fixedNow
    });
    expect(resultError.candidate.summaries.kind).toBe('failed');
    if (resultError.candidate.summaries.kind === 'failed') {
      expect(resultError.candidate.summaries.code).toBe('SUMMARIES_FAILED');
    }
    expect(resultError.advisoryCodes).toContain('SUMMARIES_FAILED');
    expect(resultError.advisoryCodes).not.toContain('SUMMARIES_PLAN_RESTRICTED');
    expect(resultError.advisoryCodes).not.toContain('HTTP_403');
  });

  it('reflects advancing clock at completion time in observation metadata rather than start time', async () => {
    const summaryJson = JSON.stringify(validDetailedSummaryRaw);
    let clockTicks = 0;
    // Clock starts at 12:00:00, advances by 10 seconds on each call
    const advancingNow = () => {
      clockTicks++;
      return new Date(fixedNow.getTime() + clockTicks * 10000);
    };

    const mockFetch: typeof fetch = async () => {
      return new Response(summaryJson, { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const client = new WakaTimeClient({ accessToken: dummyToken, fetch: mockFetch });

    const result = await fetchDay({
      date: '2026-09-08',
      client,
      pinnedTimezone: 'Europe/London',
      connectionGeneration: 1,
      now: advancingNow
    });

    expect(result.candidate.summaries.kind).toBe('complete');
    if (result.candidate.summaries.kind === 'complete') {
      const observedTime = new Date(result.candidate.summaries.observedAt).getTime();
      // Must be strictly after fixedNow (start time before network work)
      expect(observedTime).toBeGreaterThan(fixedNow.getTime());
    }
  });
});
