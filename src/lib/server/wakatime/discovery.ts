import {
  WakaTimeClient
} from "./client.js";
import {
  type CurrentUserResponse,
  type SummariesResponse,
  type DurationsResponse,
  type HeartbeatsResponse,
  type DumpListResponse
} from "./schemas.js";
import {
  WakaTimeAuthError,
  CapabilityRestrictedError,
  WakaTimeError,
  sanitizeEndpoint
} from "./errors.js";
import { getYesterdayDate, type SyncCapability, type CapabilityStatus } from "../sync/capabilities.js";
import { getRuntimeConfig } from "../config.js";

/** Maximum number of dump items included in discovery output. */
export const MAX_DUMP_ITEMS = 10;
/** Maximum number of categories/types/statuses included in aggregate lists. */
export const MAX_CATEGORIES = 10;
/** Maximum number of schema field names recorded per endpoint. */
export const MAX_FIELD_NAMES = 30;
/** Maximum number of error items recorded. */
export const MAX_ERRORS = 10;
/** Maximum string length for sanitized fields. */
export const MAX_STRING_LENGTH = 120;

export const KNOWN_DUMP_TYPES = ["daily", "heartbeats"] as const;
export type KnownDumpType = (typeof KNOWN_DUMP_TYPES)[number] | "unknown";

export const KNOWN_DUMP_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed"
] as const;
export type KnownDumpStatus = (typeof KNOWN_DUMP_STATUSES)[number] | "unknown";

export interface PlanFeatures {
  hasBasicFeatures?: boolean;
  hasPremiumFeatures?: boolean;
  writesOnly?: boolean;
}

export interface DiscoveredCapability {
  status: CapabilityStatus;
  restrictionCode?: string;
}

export interface DiscoveredDumpItem {
  type: KnownDumpType;
  status: KnownDumpStatus;
}

export interface DiscoveredDumps {
  count: number;
  truncated: boolean;
  types: KnownDumpType[];
  statuses: KnownDumpStatus[];
  items: DiscoveredDumpItem[];
}

export interface DiscoveredError {
  endpoint: string;
  status?: number;
  errorName: string;
}

export interface DiscoveryResult {
  ok: boolean;
  probeDate: string;
  credentialStatus: "accepted" | "rejected" | "missing" | "unverified";
  planFeatures: PlanFeatures;
  capabilities: Record<SyncCapability, DiscoveredCapability>;
  dumps: DiscoveredDumps;
  responseFields: Record<string, string[]>;
  errors: DiscoveredError[];
}

export interface DiscoveryOptions {
  apiKey?: string | null;
  baseUrl?: string;
  probeDate?: string;
  now?: Date;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  client?: WakaTimeClient;
}

/**
 * Explicit allowlists of recognized WakaTime API schema field names.
 * Property keys not listed here are strictly excluded to prevent echoing
 * unexpected keys containing PII, tokens, or arbitrary payload names.
 */
export const RECOGNIZED_RESPONSE_FIELDS: Record<string, readonly string[]> = {
  currentUser: ["data", "message", "error"],
  currentUserData: [
    "bio",
    "city",
    "country_code",
    "created_at",
    "date_format",
    "default_dashboard_range",
    "display_name",
    "durations_slice_by",
    "email",
    "full_name",
    "has_basic_features",
    "has_premium_features",
    "human_readable_website",
    "id",
    "invoice_id_format",
    "is_email_confirmed",
    "is_email_public",
    "is_hireable",
    "languages_used_public",
    "last_heartbeat_at",
    "last_plugin",
    "last_plugin_name",
    "last_project",
    "location",
    "logged_time_public",
    "modified_at",
    "needs_payment_method",
    "photo",
    "photo_public",
    "plan",
    "profile_url",
    "profile_url_escaped",
    "public_email",
    "share_all_time_badge",
    "share_last_year_days",
    "time_format",
    "timezone",
    "timeout",
    "username",
    "website",
    "weekday_start",
    "writes_only"
  ],
  summaries: [
    "branches",
    "categories",
    "cumulative_total",
    "daily_average",
    "data",
    "dependencies",
    "editors",
    "end",
    "languages",
    "machines",
    "operating_systems",
    "projects",
    "range",
    "start"
  ],
  durations: [
    "branches",
    "data",
    "end",
    "start",
    "timezone"
  ],
  heartbeats: [
    "data",
    "end",
    "start",
    "timezone"
  ],
  dumps: [
    "data",
    "page",
    "total",
    "total_pages"
  ]
} as const;

