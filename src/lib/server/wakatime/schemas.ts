import { z } from 'zod';

// ==========================================
// Breakdown & Metric Schemas
// ==========================================

export const GrandTotalSchema = z
  .object({
    total_seconds: z.number(),
    ai_additions: z.number().optional().default(0),
    ai_deletions: z.number().optional().default(0),
    human_additions: z.number().optional().default(0),
    human_deletions: z.number().optional().default(0),
    ai_sessions: z.number().optional().default(0),
    ai_input_tokens: z.number().optional().default(0),
    ai_output_tokens: z.number().optional().default(0)
  })
  .passthrough();

export type GrandTotal = z.infer<typeof GrandTotalSchema>;

export const TimeBreakdownItemSchema = z
  .object({
    name: z.string(),
    total_seconds: z.number(),
    percent: z.number().optional().default(0)
  })
  .passthrough();

export type TimeBreakdownItem = z.infer<typeof TimeBreakdownItemSchema>;

export const MachineBreakdownItemSchema = TimeBreakdownItemSchema.extend({
  machine_name_id: z.string().nullable().optional()
}).passthrough();

export type MachineBreakdownItem = z.infer<typeof MachineBreakdownItemSchema>;

export const EntityBreakdownItemSchema = TimeBreakdownItemSchema.extend({
  type: z.enum(['file', 'app', 'domain']).or(z.string()).optional(),
  project_root_count: z.number().nullable().optional(),
  ai_additions: z.number().optional(),
  ai_deletions: z.number().optional(),
  human_additions: z.number().optional(),
  human_deletions: z.number().optional(),
  ai_sessions: z.number().optional()
}).passthrough();

export type EntityBreakdownItem = z.infer<typeof EntityBreakdownItemSchema>;

/**
 * Project summary item preserving field presence.
 *
 * CRITICAL PRESERVATION INVARIANT:
 * Absent arrays (e.g. entities omitted in a flat project summary) are preserved
 * as undefined and NOT defaulted to complete empty array [].
 * This allows distinguishing absent detail from authoritative zero entities.
 */
export const ProjectSummaryItemSchema = z
  .object({
    name: z.string(),
    total_seconds: z.number(),
    percent: z.number().optional().default(0),
    grand_total: GrandTotalSchema.optional(),
    branches: z.array(TimeBreakdownItemSchema).optional(),
    categories: z.array(TimeBreakdownItemSchema).optional(),
    dependencies: z.array(TimeBreakdownItemSchema).optional(),
    editors: z.array(TimeBreakdownItemSchema).optional(),
    entities: z.array(EntityBreakdownItemSchema).optional(),
    languages: z.array(TimeBreakdownItemSchema).optional(),
    machines: z.array(MachineBreakdownItemSchema).optional(),
    operating_systems: z.array(TimeBreakdownItemSchema).optional()
  })
  .passthrough();

export type ProjectSummaryItem = z.infer<typeof ProjectSummaryItemSchema>;

// ==========================================
// Summaries Endpoint
// ==========================================

/**
 * Summary day schema preserving field presence.
 * Absent arrays (such as projects) are preserved as undefined.
 */
