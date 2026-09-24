import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { redactPath } from './canonical.js';
import { ENTITY_TYPES, HEARTBEAT_ENTITY_TYPES, type EntityType, type HeartbeatEntityType } from '../db/schema.js';

/**
 * Default ceiling for reading a dump into memory with `JSON.parse`.
 *
 * 96 MiB, matching `MAX_DIRECT_IMPORT_BYTES`. The observed dumps are ~24 MB and
 * ~67 MB, so both fit; the guard exists so a larger future export fails with a
 * clear message instead of an out-of-memory crash mid-transaction.
 */
export const MAX_DIRECT_PARSE_BYTES = 96 * 1024 * 1024;

export class DumpTooLargeError extends Error {
  constructor(
    readonly byteSize: number,
    readonly limitBytes: number,
    path: string
  ) {
    super(
      `Dump ${redactPath(path)} is ${byteSize} bytes, above the ${limitBytes}-byte direct-parse limit. ` +
        `Raise MAX_DIRECT_IMPORT_BYTES only if the host has memory to spare.`
    );
    this.name = 'DumpTooLargeError';
  }
}

export class DumpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DumpValidationError';
  }
}

export interface ParsedFile {
  data: unknown;
  byteSize: number;
  /** SHA-256 of the exact bytes read, for source lineage and re-import detection. */
  sourceHash: string;
}

/**
 * Read, size-guard, hash and parse a dump file.
 *
 * The size check runs against the on-disk stat before any read, so an oversized
 * file is rejected without ever being buffered.
 */
export async function parseDumpFile(path: string, limitBytes = MAX_DIRECT_PARSE_BYTES): Promise<ParsedFile> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new DumpValidationError(`${redactPath(path)} is not a regular file`);
  }
  if (info.size > limitBytes) {
    throw new DumpTooLargeError(info.size, limitBytes, path);
  }

  const bytes = await readFile(path);
  const sourceHash = createHash('sha256').update(bytes).digest('hex');

  let data: unknown;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DumpValidationError(`${redactPath(path)} is not valid JSON: ${reason}`);
  }

  return { data, byteSize: info.size, sourceHash };
}

/** SHA-256 of a file streamed in chunks, without buffering it whole. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface DumpEnvelope {
  user: DumpUser;
  range: { start: number; end: number };
  days: readonly unknown[];
}

/**
 * Account settings we are permitted to persist. Every other `user` field —
 * email, names, photo, profile URLs, social handles — is PII and is
 * deliberately not modelled so it cannot be stored by accident.
 */
export interface DumpUser {
  id: string;
  timezone: string | null;
  timeout: number | null;
  weekday_start: number | null;
  writes_only: boolean;
  plan: string;
  has_premium_features: boolean;
}

export function validateEnvelope(data: unknown, label: string): DumpEnvelope {
  const root = requireObject(data, `${label} dump root`);
  const user = requireObject(root.user, `${label} dump 'user'`);
  const range = requireObject(root.range, `${label} dump 'range'`);

  if (!Array.isArray(root.days)) {
    throw new DumpValidationError(`${label} dump 'days' must be an array`);
  }

  const id = user.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new DumpValidationError(`${label} dump 'user.id' must be a non-empty string`);
  }

  const start = range.start;
  const end = range.end;
  if (typeof start !== 'number' || typeof end !== 'number') {
    throw new DumpValidationError(`${label} dump 'range.start'/'range.end' must be numbers`);
  }
  if (end < start) {
    throw new DumpValidationError(`${label} dump range ends before it starts`);
  }

  return {
    user: {
      id,
      timezone: optionalString(user.timezone, `${label} 'user.timezone'`),
      timeout: optionalInteger(user.timeout, `${label} 'user.timeout'`),
      weekday_start: optionalInteger(user.weekday_start, `${label} 'user.weekday_start'`),
      writes_only: user.writes_only === true,
      plan: optionalString(user.plan, `${label} 'user.plan'`) ?? '',
      has_premium_features: user.has_premium_features === true
    },
    range: { start, end },
    days: root.days
  };
}

// ---------------------------------------------------------------------------
// Daily dump
// ---------------------------------------------------------------------------

export interface GrandTotal {
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
  raw: Record<string, unknown>;
}

export interface BreakdownItem {
  name: string;
  total_seconds: number;
  percent: number | null;
  machine_name_id: string | null;
  entity_type: EntityType | null;
  project_root_count: number | null;
  human_additions: number;
  human_deletions: number;
  ai_additions: number;
  ai_deletions: number;
  ai_sessions: number;
  raw: Record<string, unknown>;
}

export interface DailyProject {
  name: string;
  grandTotal: GrandTotal;
  percent: number | null;
  branches: BreakdownItem[];
  categories: BreakdownItem[];
  dependencies: BreakdownItem[];
  editors: BreakdownItem[];
  entities: BreakdownItem[];
  languages: BreakdownItem[];
  machines: BreakdownItem[];
  operating_systems: BreakdownItem[];
}