export function boundedString(val: unknown, maxLength = MAX_STRING_LENGTH): string {
  if (typeof val !== "string") {
    return "";
  }
  return val.slice(0, maxLength);
}

export class InvalidCalendarDateError extends Error {
  constructor(message = "Invalid calendar date") {
    super(message);
    this.name = "InvalidCalendarDateError";
  }
}

export function sanitizeErrorName(err: unknown): string {
  if (!err) return "UnknownError";
  if (err instanceof CapabilityRestrictedError) return "CapabilityRestrictedError";
  if (err instanceof WakaTimeAuthError) return "WakaTimeAuthError";
  if (err instanceof WakaTimeError) {
    const safeWakaTimeErrorNames = new Set([
      "WakaTimeError",
      "WakaTimeNetworkError",
      "WakaTimeParseError",
      "WakaTimeApiError",
      "WakaTimeServerError",
      "WakaTimeThrottleError"
    ]);
    return safeWakaTimeErrorNames.has(err.name) ? err.name : "WakaTimeError";
  }
  if (err instanceof Error) {
    const name = err.name;
    if (typeof name === "string" && /^[A-Za-z0-9_$]{1,50}$/.test(name)) {
      return name;
    }
    return "Error";
  }
  return "UnknownError";
}

export function safeDumpType(raw: unknown): KnownDumpType {
  if (typeof raw === "string") {
    const norm = raw.trim().toLowerCase();
    if ((KNOWN_DUMP_TYPES as readonly string[]).includes(norm)) {
      return norm as KnownDumpType;
    }
  }
  return "unknown";
}

export function safeDumpStatus(raw: unknown): KnownDumpStatus {
  if (typeof raw === "string") {
    const norm = raw.trim().toLowerCase();
    if ((KNOWN_DUMP_STATUSES as readonly string[]).includes(norm)) {
      return norm as KnownDumpStatus;
    }
  }
  return "unknown";
}

export function extractRecognizedFields(
  target: unknown,
  endpointName: string
): string[] {
  if (!target || typeof target !== "object") {
    return [];
  }
  const allowlist = RECOGNIZED_RESPONSE_FIELDS[endpointName];
  if (!allowlist) {
    return [];
  }
  const allowedSet = new Set(allowlist);
  return Object.keys(target)
    .filter((k) => allowedSet.has(k))
    .slice(0, MAX_FIELD_NAMES)
    .sort();
}

/**
 * Strictly validate that a date string is a real, valid UTC calendar date.
 * Enforces YYYY-MM-DD format and verifies leap years, days-in-month, and year/month/day bounds.
 */
export function isValidCalendarDate(dateStr: string): boolean {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }
  const parts = dateStr.split("-");
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);

  if (month < 1 || month > 12) {
    return false;
  }
  if (day < 1 || day > 31) {
    return false;
  }

  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

function pushSafeError(
  errors: DiscoveredError[],
  endpoint: string,
  status: number | undefined,
  err: unknown
): void {
  if (errors.length >= MAX_ERRORS) {
    return;
  }
  errors.push({
    endpoint: boundedString(sanitizeEndpoint(endpoint), MAX_STRING_LENGTH),
    status,
    errorName: boundedString(sanitizeErrorName(err), MAX_STRING_LENGTH)
  });
}

