import {
  WakaTimeClient
} from "./client.js";
import {
  type CurrentUserResponse,
  type SummariesResponse,
  type DurationsResponse,
  type HeartbeatsResponse,
  type DumpListResponse,
  type DumpItem
} from "./schemas.js";
import {
  WakaTimeAuthError,
  CapabilityRestrictedError,
  WakaTimeError,
  sanitizeEndpoint
} from "./errors.js";
import { getYesterdayDate, type SyncCapability, type CapabilityStatus } from "../sync/capabilities.js";
import { getRuntimeConfig } from "../config.js";

export interface PlanFeatures {
  hasPremiumFeatures?: boolean;
  writesOnly?: boolean;
}

export interface DiscoveredCapability {
  status: CapabilityStatus;
  restrictionCode?: string;
}

export interface DiscoveredDumpItem {
  type: string;
  status: string;
}

export interface DiscoveredDumps {
  count: number;
  types: string[];
  statuses: string[];
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
  credentialStatus: "accepted" | "rejected" | "missing";
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
 * Validate that CLI arguments do not attempt to pass an API key.
 * Strictly rejects flags like --api-key, -k, --key, or flags containing "apikey" / "api_key".
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
      if (!next || !/^\d{4}-\d{2}-\d{2}$/.test(next)) {
        throw new Error("Expected --probe-date YYYY-MM-DD");
      }
      probeDate = next;
    } else if (arg.startsWith("--probe-date=")) {
      const val = arg.slice("--probe-date=".length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        throw new Error("Expected --probe-date=YYYY-MM-DD");
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
 */
export async function runWakaTimeDiscovery(
  options: DiscoveryOptions
): Promise<DiscoveryResult> {
  const now = options.now ?? new Date();
  const probeDate = options.probeDate ?? getYesterdayDate(now);

  const result: DiscoveryResult = {
    ok: false,
    probeDate,
    credentialStatus: "missing",
    planFeatures: {},
    capabilities: {
      summaries: { status: "untested" },
      durations: { status: "untested" },
      heartbeats: { status: "untested" }
    },
    dumps: {
      count: 0,
      types: [],
      statuses: [],
      items: []
    },
    responseFields: {},
    errors: []
  };

  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    // Zero network calls when API key is missing
    return result;
  }

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
    result.responseFields.currentUser = Object.keys(userRes).sort();

    if (userRes.data && typeof userRes.data === "object") {
      result.responseFields.currentUserData = Object.keys(userRes.data).sort();
      if (typeof userRes.data.has_premium_features === "boolean") {
        result.planFeatures.hasPremiumFeatures = userRes.data.has_premium_features;
      }
      if (typeof userRes.data.writes_only === "boolean") {
        result.planFeatures.writesOnly = userRes.data.writes_only;
      }
    }
  } catch (err) {
    if (err instanceof WakaTimeAuthError) {
      result.credentialStatus = "rejected";
      result.errors.push({
        endpoint: "/users/current",
        status: 401,
        errorName: "WakaTimeAuthError"
      });
      result.ok = false;
      return result;
    }

    const status = err instanceof WakaTimeError ? err.status : undefined;
    const endpoint =
      err instanceof WakaTimeError ? err.endpoint ?? "/users/current" : "/users/current";
    result.errors.push({
      endpoint: sanitizeEndpoint(endpoint),
      status,
      errorName: err instanceof Error ? err.name : "UnknownError"
    });
    result.ok = false;
    return result;
  }

  // 2. Probe baseline summaries
  try {
    const summariesRes: SummariesResponse = await client.getSummaries(probeDate, probeDate);
    result.capabilities.summaries = { status: "available" };
    result.responseFields.summaries = Object.keys(summariesRes).sort();
  } catch (err) {
    if (err instanceof CapabilityRestrictedError) {
      result.capabilities.summaries = {
        status: "restricted",
        restrictionCode: `HTTP_${err.statusCode}`
      };
      result.errors.push({
        endpoint: sanitizeEndpoint(err.endpoint ?? "/users/current/summaries"),
        status: err.statusCode,
        errorName: "CapabilityRestrictedError"
      });
    } else {
      result.capabilities.summaries = { status: "error" };
      const status = err instanceof WakaTimeError ? err.status : undefined;
      const endpoint =
        err instanceof WakaTimeError
          ? err.endpoint ?? "/users/current/summaries"
          : "/users/current/summaries";
      result.errors.push({
        endpoint: sanitizeEndpoint(endpoint),
        status,
        errorName: err instanceof Error ? err.name : "UnknownError"
      });
    }
  }

  // 3. Probe durations (optional, plan-gated)
  try {
    const durationsRes: DurationsResponse = await client.getDurations(probeDate);
    result.capabilities.durations = { status: "available" };
    result.responseFields.durations = Object.keys(durationsRes).sort();
  } catch (err) {
    if (err instanceof CapabilityRestrictedError) {
      result.capabilities.durations = {
        status: "restricted",
        restrictionCode: `HTTP_${err.statusCode}`
      };
      result.errors.push({
        endpoint: sanitizeEndpoint(err.endpoint ?? "/users/current/durations"),
        status: err.statusCode,
        errorName: "CapabilityRestrictedError"
      });
    } else {
      result.capabilities.durations = { status: "error" };
      const status = err instanceof WakaTimeError ? err.status : undefined;
      const endpoint =
        err instanceof WakaTimeError
          ? err.endpoint ?? "/users/current/durations"
          : "/users/current/durations";
      result.errors.push({
        endpoint: sanitizeEndpoint(endpoint),
        status,
        errorName: err instanceof Error ? err.name : "UnknownError"
      });
    }
  }

  // 4. Probe heartbeats (optional, plan-gated)
  try {
    const heartbeatsRes: HeartbeatsResponse = await client.getHeartbeats(probeDate);
    result.capabilities.heartbeats = { status: "available" };
    result.responseFields.heartbeats = Object.keys(heartbeatsRes).sort();
  } catch (err) {
    if (err instanceof CapabilityRestrictedError) {
      result.capabilities.heartbeats = {
        status: "restricted",
        restrictionCode: `HTTP_${err.statusCode}`
      };
      result.errors.push({
        endpoint: sanitizeEndpoint(err.endpoint ?? "/users/current/heartbeats"),
        status: err.statusCode,
        errorName: "CapabilityRestrictedError"
      });
    } else {
      result.capabilities.heartbeats = { status: "error" };
      const status = err instanceof WakaTimeError ? err.status : undefined;
      const endpoint =
        err instanceof WakaTimeError
          ? err.endpoint ?? "/users/current/heartbeats"
          : "/users/current/heartbeats";
      result.errors.push({
        endpoint: sanitizeEndpoint(endpoint),
        status,
        errorName: err instanceof Error ? err.name : "UnknownError"
      });
    }
  }

  // 5. List existing dumps read-only (never create a dump)
  try {
    const dumpsRes: DumpListResponse = await client.listDumps();
    result.responseFields.dumps = Object.keys(dumpsRes).sort();

    const items: DiscoveredDumpItem[] = (dumpsRes.data ?? []).map((d: DumpItem) => ({
      type: String(d.type),
      status: String(d.status)
    }));

    result.dumps = {
      count: items.length,
      types: [...new Set(items.map((i) => i.type))].sort(),
      statuses: [...new Set(items.map((i) => i.status))].sort(),
      items
    };
  } catch (err) {
    const status = err instanceof WakaTimeError ? err.status : undefined;
    const endpoint =
      err instanceof WakaTimeError
        ? err.endpoint ?? "/users/current/data_dumps"
        : "/users/current/data_dumps";
    result.errors.push({
      endpoint: sanitizeEndpoint(endpoint),
      status,
      errorName: err instanceof Error ? err.name : "UnknownError"
    });
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
  const lines: string[] = [
    "=== WakaTime API Discovery ===",
    `Probe Date:        ${result.probeDate}`,
    `Credential Status: ${result.credentialStatus}`,
    `Plan Features:     hasPremiumFeatures=${result.planFeatures.hasPremiumFeatures ?? "unknown"}, writesOnly=${result.planFeatures.writesOnly ?? "unknown"}`,
    "",
    "Capabilities:"
  ];

  for (const [cap, rec] of Object.entries(result.capabilities)) {
    const detail = rec.restrictionCode ? ` (${rec.restrictionCode})` : "";
    lines.push(`  - ${cap.padEnd(12)}: ${rec.status}${detail}`);
  }

  lines.push("");
  lines.push("Data Dumps:");
  lines.push(`  - Total Count:   ${result.dumps.count}`);
  lines.push(`  - Types:         ${result.dumps.types.length > 0 ? result.dumps.types.join(", ") : "none"}`);
  lines.push(`  - Statuses:      ${result.dumps.statuses.length > 0 ? result.dumps.statuses.join(", ") : "none"}`);

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