export interface DailyDay {
  date: string;
  grandTotal: GrandTotal;
  categories: BreakdownItem[];
  dependencies: BreakdownItem[];
  editors: BreakdownItem[];
  languages: BreakdownItem[];
  machines: BreakdownItem[];
  operating_systems: BreakdownItem[];
  projects: DailyProject[];
  raw: Record<string, unknown>;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function validateDailyDay(value: unknown, index: number): DailyDay {
  const day = requireObject(value, `daily day #${index}`);
  const date = requireDate(day.date, `daily day #${index}`);
  const where = `daily day ${date}`;

  return {
    date,
    grandTotal: requireGrandTotal(day.grand_total, where),
    categories: breakdownArray(day.categories, `${where} categories`),
    dependencies: breakdownArray(day.dependencies, `${where} dependencies`),
    editors: breakdownArray(day.editors, `${where} editors`),
    languages: breakdownArray(day.languages, `${where} languages`),
    machines: breakdownArray(day.machines, `${where} machines`),
    operating_systems: breakdownArray(day.operating_systems, `${where} operating_systems`),
    projects: asArray(day.projects).map((project, i) => validateDailyProject(project, `${where} project #${i}`)),
    raw: day
  };
}

function validateDailyProject(value: unknown, where: string): DailyProject {
  const project = requireObject(value, where);
  const name = project.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new DumpValidationError(`${where} has a missing or empty 'name'`);
  }

  const grandTotalRaw = requireObject(project.grand_total, `${where} grand_total`);

  return {
    name,
    grandTotal: requireGrandTotal(grandTotalRaw, `${where} grand_total`),
    percent: optionalNumber(grandTotalRaw.percent, `${where} grand_total.percent`),
    branches: breakdownArray(project.branches, `${where} branches`),
    categories: breakdownArray(project.categories, `${where} categories`),
    dependencies: breakdownArray(project.dependencies, `${where} dependencies`),
    editors: breakdownArray(project.editors, `${where} editors`),
    entities: breakdownArray(project.entities, `${where} entities`),
    languages: breakdownArray(project.languages, `${where} languages`),
    machines: breakdownArray(project.machines, `${where} machines`),
    operating_systems: breakdownArray(project.operating_systems, `${where} operating_systems`)
  };
}

function requireGrandTotal(value: unknown, where: string): GrandTotal {
  const total = requireObject(value, where);
  return {
    total_seconds: requireNumber(total.total_seconds, `${where}.total_seconds`),
    human_additions: countOf(total.human_additions),
    human_deletions: countOf(total.human_deletions),
    ai_additions: countOf(total.ai_additions),
    ai_deletions: countOf(total.ai_deletions),
    ai_sessions: countOf(total.ai_sessions),
    ai_input_tokens: countOf(total.ai_input_tokens),
    ai_cached_input_tokens: countOf(total.ai_cached_input_tokens),
    ai_output_tokens: countOf(total.ai_output_tokens),
    ai_prompt_length_sum: countOf(total.ai_prompt_length_sum),
    ai_model_total_cost: optionalNumber(total.ai_model_total_cost, `${where}.ai_model_total_cost`) ?? 0,
    raw: total
  };
}

function breakdownArray(value: unknown, where: string): BreakdownItem[] {
  return asArray(value).map((item, i) => validateBreakdownItem(item, `${where}[${i}]`));
}

function validateBreakdownItem(value: unknown, where: string): BreakdownItem {
  const item = requireObject(value, where);
  const name = item.name;
  if (typeof name !== 'string') {
    throw new DumpValidationError(`${where} has a non-string 'name'`);
  }

  const entityType = item.type;
  if (entityType !== undefined && entityType !== null && !isEntityType(entityType)) {
    throw new DumpValidationError(`${where} has an unknown entity type`);
  }

  return {
    name,
    total_seconds: requireNumber(item.total_seconds, `${where}.total_seconds`),
    percent: optionalNumber(item.percent, `${where}.percent`),
    machine_name_id: optionalString(item.machine_name_id, `${where}.machine_name_id`),
    entity_type: isEntityType(entityType) ? entityType : null,
    project_root_count: optionalInteger(item.project_root_count, `${where}.project_root_count`),
    human_additions: countOf(item.human_additions),
    human_deletions: countOf(item.human_deletions),
    ai_additions: countOf(item.ai_additions),
    ai_deletions: countOf(item.ai_deletions),
    ai_sessions: countOf(item.ai_sessions),
    raw: item
  };
}

// ---------------------------------------------------------------------------
// Heartbeat dump
// ---------------------------------------------------------------------------

export interface RawHeartbeat {
  id: string;
  entity: string;
  type: HeartbeatEntityType;
  category: string;
  project: string | null;
  branch: string | null;
  language: string | null;
  dependencies: readonly unknown[];
  lines: number | null;
  lineno: number | null;
  cursorpos: number | null;
  is_write: boolean;
  time: number;
  machine_name_id: string | null;
  user_agent_id: string;
  project_root_count: number | null;
  ai_session: string | null;
  ai_subscription_plan: string | null;
  ai_line_changes: number | null;
  human_line_changes: number | null;
  ai_input_tokens: number;
  ai_cached_input_tokens: number;
  ai_output_tokens: number;
  ai_prompt_length: number;
  raw: Record<string, unknown>;
}

