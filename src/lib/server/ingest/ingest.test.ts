import { describe, expect, it } from 'vitest';
import {
  SYNTHETIC_FIXTURES,
  FLAT_PROJECT_SUMMARY_RAW,
  VERIFIED_ZERO_DAY_RAW,
  MISSING_REQUESTED_DATE_RAW,
  INCOMPLETE_BODY_RAW,
  TIMEZONE_MISMATCH_RAW,
  OVERCOUNT_DAY_RAW,
  TINY_RESIDUAL_DAY_RAW,
  UNSUPPORTED_HEARTBEATS_RAW
} from '../sync/fixtures/index.js';
import {
  normalizeSummaryDay,
  normalizeHeartbeatDay,
  normalizeDurationsDay,
  RECONCILE_CODES,
  coversRetainedScopes
} from './index.js';

describe('Ingest Stage A: Pure Normalization & Source Fidelity', () => {
  describe('1. Flat Coarse Summary Adapter', () => {
    it('normalizes flat project totals with missing entity detail without manufacturing envelopes', () => {
      const result = normalizeSummaryDay(FLAT_PROJECT_SUMMARY_RAW, {
        date: '2026-09-08',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') return;

      const day = result.value;
      expect(day.date).toBe('2026-09-08');
      expect(day.timezone).toBe('Europe/London');
      expect(day.fidelity).toBe('coarse_project');
      expect(day.totalSeconds).toBe(14400.0);
      expect(day.projectSumSeconds).toBe(14400.0);
      expect(day.projectSumDelta).toBe(0.0);

      // Completeness state
      expect(day.completeness.hasAccountTotals).toBe(true);
      expect(day.completeness.hasProjectTotals).toBe(true);
      expect(day.completeness.hasEntityDetail).toBe(false);
      expect(day.completeness.isVerifiedZero).toBe(false);
      expect(day.completeness.overallEntityDetailState).toBe('coarse_only');

      // Scope verification
      expect(day.completeness.projectScopes['work-times']).toEqual({
        projectName: 'work-times',
        totalSeconds: 10800.0,
        entityDetailState: 'absent',
        entityCount: 0
      });
      expect(day.completeness.projectScopes['personal-blog']).toEqual({
        projectName: 'personal-blog',
        totalSeconds: 3600.0,
        entityDetailState: 'absent',
        entityCount: 0
      });

      // Slices: exactly one project_summary slice per project, collision-proof identity
      expect(day.slices).toHaveLength(2);
      expect(day.slices[0]).toMatchObject({
        projectName: 'personal-blog',
        entity: 'personal-blog',
        entityType: 'app',
        kind: 'project_summary',
        isUnattributed: false,
        totalSeconds: 3600.0
      });
      expect(day.slices[1]).toMatchObject({
        projectName: 'work-times',
        entity: 'work-times',
        entityType: 'app',
        kind: 'project_summary',
        isUnattributed: false,
        totalSeconds: 10800.0
      });

      expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('2. Unchanged Replay & Idempotency', () => {
    it('produces identical content hashes on repeated normalization runs', () => {
      const first = normalizeSummaryDay(FLAT_PROJECT_SUMMARY_RAW, {
        date: '2026-09-08',
        accountTimezone: 'Europe/London'
      });
      const second = normalizeSummaryDay(FLAT_PROJECT_SUMMARY_RAW, {
        date: '2026-09-08',
        accountTimezone: 'Europe/London'
      });

      expect(first.kind).toBe('complete');
      expect(second.kind).toBe('complete');
      if (first.kind === 'complete' && second.kind === 'complete') {
        expect(first.contentHash).toBe(second.contentHash);
        expect(first.value.slices).toEqual(second.value.slices);
      }
    });

    it('produces identical content hash regardless of JSON object key ordering', () => {
      const reorderedPayload = {
        end: '2026-09-08T23:59:59Z',
        start: '2026-09-08T00:00:00Z',
        data: [
          {
            projects: [
              { percent: 25.0, total_seconds: 3600.0, name: 'personal-blog' },
              { total_seconds: 10800.0, name: 'work-times', percent: 75.0 }
            ],
            grand_total: {
              human_deletions: 30,
              ai_additions: 0,
              total_seconds: 14400.0,
              human_additions: 120,
              ai_deletions: 0,
              ai_sessions: 0
            },
            range: {
              text: 'Tue Sep 8th 2026',
              timezone: 'Europe/London',
              start: '2026-09-08T00:00:00Z',
              end: '2026-09-08T23:59:59Z',
              date: '2026-09-08'
            },
            date: '2026-09-08'
          }
        ]
      };

      const original = normalizeSummaryDay(FLAT_PROJECT_SUMMARY_RAW, {
        date: '2026-09-08',
        accountTimezone: 'Europe/London'
      });
      const reordered = normalizeSummaryDay(reorderedPayload, {
        date: '2026-09-08',
        accountTimezone: 'Europe/London'
      });

      expect(original.kind).toBe('complete');
      expect(reordered.kind).toBe('complete');
      if (original.kind === 'complete' && reordered.kind === 'complete') {
        expect(original.contentHash).toBe(reordered.contentHash);
      }
    });
  });

  describe('3. Verified Zero vs Missing Date & Incomplete Detail', () => {
    it('accepts authoritative verified zero day with explicit empty projects array', () => {
      const result = normalizeSummaryDay(VERIFIED_ZERO_DAY_RAW, {
        date: '2026-09-07',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') return;

      const day = result.value;
      expect(day.date).toBe('2026-09-07');
      expect(day.fidelity).toBe('verified_zero');
      expect(day.totalSeconds).toBe(0.0);
      expect(day.completeness.isVerifiedZero).toBe(true);
      expect(day.completeness.overallEntityDetailState).toBe('empty');
      expect(day.slices).toEqual([]);
    });

    it('fails closed when projects field is omitted (cannot establish verified zero or complete totals)', () => {
      const omittedProjectsZero = {
        data: [
          {
            date: '2026-09-07',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 0 }
            // projects field completely omitted!
          }
        ]
      };

      const result = normalizeSummaryDay(omittedProjectsZero, {
        date: '2026-09-07',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.INCOMPLETE_BODY);
      }
    });

    it('fails closed when projects field is omitted with positive duration', () => {
      const omittedProjectsPositive = {
        data: [
          {
            date: '2026-09-07',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 3600.0 }
            // projects field completely omitted!
          }
        ]
      };

      const result = normalizeSummaryDay(omittedProjectsPositive, {
        date: '2026-09-07',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.INCOMPLETE_BODY);
      }
    });

    it('accepts explicit empty projects with positive account total as coarse residual day', () => {
      const explicitEmptyProjects = {
        data: [
          {
            date: '2026-09-07',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 3600.0 },
            projects: [] // Explicitly empty
          }
        ]
      };

      const result = normalizeSummaryDay(explicitEmptyProjects, {
        date: '2026-09-07',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') return;
      expect(result.value.fidelity).toBe('coarse_project');
      expect(result.value.slices).toHaveLength(1);
      expect(result.value.slices[0].kind).toBe('unattributed_residual');
      expect(result.value.slices[0].totalSeconds).toBe(3600.0);
    });

    it('rejects missing requested date with MISSING_REQUESTED_DATE instead of zero', () => {
      const result = normalizeSummaryDay(MISSING_REQUESTED_DATE_RAW, {
        date: '2026-09-06',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.MISSING_REQUESTED_DATE);
      }
    });

    it('rejects when requested date is absent from data array of other dates', () => {
      const result = normalizeSummaryDay(FLAT_PROJECT_SUMMARY_RAW, {
        date: '2026-09-15',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.MISSING_REQUESTED_DATE);
      }
    });

    it('distinguishes absent entity detail from authoritative empty entities array', () => {
      const emptyEntitiesSummary = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 3600.0 },
            projects: [
              {
                name: 'work-times',
                total_seconds: 3600.0,
                entities: [] // Explicit authoritative zero entities
              }
            ]
          }
        ]
      };

      const result = normalizeSummaryDay(emptyEntitiesSummary, {
        date: '2026-09-08',
        accountTimezone: 'Europe/London'
      });
      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') return;

      expect(result.value.completeness.projectScopes['work-times'].entityDetailState).toBe('empty');
      expect(result.value.completeness.hasEntityDetail).toBe(false);
      expect(result.value.fidelity).toBe('coarse_project');
      expect(result.value.completeness.overallEntityDetailState).toBe('coarse_only');
      expect(result.value.projects[0].hasEntityDetail).toBe(false);
    });

    it('detects detail downgrade via coversRetainedScopes', () => {
      const acceptedDetailed = normalizeSummaryDay({
        data: [
          {
            date: '2026-09-04',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 7200.0 },
            projects: [
              {
                name: 'work-times',
                total_seconds: 7200.0,
                entities: [
                  { name: '/src/index.ts', total_seconds: 5000.0, type: 'file' },
                  { name: '/src/lib.ts', total_seconds: 2200.0, type: 'file' }
                ]
              }
            ]
          }
        ]
      }, { date: '2026-09-04', accountTimezone: 'Europe/London' });

      const incomingCoarse = normalizeSummaryDay({
        data: [
          {
            date: '2026-09-04',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 7200.0 },
            projects: [
              {
                name: 'work-times',
                total_seconds: 7200.0
                // Missing entities!
              }
            ]
          }
        ]
      }, { date: '2026-09-04', accountTimezone: 'Europe/London' });

      expect(acceptedDetailed.kind).toBe('complete');
      expect(incomingCoarse.kind).toBe('complete');
      if (acceptedDetailed.kind === 'complete' && incomingCoarse.kind === 'complete') {
        expect(coversRetainedScopes(incomingCoarse.value.completeness, acceptedDetailed.value.completeness)).toBe(false);
      }
    });
  });

  describe('4. Numerical Invariants & Tolerances', () => {
    it('rejects overcount exceeding 0.001s tolerance with OVERCOUNT_TOLERANCE_EXCEEDED and never clamps', () => {
      const result = normalizeSummaryDay(OVERCOUNT_DAY_RAW, {
        date: '2026-09-01',
        accountTimezone: 'UTC'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.OVERCOUNT_TOLERANCE_EXCEEDED);
      }
    });

    it('rejects per-project entity overcount exceeding 0.001s tolerance', () => {
      const perProjectOvercount = {
        data: [
          {
            date: '2026-09-01',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 2000.0 },
            projects: [
              {
                name: 'work-times',
                total_seconds: 1000.0,
                entities: [
                  { name: '/src/a.ts', total_seconds: 600.0, type: 'file' },
                  { name: '/src/b.ts', total_seconds: 400.005, type: 'file' } // 1000.005 > 1000.0 + 0.001
                ]
              },
              {
                name: 'other',
                total_seconds: 1000.0,
                entities: []
              }
            ]
          }
        ]
      };

      const result = normalizeSummaryDay(perProjectOvercount, {
        date: '2026-09-01',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.OVERCOUNT_TOLERANCE_EXCEEDED);
      }
    });

    it('preserves tiny positive residual in __unattributed__ slice even below 1 second', () => {
      const result = normalizeSummaryDay(TINY_RESIDUAL_DAY_RAW, {
        date: '2026-08-31',
        accountTimezone: 'UTC'
      });

      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') return;

      const day = result.value;
      expect(day.totalSeconds).toBe(3600.005);
      expect(day.projectSumSeconds).toBe(3600.0);
      expect(day.projectSumDelta).toBeCloseTo(0.005, 5);

      const residualSlice = day.slices.find((s) => s.kind === 'unattributed_residual');
      expect(residualSlice).toBeDefined();
      expect(residualSlice?.entity).toBe('__unattributed__');
      expect(residualSlice?.projectName).toBe('__unattributed__');
      expect(residualSlice?.entityType).toBe('unattributed');
      expect(residualSlice?.isUnattributed).toBe(true);
      expect(residualSlice?.totalSeconds).toBeCloseTo(0.005, 5);
    });

    it('retains sub-microsecond positive residual (e.g. 1e-7 seconds)', () => {
      const subMicrosecondInput = {
        data: [
          {
            date: '2026-08-31',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 1000.0000001 },
            projects: [
              {
                name: 'work-times',
                total_seconds: 1000.0,
                entities: []
              }
            ]
          }
        ]
      };

      const result = normalizeSummaryDay(subMicrosecondInput, {
        date: '2026-08-31',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') return;

      const residualSlice = result.value.slices.find((s) => s.kind === 'unattributed_residual');
      expect(residualSlice).toBeDefined();
      expect(residualSlice?.totalSeconds).toBeCloseTo(0.0000001, 7);
    });

    it('rejects nonfinite duration values', () => {
      const nonfiniteInput = {
        data: [
          {
            date: '2026-09-01',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: NaN },
            projects: []
          }
        ]
      };

      const result = normalizeSummaryDay(nonfiniteInput, {
        date: '2026-09-01',
        accountTimezone: 'Europe/London'
      });
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.INCOMPLETE_BODY);
      }
    });

    it('rejects negative grand_total seconds', () => {
      const negativeInput = {
        data: [
          {
            date: '2026-09-01',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: -100.0 },
            projects: []
          }
        ]
      };

      const result = normalizeSummaryDay(negativeInput, {
        date: '2026-09-01',
        accountTimezone: 'Europe/London'
      });
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.NEGATIVE_RESIDUAL);
      }
    });

    it('rejects negative project seconds with MATHEMATICAL_INVARIANT_VIOLATION', () => {
      const negativeProject = {
        data: [
          {
            date: '2026-09-01',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 100.0 },
            projects: [{ name: 'proj', total_seconds: -50.0 }]
          }
        ]
      };

      const result = normalizeSummaryDay(negativeProject, {
        date: '2026-09-01',
        accountTimezone: 'Europe/London'
      });
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.MATHEMATICAL_INVARIANT_VIOLATION);
      }
    });
  });

  describe('5. Envelopes, Oversized, Timezone & Dimension Guards', () => {
    it('fails closed on incomplete truncated JSON body', () => {
      const result = normalizeSummaryDay(INCOMPLETE_BODY_RAW, {
        date: '2026-09-05',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.INCOMPLETE_BODY);
      }
    });

    it('fails closed on missing grand_total object', () => {
      const missingGrandTotal = {
        data: [{ date: '2026-09-05', range: { timezone: 'Europe/London' } }]
      };

      const result = normalizeSummaryDay(missingGrandTotal, {
        date: '2026-09-05',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.INCOMPLETE_BODY);
      }
    });

    it('rejects responses exceeding maxBytes with RESPONSE_SIZE_EXCEEDED', () => {
      const payload = '{"data":[]}'.padEnd(200, ' ');
      const result = normalizeSummaryDay(payload, {
        date: '2026-09-05',
        accountTimezone: 'Europe/London',
        maxBytes: 100
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.RESPONSE_SIZE_EXCEEDED);
      }
    });

    it('fails on missing verified response and account timezone (no silent UTC default)', () => {
      const noTimezoneInput = {
        data: [
          {
            date: '2026-09-05',
            grand_total: { total_seconds: 3600 },
            projects: [{ name: 'work-times', total_seconds: 3600 }]
          }
        ]
      };

      const result = normalizeSummaryDay(noTimezoneInput, {
        date: '2026-09-05'
        // accountTimezone omitted!
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.TIMEZONE_MISMATCH);
      }
    });

    it('pauses acceptance on timezone mismatch with TIMEZONE_MISMATCH', () => {
      const result = normalizeSummaryDay(TIMEZONE_MISMATCH_RAW, {
        date: '2026-09-02',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.TIMEZONE_MISMATCH);
      }
    });

    it('rejects malformed dimension: non-array categories with INCOMPLETE_BODY', () => {
      const malformed = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 3600.0 },
            projects: [{ name: 'work-times', total_seconds: 3600.0 }],
            categories: 'Coding' // Not an array!
          }
        ]
      };

      const result = normalizeSummaryDay(malformed, {
        date: '2026-09-08',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.INCOMPLETE_BODY);
      }
    });

    it('rejects malformed dimension: missing total_seconds with INCOMPLETE_BODY', () => {
      const malformed = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 3600.0 },
            projects: [{ name: 'work-times', total_seconds: 3600.0 }],
            categories: [{ name: 'Coding' }] // Missing total_seconds!
          }
        ]
      };

      const result = normalizeSummaryDay(malformed, {
        date: '2026-09-08',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.INCOMPLETE_BODY);
      }
    });

    it('rejects unsupported summary entity type without coercing to file', () => {
      const unsupportedEntity = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 3600.0 },
            projects: [
              {
                name: 'work-times',
                total_seconds: 3600.0,
                entities: [
                  { name: 'https://example.com', total_seconds: 3600.0, type: 'url' } // Unsupported type!
                ]
              }
            ]
          }
        ]
      };

      const result = normalizeSummaryDay(unsupportedEntity, {
        date: '2026-09-08',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.INCOMPLETE_BODY);
      }
    });
  });

  describe('6. Mixed Project Detail Preservation', () => {
    it('preserves mixed summary fidelity: retains entity slices and emits coarse slices for coarse projects', () => {
      const mixedSummary = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 7000.0 },
            projects: [
              {
                name: 'work-times',
                total_seconds: 5000.0,
                entities: [
                  { name: '/src/index.ts', total_seconds: 3000.0, type: 'file' },
                  { name: '/src/lib.ts', total_seconds: 1500.0, type: 'file' }
                ] // Entity sum: 4500.0, project residual: 500.0
              },
              {
                name: 'personal-site',
                total_seconds: 2000.0
                // Absent entities: coarse project
              }
            ]
          }
        ]
      };

      const result = normalizeSummaryDay(mixedSummary, {
        date: '2026-09-08',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') return;

      const day = result.value;
      expect(day.fidelity).toBe('entity_detail');
      expect(day.completeness.overallEntityDetailState).toBe('mixed');
      expect(day.completeness.hasEntityDetail).toBe(true);

      // Verify scopes
      expect(day.completeness.projectScopes['work-times'].entityDetailState).toBe('present');
      expect(day.completeness.projectScopes['personal-site'].entityDetailState).toBe('absent');

      // Verify slices:
      // - 2 entity slices for work-times (3000 + 1500)
      // - 1 project_summary slice for work-times project-local residual (500)
      // - 1 project_summary slice for personal-site (2000)
      expect(day.slices).toHaveLength(4);

      const entitySlices = day.slices.filter((s) => s.kind === 'entity');
      expect(entitySlices).toHaveLength(2);
      expect(entitySlices[0]).toMatchObject({ projectName: 'work-times', entity: '/src/index.ts', totalSeconds: 3000.0 });
      expect(entitySlices[1]).toMatchObject({ projectName: 'work-times', entity: '/src/lib.ts', totalSeconds: 1500.0 });

      const coarseSlices = day.slices.filter((s) => s.kind === 'project_summary');
      expect(coarseSlices).toHaveLength(2);
      expect(coarseSlices.find((s) => s.projectName === 'work-times')).toMatchObject({
        projectName: 'work-times',
        entity: 'work-times',
        kind: 'project_summary',
        totalSeconds: 500.0
      });
      expect(coarseSlices.find((s) => s.projectName === 'personal-site')).toMatchObject({
        projectName: 'personal-site',
        entity: 'personal-site',
        kind: 'project_summary',
        totalSeconds: 2000.0
      });

      // Sum of all slices equals grand_total exactly
      const totalSliceSeconds = day.slices.reduce((sum, s) => sum + s.totalSeconds, 0);
      expect(totalSliceSeconds).toBe(7000.0);
    });
  });

  describe('7. Heartbeat Adapter & Fidelity', () => {
    it('normalizes valid heartbeats without inferring duration or synthesizing IDs', () => {
      // 1788868800 = 2026-09-08T12:00:00.000Z
      const validHeartbeats = {
        data: [
          {
            id: '550e8400-e29b-41d4-a716-446655440000',
            entity: '/src/main.ts',
            type: 'file',
            category: 'coding',
            project: 'work-times',
            branch: 'main',
            language: 'TypeScript',
            time: 1788868800.123456,
            is_write: true,
            user_agent_id: 'ua-1',
            machine_name_id: 'mach-1',
            dependencies: ['vitest', 'svelte', '  svelte  ']
          }
        ]
      };

      const result = normalizeHeartbeatDay(validHeartbeats, {
        date: '2026-09-08',
        timezone: 'UTC'
      });

      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') return;

      const day = result.value;
      expect(day.date).toBe('2026-09-08');
      expect(day.heartbeats).toHaveLength(1);

      const event = day.heartbeats[0];
      expect(event.id).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(event.entity).toBe('/src/main.ts');
      expect(event.occurredAtUs).toBe(1788868800123456);
      expect(event.dependencies).toEqual(['svelte', 'vitest']);
      expect((event as any).duration).toBeUndefined(); // Invariant: never infers duration
    });

    it('rejects non-UUID heartbeat IDs with UNSUPPORTED_HEARTBEAT_ID', () => {
      const result = normalizeHeartbeatDay(
        { data: [{ ...UNSUPPORTED_HEARTBEATS_RAW.invalidId, time: 1788868800, category: 'coding', user_agent_id: 'ua-1' }] },
        { date: '2026-09-08', timezone: 'UTC' }
      );

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ID);
      }
    });

    it('rejects missing or empty category in heartbeat with UNSUPPORTED_HEARTBEAT_ENVELOPE (no synthesis)', () => {
      const result = normalizeHeartbeatDay(
        {
          data: [
            {
              id: '550e8400-e29b-41d4-a716-446655440000',
              entity: '/src/main.ts',
              type: 'file',
              time: 1788868800,
              user_agent_id: 'ua-1'
              // category missing!
            }
          ]
        },
        { date: '2026-09-08', timezone: 'UTC' }
      );

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE);
      }
    });

    it('rejects missing or empty user_agent_id in heartbeat with UNSUPPORTED_HEARTBEAT_ENVELOPE (no synthesis)', () => {
      const result = normalizeHeartbeatDay(
        {
          data: [
            {
              id: '550e8400-e29b-41d4-a716-446655440000',
              entity: '/src/main.ts',
              type: 'file',
              category: 'coding',
              time: 1788868800
              // user_agent_id missing!
            }
          ]
        },
        { date: '2026-09-08', timezone: 'UTC' }
      );

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE);
      }
    });

    it('rejects unsupported heartbeat entity type without coercing to file', () => {
      const result = normalizeHeartbeatDay(
        {
          data: [
            {
              id: '550e8400-e29b-41d4-a716-446655440000',
              entity: 'window-title',
              type: 'window', // Unsupported!
              category: 'coding',
              user_agent_id: 'ua-1',
              time: 1788868800
            }
          ]
        },
        { date: '2026-09-08', timezone: 'UTC' }
      );

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE);
      }
    });

    it('rejects non-string dependencies with UNSUPPORTED_HEARTBEAT_DEPENDENCY', () => {
      const result = normalizeHeartbeatDay(
        { data: [{ ...UNSUPPORTED_HEARTBEATS_RAW.invalidDependencies, time: 1788868800, category: 'coding', user_agent_id: 'ua-1' }] },
        { date: '2026-09-08', timezone: 'UTC' }
      );

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_DEPENDENCY);
      }
    });

    it('fails closed when heartbeat days envelope is missing requested date', () => {
      const daysEnvelope = {
        days: [
          {
            date: '2026-09-01',
            heartbeats: []
          }
        ]
      };

      const result = normalizeHeartbeatDay(daysEnvelope, {
        date: '2026-09-02',
        timezone: 'UTC'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.MISSING_REQUESTED_DATE);
      }
    });

    it('fails closed when matched day has omitted heartbeats field (never convert to [])', () => {
      const daysEnvelope = {
        days: [
          {
            date: '2026-09-02'
            // heartbeats field omitted!
          }
        ]
      };

      const result = normalizeHeartbeatDay(daysEnvelope, {
        date: '2026-09-02',
        timezone: 'UTC'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE);
      }
    });

    it('rejects heartbeat event outside requested source-local date / DST boundary', () => {
      // 1774827000 = 2026-03-29T23:30:00Z
      // In Europe/London on 2026-03-29 (DST start), 23:30 UTC is 2026-03-30 00:30 BST (next day!)
      const dstEvent = {
        data: [
          {
            id: '550e8400-e29b-41d4-a716-446655440000',
            entity: '/src/main.ts',
            type: 'file',
            category: 'coding',
            user_agent_id: 'ua-1',
            time: 1774827000
          }
        ]
      };

      const result = normalizeHeartbeatDay(dstEvent, {
        date: '2026-03-29',
        timezone: 'Europe/London'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.TIMEZONE_MISMATCH);
      }
    });

    it('detects conflicting duplicate payloads with HEARTBEAT_PAYLOAD_CONFLICT and fails layer closed', () => {
      const payload = {
        data: [
          { ...UNSUPPORTED_HEARTBEATS_RAW.conflictBase, time: 1788868800, category: 'coding', user_agent_id: 'ua-1' },
          { ...UNSUPPORTED_HEARTBEATS_RAW.conflictVariant, time: 1788868800, category: 'coding', user_agent_id: 'ua-1' }
        ]
      };

      const result = normalizeHeartbeatDay(payload, { date: '2026-09-08', timezone: 'UTC' });
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.HEARTBEAT_PAYLOAD_CONFLICT);
      }
    });

    it('deduplicates exact identical repeated heartbeats without conflict', () => {
      const payload = {
        data: [
          { ...UNSUPPORTED_HEARTBEATS_RAW.conflictBase, time: 1788868800, category: 'coding', user_agent_id: 'ua-1' },
          { ...UNSUPPORTED_HEARTBEATS_RAW.conflictBase, time: 1788868800, category: 'coding', user_agent_id: 'ua-1' }
        ]
      };

      const result = normalizeHeartbeatDay(payload, { date: '2026-09-08', timezone: 'UTC' });
      expect(result.kind).toBe('complete');
      if (result.kind === 'complete') {
        expect(result.value.heartbeats).toHaveLength(1);
      }
    });
  });

  describe('8. Durations Adapter', () => {
    it('normalizes API duration events and enforces numerical bounds', () => {
      // 1788868800 = 2026-09-08T12:00:00Z
      const rawDurations = {
        data: [
          { project: 'work-times', time: 1788868800, duration: 300 },
          { project: 'work-times', time: 1788869200, duration: 600 }
        ]
      };

      const result = normalizeDurationsDay(rawDurations, { date: '2026-09-08', timezone: 'UTC' });
      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') return;

      expect(result.value.totalSeconds).toBe(900);
      expect(result.value.durations).toHaveLength(2);
    });

    it('rejects duration event with missing project (no empty project synthesis)', () => {
      const rawDurations = {
        data: [{ time: 1788868800, duration: 300 }]
      };

      const result = normalizeDurationsDay(rawDurations, { date: '2026-09-08', timezone: 'UTC' });
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.INCOMPLETE_BODY);
      }
    });

    it('rejects duration event outside source-local target date', () => {
      // 1725876000 is in 2024
      const rawDurations = {
        data: [{ project: 'work-times', time: 1725876000, duration: 300 }]
      };

      const result = normalizeDurationsDay(rawDurations, { date: '2026-09-08', timezone: 'UTC' });
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.TIMEZONE_MISMATCH);
      }
    });

    it('rejects negative duration with MATHEMATICAL_INVARIANT_VIOLATION', () => {
      const rawDurations = {
        data: [{ project: 'work-times', time: 1788868800, duration: -10 }]
      };

      const result = normalizeDurationsDay(rawDurations, { date: '2026-09-08', timezone: 'UTC' });
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.MATHEMATICAL_INVARIANT_VIOLATION);
      }
    });

    it('rejects duration event with non-string branch, entity, category, or created_at with INCOMPLETE_BODY', () => {
      const baseValid = { project: 'work-times', time: 1788868800, duration: 300 };

      // Non-string branch
      expect(normalizeDurationsDay({ data: [{ ...baseValid, branch: 123 }] }, { date: '2026-09-08', timezone: 'UTC' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Non-string entity
      expect(normalizeDurationsDay({ data: [{ ...baseValid, entity: { path: '/foo' } }] }, { date: '2026-09-08', timezone: 'UTC' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Non-string category
      expect(normalizeDurationsDay({ data: [{ ...baseValid, category: true }] }, { date: '2026-09-08', timezone: 'UTC' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Non-string created_at
      expect(normalizeDurationsDay({ data: [{ ...baseValid, created_at: 1788868800 }] }, { date: '2026-09-08', timezone: 'UTC' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Valid string values pass cleanly
      const valid = normalizeDurationsDay({
        data: [{
          ...baseValid,
          branch: 'main',
          entity: '/src/index.ts',
          category: 'Coding',
          created_at: '2026-09-08T00:00:00Z'
        }]
      }, { date: '2026-09-08', timezone: 'UTC' });
      expect(valid.kind).toBe('complete');
    });
  });

  describe('9. Content Hash Coverage of All Accepted Fields', () => {
    it('changes summary hash when previously omitted entity metric changes', () => {
      const base = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 3600 },
            projects: [
              {
                name: 'work-times',
                total_seconds: 3600,
                entities: [
                  { name: '/src/a.ts', total_seconds: 3600, type: 'file', human_additions: 0 }
                ]
              }
            ]
          }
        ]
      };

      const modified = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 3600 },
            projects: [
              {
                name: 'work-times',
                total_seconds: 3600,
                entities: [
                  { name: '/src/a.ts', total_seconds: 3600, type: 'file', human_additions: 25 } // Changed!
                ]
              }
            ]
          }
        ]
      };

      const resBase = normalizeSummaryDay(base, { date: '2026-09-08', accountTimezone: 'Europe/London' });
      const resMod = normalizeSummaryDay(modified, { date: '2026-09-08', accountTimezone: 'Europe/London' });

      expect(resBase.kind).toBe('complete');
      expect(resMod.kind).toBe('complete');
      if (resBase.kind === 'complete' && resMod.kind === 'complete') {
        expect(resBase.contentHash).not.toBe(resMod.contentHash);
      }
    });

    it('changes duration hash when optional field changes', () => {
      const base = {
        data: [{ project: 'work-times', time: 1788868800, duration: 300, branch: 'main' }]
      };
      const modified = {
        data: [{ project: 'work-times', time: 1788868800, duration: 300, branch: 'feature-x' }]
      };

      const resBase = normalizeDurationsDay(base, { date: '2026-09-08', timezone: 'UTC' });
      const resMod = normalizeDurationsDay(modified, { date: '2026-09-08', timezone: 'UTC' });

      expect(resBase.kind).toBe('complete');
      expect(resMod.kind).toBe('complete');
      if (resBase.kind === 'complete' && resMod.kind === 'complete') {
        expect(resBase.contentHash).not.toBe(resMod.contentHash);
      }
    });
  });

  describe('10. Old Detailed Dump & Cross-Layer Fidelity', () => {
    it('normalizes old detailed dump days to entity_detail fidelity with entity slices', async () => {
      const { readFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');

      const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../tests/fixtures');
      const dailyDump = JSON.parse(readFileSync(join(fixturesDir, 'synthetic-daily.json'), 'utf8'));

      const result = normalizeSummaryDay(dailyDump, {
        date: '2026-01-03',
        accountTimezone: 'Europe/Lisbon'
      });

      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') return;

      const day = result.value;
      expect(day.date).toBe('2026-01-03');
      expect(day.fidelity).toBe('entity_detail');
      expect(day.totalSeconds).toBe(3600);
      expect(day.completeness.hasEntityDetail).toBe(true);
      expect(day.completeness.overallEntityDetailState).toBe('complete_detail');

      // Verify entity slices
      expect(day.slices.length).toBeGreaterThan(0);
      for (const s of day.slices) {
        if (s.isUnattributed) {
          expect(s.kind).toBe('unattributed_residual');
        } else {
          expect(s.kind).toBe('entity');
        }
      }

      // Verify scoped dimensions preserved
      expect(day.scopedDimensions.length).toBeGreaterThan(0);
      expect(day.scopedDimensions.some((d) => d.dimension === 'project')).toBe(true);
      expect(day.scopedDimensions.some((d) => d.dimension === 'category')).toBe(true);

      // Re-running normalization produces identical contentHash (replay stability)
      const replay = normalizeSummaryDay(dailyDump, {
        date: '2026-01-03',
        accountTimezone: 'Europe/Lisbon'
      });
      expect(replay.kind).toBe('complete');
      if (replay.kind === 'complete') {
        expect(replay.contentHash).toBe(result.contentHash);
      }
    });

    it('rejects synthetic-heartbeats.json non-UUID IDs with UNSUPPORTED_HEARTBEAT_ID and never synthesizes IDs', async () => {
      const { readFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');

      const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../tests/fixtures');
      const hbDump = JSON.parse(readFileSync(join(fixturesDir, 'synthetic-heartbeats.json'), 'utf8'));

      const result = normalizeHeartbeatDay(hbDump, {
        date: '2026-01-03',
        timezone: 'Europe/Lisbon'
      });

      // Must fail closed because synthetic-heartbeats.json has non-UUID IDs like "hb-nearzero-0001"
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ID);
      }
    });

    it('normalizes dump heartbeats with valid UUIDs into canonical events', async () => {
      const { readFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');

      const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../tests/fixtures');
      const hbDump = JSON.parse(readFileSync(join(fixturesDir, 'synthetic-heartbeats.json'), 'utf8'));

      // Provide valid UUIDs for testing complete normalization
      const validHbDump = {
        ...hbDump,
        days: hbDump.days.map((d: any) => ({
          ...d,
          heartbeats: d.heartbeats.map((h: any, idx: number) => ({
            ...h,
            id: `550e8400-e29b-41d4-a716-44665544${String(idx).padStart(4, '0')}`
          }))
        }))
      };

      const result = normalizeHeartbeatDay(validHbDump, {
        date: '2026-01-03',
        timezone: 'Europe/Lisbon'
      });

      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') return;

      const hbDay = result.value;
      expect(hbDay.date).toBe('2026-01-03');
      expect(hbDay.heartbeats.length).toBeGreaterThan(0);
      for (const event of hbDay.heartbeats) {
        expect(event.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
        expect(event.occurredAtUs).toBeGreaterThan(0);
      }
    });

    it('detects detail downgrade when a flat coarse summary replaces an accepted entity_detail dump day', async () => {
      const { readFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');

      const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../tests/fixtures');
      const dailyDump = JSON.parse(readFileSync(join(fixturesDir, 'synthetic-daily.json'), 'utf8'));

      const acceptedDetailed = normalizeSummaryDay(dailyDump, {
        date: '2026-01-03',
        accountTimezone: 'Europe/Lisbon'
      });

      // Incoming flat coarse summary with same projects but missing entity arrays
      const incomingCoarse = normalizeSummaryDay({
        data: [
          {
            date: '2026-01-03',
            grand_total: { total_seconds: 3600 },
            projects: [
              { name: 'alpha', total_seconds: 3600 } // No entities!
            ]
          }
        ]
      }, {
        date: '2026-01-03',
        accountTimezone: 'Europe/Lisbon'
      });

      expect(acceptedDetailed.kind).toBe('complete');
      expect(incomingCoarse.kind).toBe('complete');
      if (acceptedDetailed.kind === 'complete' && incomingCoarse.kind === 'complete') {
        expect(acceptedDetailed.value.fidelity).toBe('entity_detail');
        expect(incomingCoarse.value.fidelity).toBe('coarse_project');
        // Scopes retained must NOT be downgraded
        expect(coversRetainedScopes(incomingCoarse.value.completeness, acceptedDetailed.value.completeness)).toBe(false);
      }
    });
  });

  describe('11. P3 Stage A Boundary Corrections: Scoped Dimensions, Coarse Empty Entities, & Collisions', () => {
    it('preserves project-scoped dimensions in synthetic-daily.json and includes them in content hash', async () => {
      const { readFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');

      const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../tests/fixtures');
      const dailyDump = JSON.parse(readFileSync(join(fixturesDir, 'synthetic-daily.json'), 'utf8'));

      const result = normalizeSummaryDay(dailyDump, {
        date: '2026-01-03',
        accountTimezone: 'Europe/Lisbon'
      });

      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') return;

      const day = result.value;

      // Both account and project scoped dimensions are present
      const projectDims = day.scopedDimensions.filter((d) => d.scope === 'project');
      const accountDims = day.scopedDimensions.filter((d) => d.scope === 'account');

      expect(projectDims.length).toBeGreaterThan(0);
      expect(accountDims.length).toBeGreaterThan(0);

      // Verify specific project-level dimensions for project 'alpha'
      expect(projectDims.some((d) => d.projectName === 'alpha' && d.dimension === 'branch' && d.name === 'main')).toBe(true);
      expect(projectDims.some((d) => d.projectName === 'alpha' && d.dimension === 'category' && d.name === 'Coding')).toBe(true);
      expect(projectDims.some((d) => d.projectName === 'alpha' && d.dimension === 'dependency' && d.name === 'zod')).toBe(true);
      expect(projectDims.some((d) => d.projectName === 'alpha' && d.dimension === 'editor' && d.name === 'VS Code')).toBe(true);
      expect(projectDims.some((d) => d.projectName === 'alpha' && d.dimension === 'language' && d.name === 'TypeScript')).toBe(true);
      expect(projectDims.some((d) => d.projectName === 'alpha' && d.dimension === 'machine' && d.name === 'fixture-laptop')).toBe(true);
      expect(projectDims.some((d) => d.projectName === 'alpha' && d.dimension === 'operating_system' && d.name === 'Mac')).toBe(true);

      // Mutating a project-scoped dimension changes the content hash
      const modifiedDump = JSON.parse(JSON.stringify(dailyDump));
      const targetDay = modifiedDump.days.find((d: any) => d.date === '2026-01-03');
      targetDay.projects[0].branches[0].name = 'feature/branch-x';

      const modifiedResult = normalizeSummaryDay(modifiedDump, {
        date: '2026-01-03',
        accountTimezone: 'Europe/Lisbon'
      });
      expect(modifiedResult.kind).toBe('complete');
      if (modifiedResult.kind === 'complete') {
        expect(modifiedResult.contentHash).not.toBe(result.contentHash);
      }
    });

    it('fails closed with INCOMPLETE_BODY when project-scoped dimensions are malformed', () => {
      const basePayload = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 3600.0 },
            projects: [
              {
                name: 'proj-a',
                total_seconds: 3600.0,
                entities: []
              }
            ]
          }
        ]
      };

      // branches not an array
      const badBranches = JSON.parse(JSON.stringify(basePayload));
      badBranches.data[0].projects[0].branches = 'not-an-array';
      expect(normalizeSummaryDay(badBranches, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // empty dimension name
      const badName = JSON.parse(JSON.stringify(basePayload));
      badName.data[0].projects[0].categories = [{ name: '  ', total_seconds: 100 }];
      expect(normalizeSummaryDay(badName, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // negative dimension seconds
      const badSecs = JSON.parse(JSON.stringify(basePayload));
      badSecs.data[0].projects[0].languages = [{ name: 'TypeScript', total_seconds: -10 }];
      expect(normalizeSummaryDay(badSecs, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // invalid percent
      const badPercent = JSON.parse(JSON.stringify(basePayload));
      badPercent.data[0].projects[0].editors = [{ name: 'VS Code', total_seconds: 100, percent: '100%' }];
      expect(normalizeSummaryDay(badPercent, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // invalid machine_name_id
      const badMachine = JSON.parse(JSON.stringify(basePayload));
      badMachine.data[0].projects[0].machines = [{ name: 'host-1', total_seconds: 100, machine_name_id: 12345 }];
      expect(normalizeSummaryDay(badMachine, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });
    });

    it('treats positive projects with entities: [] as coarse without establishing complete_detail or hasEntityDetail', () => {
      // Mixed projects: proj-detail has entities, proj-coarse has entities: []
      const mixedPayload = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 7200.0 },
            projects: [
              {
                name: 'proj-detail',
                total_seconds: 3600.0,
                entities: [
                  { name: 'main.ts', total_seconds: 3600.0, type: 'file' }
                ]
              },
              {
                name: 'proj-coarse',
                total_seconds: 3600.0,
                entities: [] // Positive time but 0 entities -> coarse!
              }
            ]
          }
        ]
      };

      const result = normalizeSummaryDay(mixedPayload, {
        date: '2026-09-08',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') return;

      const day = result.value;
      // Day is mixed, NOT complete_detail
      expect(day.fidelity).toBe('entity_detail');
      expect(day.completeness.overallEntityDetailState).toBe('mixed');
      expect(day.completeness.hasEntityDetail).toBe(true);

      const pDetail = day.projects.find((p) => p.name === 'proj-detail')!;
      const pCoarse = day.projects.find((p) => p.name === 'proj-coarse')!;

      expect(pDetail.hasEntityDetail).toBe(true);
      expect(pDetail.entityDetailState).toBe('present');

      expect(pCoarse.hasEntityDetail).toBe(false);
      expect(pCoarse.entityDetailState).toBe('empty');

      // Slices: proj-detail gets an 'entity' slice; proj-coarse gets a 'project_summary' slice
      const projDetailSlice = day.slices.find((s) => s.projectName === 'proj-detail');
      const projCoarseSlice = day.slices.find((s) => s.projectName === 'proj-coarse');

      expect(projDetailSlice?.kind).toBe('entity');
      expect(projCoarseSlice?.kind).toBe('project_summary');
    });

    it('prevents semantic collisions by keeping slices with same entity name but different entityType distinct', () => {
      const collisionPayload = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 300.0 },
            projects: [
              {
                name: 'multi-type-proj',
                total_seconds: 300.0,
                entities: [
                  { name: 'terminal', total_seconds: 100.0, type: 'app' },
                  { name: 'terminal', total_seconds: 200.0, type: 'domain' }
                ]
              }
            ]
          }
        ]
      };

      const result = normalizeSummaryDay(collisionPayload, {
        date: '2026-09-08',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('complete');
      if (result.kind !== 'complete') return;

      const day = result.value;
      // Must NOT merge into 1 slice: both app and domain must exist distinctly
      expect(day.slices).toHaveLength(2);

      const appSlice = day.slices.find((s) => s.entityType === 'app');
      const domainSlice = day.slices.find((s) => s.entityType === 'domain');

      expect(appSlice).toBeDefined();
      expect(appSlice?.totalSeconds).toBe(100.0);
      expect(appSlice?.entity).toBe('terminal');

      expect(domainSlice).toBeDefined();
      expect(domainSlice?.totalSeconds).toBe(200.0);
      expect(domainSlice?.entity).toBe('terminal');

      // Slices are deterministically sorted by (projectName, entity, entityType, kind)
      // Since entity is identical ('terminal'), entityType tiebreaker places 'app' before 'domain'
      expect(day.slices[0].entityType).toBe('app');
      expect(day.slices[1].entityType).toBe('domain');
    });

    it('fails closed when duplicate project names exist in projects array', () => {
      const duplicateProjectsPayload = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 200.0 },
            projects: [
              { name: 'alpha', total_seconds: 100.0, entities: [] },
              { name: 'alpha', total_seconds: 100.0, entities: [] }
            ]
          }
        ]
      };

      const result = normalizeSummaryDay(duplicateProjectsPayload, {
        date: '2026-09-08',
        accountTimezone: 'Europe/London'
      });

      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.code).toBe(RECONCILE_CODES.MATHEMATICAL_INVARIANT_VIOLATION);
      }
    });

    it('validates heartbeat scalar types strictly and rejects malformed values', () => {
      const validBaseHb = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        entity: '/src/index.ts',
        type: 'file',
        category: 'Coding',
        time: 1767344400, // on 2026-01-02 in Europe/Lisbon
        user_agent_id: 'agent/1.0',
        dependencies: []
      };

      // Test valid baseline passes
      const validResult = normalizeHeartbeatDay([validBaseHb], {
        date: '2026-01-02',
        timezone: 'Europe/Lisbon'
      });
      expect(validResult.kind).toBe('complete');

      // Reject non-boolean is_write
      const badWrite = { ...validBaseHb, is_write: 'yes' };
      expect(normalizeHeartbeatDay([badWrite], { date: '2026-01-02', timezone: 'Europe/Lisbon' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE
      });

      // Reject non-integer lines
      const badLines = { ...validBaseHb, lines: 'one hundred' };
      expect(normalizeHeartbeatDay([badLines], { date: '2026-01-02', timezone: 'Europe/Lisbon' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE
      });

      // Reject negative lines
      const negLines = { ...validBaseHb, lines: -5 };
      expect(normalizeHeartbeatDay([negLines], { date: '2026-01-02', timezone: 'Europe/Lisbon' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE
      });

      // Reject non-integer lineno
      const badLineno = { ...validBaseHb, lineno: 3.14 };
      expect(normalizeHeartbeatDay([badLineno], { date: '2026-01-02', timezone: 'Europe/Lisbon' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE
      });

      // Reject non-integer cursorpos
      const badCursor = { ...validBaseHb, cursorpos: NaN };
      expect(normalizeHeartbeatDay([badCursor], { date: '2026-01-02', timezone: 'Europe/Lisbon' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE
      });

      // Reject non-string machine_name_id
      const badMachine = { ...validBaseHb, machine_name_id: 12345 };
      expect(normalizeHeartbeatDay([badMachine], { date: '2026-01-02', timezone: 'Europe/Lisbon' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE
      });

      // Reject non-integer project_root_count
      const badRootCount = { ...validBaseHb, project_root_count: -1 };
      expect(normalizeHeartbeatDay([badRootCount], { date: '2026-01-02', timezone: 'Europe/Lisbon' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.UNSUPPORTED_HEARTBEAT_ENVELOPE
      });
    });

    it('fails closed on duplicate normalized entity identity within one project but retains different types as distinct', () => {
      // Duplicate same normalized name and type
      const dupEntities = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 200 },
            projects: [
              {
                name: 'proj-1',
                total_seconds: 200,
                entities: [
                  { name: '/src/main.ts', type: 'file', total_seconds: 100 },
                  { name: '\\src\\main.ts', type: 'file', total_seconds: 100 } // Normalizes to /src/main.ts!
                ]
              }
            ]
          }
        ]
      };
      expect(normalizeSummaryDay(dupEntities, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Different types with same name are allowed and retained
      const diffTypes = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 300 },
            projects: [
              {
                name: 'proj-1',
                total_seconds: 300,
                entities: [
                  { name: 'terminal', type: 'app', total_seconds: 100 },
                  { name: 'terminal', type: 'domain', total_seconds: 200 }
                ]
              }
            ]
          }
        ]
      };
      const diffResult = normalizeSummaryDay(diffTypes, { date: '2026-09-08', accountTimezone: 'Europe/London' });
      expect(diffResult.kind).toBe('complete');
      if (diffResult.kind === 'complete') {
        expect(diffResult.value.projects[0].entities).toHaveLength(2);
        expect(diffResult.value.slices).toHaveLength(2);
      }
    });

    it('fails closed on duplicate scoped-dimension semantic identity', () => {
      // Duplicate category in project
      const dupProjDim = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 200 },
            projects: [
              {
                name: 'proj-1',
                total_seconds: 200,
                categories: [
                  { name: 'Coding', total_seconds: 100 },
                  { name: 'Coding', total_seconds: 100 }
                ]
              }
            ]
          }
        ]
      };
      expect(normalizeSummaryDay(dupProjDim, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Duplicate category at account level
      const dupAccountDim = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 200 },
            categories: [
              { name: 'Coding', total_seconds: 100 },
              { name: 'Coding', total_seconds: 100 }
            ],
            projects: [
              { name: 'proj-1', total_seconds: 200 }
            ]
          }
        ]
      };
      expect(normalizeSummaryDay(dupAccountDim, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });
    });

    it('produces identical content hash regardless of array ordering across entities, dimensions, projects, and durations', () => {
      // Summary array reordering
      const orderA = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 600 },
            categories: [
              { name: 'Coding', total_seconds: 400 },
              { name: 'Design', total_seconds: 200 }
            ],
            projects: [
              {
                name: 'beta',
                total_seconds: 200,
                entities: [
                  { name: 'b2.ts', type: 'file', total_seconds: 100 },
                  { name: 'b1.ts', type: 'file', total_seconds: 100 }
                ]
              },
              {
                name: 'alpha',
                total_seconds: 400,
                entities: [
                  { name: 'a2.ts', type: 'file', total_seconds: 200 },
                  { name: 'a1.ts', type: 'file', total_seconds: 200 }
                ]
              }
            ]
          }
        ]
      };

      const orderB = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 600 },
            categories: [
              { name: 'Design', total_seconds: 200 },
              { name: 'Coding', total_seconds: 400 }
            ],
            projects: [
              {
                name: 'alpha',
                total_seconds: 400,
                entities: [
                  { name: 'a1.ts', type: 'file', total_seconds: 200 },
                  { name: 'a2.ts', type: 'file', total_seconds: 200 }
                ]
              },
              {
                name: 'beta',
                total_seconds: 200,
                entities: [
                  { name: 'b1.ts', type: 'file', total_seconds: 100 },
                  { name: 'b2.ts', type: 'file', total_seconds: 100 }
                ]
              }
            ]
          }
        ]
      };

      const resA = normalizeSummaryDay(orderA, { date: '2026-09-08', accountTimezone: 'Europe/London' });
      const resB = normalizeSummaryDay(orderB, { date: '2026-09-08', accountTimezone: 'Europe/London' });

      expect(resA.kind).toBe('complete');
      expect(resB.kind).toBe('complete');
      if (resA.kind === 'complete' && resB.kind === 'complete') {
        expect(resA.contentHash).toBe(resB.contentHash);
      }

      // Durations array reordering
      const durA = {
        data: [
          { project: 'beta', time: 1788868800, duration: 100 },
          { project: 'alpha', time: 1788868800, duration: 200 }
        ]
      };
      const durB = {
        data: [
          { project: 'alpha', time: 1788868800, duration: 200 },
          { project: 'beta', time: 1788868800, duration: 100 }
        ]
      };
      const durResA = normalizeDurationsDay(durA, { date: '2026-09-08', timezone: 'UTC' });
      const durResB = normalizeDurationsDay(durB, { date: '2026-09-08', timezone: 'UTC' });
      expect(durResA.kind).toBe('complete');
      expect(durResB.kind).toBe('complete');
      if (durResA.kind === 'complete' && durResB.kind === 'complete') {
        expect(durResA.contentHash).toBe(durResB.contentHash);
      }
    });

    it('preserves missing versus explicit zero in entity metrics and AI tokens, altering hash on explicit zero', () => {
      // Absent optional fields
      const absentPayload = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 100 }, // ai_input_tokens and ai_output_tokens absent!
            projects: [
              {
                name: 'proj-1',
                total_seconds: 100,
                entities: [
                  { name: 'main.ts', type: 'file', total_seconds: 100 } // human_additions etc absent!
                ]
              }
            ]
          }
        ]
      };

      // Explicit zero optional fields
      const explicitZeroPayload = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: {
              total_seconds: 100,
              ai_input_tokens: 0,
              ai_output_tokens: 0
            },
            projects: [
              {
                name: 'proj-1',
                total_seconds: 100,
                entities: [
                  {
                    name: 'main.ts',
                    type: 'file',
                    total_seconds: 100,
                    human_additions: 0,
                    human_deletions: 0,
                    ai_additions: 0,
                    ai_deletions: 0,
                    ai_sessions: 0
                  }
                ]
              }
            ]
          }
        ]
      };

      const absentRes = normalizeSummaryDay(absentPayload, { date: '2026-09-08', accountTimezone: 'Europe/London' });
      const explicitZeroRes = normalizeSummaryDay(explicitZeroPayload, { date: '2026-09-08', accountTimezone: 'Europe/London' });

      expect(absentRes.kind).toBe('complete');
      expect(explicitZeroRes.kind).toBe('complete');
      if (absentRes.kind === 'complete' && explicitZeroRes.kind === 'complete') {
        // Absent fields remain undefined in normalized value
        expect(absentRes.value.grandTotal.ai_input_tokens).toBeUndefined();
        expect(absentRes.value.grandTotal.ai_output_tokens).toBeUndefined();
        expect(absentRes.value.projects[0].entities[0].humanAdditions).toBeUndefined();
        expect(absentRes.value.projects[0].entities[0].humanDeletions).toBeUndefined();
        expect(absentRes.value.projects[0].entities[0].aiAdditions).toBeUndefined();
        expect(absentRes.value.projects[0].entities[0].aiDeletions).toBeUndefined();
        expect(absentRes.value.projects[0].entities[0].aiSessions).toBeUndefined();

        // Slices may use required numeric zero
        expect(absentRes.value.slices[0].humanAdditions).toBe(0);
        expect(absentRes.value.slices[0].humanDeletions).toBe(0);

        // Explicit zero fields remain 0 in normalized value
        expect(explicitZeroRes.value.grandTotal.ai_input_tokens).toBe(0);
        expect(explicitZeroRes.value.grandTotal.ai_output_tokens).toBe(0);
        expect(explicitZeroRes.value.projects[0].entities[0].humanAdditions).toBe(0);
        expect(explicitZeroRes.value.projects[0].entities[0].humanDeletions).toBe(0);
        expect(explicitZeroRes.value.projects[0].entities[0].aiAdditions).toBe(0);
        expect(explicitZeroRes.value.projects[0].entities[0].aiDeletions).toBe(0);
        expect(explicitZeroRes.value.projects[0].entities[0].aiSessions).toBe(0);

        // Hash MUST differ because explicit zero is serialized while undefined is omitted
        expect(absentRes.contentHash).not.toBe(explicitZeroRes.contentHash);
      }
    });

    it('rejects malformed present project/entity percent, count, or metric values with INCOMPLETE_BODY', () => {
      const basePayload = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 100 },
            projects: [
              {
                name: 'proj-1',
                total_seconds: 100,
                entities: [
                  { name: 'main.ts', type: 'file', total_seconds: 100 }
                ]
              }
            ]
          }
        ]
      };

      // Non-integer entity human additions
      const badHAdd = JSON.parse(JSON.stringify(basePayload));
      badHAdd.data[0].projects[0].entities[0].human_additions = 1.5;
      expect(normalizeSummaryDay(badHAdd, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Negative entity ai additions
      const negAAdd = JSON.parse(JSON.stringify(basePayload));
      negAAdd.data[0].projects[0].entities[0].ai_additions = -1;
      expect(normalizeSummaryDay(negAAdd, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // String entity percent
      const strPercent = JSON.parse(JSON.stringify(basePayload));
      strPercent.data[0].projects[0].entities[0].percent = '50%';
      expect(normalizeSummaryDay(strPercent, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Negative project root count
      const negRootCount = JSON.parse(JSON.stringify(basePayload));
      negRootCount.data[0].projects[0].entities[0].project_root_count = -1;
      expect(normalizeSummaryDay(negRootCount, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Negative project percent
      const negProjPercent = JSON.parse(JSON.stringify(basePayload));
      negProjPercent.data[0].projects[0].percent = -10;
      expect(normalizeSummaryDay(negProjPercent, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Non-integer grand total ai input tokens
      const badAiIn = JSON.parse(JSON.stringify(basePayload));
      badAiIn.data[0].grand_total.ai_input_tokens = 'thousand';
      expect(normalizeSummaryDay(badAiIn, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Negative grand total ai output tokens
      const negAiOut = JSON.parse(JSON.stringify(basePayload));
      negAiOut.data[0].grand_total.ai_output_tokens = -5;
      expect(normalizeSummaryDay(negAiOut, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });
    });
  });

  describe('12. Final Boundary Fix: Null-as-Absence Rejection & Own-Property Semantics', () => {
    it('rejects duration event with null branch, entity, category, or created_at with INCOMPLETE_BODY', () => {
      const baseValid = { project: 'work-times', time: 1788868800, duration: 300 };

      // branch supplied as null
      expect(normalizeDurationsDay({ data: [{ ...baseValid, branch: null }] }, { date: '2026-09-08', timezone: 'UTC' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // entity supplied as null
      expect(normalizeDurationsDay({ data: [{ ...baseValid, entity: null }] }, { date: '2026-09-08', timezone: 'UTC' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // category supplied as null
      expect(normalizeDurationsDay({ data: [{ ...baseValid, category: null }] }, { date: '2026-09-08', timezone: 'UTC' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // created_at supplied as null
      expect(normalizeDurationsDay({ data: [{ ...baseValid, created_at: null }] }, { date: '2026-09-08', timezone: 'UTC' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Omitted fields succeed cleanly with defaults
      const validOmitted = normalizeDurationsDay({ data: [baseValid] }, { date: '2026-09-08', timezone: 'UTC' });
      expect(validOmitted.kind).toBe('complete');
      if (validOmitted.kind === 'complete') {
        expect(validOmitted.value.durations[0].branch).toBeNull();
        expect(validOmitted.value.durations[0].entity).toBeNull();
        expect(validOmitted.value.durations[0].category).toBeNull();
        expect(validOmitted.value.durations[0].createdAt).toBeUndefined();
      }
    });

    it('rejects supplied null or non-array scoped dimension collections and malformed percent', () => {
      const basePayload = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 100 },
            projects: [
              {
                name: 'proj-1',
                total_seconds: 100,
                entities: [{ name: 'main.ts', type: 'file', total_seconds: 100 }]
              }
            ]
          }
        ]
      };

      // Account categories supplied as null
      const nullAccountCat = JSON.parse(JSON.stringify(basePayload));
      nullAccountCat.data[0].categories = null;
      expect(normalizeSummaryDay(nullAccountCat, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Project categories supplied as null
      const nullProjCat = JSON.parse(JSON.stringify(basePayload));
      nullProjCat.data[0].projects[0].categories = null;
      expect(normalizeSummaryDay(nullProjCat, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Project editors supplied as non-array
      const badProjEditors = JSON.parse(JSON.stringify(basePayload));
      badProjEditors.data[0].projects[0].editors = 'VS Code';
      expect(normalizeSummaryDay(badProjEditors, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Scoped dimension item with percent supplied as null
      const nullDimPercent = JSON.parse(JSON.stringify(basePayload));
      nullDimPercent.data[0].projects[0].categories = [{ name: 'Coding', total_seconds: 100, percent: null }];
      expect(normalizeSummaryDay(nullDimPercent, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Scoped dimension item with percent supplied as negative
      const negDimPercent = JSON.parse(JSON.stringify(basePayload));
      negDimPercent.data[0].projects[0].categories = [{ name: 'Coding', total_seconds: 100, percent: -5 }];
      expect(normalizeSummaryDay(negDimPercent, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // Scoped dimension item with valid percent
      const validDimPercent = JSON.parse(JSON.stringify(basePayload));
      validDimPercent.data[0].projects[0].categories = [{ name: 'Coding', total_seconds: 100, percent: 50 }];
      const validDimRes = normalizeSummaryDay(validDimPercent, { date: '2026-09-08', accountTimezone: 'Europe/London' });
      expect(validDimRes.kind).toBe('complete');
      if (validDimRes.kind === 'complete') {
        const catDim = validDimRes.value.scopedDimensions.find((d) => d.dimension === 'category');
        expect(catDim?.percent).toBe(50);
      }
    });

    it('validates project percent aliases and nested grand-total percent without silent fallthrough or zero coercion', () => {
      const basePayload = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 100 },
            projects: [
              {
                name: 'proj-1',
                total_seconds: 100,
                entities: [{ name: 'main.ts', type: 'file', total_seconds: 100 }]
              }
            ]
          }
        ]
      };

      // rawProj.percent supplied as null, even when grand_total.percent is valid (no fallthrough!)
      const nullProjPercent = JSON.parse(JSON.stringify(basePayload));
      nullProjPercent.data[0].projects[0].percent = null;
      nullProjPercent.data[0].projects[0].grand_total = { total_seconds: 100, percent: 50 };
      expect(normalizeSummaryDay(nullProjPercent, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // rawProj.percent valid, but grand_total.percent supplied as null (both validated before selection!)
      const nullGtPercent = JSON.parse(JSON.stringify(basePayload));
      nullGtPercent.data[0].projects[0].percent = 50;
      nullGtPercent.data[0].projects[0].grand_total = { total_seconds: 100, percent: null };
      expect(normalizeSummaryDay(nullGtPercent, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // rawProj.percent omitted, grand_total.percent supplied as null (never turn malformed data into zero!)
      const nullOnlyGtPercent = JSON.parse(JSON.stringify(basePayload));
      nullOnlyGtPercent.data[0].projects[0].grand_total = { total_seconds: 100, percent: null };
      expect(normalizeSummaryDay(nullOnlyGtPercent, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // rawProj.percent omitted, grand_total.percent supplied as valid
      const validGtPercentOnly = JSON.parse(JSON.stringify(basePayload));
      validGtPercentOnly.data[0].projects[0].grand_total = { total_seconds: 100, percent: 75 };
      const validGtRes = normalizeSummaryDay(validGtPercentOnly, { date: '2026-09-08', accountTimezone: 'Europe/London' });
      expect(validGtRes.kind).toBe('complete');
      if (validGtRes.kind === 'complete') {
        expect(validGtRes.value.projects[0].percent).toBe(75);
      }

      // Both omitted default cleanly to 0
      const omittedPercentRes = normalizeSummaryDay(basePayload, { date: '2026-09-08', accountTimezone: 'Europe/London' });
      expect(omittedPercentRes.kind).toBe('complete');
      if (omittedPercentRes.kind === 'complete') {
        expect(omittedPercentRes.value.projects[0].percent).toBe(0);
      }
    });

    it('rejects null for optional entity metrics and grand total tokens, except project_root_count which permits null', () => {
      const basePayload = {
        data: [
          {
            date: '2026-09-08',
            range: { timezone: 'Europe/London' },
            grand_total: { total_seconds: 100 },
            projects: [
              {
                name: 'proj-1',
                total_seconds: 100,
                entities: [{ name: 'main.ts', type: 'file', total_seconds: 100 }]
              }
            ]
          }
        ]
      };

      // entity human_additions supplied as null
      const nullHAdd = JSON.parse(JSON.stringify(basePayload));
      nullHAdd.data[0].projects[0].entities[0].human_additions = null;
      expect(normalizeSummaryDay(nullHAdd, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // entity percent supplied as null
      const nullEntPercent = JSON.parse(JSON.stringify(basePayload));
      nullEntPercent.data[0].projects[0].entities[0].percent = null;
      expect(normalizeSummaryDay(nullEntPercent, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // grand_total ai_input_tokens supplied as null
      const nullAiTokens = JSON.parse(JSON.stringify(basePayload));
      nullAiTokens.data[0].grand_total.ai_input_tokens = null;
      expect(normalizeSummaryDay(nullAiTokens, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // grand_total percent supplied as null
      const nullGtTotalPercent = JSON.parse(JSON.stringify(basePayload));
      nullGtTotalPercent.data[0].grand_total.percent = null;
      expect(normalizeSummaryDay(nullGtTotalPercent, { date: '2026-09-08', accountTimezone: 'Europe/London' })).toMatchObject({
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY
      });

      // project_root_count supplied as null explicitly permits null per frozen contracts!
      const nullRootCount = JSON.parse(JSON.stringify(basePayload));
      nullRootCount.data[0].projects[0].entities[0].project_root_count = null;
      const rootRes = normalizeSummaryDay(nullRootCount, { date: '2026-09-08', accountTimezone: 'Europe/London' });
      expect(rootRes.kind).toBe('complete');
      if (rootRes.kind === 'complete') {
        expect(rootRes.value.projects[0].entities[0].projectRootCount).toBeNull();
        expect(rootRes.value.slices[0].projectRootCount).toBeNull();
      }
    });
  });
});
