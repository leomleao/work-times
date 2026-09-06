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
});