export interface HeartbeatDay {
  date: string;
  heartbeats: readonly unknown[];
  raw: Record<string, unknown>;
}

export function validateHeartbeatDay(value: unknown, index: number): HeartbeatDay {
  const day = requireObject(value, `heartbeat day #${index}`);
  const date = requireDate(day.date, `heartbeat day #${index}`);

  if (day.heartbeats !== undefined && day.heartbeats !== null && !Array.isArray(day.heartbeats)) {
    throw new DumpValidationError(`heartbeat day ${date} has a non-array 'heartbeats'`);
  }

  return { date, heartbeats: asArray(day.heartbeats), raw: day };
}

/**
 * Validate one heartbeat.
 *
 * Nullability follows DUMP-DATA-CONTRACT §5.1: documented-nullable fields
 * accept null, but a wrong non-null type is rejected rather than coerced —
 * silently coercing would let a schema change through unnoticed.
 */
export function validateHeartbeat(value: unknown, date: string, index: number): RawHeartbeat {
  const where = `heartbeat ${date}#${index}`;
  const beat = requireObject(value, where);

  const id = beat.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new DumpValidationError(`${where} has a missing or empty 'id'`);
  }

  const type = beat.type;
  if (!isHeartbeatEntityType(type)) {
    throw new DumpValidationError(`${where} has an unknown 'type'`);
  }

  const entity = beat.entity;
  if (typeof entity !== 'string' || entity.length === 0) {
    throw new DumpValidationError(`${where} has a missing or empty 'entity'`);
  }

  const category = beat.category;
  if (typeof category !== 'string' || category.length === 0) {
    throw new DumpValidationError(`${where} has a missing or empty 'category'`);
  }

  const userAgentId = beat.user_agent_id;
  if (typeof userAgentId !== 'string' || userAgentId.length === 0) {
    throw new DumpValidationError(`${where} has a missing or empty 'user_agent_id'`);
  }

  if (beat.dependencies !== undefined && beat.dependencies !== null && !Array.isArray(beat.dependencies)) {
    throw new DumpValidationError(`${where} has a non-array 'dependencies'`);
  }

  if (typeof beat.is_write !== 'boolean' && beat.is_write !== null && beat.is_write !== undefined) {
    throw new DumpValidationError(`${where} has a non-boolean 'is_write'`);
  }

  return {
    id,
    entity,
    type,
    category,
    project: optionalString(beat.project, `${where}.project`),
    branch: optionalString(beat.branch, `${where}.branch`),
    language: optionalString(beat.language, `${where}.language`),
    dependencies: asArray(beat.dependencies),
    lines: optionalInteger(beat.lines, `${where}.lines`),
    lineno: optionalInteger(beat.lineno, `${where}.lineno`),
    cursorpos: optionalInteger(beat.cursorpos, `${where}.cursorpos`),
    is_write: beat.is_write === true,
    time: requireNumber(beat.time, `${where}.time`),
    machine_name_id: optionalString(beat.machine_name_id, `${where}.machine_name_id`),
    user_agent_id: userAgentId,
    project_root_count: optionalInteger(beat.project_root_count, `${where}.project_root_count`),
    ai_session: optionalString(beat.ai_session, `${where}.ai_session`),
    ai_subscription_plan: optionalString(beat.ai_subscription_plan, `${where}.ai_subscription_plan`),
    ai_line_changes: optionalInteger(beat.ai_line_changes, `${where}.ai_line_changes`),
    human_line_changes: optionalInteger(beat.human_line_changes, `${where}.human_line_changes`),
    ai_input_tokens: countOf(beat.ai_input_tokens),
    ai_cached_input_tokens: countOf(beat.ai_cached_input_tokens),
    ai_output_tokens: countOf(beat.ai_output_tokens),
    ai_prompt_length: countOf(beat.ai_prompt_length),
    raw: beat
  };
}

// ---------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------

function isEntityType(value: unknown): value is EntityType {
  return typeof value === 'string' && (ENTITY_TYPES as readonly string[]).includes(value);
}

function isHeartbeatEntityType(value: unknown): value is HeartbeatEntityType {
  return typeof value === 'string' && (HEARTBEAT_ENTITY_TYPES as readonly string[]).includes(value);
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DumpValidationError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireDate(value: unknown, where: string): string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new DumpValidationError(`${where} has a missing or malformed 'date' (expected YYYY-MM-DD)`);
  }
  return value;
}

function requireNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DumpValidationError(`${where} must be a finite number`);
  }
  return value;
}

function optionalNumber(value: unknown, where: string): number | null {
  if (value === null || value === undefined) return null;
  return requireNumber(value, where);
}

function optionalInteger(value: unknown, where: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DumpValidationError(`${where} must be an integer or null`);
  }
  return value;
}

function optionalString(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new DumpValidationError(`${where} must be a string or null`);
  }
  return value;
}

/** Non-negative counter that the export leaves absent or null on quiet days. */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
