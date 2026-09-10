/**
 * Row types and closed value sets mirroring migrations/001-import-schema.sql.
 *
 * SQLite has no booleans: every `*_flag`-style column is exposed as 0 | 1.
 */

export type SqliteBoolean = 0 | 1;

export const SOURCE_TYPES = ['daily_dump', 'heartbeat_dump', 'api_summaries', 'api_heartbeats'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const IMPORT_STATUSES = ['running', 'completed', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/**
 * The two non-additive views of the same time. Account-scope rows are day-level
 * rollups; project-scope rows are nested inside one project. Summing across
 * scopes double-counts, so every query takes this as a required predicate.
 */
export const DIMENSION_SCOPES = ['account', 'project'] as const;
export type DimensionScope = (typeof DIMENSION_SCOPES)[number];

export const DIMENSIONS = [
  'project',
  'category',
  'dependency',
  'editor',
  'entity',
  'language',
  'machine',
  'operating_system',
  'branch'
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const ENTITY_TYPES = ['file', 'app', 'domain'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Slice entity types add the synthetic residual bucket. */
export const SLICE_ENTITY_TYPES = [...ENTITY_TYPES, 'unattributed'] as const;
export type SliceEntityType = (typeof SLICE_ENTITY_TYPES)[number];

/** Name of the pseudo-project and pseudo-entity carrying each day's residual. */
export const UNATTRIBUTED = '__unattributed__';

export interface SourceImportRow {
  id: number;
  source_type: SourceType;
  source_hash: string;
  byte_size: number;
  range_start_date: string | null;
  range_end_date: string | null;
  started_at: string;
  finished_at: string | null;
  status: ImportStatus;
  dry_run: SqliteBoolean;
  day_count: number;
  record_count: number;
  duplicate_count: number;
  conflict_count: number;
  warnings_json: string | null;
  error_summary: string | null;
}

export interface SourcePayloadRow {
  id: number;
  source_import_id: number;
  endpoint: string;
  covered_date: string;
  payload_hash: string;
  payload_json: string;
  first_seen_at: string;
  last_seen_at: string;
}

export interface AccountSettingsRow {
  wakatime_user_id: string;
  timezone: string;
  weekday_start: number;
  keystroke_timeout_seconds: number;
  writes_only: SqliteBoolean;
  plan: string;
  has_premium_features: SqliteBoolean;
  source_import_id: number | null;
  updated_at: string;
}

export interface ProjectRow {
  id: number;
  name: string;
  is_unattributed: SqliteBoolean;
  first_activity_date: string | null;
  last_activity_date: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface DailyTotalRow {
  date: string;
  timezone: string;
  total_seconds: number;
  human_additions: number;
  human_deletions: number;
  ai_additions: number;
  ai_deletions: number;
  ai_sessions: number;
  ai_input_tokens: number;
  ai_cached_input_tokens: number;
  ai_output_tokens: number;
  ai_prompt_length_sum: number;
  ai_model_total_cost: number;
  ai_model_data_json: string | null;
  grand_total_json: string;
  project_sum_seconds: number;
  project_sum_delta: number;
  source_import_id: number;
  source_hash: string;
  reconciled_at: string;
}

export interface DailyDimensionTotalRow {
  id: number;
  date: string;
  scope: DimensionScope;
  project_id: number | null;
  project_key: number;
  dimension: Dimension;
  name: string;
  entity_type: EntityType | null;
  machine_name_id: string | null;
  project_root_count: number | null;
  total_seconds: number;
  percent: number | null;
  human_additions: number;
  human_deletions: number;
  ai_additions: number;
  ai_deletions: number;
  ai_sessions: number;
  raw_json: string | null;
  source_import_id: number;
}

export const SLICE_KINDS = ['entity', 'project_summary', 'unattributed_residual'] as const;
export type SliceKind = (typeof SLICE_KINDS)[number];

export interface DayProjectEntitySliceRow {
  id: number;
  date: string;
  project_id: number;
  entity: string;
  entity_type: SliceEntityType;
  total_seconds: number;
  percent: number | null;
  project_root_count: number | null;
  human_additions: number;
  human_deletions: number;
  ai_additions: number;
  ai_deletions: number;
  ai_sessions: number;
  is_unattributed: SqliteBoolean;
  source_import_id: number;
  kind: SliceKind;
  snapshot_version: number;
}

/**
 * Identity selector types allowed on a slice. Language, category, branch and
 * dependency are deliberately absent: they describe code, not an identity
 * boundary, and classifying on them causes cross-cutting misclassification.
 */
export const SLICE_SELECTOR_TYPES = [
  'machine',
  'editor',
  'application',
  'domain',
  'project',
  'folder_prefix',
  'entity'
] as const;
export type SliceSelectorType = (typeof SLICE_SELECTOR_TYPES)[number];

export const SLICE_IDENTITY_SOURCES = ['slice', 'heartbeat'] as const;
export type SliceIdentitySource = (typeof SLICE_IDENTITY_SOURCES)[number];

export interface SliceIdentityRow {
  id: number;
  slice_id: number;
  selector_type: SliceSelectorType;
  value: string;
  source: SliceIdentitySource;
  observed_heartbeats: number;
}

export interface HeartbeatRow {
  id: number;
  external_id: string;
  occurred_at_us: number;
  occurred_at: string;
  local_date: string;
  entity: string;
  entity_type: EntityType;
  category: string;
  project_id: number | null;
  project_name: string | null;
  branch: string | null;
  language: string | null;
  project_root_count: number | null;
  machine_name_id: string | null;
  user_agent_id: string;
  lines: number | null;
  lineno: number | null;
  cursorpos: number | null;
  is_write: SqliteBoolean;
  ai_session: string | null;
  ai_subscription_plan: string | null;
  ai_line_changes: number | null;
  human_line_changes: number | null;
  ai_input_tokens: number;
  ai_cached_input_tokens: number;
  ai_output_tokens: number;
  ai_prompt_length: number;
  canonical_hash: string;
  occurrence_count: number;
  source_import_id: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface HeartbeatDependencyRow {
  id: number;
  heartbeat_id: number;
  name: string;
  position: number;
}

export const VARIANT_CONFLICT_STATES = ['canonical', 'conflict'] as const;
export type VariantConflictState = (typeof VARIANT_CONFLICT_STATES)[number];

export interface HeartbeatVariantRow {
  id: number;
  external_id: string;
  canonical_hash: string;
  raw_json: string;
  occurrence_count: number;
  conflict_state: VariantConflictState;
  source_import_id: number;
  first_seen_at: string;
  last_seen_at: string;
}

export const ALLOCATION_STATES = ['active', 'detached'] as const;
export type AllocationState = (typeof ALLOCATION_STATES)[number];

export interface DailyTimeAllocationRow {
  id: string;
  date: string;
  project_id: number;
  entity: string;
  classification: 'work' | 'personal';
  allocated_seconds: number;
  timesheet_code: string | null;
  note: string | null;
  state: AllocationState;
  detached_at: string | null;
  reattached_at: string | null;
  created_at: string;
  updated_at: string;
}

export const CLASSIFICATION_MUTATION_TYPES = [
  'rule_created',
  'rule_updated',
  'rule_deleted',
  'allocation_created',
  'allocation_deleted',
  'reconciliation_adjusted',
  'allocation_detached',
  'allocation_reattached'
] as const;
export type ClassificationMutationType = (typeof CLASSIFICATION_MUTATION_TYPES)[number];

export interface ClassificationRevisionRow {
  id: number;
  mutation_type: ClassificationMutationType;
  target_type: 'rule' | 'allocation';
  target_id: string;
  before_json: string | null;
  after_json: string | null;
  affected_json: string | null;
  actor: string;
  created_at: string;
}

export interface HeartbeatMembershipRow {
  date: string;
  heartbeat_id: number;
  active: SqliteBoolean;
}

export const SYNC_RUN_MODES = ['recent', 'backfill', 'compare', 'retry', 'registry'] as const;
export type SyncRunMode = (typeof SYNC_RUN_MODES)[number];

export const SYNC_RUN_TRIGGERS = ['manual', 'scheduled', 'startup', 'catchup'] as const;
export type SyncRunTrigger = (typeof SYNC_RUN_TRIGGERS)[number];

export const SYNC_RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'interrupted'
] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

export interface SyncRunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  trigger: SyncRunTrigger;
  mode: SyncRunMode;
  status: SyncRunStatus;
  range_start_date: string | null;
  range_end_date: string | null;
  day_count: number;
  days_synced: number;
  days_failed: number;
  degraded_capabilities: string | null;
  advisory_codes: string | null;
  summary: string | null;
  error_message: string | null;
  policy_state_json: string | null;
  idempotency_key: string | null;
  payload_hash: string | null;
  resumed_from_run_id: number | null;
  cancel_requested_at: string | null;
}

export const SYNC_DAY_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'partial',
  'failed',
  'skipped',
  'cancelled',
  'interrupted'
] as const;
export type SyncDayStatus = (typeof SYNC_DAY_STATUSES)[number];

export const RECONCILE_DISPOSITIONS = ['updated', 'unchanged', 'preserved', 'rejected'] as const;
export type ReconcileDisposition = (typeof RECONCILE_DISPOSITIONS)[number];

export const SYNC_LAYER_STATUSES = ['succeeded', 'failed', 'restricted', 'skipped'] as const;
export type SyncLayerStatus = (typeof SYNC_LAYER_STATUSES)[number];

export interface SyncDayRow {
  id: number;
  sync_run_id: number;
  date: string;
  status: SyncDayStatus;
  disposition: ReconcileDisposition | null;
  summaries_status: SyncLayerStatus | null;
  durations_status: SyncLayerStatus | null;
  heartbeats_status: SyncLayerStatus | null;
  source_import_id: number | null;
  total_seconds: number;
  heartbeat_count: number;
  advisory_codes_json: string | null;
  error_message: string | null;
  synced_at: string;
}

export const SYNC_LAYERS = ['summaries', 'durations', 'heartbeats'] as const;
export type SyncLayer = (typeof SYNC_LAYERS)[number];

export const SUMMARY_FIDELITIES = ['entity_detail', 'coarse_project', 'verified_zero'] as const;
export type SummaryFidelity = (typeof SUMMARY_FIDELITIES)[number];

export interface SyncLayerStateRow {
  date: string;
  layer: SyncLayer;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_accepted_change_at: string | null;
  accepted_source_reference: string | null;
  accepted_snapshot_version: number;
  accepted_fidelity: SummaryFidelity | null;
  accepted_content_hash: string | null;
  verified_timezone: string | null;
  evidence_matches_summary: SqliteBoolean | null;
  status_code: string | null;
  next_retry_at: string | null;
  is_stale: SqliteBoolean;
  unresolved_mismatch: SqliteBoolean;
  has_detail_downgrade: SqliteBoolean;
  has_restriction: SqliteBoolean;
  has_failure: SqliteBoolean;
  updated_at: string;
}

export interface UserAgentRegistryRow {
  id: string;
  editor: string;
  user_agent_value: string;
  os: string;
  version: string | null;
  ai_model: string | null;
  ai_model_version: string | null;
  ai_model_complexity: string | null;
  is_browser_extension: SqliteBoolean;
  is_desktop_app: SqliteBoolean;
  first_seen_at: string | null;
  last_seen_at: string | null;
  is_historical: SqliteBoolean;
  refreshed_at: string;
}

export interface WakaTimeOAuthConnectionRow {
  id: 1;
  access_token_sealed: string;
  refresh_token_sealed: string;
  token_type: string;
  scopes: string;
  expires_at: string | null;
  connected_at: string;
  updated_at: string;
  generation: number;
  bound_archive_identity: string | null;
  rebound_at: string | null;
}