/**
 * Validate that CLI arguments do not attempt to pass an API key.
 * Strictly rejects flags like --api-key, -k, --key, or flags containing "apikey" / "api_key".
 * Also strictly validates that --probe-date is a real UTC calendar date.
 */
export function validateDiscoveryArgs(argv: readonly string[]): {
  json: boolean;
  probeDate?: string;
  help: boolean;
} {
  let json = false;
  let probeDate: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const lower = arg.toLowerCase();

    // Explicit rejection of any API key style arguments
    if (
      lower === "-k" ||
      lower.startsWith("-k=") ||
      lower === "--key" ||
      lower.startsWith("--key=") ||
      lower === "--api-key" ||
      lower.startsWith("--api-key=") ||
      lower === "--apikey" ||
      lower.startsWith("--apikey=") ||
      lower.includes("api_key") ||
      lower.includes("apikey")
    ) {
      throw new Error(
        "Passing API keys via CLI arguments is strictly forbidden. Configure WAKATIME_API_KEY in .env or WAKATIME_API_KEY_FILE instead."
      );
    }

    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--probe-date" || arg === "--probeDate") {
      const next = argv[++i];
      if (!next || !isValidCalendarDate(next)) {
        throw new Error(
          "Expected --probe-date YYYY-MM-DD (must be a valid UTC calendar date)"
        );
      }
      probeDate = next;
    } else if (arg.startsWith("--probe-date=")) {
      const val = arg.slice("--probe-date=".length);
      if (!isValidCalendarDate(val)) {
        throw new Error(
          "Expected --probe-date=YYYY-MM-DD (must be a valid UTC calendar date)"
        );
      }
      probeDate = val;
    } else if (arg.startsWith("--probeDate=")) {
      const val = arg.slice("--probeDate=".length);
      if (!isValidCalendarDate(val)) {
        throw new Error(
          "Expected --probeDate=YYYY-MM-DD (must be a valid UTC calendar date)"
        );
      }
      probeDate = val;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { json, probeDate, help };
}

/**
 * Perform safe, opt-in discovery of WakaTime account credentials and capabilities.
 *
 * Invariants:
 * - With no key configured: makes zero network calls and returns credentialStatus: "missing".
 * - Never modifies upstream state: does not create dumps.
 * - Single currentUser check avoids duplicate verification calls.
 * - Soft-degraded optional capabilities (402/403) do not fail the discovery when summaries succeed.
 * - Absolutely zero PII, entity paths, download URLs, or raw bodies in output.
 * - Output is strictly bounded: dumps capped to MAX_DUMP_ITEMS with truncation indicator.
 * - Types and statuses mapped to known safe enums or "unknown".
 * - Response fields filtered against explicit schema allowlist.
 */
