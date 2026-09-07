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

export const ProjectSummaryItemSchema = z
  .object({
    name: z.string(),
    total_seconds: z.number(),
    percent: z.number().optional().default(0),
    grand_total: GrandTotalSchema.optional(),
    branches: z.array(TimeBreakdownItemSchema).optional().default([]),
    categories: z.array(TimeBreakdownItemSchema).optional().default([]),
    dependencies: z.array(TimeBreakdownItemSchema).optional().default([]),
    editors: z.array(TimeBreakdownItemSchema).optional().default([]),
    entities: z.array(EntityBreakdownItemSchema).optional().default([]),
    languages: z.array(TimeBreakdownItemSchema).optional().default([]),
    machines: z.array(MachineBreakdownItemSchema).optional().default([]),
    operating_systems: z.array(TimeBreakdownItemSchema).optional().default([])
  })
  .passthrough();

export type ProjectSummaryItem = z.infer<typeof ProjectSummaryItemSchema>;

// ==========================================
// Summaries Endpoint
// ==========================================

const SummaryDayWireSchema = z
  .object({
    // Current API responses put the calendar date in range.date. Older
    // fixtures/export-derived payloads may still expose a top-level date.
    date: z.string().optional(),
    grand_total: GrandTotalSchema,
    categories: z.array(TimeBreakdownItemSchema).optional().default([]),
    editors: z.array(TimeBreakdownItemSchema).optional().default([]),
    languages: z.array(TimeBreakdownItemSchema).optional().default([]),
    machines: z.array(MachineBreakdownItemSchema).optional().default([]),
    operating_systems: z.array(TimeBreakdownItemSchema).optional().default([]),
    dependencies: z.array(TimeBreakdownItemSchema).optional().default([]),
    projects: z.array(ProjectSummaryItemSchema).optional().default([]),
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

export const HeartbeatItemSchema = z
  .object({
    id: z.string(),
    entity: z.string(),
    type: z.enum(['file', 'app', 'domain']).or(z.string()),
    time: z.number(), // Unix timestamp (floating or integer seconds)
    category: z.string().optional(),
    project: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    dependencies: z.array(z.string()).optional().default([]),
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

export const ProjectRegistryItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  repository: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  last_heartbeat_at: z.string().nullable().optional(),
  first_heartbeat_at: z.string().nullable().optional()
}).passthrough();

export const ProjectsResponseSchema = PaginationSchema.extend({
  data: z.array(ProjectRegistryItemSchema)
}).passthrough();
export type ProjectsResponse = z.infer<typeof ProjectsResponseSchema>;

export const MachineNameItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  value: z.string(),
  ip: z.string(),
  timezone: z.string().nullable().optional(),
  last_seen_at: z.string().nullable().optional(),
  created_at: z.string().optional()
}).passthrough();

export const MachineNamesResponseSchema = PaginationSchema.extend({
  data: z.array(MachineNameItemSchema)
}).passthrough();
export type MachineNamesResponse = z.infer<typeof MachineNamesResponseSchema>;

export const UserAgentItemSchema = z.object({
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
}).passthrough();

export const UserAgentsResponseSchema = PaginationSchema.extend({
  data: z.array(UserAgentItemSchema)
}).passthrough();
export type UserAgentsResponse = z.infer<typeof UserAgentsResponseSchema>;