const SummaryDayWireSchema = z
  .object({
    date: z.string().optional(),
    grand_total: GrandTotalSchema,
    categories: z.array(TimeBreakdownItemSchema).optional(),
    editors: z.array(TimeBreakdownItemSchema).optional(),
    languages: z.array(TimeBreakdownItemSchema).optional(),
    machines: z.array(MachineBreakdownItemSchema).optional(),
    operating_systems: z.array(TimeBreakdownItemSchema).optional(),
    dependencies: z.array(TimeBreakdownItemSchema).optional(),
    projects: z.array(ProjectSummaryItemSchema).optional(),
    range: z
      .object({
        date: z.string().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        text: z.string().optional(),
        timezone: z.string().optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export const SummaryDaySchema = SummaryDayWireSchema
  .refine((day) => Boolean(day.date ?? day.range?.date), {
    message: 'Summary day must contain date or range.date'
  })
  .transform((day) => ({ ...day, date: day.date ?? day.range!.date! }));

export type SummaryDay = z.infer<typeof SummaryDaySchema>;

export const SummariesResponseSchema = z
  .object({
    data: z.array(SummaryDaySchema),
    start: z.string().optional(),
    end: z.string().optional(),
    cumulative_total: z
      .object({
        seconds: z.number().optional(),
        text: z.string().optional()
      })
      .passthrough()
      .optional(),
    daily_average: z
      .object({
        seconds: z.number().optional(),
        text: z.string().optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export type SummariesResponse = z.infer<typeof SummariesResponseSchema>;

// ==========================================
// Heartbeats Endpoint
// ==========================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates whether an external ID string matches the canonical RFC 4122 UUID format.
 */
export function isValidHeartbeatUuid(id: string): boolean {
  return typeof id === 'string' && UUID_REGEX.test(id.trim());
}

/**
 * Single heartbeat item.
 *
 * INVARIANT:
 * No durations are inferred from heartbeats. Heartbeat represents point-in-time event.
 * Dependencies presence is preserved: absent dependencies are undefined, not defaulted to [].
 */
export const HeartbeatItemSchema = z
  .object({
    id: z.string().min(1),
    entity: z.string(),
    type: z.enum(['file', 'app', 'domain']).or(z.string()),
    time: z.number(), // Unix timestamp (floating or integer seconds)
    category: z.string().optional(),
    project: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    dependencies: z.array(z.string()).optional(),
    lines: z.number().nullable().optional(),
    lineno: z.number().nullable().optional(),
    cursorpos: z.number().nullable().optional(),
    is_write: z.boolean().optional().default(false),
    created_at: z.string().optional(),
    machine_name_id: z.string().nullable().optional(),
    user_agent_id: z.string().optional(),
    project_root_count: z.number().nullable().optional(),
    ai_session: z.string().nullable().optional(),
    ai_subscription_plan: z.string().nullable().optional(),
    ai_line_changes: z.number().nullable().optional(),
    human_line_changes: z.number().nullable().optional(),
    ai_input_tokens: z.number().nullable().optional(),
    ai_cached_input_tokens: z.number().nullable().optional(),
    ai_output_tokens: z.number().nullable().optional(),
    ai_prompt_length: z.number().nullable().optional()
  })
  .passthrough();

export type HeartbeatItem = z.infer<typeof HeartbeatItemSchema>;

export const HeartbeatsResponseSchema = z
  .object({
    data: z.array(HeartbeatItemSchema),
    start: z.string().optional(),
    end: z.string().optional(),
    timezone: z.string().optional()
  })
  .passthrough();

export type HeartbeatsResponse = z.infer<typeof HeartbeatsResponseSchema>;

// ==========================================
// Durations Endpoint
// ==========================================

export const DurationItemSchema = z
  .object({
    project: z.string(),
    time: z.number(), // Unix timestamp (start of duration block)
    duration: z.number(), // Length of block in seconds
    created_at: z.string().optional(),
    color: z.string().nullable().optional()
  })
  .passthrough();

export type DurationItem = z.infer<typeof DurationItemSchema>;

export const DurationsResponseSchema = z
  .object({
    data: z.array(DurationItemSchema),
    start: z.string().optional(),
    end: z.string().optional(),
    timezone: z.string().optional(),
    branches: z.array(z.string()).optional()
  })
  .passthrough();

export type DurationsResponse = z.infer<typeof DurationsResponseSchema>;

// ==========================================
// Data Dumps Endpoint
// ==========================================

export const DumpTypeSchema = z.enum(['daily', 'heartbeats']);
export type DumpType = z.infer<typeof DumpTypeSchema>;

export const CreateDumpInputSchema = z
  .object({
    type: DumpTypeSchema,
    email_when_finished: z.boolean().optional()
  })
  .passthrough();

export type CreateDumpInput = z.infer<typeof CreateDumpInputSchema>;

export const DumpItemSchema = z
  .object({
    id: z.string(),
    type: z.string(), // 'heartbeats' | 'daily'
    status: z.string(), // 'pending' | 'processing' | 'completed' | 'failed'
    percent_complete: z.number().nullable().optional(),
    download_url: z.string().nullable().optional(),
    created_at: z.string(),
    expires: z.string().nullable().optional(),
    is_empty: z.boolean().optional(),
    is_processing: z.boolean().optional(),
    is_stuck: z.boolean().optional(),
    has_failed: z.boolean().optional(),
    error_message: z.string().nullable().optional()
  })
  .passthrough();

export type DumpItem = z.infer<typeof DumpItemSchema>;

export const DumpListResponseSchema = z
  .object({
    data: z.array(DumpItemSchema),
    total: z.number().optional(),
    page: z.number().optional(),
    total_pages: z.number().optional()
  })
  .passthrough();

export type DumpListResponse = z.infer<typeof DumpListResponseSchema>;

export const DumpStatusResponseSchema = z
  .object({
    data: DumpItemSchema
  })
  .passthrough();

export type DumpStatusResponse = z.infer<typeof DumpStatusResponseSchema>;

// ==========================================
// Current User Endpoint (for probing / discovery)
// ==========================================

export const CurrentUserSchema = z
  .object({
    id: z.string(),
    email: z.string().optional(),
    username: z.string().nullable().optional(),
    timezone: z.string().optional(),
    timeout: z.number().optional(),
    weekday_start: z.number().optional(),
    writes_only: z.boolean().optional(),
    plan: z.string().optional(),
    has_premium_features: z.boolean().optional()
  })
  .passthrough();

export type CurrentUser = z.infer<typeof CurrentUserSchema>;

export const CurrentUserResponseSchema = z
  .object({
    data: CurrentUserSchema
  })
  .passthrough();

export type CurrentUserResponse = z.infer<typeof CurrentUserResponseSchema>;

// ==========================================
// Identity registries used to normalize heartbeat foreign keys
// ==========================================

const PaginationSchema = z.object({
  page: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
  next_page: z.number().int().positive().nullable().optional(),
  prev_page: z.number().int().positive().nullable().optional()
});

export const ProjectRegistryItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    repository: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    last_heartbeat_at: z.string().nullable().optional(),
    first_heartbeat_at: z.string().nullable().optional()
  })
  .passthrough();

export const ProjectsResponseSchema = PaginationSchema.extend({
  data: z.array(ProjectRegistryItemSchema)
}).passthrough();
export type ProjectsResponse = z.infer<typeof ProjectsResponseSchema>;

export const MachineNameItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    value: z.string(),
    ip: z.string(),
    timezone: z.string().nullable().optional(),
    last_seen_at: z.string().nullable().optional(),
    created_at: z.string().optional()
  })
  .passthrough();

export const MachineNamesResponseSchema = PaginationSchema.extend({
  data: z.array(MachineNameItemSchema)
}).passthrough();
export type MachineNamesResponse = z.infer<typeof MachineNamesResponseSchema>;

export const UserAgentItemSchema = z
  .object({
    id: z.string(),
    value: z.string(),
    editor: z.string(),
    os: z.string(),
    version: z.string().nullable().optional(),
    ai_model: z.string().nullable().optional(),
    ai_model_version: z.string().nullable().optional(),
    ai_model_complexity: z.string().nullable().optional(),
    is_browser_extension: z.boolean().optional(),
    is_desktop_app: z.boolean().optional(),
    last_seen_at: z.string().nullable().optional(),
    created_at: z.string().optional()
  })
  .passthrough();

export const UserAgentsResponseSchema = PaginationSchema.extend({
  data: z.array(UserAgentItemSchema)
}).passthrough();
export type UserAgentsResponse = z.infer<typeof UserAgentsResponseSchema>;

// ==========================================
// Field Presence & Fidelity Query Helpers
// ==========================================

/**
 * Returns entity detail state for a project summary item:
 * - 'absent': entities array field was omitted in the upstream response
 * - 'empty': entities array field was explicitly returned as []
 * - 'present': entities array field was returned with >= 1 entries
 */
export function getEntityDetailState(project: ProjectSummaryItem): 'present' | 'empty' | 'absent' {
  if (project.entities === undefined) return 'absent';
  return project.entities.length === 0 ? 'empty' : 'present';
}

/**
 * Returns project presence state for a summary day:
 * - 'absent': projects array was omitted
 * - 'empty': projects array was explicitly returned as []
 * - 'present': projects array was returned with >= 1 entries
 */
export function getProjectPresenceState(day: SummaryDay): 'present' | 'empty' | 'absent' {
  if (day.projects === undefined) return 'absent';
  return day.projects.length === 0 ? 'empty' : 'present';
}

/**
 * Checks whether a summary day represents an authoritative verified zero day:
 * total_seconds === 0 and projects is an explicit empty array [].
 */
export function isVerifiedZeroSummary(day: SummaryDay): boolean {
  const isZeroSeconds = day.grand_total.total_seconds === 0;
  const hasEmptyProjects = Array.isArray(day.projects) && day.projects.length === 0;
  return isZeroSeconds && hasEmptyProjects;
}

/**
 * Checks if a requested calendar date is present in a SummariesResponse.
 */
export function hasDateInSummaries(response: SummariesResponse, date: string): boolean {
  if (!response.data || !Array.isArray(response.data)) return false;
  return response.data.some((d) => d.date === date);
}
