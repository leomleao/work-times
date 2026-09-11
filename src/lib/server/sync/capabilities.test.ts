import { describe, it, expect, vi } from 'vitest';
import {
  CapabilityPolicy,
  probeCapabilities,
  isDateWithinFreeWindow,
  getFreeWindowStartDate,
  getYesterdayDate,
  WAKATIME_FREE_TIER_WINDOW_DAYS,
  DEFAULT_REPROBE_INTERVAL_MS,
  type SyncStepResult
} from './capabilities.js';
import {
  WakaTimeClient,
  CapabilityRestrictedError,
  WakaTimeAuthError
} from '../wakatime/index.js';

describe('Sync Capability Policy', () => {
  const fixedNow = new Date('2026-09-05T12:00:00Z');

  describe('7-Day Free-Tier Window Policy Constants and Helpers', () => {
    it('defines 7-day free window constant documented as policy', () => {
      expect(WAKATIME_FREE_TIER_WINDOW_DAYS).toBe(7);
      expect(DEFAULT_REPROBE_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    });

    it('correctly identifies dates within the 7-calendar-day inclusive window (today minus 6)', () => {
      // fixedNow is 2026-09-05
      // 7 calendar days inclusive of today:
      // Day 1: 2026-09-05 (today)
      // Day 2: 2026-09-04 (yesterday)
      // Day 3: 2026-09-03
      // Day 4: 2026-09-02
      // Day 5: 2026-09-01
      // Day 6: 2026-08-31
      // Day 7: 2026-08-30 (today minus 6)
      expect(isDateWithinFreeWindow('2026-09-05', fixedNow)).toBe(true);
      expect(isDateWithinFreeWindow('2026-09-04', fixedNow)).toBe(true);
      expect(isDateWithinFreeWindow('2026-09-03', fixedNow)).toBe(true);
      expect(isDateWithinFreeWindow('2026-09-02', fixedNow)).toBe(true);
      expect(isDateWithinFreeWindow('2026-09-01', fixedNow)).toBe(true);
      expect(isDateWithinFreeWindow('2026-08-31', fixedNow)).toBe(true);
      expect(isDateWithinFreeWindow('2026-08-30', fixedNow)).toBe(true); // exactly 6 days back (7th calendar day)
      expect(isDateWithinFreeWindow('2026-08-29', fixedNow)).toBe(false); // 7 days back (8th day): outside 7-day window
      expect(isDateWithinFreeWindow('2026-08-28', fixedNow)).toBe(false); // 8 days back: outside policy window
      expect(isDateWithinFreeWindow('2026-08-01', fixedNow)).toBe(false);
      expect(isDateWithinFreeWindow('invalid-date', fixedNow)).toBe(false);
      expect(isDateWithinFreeWindow('', fixedNow)).toBe(false);
      expect(isDateWithinFreeWindow('2026-02-31', fixedNow)).toBe(false); // invalid calendar date
      expect(isDateWithinFreeWindow('2026-9-5', fixedNow)).toBe(false); // non-canonical format
    });

    it('calculates the free-window start date string for 7-day inclusive window (today minus 6)', () => {
      // Default uses WAKATIME_FREE_TIER_WINDOW_DAYS = 7 -> today minus 6 = 2026-08-30
      expect(getFreeWindowStartDate(fixedNow)).toBe('2026-08-30');
      expect(getFreeWindowStartDate(fixedNow, 7)).toBe('2026-08-30');
      // 1-day inclusive window is just today
      expect(getFreeWindowStartDate(fixedNow, 1)).toBe('2026-09-05');
      // 14-day inclusive window starts today minus 13 = 2026-08-23
      expect(getFreeWindowStartDate(fixedNow, 14)).toBe('2026-08-23');
    });

    it('handles month and year boundaries in getFreeWindowStartDate', () => {
      // March 1, 2026 (non-leap year, Feb has 28 days) -> Feb 23 is 6 days prior
      const marchFirst = new Date('2026-03-01T08:00:00Z');
      expect(getFreeWindowStartDate(marchFirst, 7)).toBe('2026-02-23');

      // January 3, 2026 -> Dec 28, 2025 is 6 days prior
      const janThird = new Date('2026-01-03T10:00:00Z');
      expect(getFreeWindowStartDate(janThird, 7)).toBe('2025-12-28');
    });

    it('calculates yesterday correctly across standard, month, and year boundaries', () => {
      expect(getYesterdayDate(fixedNow)).toBe('2026-09-04');

      const sepFirst = new Date('2026-09-01T05:00:00Z');
      expect(getYesterdayDate(sepFirst)).toBe('2026-08-31');

      const janFirst = new Date('2026-01-01T00:00:00Z');
      expect(getYesterdayDate(janFirst)).toBe('2025-12-31');
    });
  });

  describe('Capability Lifecycle, Degradation & Reprobing', () => {
    it('initializes capabilities in untested state and allows initial attempt', () => {
      const policy = new CapabilityPolicy();
      expect(policy.isAvailable('summaries')).toBe(false);
      expect(policy.isRestricted('durations')).toBe(false);
      expect(policy.shouldReprobe('summaries', fixedNow)).toBe(true);
      expect(policy.shouldAttempt('summaries', fixedNow)).toBe(true);
      expect(policy.isDegraded()).toBe(false);
    });

    it('records success and marks capability as available', () => {
      const policy = new CapabilityPolicy();
      policy.recordSuccess('summaries', fixedNow);

      expect(policy.isAvailable('summaries')).toBe(true);
      expect(policy.shouldReprobe('summaries', fixedNow)).toBe(false);
      expect(policy.shouldAttempt('summaries', fixedNow)).toBe(true);

      const record = policy.getRecord('summaries');
      expect(record.status).toBe('available');
      expect(record.lastSuccessAt).toBe(fixedNow.toISOString());
      expect(record.nextReprobeAt).toBeNull();
    });

    it('degrades optional capabilities when restricted and schedules infrequent reprobe', () => {
      const policy = new CapabilityPolicy();
      policy.recordSuccess('summaries', fixedNow);
      policy.recordRestriction('durations', 402, fixedNow);
      policy.recordRestriction('heartbeats', 403, fixedNow);

      expect(policy.isAvailable('summaries')).toBe(true);
      expect(policy.isRestricted('durations')).toBe(true);
      expect(policy.isRestricted('heartbeats')).toBe(true);
      expect(policy.isDegraded()).toBe(true);

      // Check nextReprobeAt is scheduled 24 hours later
      const durRecord = policy.getRecord('durations');
      expect(durRecord.status).toBe('restricted');
      expect(durRecord.restrictionCode).toBe('HTTP_402');
      const expectedReprobeTime = new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000).toISOString();
      expect(durRecord.nextReprobeAt).toBe(expectedReprobeTime);

      // Within 24 hours, should NOT reprobe or attempt
      const twelveHoursLater = new Date(fixedNow.getTime() + 12 * 60 * 60 * 1000);
      expect(policy.shouldReprobe('durations', twelveHoursLater)).toBe(false);
      expect(policy.shouldAttempt('durations', twelveHoursLater)).toBe(false);

      // After 24 hours, reprobe becomes eligible
      const twentyFiveHoursLater = new Date(fixedNow.getTime() + 25 * 60 * 60 * 1000);
      expect(policy.shouldReprobe('durations', twentyFiveHoursLater)).toBe(true);
      expect(policy.shouldAttempt('durations', twentyFiveHoursLater)).toBe(true);
    });
  });

  describe('Sync Run Outcome Evaluation (evaluateSyncRun)', () => {
    it('returns succeeded when all capabilities succeed', () => {
      const policy = new CapabilityPolicy();
      const results: SyncStepResult[] = [
        { capability: 'summaries', attempted: true, success: true },
        { capability: 'durations', attempted: true, success: true },
        { capability: 'heartbeats', attempted: true, success: true }
      ];

      const outcome = policy.evaluateSyncRun(results);
      expect(outcome.outcome).toBe('succeeded');
      expect(outcome.advisoryCodes).toEqual([]);
      expect(outcome.degradedCapabilities).toEqual([]);
    });

    it('returns partial outcome when summaries succeed but durations or heartbeats are restricted', () => {
      const policy = new CapabilityPolicy();
      const results: SyncStepResult[] = [
        { capability: 'summaries', attempted: true, success: true },
        {
          capability: 'durations',
          attempted: false,
          skippedReason: 'plan_restricted',
          success: false
        },
        {
          capability: 'heartbeats',
          attempted: true,
          success: false,
          error: new CapabilityRestrictedError('heartbeats', 403)
        }
      ];

      const outcome = policy.evaluateSyncRun(results);
      expect(outcome.outcome).toBe('partial');
      expect(outcome.advisoryCodes).toEqual([
        'DURATIONS_PLAN_RESTRICTED',
        'HEARTBEATS_PLAN_RESTRICTED'
      ]);
      expect(outcome.degradedCapabilities).toEqual(['durations', 'heartbeats']);
      expect(outcome.summary).toContain('Sync completed with degraded capabilities');
    });

    it('returns failed outcome when summaries fail', () => {
      const policy = new CapabilityPolicy();
      const results: SyncStepResult[] = [
        {
          capability: 'summaries',
          attempted: true,
          success: false,
          error: new Error('Internal error')
        },
        { capability: 'durations', attempted: true, success: true }
      ];

      const outcome = policy.evaluateSyncRun(results);
      expect(outcome.outcome).toBe('failed');
      expect(outcome.advisoryCodes).toContain('SUMMARIES_FAILED');
      expect(outcome.degradedCapabilities).toEqual(['summaries']);
    });
  });

  describe('probeCapabilities with Mock Client', () => {
    const dummyKey = 'test_key_dummy_123';

    it('discovers degraded state: summaries available, durations & heartbeats restricted (402/403)', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = input.toString();

        if (url.includes('/users/current') && !url.includes('/users/current/')) {
          return new Response(JSON.stringify({ data: { id: 'usr_1', plan: 'free' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/users/current/summaries')) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/users/current/durations')) {
          // Free tier plan restriction
          return new Response(JSON.stringify({ error: 'Upgrade required' }), {
            status: 402,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/users/current/heartbeats')) {
          // Free tier forbidden restriction
          return new Response(JSON.stringify({ error: 'Endpoint forbidden for plan' }), {
            status: 403,
            headers: { 'content-type': 'application/json' }
          });
        }

        return new Response(null, { status: 404 });
      };

      const client = new WakaTimeClient({
        accessToken: dummyKey,
        fetch: mockFetch
      });

      const policy = await probeCapabilities(client, { now: fixedNow, probeDate: '2026-09-04' });

      expect(policy.isAvailable('summaries')).toBe(true);
      expect(policy.isRestricted('durations')).toBe(true);
      expect(policy.isRestricted('heartbeats')).toBe(true);
      expect(policy.isDegraded()).toBe(true);

      const durRecord = policy.getRecord('durations');
      expect(durRecord.restrictionCode).toBe('HTTP_402');
      const hbRecord = policy.getRecord('heartbeats');
      expect(hbRecord.restrictionCode).toBe('HTTP_403');
    });

    it('probes yesterday by default when probeDate is omitted', async () => {
      const requestedUrls: string[] = [];
      const mockFetch: typeof fetch = async (input) => {
        const url = input.toString();
        requestedUrls.push(url);

        if (url.includes('/users/current') && !url.includes('/users/current/')) {
          return new Response(JSON.stringify({ data: { id: 'usr_1', plan: 'free' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/users/current/summaries')) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/users/current/durations')) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/users/current/heartbeats')) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }

        return new Response(null, { status: 404 });
      };

      const client = new WakaTimeClient({
        accessToken: dummyKey,
        fetch: mockFetch
      });

      // fixedNow is 2026-09-05T12:00:00Z -> yesterday is 2026-09-04
      const policy = await probeCapabilities(client, { now: fixedNow });

      expect(policy.isAvailable('summaries')).toBe(true);
      expect(policy.isAvailable('durations')).toBe(true);
      expect(policy.isAvailable('heartbeats')).toBe(true);

      // Verify exact URLs requested yesterday's date
      expect(requestedUrls).not.toContain('https://api.wakatime.com/api/v1/users/current');
      expect(requestedUrls).toContain(
        'https://api.wakatime.com/api/v1/users/current/summaries?start=2026-09-04&end=2026-09-04'
      );
      expect(requestedUrls).toContain(
        'https://api.wakatime.com/api/v1/users/current/durations?date=2026-09-04'
      );
      expect(requestedUrls).toContain(
        'https://api.wakatime.com/api/v1/users/current/heartbeats?date=2026-09-04'
      );
    });

    it('aborts probing immediately on 401 authentication failure', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(null, { status: 401 });
      };

      const client = new WakaTimeClient({
        accessToken: dummyKey,
        fetch: mockFetch
      });

      await expect(probeCapabilities(client, { now: fixedNow })).rejects.toThrow(WakaTimeAuthError);
    });
  });

  describe('Date-Aware Restrictions and Reprobing', () => {
    it('records old-date 402/403 only on that date and does not globally restrict endpoint', () => {
      const policy = new CapabilityPolicy();
      policy.recordSuccess('summaries', fixedNow);

      // 2026-08-01 is far outside the 7-day free window relative to fixedNow (2026-09-05)
      expect(isDateWithinFreeWindow('2026-08-01', fixedNow)).toBe(false);

      // Old date 402
      policy.recordRestriction('summaries', 402, '2026-08-01', fixedNow);

      // Endpoint-wide status remains available!
      expect(policy.isAvailable('summaries')).toBe(true);
      expect(policy.isRestricted('summaries')).toBe(false);

      // Old date should not be attempted
      expect(policy.shouldAttempt('summaries', '2026-08-01', fixedNow)).toBe(false);
      expect(policy.shouldReprobe('summaries', '2026-08-01', fixedNow)).toBe(false);

      // Recent dates (yesterday, today) should still be attempted!
      expect(policy.shouldAttempt('summaries', '2026-09-04', fixedNow)).toBe(true);
      expect(policy.shouldAttempt('summaries', '2026-09-05', fixedNow)).toBe(true);
      expect(policy.shouldAttempt('summaries', fixedNow)).toBe(true);
    });

    it('establishes endpoint-wide restriction when restriction is observed on a recent probe', () => {
      const policy = new CapabilityPolicy();

      // 2026-09-04 is yesterday, within the 7-day free window relative to fixedNow (2026-09-05)
      expect(isDateWithinFreeWindow('2026-09-04', fixedNow)).toBe(true);

      // Recent date probe gets 403
      policy.recordRestriction('heartbeats', 403, '2026-09-04', fixedNow);

      // Endpoint-wide restriction is established!
      expect(policy.isRestricted('heartbeats')).toBe(true);
      expect(policy.shouldAttempt('heartbeats', '2026-09-04', fixedNow)).toBe(false);
      expect(policy.shouldAttempt('heartbeats', '2026-09-05', fixedNow)).toBe(false);
      expect(policy.shouldAttempt('heartbeats', fixedNow)).toBe(false);
    });
  });

  describe('State Serialization & Restoration', () => {
    it('serializes to JSON and restores cleanly', () => {
      const policy1 = new CapabilityPolicy();
      policy1.recordSuccess('summaries', fixedNow);
      policy1.recordRestriction('durations', 402, fixedNow);

      const exported = policy1.toJSON();
      expect(exported.capabilities.summaries.status).toBe('available');
      expect(exported.capabilities.durations.status).toBe('restricted');

      const policy2 = CapabilityPolicy.fromJSON(exported);
      expect(policy2.isAvailable('summaries')).toBe(true);
      expect(policy2.isRestricted('durations')).toBe(true);
      expect(policy2.getRecord('durations').restrictionCode).toBe('HTTP_402');
    });
  });
});
