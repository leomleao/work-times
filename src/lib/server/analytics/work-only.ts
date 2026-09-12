import type { McpDataQuality } from '../sync/contracts.js';

export interface WorkProjectSummary {
  project: string;
  seconds: number;
  categories: Array<{ name: string; seconds: number }>;
  languages: Array<{ name: string; seconds: number }>;
}

export interface WorkDaySummary {
  date: string;
  workSeconds: number;
  projects: WorkProjectSummary[];
}

export interface WorkRangeSummary {
  start: string;
  end: string;
  workSeconds: number;
  unclassifiedSeconds: number;
  hasUnclassified: boolean;
  days: WorkDaySummary[];
  dataQuality: McpDataQuality;
}

export interface WorkEvidence {
  date: string;
  workSeconds: number;
  unclassifiedSeconds: number;
  hasUnclassified: boolean;
  projects: WorkProjectSummary[];
  dataQuality: McpDataQuality;
}

/**
 * This interface is the MCP privacy boundary. Implementations must query only
 * effective `work` slices. The sole non-work value permitted across the
 * boundary is an aggregate unclassified-seconds warning with no identities.
 */
export interface WorkOnlyAnalytics {
  getRangeSummary(input: { start: string; end: string }): Promise<WorkRangeSummary>;
  getDayEvidence(input: { date: string; project?: string }): Promise<WorkEvidence>;
}