export async function runWakaTimeDiscovery(
  options: DiscoveryOptions
): Promise<DiscoveryResult> {
  const now = options.now ?? new Date();

  const result: DiscoveryResult = {
    ok: false,
    probeDate: "",
    credentialStatus: "missing",
    planFeatures: {},
    capabilities: {
      summaries: { status: "untested" },
      durations: { status: "untested" },
      heartbeats: { status: "untested" }
    },
    dumps: {
      count: 0,
      truncated: false,
      types: [],
      statuses: [],
      items: []
    },
    responseFields: {},
    errors: []
  };

  let probeDate: string;
  if (options.probeDate !== undefined) {
    if (!isValidCalendarDate(options.probeDate)) {
      result.probeDate = boundedString(options.probeDate, 10);
      result.ok = false;
      pushSafeError(result.errors, "probeDate", undefined, new InvalidCalendarDateError());
      return result;
    }
    probeDate = options.probeDate;
  } else {
    probeDate = getYesterdayDate(now);
  }
  result.probeDate = probeDate;

  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    // Zero network calls when API key is missing
    return result;
  }

  // A key was supplied, but it is not accepted or rejected until the current-user
  // request completes. Network and response-validation failures must not be
  // misreported as a missing credential.
  result.credentialStatus = "unverified";

  const client =
    options.client ??
    new WakaTimeClient({
      apiKey,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      sleep: options.sleep,
      maxThrottleRetries: 2,
      maxRetries5xx: 2
    });

  // 1. Verify credentials and inspect user metadata (single call)
  try {
    const userRes: CurrentUserResponse = await client.getCurrentUser();
    result.credentialStatus = "accepted";
    result.responseFields.currentUser = extractRecognizedFields(userRes, "currentUser");

    if (userRes.data && typeof userRes.data === "object") {
      const data = userRes.data as Record<string, unknown>;
      result.responseFields.currentUserData = extractRecognizedFields(
        data,
        "currentUserData"
      );

      if (typeof data.has_basic_features === "boolean") {
        result.planFeatures.hasBasicFeatures = data.has_basic_features;
      } else if (typeof data.hasBasicFeatures === "boolean") {
        result.planFeatures.hasBasicFeatures = data.hasBasicFeatures;
      }

      if (typeof data.has_premium_features === "boolean") {
        result.planFeatures.hasPremiumFeatures = data.has_premium_features;
      } else if (typeof data.hasPremiumFeatures === "boolean") {
        result.planFeatures.hasPremiumFeatures = data.hasPremiumFeatures;
      }

      if (typeof data.writes_only === "boolean") {
        result.planFeatures.writesOnly = data.writes_only;
      } else if (typeof data.writesOnly === "boolean") {
        result.planFeatures.writesOnly = data.writesOnly;
      }
    }
  } catch (err) {
    if (err instanceof WakaTimeAuthError) {
      result.credentialStatus = "rejected";
      pushSafeError(result.errors, "/users/current", 401, err);
      result.ok = false;
      return result;
    }

    const status = err instanceof WakaTimeError ? err.status : undefined;
    const endpoint =
      err instanceof WakaTimeError ? err.endpoint ?? "/users/current" : "/users/current";
    pushSafeError(result.errors, endpoint, status, err);
    result.ok = false;
    return result;
  }

  // 2. Probe baseline summaries
  try {
    const summariesRes: SummariesResponse = await client.getSummaries(probeDate, probeDate);
    result.capabilities.summaries = { status: "available" };
    result.responseFields.summaries = extractRecognizedFields(summariesRes, "summaries");
  } catch (err) {
    if (err instanceof CapabilityRestrictedError) {
      result.capabilities.summaries = {
        status: "restricted",
        restrictionCode: boundedString(`HTTP_${err.statusCode}`, 20)
      };
      pushSafeError(
        result.errors,
        err.endpoint ?? "/users/current/summaries",
        err.statusCode,
        err
      );
    } else {
      result.capabilities.summaries = { status: "error" };
      const status = err instanceof WakaTimeError ? err.status : undefined;
      const endpoint =
        err instanceof WakaTimeError
          ? err.endpoint ?? "/users/current/summaries"
          : "/users/current/summaries";
      pushSafeError(result.errors, endpoint, status, err);
    }
  }

  // 3. Probe durations (optional, plan-gated)
  try {
    const durationsRes: DurationsResponse = await client.getDurations(probeDate);
    result.capabilities.durations = { status: "available" };
    result.responseFields.durations = extractRecognizedFields(durationsRes, "durations");
  } catch (err) {
    if (err instanceof CapabilityRestrictedError) {
      result.capabilities.durations = {
        status: "restricted",
        restrictionCode: boundedString(`HTTP_${err.statusCode}`, 20)
      };
      pushSafeError(
        result.errors,
        err.endpoint ?? "/users/current/durations",
        err.statusCode,
        err
      );
    } else {
      result.capabilities.durations = { status: "error" };
      const status = err instanceof WakaTimeError ? err.status : undefined;
      const endpoint =
        err instanceof WakaTimeError
          ? err.endpoint ?? "/users/current/durations"
          : "/users/current/durations";
      pushSafeError(result.errors, endpoint, status, err);
    }
  }

  // 4. Probe heartbeats (optional, plan-gated)
  try {
    const heartbeatsRes: HeartbeatsResponse = await client.getHeartbeats(probeDate);
    result.capabilities.heartbeats = { status: "available" };
    result.responseFields.heartbeats = extractRecognizedFields(heartbeatsRes, "heartbeats");
  } catch (err) {
    if (err instanceof CapabilityRestrictedError) {
      result.capabilities.heartbeats = {
        status: "restricted",
        restrictionCode: boundedString(`HTTP_${err.statusCode}`, 20)
      };
      pushSafeError(
        result.errors,
        err.endpoint ?? "/users/current/heartbeats",
        err.statusCode,
        err
      );
    } else {
      result.capabilities.heartbeats = { status: "error" };
      const status = err instanceof WakaTimeError ? err.status : undefined;
      const endpoint =
        err instanceof WakaTimeError
          ? err.endpoint ?? "/users/current/heartbeats"
          : "/users/current/heartbeats";
      pushSafeError(result.errors, endpoint, status, err);
    }
  }

  // 5. List existing dumps read-only (never create a dump)
  try {
    const dumpsRes: DumpListResponse = await client.listDumps();
    result.responseFields.dumps = extractRecognizedFields(dumpsRes, "dumps");

    const rawList = Array.isArray(dumpsRes.data) ? dumpsRes.data : [];
    const totalCount = rawList.length;
    const truncated = totalCount > MAX_DUMP_ITEMS;

    const items: DiscoveredDumpItem[] = rawList
      .slice(0, MAX_DUMP_ITEMS)
      .map((d: any) => ({
        type: safeDumpType(d?.type),
        status: safeDumpStatus(d?.status)
      }));

    const typesSet = new Set<KnownDumpType>();
    const statusesSet = new Set<KnownDumpStatus>();
    for (const d of rawList) {
      typesSet.add(safeDumpType(d?.type));
      statusesSet.add(safeDumpStatus(d?.status));
    }

    result.dumps = {
      count: totalCount,
      truncated,
      types: [...typesSet].sort().slice(0, MAX_CATEGORIES),
      statuses: [...statusesSet].sort().slice(0, MAX_CATEGORIES),
      items
    };
  } catch (err) {
    const status = err instanceof WakaTimeError ? err.status : undefined;
    const endpoint =
      err instanceof WakaTimeError
        ? err.endpoint ?? "/users/current/data_dumps"
        : "/users/current/data_dumps";
    pushSafeError(result.errors, endpoint, status, err);
  }

  // Baseline evaluation:
  // Summaries is the required capability. If summaries is available and credentials are valid,
  // the discovery is successful even if durations/heartbeats are restricted (soft degradation).
  result.ok =
    result.credentialStatus === "accepted" &&
    result.capabilities.summaries.status === "available";

  return result;
}

