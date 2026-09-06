import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WorkOnlyAnalytics } from '$lib/server/analytics/work-only';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD)');
const namedSeconds = z.object({ name: z.string(), seconds: z.number().nonnegative() }).strict();
const projectSummary = z
  .object({
    project: z.string(),
    seconds: z.number().nonnegative(),
    categories: z.array(namedSeconds),
    languages: z.array(namedSeconds)
  })
  .strict();
const daySummary = z
  .object({
    date: isoDate,
    workSeconds: z.number().nonnegative(),
    projects: z.array(projectSummary)
  })
  .strict();
const coverageFields = {
  unclassifiedSeconds: z.number().nonnegative(),
  hasUnclassified: z.boolean()
};

export function createWorkTimesMcpServer(analytics: WorkOnlyAnalytics): McpServer {
  const server = new McpServer({
    name: 'work-times',
    version: '0.1.0'
  });

  server.registerTool(
    'get_work_summary',
    {
      title: 'Get work summary',
      description:
        'Return work-only time grouped by day and project. Personal and unclassified identities are never returned.',
      inputSchema: z
        .object({
          start: isoDate.describe('Inclusive first day'),
          end: isoDate.describe('Inclusive last day')
        })
        .strict(),
      outputSchema: z
        .object({
          start: isoDate,
          end: isoDate,
          workSeconds: z.number().nonnegative(),
          ...coverageFields,
          days: z.array(daySummary)
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ start, end }) => {
      if (start > end) throw new Error('start must be on or before end');
      const output = await analytics.getRangeSummary({ start, end });

      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output
      };
    }
  );

  server.registerTool(
    'get_work_evidence',
    {
      title: 'Get work evidence for a day',
      description:
        'Return work-only project, category, and language evidence for timesheet preparation. Exact files are excluded.',
      inputSchema: z
        .object({
          date: isoDate,
          project: z.string().trim().min(1).optional()
        })
        .strict(),
      outputSchema: z
        .object({
          date: isoDate,
          workSeconds: z.number().nonnegative(),
          ...coverageFields,
          projects: z.array(projectSummary)
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ date, project }) => {
      const output = await analytics.getDayEvidence({ date, project });

      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output
      };
    }
  );

  return server;
}

export function createWorkTimesMcpHandler(analytics: WorkOnlyAnalytics) {
  return createMcpHandler(() => createWorkTimesMcpServer(analytics), {
    legacy: 'stateless',
    responseMode: 'auto'
  });
}
