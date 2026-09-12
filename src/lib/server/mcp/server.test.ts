import { describe, expect, it, vi } from 'vitest';
import type { WorkOnlyAnalytics } from '$lib/server/analytics/work-only';
import { createWorkTimesMcpServer } from './server';

describe('work-only MCP server', () => {
  it('constructs without reading analytics or private activity', () => {
    const analytics: WorkOnlyAnalytics = {
      getRangeSummary: vi.fn(),
      getDayEvidence: vi.fn()
    };

    const server = createWorkTimesMcpServer(analytics);

    expect(server).toBeDefined();
    expect(analytics.getRangeSummary).not.toHaveBeenCalled();
    expect(analytics.getDayEvidence).not.toHaveBeenCalled();
  });

  it('exposes dataQuality in get_work_summary and preserves work-only results', async () => {
    const mockSummary = {
      start: '2026-01-01',
      end: '2026-01-02',
      workSeconds: 3600,
      unclassifiedSeconds: 0,
      hasUnclassified: false,
      days: [
        {
          date: '2026-01-01',
          workSeconds: 3600,
          projects: [
            {
              project: 'work-project',
              seconds: 3600,
              categories: [{ name: 'Coding', seconds: 3600 }],
              languages: [{ name: 'TypeScript', seconds: 3600 }]
            }
          ]
        }
      ],
      dataQuality: {
        asOf: '2026-01-02T10:00:00.000Z',
        hasMissingDays: false,
        hasStaleDays: false,
        hasLimitedDetail: false,
        advisoryCodes: []
      }
    };

    const analytics: WorkOnlyAnalytics = {
      getRangeSummary: vi.fn().mockResolvedValue(mockSummary),
      getDayEvidence: vi.fn()
    };

    const server = createWorkTimesMcpServer(analytics);

    const tool = (server as any)._registeredTools['get_work_summary'];
    expect(tool).toBeDefined();

    const result = await tool.handler({ start: '2026-01-01', end: '2026-01-02' });
    expect(result.structuredContent.dataQuality).toBeDefined();
    expect(result.structuredContent.dataQuality.asOf).toBe('2026-01-02T10:00:00.000Z');
    expect(result.structuredContent.dataQuality.hasMissingDays).toBe(false);
    expect(result.structuredContent.workSeconds).toBe(3600);

    const json = JSON.stringify(result);
    expect(json).not.toContain('confidential');
    expect(json).not.toContain('account_id');
    expect(json).not.toContain('personal_seconds');
  });

  it('exposes dataQuality in get_work_evidence with asOf null on missing days', async () => {
    const mockEvidence = {
      date: '2026-01-01',
      workSeconds: 1800,
      unclassifiedSeconds: 300,
      hasUnclassified: true,
      projects: [
        {
          project: 'work-project',
          seconds: 1800,
          categories: [{ name: 'Coding', seconds: 1800 }],
          languages: [{ name: 'TypeScript', seconds: 1800 }]
        }
      ],
      dataQuality: {
        asOf: null,
        hasMissingDays: true,
        hasStaleDays: true,
        hasLimitedDetail: false,
        advisoryCodes: ['STALE_MISSING_COVERAGE']
      }
    };

    const analytics: WorkOnlyAnalytics = {
      getRangeSummary: vi.fn(),
      getDayEvidence: vi.fn().mockResolvedValue(mockEvidence)
    };

    const server = createWorkTimesMcpServer(analytics);

    const tool = (server as any)._registeredTools['get_work_evidence'];
    expect(tool).toBeDefined();

    const result = await tool.handler({ date: '2026-01-01' });
    expect(result.structuredContent.dataQuality).toBeDefined();
    expect(result.structuredContent.dataQuality.asOf).toBeNull();
    expect(result.structuredContent.dataQuality.hasMissingDays).toBe(true);
    expect(result.structuredContent.dataQuality.advisoryCodes).toContain('STALE_MISSING_COVERAGE');
  });
});
