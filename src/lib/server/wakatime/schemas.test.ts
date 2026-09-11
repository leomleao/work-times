import { describe, it, expect } from 'vitest';
import {
  SummariesResponseSchema,
  HeartbeatsResponseSchema,
  ProjectSummaryItemSchema,
  getEntityDetailState,
  getProjectPresenceState,
  isVerifiedZeroSummary,
  hasDateInSummaries,
  isValidHeartbeatUuid
} from './schemas.js';
import {
  FLAT_PROJECT_SUMMARY_RAW,
  VERIFIED_ZERO_DAY_RAW,
  MISSING_REQUESTED_DATE_RAW,
  UNSUPPORTED_HEARTBEATS_RAW
} from '../sync/fixtures/index.js';

describe('WakaTime Schemas & Field Presence Preservation', () => {
  describe('Project and Entity Detail Presence', () => {
    it('preserves omitted entities array as absent (undefined) rather than defaulting to []', () => {
      const parsed = SummariesResponseSchema.parse(FLAT_PROJECT_SUMMARY_RAW);
      const day = parsed.data[0];
      expect(day.projects).toBeDefined();
      expect(day.projects).toHaveLength(2);

      const workTimesProj = day.projects![0];
      expect(workTimesProj.name).toBe('work-times');
      // Crucial: entities must be undefined, NOT []!
      expect(workTimesProj.entities).toBeUndefined();
      expect(getEntityDetailState(workTimesProj)).toBe('absent');

      const blogProj = day.projects![1];
      expect(blogProj.name).toBe('personal-blog');
      expect(blogProj.entities).toBeUndefined();
      expect(getEntityDetailState(blogProj)).toBe('absent');
    });

    it('distinguishes absent entities from explicit empty entities []', () => {
      const projAbsent = ProjectSummaryItemSchema.parse({
        name: 'test-proj',
        total_seconds: 100
      });
      expect(projAbsent.entities).toBeUndefined();
      expect(getEntityDetailState(projAbsent)).toBe('absent');

      const projEmpty = ProjectSummaryItemSchema.parse({
        name: 'test-proj',
        total_seconds: 100,
        entities: []
      });
      expect(projEmpty.entities).toEqual([]);
      expect(getEntityDetailState(projEmpty)).toBe('empty');

      const projPresent = ProjectSummaryItemSchema.parse({
        name: 'test-proj',
        total_seconds: 100,
        entities: [{ name: 'file.ts', total_seconds: 100, type: 'file' }]
      });
      expect(projPresent.entities).toHaveLength(1);
      expect(getEntityDetailState(projPresent)).toBe('present');
    });

    it('distinguishes absent projects from explicit empty projects []', () => {
      const parsedNoProjects = SummariesResponseSchema.parse({
        data: [{
          date: '2026-09-08',
          grand_total: { total_seconds: 100 }
        }]
      });
      expect(parsedNoProjects.data[0].projects).toBeUndefined();
      expect(getProjectPresenceState(parsedNoProjects.data[0])).toBe('absent');

      const parsedEmptyProjects = SummariesResponseSchema.parse({
        data: [{
          date: '2026-09-08',
          grand_total: { total_seconds: 0 },
          projects: []
        }]
      });
      expect(parsedEmptyProjects.data[0].projects).toEqual([]);
      expect(getProjectPresenceState(parsedEmptyProjects.data[0])).toBe('empty');
    });
  });

  describe('Verified Zero Day vs Missing Date', () => {
    it('authoritatively identifies verified zero day when total_seconds is 0 and projects is []', () => {
      const parsed = SummariesResponseSchema.parse(VERIFIED_ZERO_DAY_RAW);
      const day = parsed.data[0];
      expect(day.grand_total.total_seconds).toBe(0.0);
      expect(day.projects).toEqual([]);
      expect(isVerifiedZeroSummary(day)).toBe(true);
      expect(hasDateInSummaries(parsed, '2026-09-07')).toBe(true);
    });

    it('does not treat missing requested date or empty data array as verified zero', () => {
      const parsed = SummariesResponseSchema.parse(MISSING_REQUESTED_DATE_RAW);
      expect(parsed.data).toEqual([]);
      expect(hasDateInSummaries(parsed, '2026-09-06')).toBe(false);
      // No day in parsed.data, so cannot be a verified zero day
    });

    it('does not identify a non-zero day as verified zero even if projects is empty', () => {
      const parsed = SummariesResponseSchema.parse({
        data: [{
          date: '2026-09-08',
          grand_total: { total_seconds: 50.0 },
          projects: []
        }]
      });
      expect(isVerifiedZeroSummary(parsed.data[0])).toBe(false);
    });
  });

  describe('Heartbeats Schema & UUID Validation', () => {
    it('validates canonical RFC 4122 UUIDs and rejects malformed external IDs', () => {
      expect(isValidHeartbeatUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(isValidHeartbeatUuid('990E8400-E29B-41D4-A716-446655440001')).toBe(true);

      // Malformed from fixture samples
      expect(isValidHeartbeatUuid(UNSUPPORTED_HEARTBEATS_RAW.invalidId.id)).toBe(false);
      expect(isValidHeartbeatUuid('hb_12345')).toBe(false);
      expect(isValidHeartbeatUuid('')).toBe(false);
      expect(isValidHeartbeatUuid('not-a-uuid')).toBe(false);
    });

    it('fails schema parsing on non-array envelope in heartbeats response', () => {
      expect(() =>
        HeartbeatsResponseSchema.parse(UNSUPPORTED_HEARTBEATS_RAW.invalidEnvelope)
      ).toThrow();
    });

    it('fails schema parsing when dependencies contain non-string objects', () => {
      expect(() =>
        HeartbeatsResponseSchema.parse({
          data: [UNSUPPORTED_HEARTBEATS_RAW.invalidDependencies]
        })
      ).toThrow();
    });

    it('preserves absent dependencies as undefined instead of defaulting to []', () => {
      const parsed = HeartbeatsResponseSchema.parse({
        data: [{
          id: '550e8400-e29b-41d4-a716-446655440000',
          entity: '/src/main.ts',
          type: 'file',
          time: 1725876000.0
        }]
      });
      expect(parsed.data[0].dependencies).toBeUndefined();
    });

    it('never infers or adds a duration field to heartbeats', () => {
      const parsed = HeartbeatsResponseSchema.parse({
        data: [{
          id: '550e8400-e29b-41d4-a716-446655440000',
          entity: '/src/main.ts',
          type: 'file',
          time: 1725876000.0
        }]
      });
      // Heartbeats do not have duration; durations must not be inferred
      expect((parsed.data[0] as unknown as Record<string, unknown>).duration).toBeUndefined();
    });
  });
});