export function formatDiscoveryText(result: DiscoveryResult): string {
  const basicStr =
    result.planFeatures.hasBasicFeatures !== undefined
      ? String(result.planFeatures.hasBasicFeatures)
      : "unknown";
  const premiumStr =
    result.planFeatures.hasPremiumFeatures !== undefined
      ? String(result.planFeatures.hasPremiumFeatures)
      : "unknown";
  const writesStr =
    result.planFeatures.writesOnly !== undefined
      ? String(result.planFeatures.writesOnly)
      : "unknown";

  const lines: string[] = [
    "=== WakaTime API Discovery ===",
    `Probe Date:        ${result.probeDate}`,
    `Credential Status: ${result.credentialStatus}`,
    `Plan Features:     hasBasicFeatures=${basicStr}, hasPremiumFeatures=${premiumStr}, writesOnly=${writesStr}`,
    "",
    "Capabilities:"
  ];

  for (const [cap, rec] of Object.entries(result.capabilities)) {
    const detail = rec.restrictionCode ? ` (${rec.restrictionCode})` : "";
    lines.push(`  - ${cap.padEnd(12)}: ${rec.status}${detail}`);
  }

  lines.push("");
  lines.push("Data Dumps:");
  const truncStr = result.dumps.truncated
    ? ` (truncated to first ${result.dumps.items.length})`
    : "";
  lines.push(`  - Total Count:   ${result.dumps.count}${truncStr}`);
  lines.push(
    `  - Types:         ${result.dumps.types.length > 0 ? result.dumps.types.join(", ") : "none"}`
  );
  lines.push(
    `  - Statuses:      ${result.dumps.statuses.length > 0 ? result.dumps.statuses.join(", ") : "none"}`
  );

  lines.push("");
  lines.push("Response Schema Fields:");
  for (const [endpoint, fields] of Object.entries(result.responseFields)) {
    lines.push(`  - ${endpoint.padEnd(16)}: [${fields.join(", ")}]`);
  }

  if (result.errors.length > 0) {
    lines.push("");
    lines.push("Errors / Restrictions:");
    for (const err of result.errors) {
      const statusStr = err.status ? ` (HTTP ${err.status})` : "";
      lines.push(`  - ${err.endpoint}: ${err.errorName}${statusStr}`);
    }
  }

  return lines.join("\n");
}

export function formatDiscoveryJson(result: DiscoveryResult): string {
  return JSON.stringify(result, null, 2);
}

export function getDiscoveryHelpText(): string {
  return [
    "Usage: pnpm wakatime:discover [options]",
    "",
    "Safe, read-only discovery of WakaTime API credentials and capabilities.",
    "",
    "Options:",
    "  --json                  Emit bounded JSON report on stdout",
    "  --probe-date <date>     Date to probe (YYYY-MM-DD, defaults to yesterday UTC)",
    "  --help, -h              Show this help message",
    "",
    "Security:",
    "  The API key is read strictly from WAKATIME_API_KEY in .env or WAKATIME_API_KEY_FILE.",
    "  Passing API keys via command-line arguments is strictly rejected.",
    "  Reports and errors never contain API keys, authorization headers, PII, or entity paths."
  ].join("\n");
}

export async function runDiscoveryCli(
  argv: readonly string[],
  options?: {
    apiKey?: string | null;
    baseUrl?: string;
    fetch?: typeof fetch;
    now?: Date;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
  }
): Promise<number> {
  const writeOut =
    options?.stdout ??
    ((text: string) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`));
  const writeErr =
    options?.stderr ??
    ((text: string) => process.stderr.write(text.endsWith("\n") ? text : `${text}\n`));

  let parsedArgs: ReturnType<typeof validateDiscoveryArgs>;
  try {
    parsedArgs = validateDiscoveryArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid arguments";
    writeErr(`Error: ${msg}`);
    return 1;
  }

  if (parsedArgs.help) {
    writeOut(getDiscoveryHelpText());
    return 0;
  }

  let apiKey: string | null = null;
  if (options?.apiKey !== undefined) {
    apiKey = options.apiKey;
  } else {
    try {
      const config = getRuntimeConfig();
      apiKey = config.wakatimeApiKey;
    } catch {
      apiKey = null;
    }
  }

  if (!apiKey || !apiKey.trim()) {
    writeErr(
      "Error: No WakaTime API key configured. Set WAKATIME_API_KEY in your gitignored .env or set WAKATIME_API_KEY_FILE to point to a restricted secret file."
    );
    return 1;
  }

  const result = await runWakaTimeDiscovery({
    apiKey: apiKey.trim(),
    baseUrl: options?.baseUrl,
    probeDate: parsedArgs.probeDate,
    now: options?.now,
    fetch: options?.fetch
  });

  if (parsedArgs.json) {
    writeOut(formatDiscoveryJson(result));
  } else {
    writeOut(formatDiscoveryText(result));
  }

  return result.ok ? 0 : 1;
}
