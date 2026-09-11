import { describe, it, expect, vi } from "vitest";
import { openTestDatabase } from "../db/connection.js";
import {
  runWakaTimeDiscovery,
  runDiscoveryCli,
  validateDiscoveryArgs,
  formatDiscoveryText,
  formatDiscoveryJson,
  isValidCalendarDate,
  safeDumpType,
  safeDumpStatus,
  MAX_DUMP_ITEMS
} from "./discovery.js";

describe("WakaTime API Discovery", () => {
  const secretAccessToken = "waka_sec_999888777_super_secret_token";

  function createJsonResponse(status: number, data: unknown): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  }

  const mockUserPayload = {
    data: {
      id: "usr_secret_id_9999",
      email: "engineer@secretcorp.internal",
      username: "secret_leomleao",
      plan: "basic",
      has_basic_features: false,
      has_premium_features: false,
      writes_only: true,
      timezone: "Europe/London"
    }
  };

  const mockSummariesPayload = {
    data: [
      {
        date: "2026-09-05",
        grand_total: { total_seconds: 7200 },
        projects: [
          {
            name: "TopSecretProject",
            total_seconds: 7200,
            entities: [
              {
                name: "/Users/secret/dev/proprietary/source.ts",
                total_seconds: 3600
              }
            ]
          }
        ]
      }
    ],
    start: "2026-09-05",
    end: "2026-09-05"
  };

  const mockDurationsPayload = {
    data: [
      {
        project: "TopSecretProject",
        time: 1725500000,
        duration: 3600
      }
    ],
    start: "2026-09-05",
    end: "2026-09-05"
  };

  const mockHeartbeatsPayload = {
    data: [
      {
        id: "hb_uuid_111",
        entity: "/Users/secret/dev/proprietary/source.ts",
        type: "file",
        time: 1725500000,
        project: "TopSecretProject"
      }
    ]
  };

  const mockDumpsPayload = {
    data: [
      {
        id: "dump_uuid_888",
        type: "daily",
        status: "completed",
        download_url: "https://api.wakatime.com/download/dump_uuid_888.tar.gz?signature=secret_sig",
        created_at: "2026-09-01T00:00:00Z"
      },
      {
        id: "dump_uuid_999",
        type: "heartbeats",
        status: "completed",
        download_url: "https://api.wakatime.com/download/dump_uuid_999.tar.gz?signature=secret_sig",
        created_at: "2026-09-02T00:00:00Z"
      }
    ]
  };

  // Requirement 1 & 7: Missing key causes zero fetch calls and safe error
  it("missing-key makes zero network calls and exits non-zero", async () => {
    const fetchMock = vi.fn();
    const stdoutMock = vi.fn();
    const stderrMock = vi.fn();

    // Direct runner with null key
    const directResult = await runWakaTimeDiscovery({
      accessToken: null,
      fetch: fetchMock as unknown as typeof fetch
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(directResult.ok).toBe(false);
    expect(directResult.credentialStatus).toBe("missing");

    // CLI runner with empty key
    const exitCode = await runDiscoveryCli([], {
      accessToken: "",
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdoutMock,
      stderr: stderrMock
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(stderrMock).toHaveBeenCalledTimes(1);
    const errText = stderrMock.mock.calls[0][0];
    expect(errText).toContain("WakaTime is not connected");
    expect(errText).toContain("/integrations/wakatime");
  });

  it("reports a supplied credential as unverified when transport prevents validation", async () => {
    const result = await runWakaTimeDiscovery({
      accessToken: secretAccessToken,
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch
    });

    expect(result.ok).toBe(false);
    expect(result.credentialStatus).toBe("unverified");
    expect(result.errors).toContainEqual({
      endpoint: "/api/v1/users/current/summaries",
      status: undefined,
      errorName: "WakaTimeNetworkError"
    });
    const textOutput = formatDiscoveryText(result);
    expect(textOutput).toContain("Credential Status: unverified");
    expect(textOutput).toContain("WakaTimeNetworkError");
    expect(JSON.stringify(result)).not.toContain(secretAccessToken);
    expect(textOutput).not.toContain(secretAccessToken);
  });

  // Requirement: CLI args cannot carry a key
  it("strictly rejects any CLI argument attempting to pass an access token", async () => {
    const forbiddenArgs = [
      ["--api-key", "some-key"],
      ["--api-key=some-key"],
      ["--apikey", "some-key"],
      ["--apikey=some-key"],
      ["-k", "some-key"],
      ["-k=some-key"],
      ["--key", "some-key"],
      ["--custom-api_key"],
      ["--pass_apikey_here"]
    ];

    for (const args of forbiddenArgs) {
      expect(() => validateDiscoveryArgs(args)).toThrow(
        /Passing access tokens via CLI arguments is strictly forbidden/
      );

      const stderrMock = vi.fn();
      const exitCode = await runDiscoveryCli(args, {
        accessToken: secretAccessToken,
        stderr: stderrMock
      });
      expect(exitCode).toBe(1);
      expect(stderrMock.mock.calls[0][0]).toContain(
        "Passing access tokens via CLI arguments is strictly forbidden"
      );
    }
  });

  // access token absent from output/errors/JSON
  it("guarantees access token is absent from text output, JSON, and errors", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/users/current/summaries")) {
        return createJsonResponse(200, mockSummariesPayload);
      }
      if (url.includes("/users/current/durations")) {
        return createJsonResponse(402, { message: "Payment required" });
      }
      if (url.includes("/users/current/heartbeats")) {
        return createJsonResponse(403, { message: "Forbidden" });
      }
      if (url.includes("/users/current/data_dumps")) {
        return createJsonResponse(200, mockDumpsPayload);
      }
      if (url.includes("/users/current")) {
        return createJsonResponse(200, mockUserPayload);
      }
      return new Response("Not Found", { status: 404 });
    });

    const result = await runWakaTimeDiscovery({
      accessToken: secretAccessToken,
      fetch: fetchMock as unknown as typeof fetch
    });

    const textOutput = formatDiscoveryText(result);
    const jsonOutput = formatDiscoveryJson(result);
    const base64Key = Buffer.from(secretAccessToken).toString("base64");

    // The key must never appear in raw or encoded form in text or json
    expect(textOutput).not.toContain(secretAccessToken);
    expect(textOutput).not.toContain(base64Key);
    expect(jsonOutput).not.toContain(secretAccessToken);
    expect(jsonOutput).not.toContain(base64Key);

    // Errors must not contain the key
    for (const err of result.errors) {
      expect(JSON.stringify(err)).not.toContain(secretAccessToken);
    }
  });

  // PII and entity/path values absent
  it("guarantees PII, entity paths, usernames, project names, and download URLs are absent from report", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/users/current/summaries")) {
        return createJsonResponse(200, mockSummariesPayload);
      }
      if (url.includes("/users/current/durations")) {
        return createJsonResponse(200, mockDurationsPayload);
      }
      if (url.includes("/users/current/heartbeats")) {
        return createJsonResponse(200, mockHeartbeatsPayload);
      }
      if (url.includes("/users/current/data_dumps")) {
        return createJsonResponse(200, mockDumpsPayload);
      }
      if (url.includes("/users/current")) {
        return createJsonResponse(200, mockUserPayload);
      }
      return new Response("Not Found", { status: 404 });
    });

    const result = await runWakaTimeDiscovery({
      accessToken: secretAccessToken,
      fetch: fetchMock as unknown as typeof fetch
    });

    const textOutput = formatDiscoveryText(result);
    const jsonOutput = formatDiscoveryJson(result);

    // Verify PII is completely absent
    expect(textOutput).not.toContain("engineer@secretcorp.internal");
    expect(jsonOutput).not.toContain("engineer@secretcorp.internal");
    expect(textOutput).not.toContain("secret_leomleao");
    expect(jsonOutput).not.toContain("secret_leomleao");
    expect(textOutput).not.toContain("usr_secret_id_9999");
    expect(jsonOutput).not.toContain("usr_secret_id_9999");

    // Verify project names and file paths are absent
    expect(textOutput).not.toContain("TopSecretProject");
    expect(jsonOutput).not.toContain("TopSecretProject");
    expect(textOutput).not.toContain("/Users/secret/dev/proprietary/source.ts");
    expect(jsonOutput).not.toContain("/Users/secret/dev/proprietary/source.ts");

    // Verify dump download URLs are absent
    expect(textOutput).not.toContain("https://api.wakatime.com/download");
    expect(jsonOutput).not.toContain("https://api.wakatime.com/download");
    expect(textOutput).not.toContain("dump_uuid_888");
    expect(jsonOutput).not.toContain("dump_uuid_888");

    // Verify only safe metadata is preserved
    expect(result.planFeatures).toEqual({});
    expect(result.responseFields.currentUser).toBeUndefined();
    expect(result.responseFields.currentUserData).toBeUndefined();
    expect(result.dumps.count).toBe(2);
    expect(result.dumps.truncated).toBe(false);
    expect(result.dumps.types).toEqual(["daily", "heartbeats"]);
    expect(result.dumps.statuses).toEqual(["completed"]);
    expect(result.dumps.items).toEqual([
      { type: "daily", status: "completed" },
      { type: "heartbeats", status: "completed" }
    ]);
  });

  // Soft-degraded heartbeat/duration restrictions do not fail discovery
  it("soft-degraded heartbeat and duration restrictions (HTTP 402/403) do not fail discovery when summaries work", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/users/current/summaries")) {
        return createJsonResponse(200, mockSummariesPayload);
      }
      if (url.includes("/users/current/durations")) {
        return createJsonResponse(402, { message: "Upgrade required for durations" });
      }
      if (url.includes("/users/current/heartbeats")) {
        return createJsonResponse(403, { message: "Heartbeats restricted on Free plan" });
      }
      if (url.includes("/users/current/data_dumps")) {
        return createJsonResponse(200, mockDumpsPayload);
      }
      if (url.includes("/users/current")) {
        return createJsonResponse(200, mockUserPayload);
      }
      return new Response("Not Found", { status: 404 });
    });

    const result = await runWakaTimeDiscovery({
      accessToken: secretAccessToken,
      fetch: fetchMock as unknown as typeof fetch
    });

    expect(result.ok).toBe(true);
    expect(result.credentialStatus).toBe("accepted");
    expect(result.capabilities.summaries.status).toBe("available");
    expect(result.capabilities.durations.status).toBe("restricted");
    expect(result.capabilities.durations.restrictionCode).toBe("HTTP_402");
    expect(result.capabilities.heartbeats.status).toBe("restricted");
    expect(result.capabilities.heartbeats.restrictionCode).toBe("HTTP_403");

    // CLI runner returns 0 (success) under soft-degraded conditions
    const stdoutMock = vi.fn();
    const exitCode = await runDiscoveryCli([], {
      accessToken: secretAccessToken,
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdoutMock
    });
    expect(exitCode).toBe(0);
    expect(stdoutMock.mock.calls[0][0]).toContain("durations   : restricted (HTTP_402)");
    expect(stdoutMock.mock.calls[0][0]).toContain("heartbeats  : restricted (HTTP_403)");
  }, 15000);

  it("persists discovered capability policy state for the active database", async () => {
    const db = openTestDatabase();
    const now = new Date("2026-09-07T12:00:00.000Z");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/users/current/summaries")) {
        return createJsonResponse(200, mockSummariesPayload);
      }
      if (url.includes("/users/current/durations")) {
        return createJsonResponse(402, { message: "Upgrade required" });
      }
      if (url.includes("/users/current/heartbeats")) {
        return createJsonResponse(403, { message: "Upgrade required" });
      }
      if (url.includes("/users/current/data_dumps")) {
        return createJsonResponse(200, mockDumpsPayload);
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      const exitCode = await runDiscoveryCli([], {
        accessToken: secretAccessToken,
        fetch: fetchMock as unknown as typeof fetch,
        stdout: vi.fn(),
        database: db,
        now
      });
      const row = db
        .prepare("SELECT value, updated_at FROM app_settings WHERE key = 'capability_policy_state'")
        .get() as { value: string; updated_at: string };
      const state = JSON.parse(row.value);

      expect(exitCode).toBe(0);
      expect(row.updated_at).toBe(now.toISOString());
      expect(state.updatedAt).toBe(now.toISOString());
      expect(state.capabilities.summaries.status).toBe("available");
      expect(state.capabilities.durations).toMatchObject({
        status: "restricted",
        restrictionCode: "HTTP_402"
      });
      expect(state.capabilities.heartbeats).toMatchObject({
        status: "restricted",
        restrictionCode: "HTTP_403"
      });
    } finally {
      db.close();
    }
  });

  // Auth rejection is non-zero
  it("auth rejection (HTTP 401) results in rejected credential status and non-zero exit code", async () => {
    const fetchMock = vi.fn(async () => {
      return createJsonResponse(401, { error: "Unauthorized" });
    });

    const result = await runWakaTimeDiscovery({
      accessToken: secretAccessToken,
      fetch: fetchMock as unknown as typeof fetch
    });

    expect(result.ok).toBe(false);
    expect(result.credentialStatus).toBe("rejected");
    expect(result.errors).toContainEqual({
      endpoint: "/api/v1/users/current/summaries",
      status: 401,
      errorName: "WakaTimeAuthError"
    });

    const stdoutMock = vi.fn();
    const stderrMock = vi.fn();
    const exitCode = await runDiscoveryCli([], {
      accessToken: secretAccessToken,
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdoutMock,
      stderr: stderrMock
    });
    expect(exitCode).toBe(1);
  });

  // Read-only dump listing, no dump creation, and avoids duplicate getCurrentUser calls
  it("lists dumps read-only with GET and avoids the email-scoped current-user endpoint", async () => {
    const requestedEndpoints: Array<{ method: string; url: string }> = [];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requestedEndpoints.push({ method, url });

      if (url.includes("/users/current/summaries")) {
        return createJsonResponse(200, mockSummariesPayload);
      }
      if (url.includes("/users/current/durations")) {
        return createJsonResponse(200, mockDurationsPayload);
      }
      if (url.includes("/users/current/heartbeats")) {
        return createJsonResponse(200, mockHeartbeatsPayload);
      }
      if (url.includes("/users/current/data_dumps")) {
        return createJsonResponse(200, mockDumpsPayload);
      }
      if (url.includes("/users/current")) {
        return createJsonResponse(200, mockUserPayload);
      }
      return new Response("Not Found", { status: 404 });
    });

    const result = await runWakaTimeDiscovery({
      accessToken: secretAccessToken,
      fetch: fetchMock as unknown as typeof fetch
    });

    expect(result.ok).toBe(true);

    // Verify all requests were GET, never POST/PUT/DELETE
    expect(requestedEndpoints.every((r) => r.method === "GET")).toBe(true);

    // Verify currentUser was requested exactly once (no duplicate calls)
    const currentUserRequests = requestedEndpoints.filter(
      (r) => r.url.endsWith("/users/current") || r.url.endsWith("/users/current/")
    );
    expect(currentUserRequests.length).toBe(0);

    // Verify data_dumps was requested with GET only
    const dumpRequests = requestedEndpoints.filter((r) => r.url.includes("/data_dumps"));
    expect(dumpRequests.length).toBe(1);
    expect(dumpRequests[0].method).toBe("GET");
  });

  // Requirement 1 & 6: Adversarial test for hundreds of dumps with truncation indicator
  it("adversarially bounds hundreds of dumps to MAX_DUMP_ITEMS with aggregate total count and truncation indicator", async () => {
    // Generate 250 upstream dump items
    const manyDumps = Array.from({ length: 250 }, (_, i) => ({
      id: `dump_${i}`,
      type: i % 2 === 0 ? "daily" : "heartbeats",
      status: "completed",
      created_at: "2026-09-01T00:00:00Z"
    }));

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/users/current/data_dumps")) {
        return createJsonResponse(200, { data: manyDumps });
      }
      if (url.includes("/users/current/summaries")) {
        return createJsonResponse(200, mockSummariesPayload);
      }
      if (url.includes("/users/current/durations")) {
        return createJsonResponse(200, mockDurationsPayload);
      }
      if (url.includes("/users/current/heartbeats")) {
        return createJsonResponse(200, mockHeartbeatsPayload);
      }
      if (url.includes("/users/current")) {
        return createJsonResponse(200, mockUserPayload);
      }
      return new Response("Not Found", { status: 404 });
    });

    const result = await runWakaTimeDiscovery({
      accessToken: secretAccessToken,
      fetch: fetchMock as unknown as typeof fetch
    });

    expect(result.dumps.count).toBe(250);
    expect(result.dumps.truncated).toBe(true);
    expect(result.dumps.items.length).toBe(MAX_DUMP_ITEMS);
    expect(result.dumps.items.length).toBe(10);
    expect(result.dumps.types).toEqual(["daily", "heartbeats"]);
    expect(result.dumps.statuses).toEqual(["completed"]);

    const text = formatDiscoveryText(result);
    expect(text).toContain("Total Count:   250 (truncated to first 10)");

    const json = JSON.parse(formatDiscoveryJson(result));
    expect(json.dumps.count).toBe(250);
    expect(json.dumps.truncated).toBe(true);
    expect(json.dumps.items).toHaveLength(10);
  });

  // Requirement 2 & 6: Adversarial test for overlong/arbitrary dump type/status mapped to safe known values plus unknown
  it("adversarially maps overlong, unexpected, or malicious dump types and statuses to safe values or 'unknown'", async () => {
    const maliciousDumps = [
      {
        id: "d1",
        type: "OVERLONG_ARBITRARY_TYPE_CONTAINING_EXPLOIT_PAYLOAD_AND_SECRETS_abcdef123456",
        status: "MALICIOUS_SQL_STATUS_DROP_TABLE_USERS",
        created_at: "2026-09-01T00:00:00Z"
      },
      {
        id: "d2",
        type: "daily",
        status: "ATTACKER_SERVER_IP_10_0_0_1",
        created_at: "2026-09-01T00:00:00Z"
      },
      {
        id: "d3",
        type: "UNKNOWN_DUMP_TYPE",
        status: "pending",
        created_at: "2026-09-01T00:00:00Z"
      }
    ];

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/users/current/data_dumps")) {
        return createJsonResponse(200, { data: maliciousDumps });
      }
      if (url.includes("/users/current/summaries")) {
        return createJsonResponse(200, mockSummariesPayload);
      }
      if (url.includes("/users/current/durations")) {
        return createJsonResponse(200, mockDurationsPayload);
      }
      if (url.includes("/users/current/heartbeats")) {
        return createJsonResponse(200, mockHeartbeatsPayload);
      }
      if (url.includes("/users/current")) {
        return createJsonResponse(200, mockUserPayload);
      }
      return new Response("Not Found", { status: 404 });
    });

    const result = await runWakaTimeDiscovery({
      accessToken: secretAccessToken,
      fetch: fetchMock as unknown as typeof fetch
    });

    expect(result.dumps.items[0]).toEqual({ type: "unknown", status: "unknown" });
    expect(result.dumps.items[1]).toEqual({ type: "daily", status: "unknown" });
    expect(result.dumps.items[2]).toEqual({ type: "unknown", status: "pending" });

    // Types and statuses arrays only contain known safe values plus "unknown"
    expect(result.dumps.types).toEqual(["daily", "unknown"]);
    expect(result.dumps.statuses).toEqual(["pending", "unknown"]);

    // The arbitrary strings must not leak in text or json
    const text = formatDiscoveryText(result);
    const json = formatDiscoveryJson(result);

    expect(text).not.toContain("OVERLONG_ARBITRARY_TYPE");
    expect(text).not.toContain("DROP_TABLE_USERS");
    expect(text).not.toContain("ATTACKER_SERVER_IP");
    expect(json).not.toContain("OVERLONG_ARBITRARY_TYPE");
    expect(json).not.toContain("DROP_TABLE_USERS");
    expect(json).not.toContain("ATTACKER_SERVER_IP");

    // Unit test safeDumpType and safeDumpStatus directly
    expect(safeDumpType("daily")).toBe("daily");
    expect(safeDumpType("DAILY ")).toBe("daily");
    expect(safeDumpType("heartbeats")).toBe("heartbeats");
    expect(safeDumpType("anything-else")).toBe("unknown");
    expect(safeDumpType(null)).toBe("unknown");

    expect(safeDumpStatus("pending")).toBe("pending");
    expect(safeDumpStatus("COMPLETED")).toBe("completed");
    expect(safeDumpStatus("processing")).toBe("processing");
    expect(safeDumpStatus("failed")).toBe("failed");
    expect(safeDumpStatus("injected_status")).toBe("unknown");
    expect(safeDumpStatus(undefined)).toBe("unknown");
  });

  // Requirement 3 & 4 & 6: Adversarial test for property keys containing emails/secrets
  it("adversarially redacts unallowlisted property keys containing emails or secrets from responseFields", async () => {
    const maliciousUserPayload = {
      data: {
        id: "usr_safe_123",
        has_basic_features: true,
        has_premium_features: false,
        writes_only: true,
        // Adversarial property names:
        "victim_email_address@secretcorp.internal": "stolen_email_value",
        "api_key_leak_secret_998877": "stolen_key",
        "__proto__": "polluted",
        "nested_exploit_key": { leak: true }
      }
    };

    const maliciousSummariesPayload = {
      data: [],
      start: "2026-09-05",
      end: "2026-09-05",
      "internal_db_connection_string": "postgres://user:pass@internal:5432/db",
      "confidential_contractor@domain.com": 123
    };

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/users/current/summaries")) {
        return createJsonResponse(200, maliciousSummariesPayload);
      }
      if (url.includes("/users/current/durations")) {
        return createJsonResponse(200, mockDurationsPayload);
      }
      if (url.includes("/users/current/heartbeats")) {
        return createJsonResponse(200, mockHeartbeatsPayload);
      }
      if (url.includes("/users/current/data_dumps")) {
        return createJsonResponse(200, mockDumpsPayload);
      }
      if (url.includes("/users/current")) {
        return createJsonResponse(200, maliciousUserPayload);
      }
      return new Response("Not Found", { status: 404 });
    });

    const result = await runWakaTimeDiscovery({
      accessToken: secretAccessToken,
      fetch: fetchMock as unknown as typeof fetch
    });

    // Account-plan flags are not requested because /users/current requires the
    // unrelated email scope. Capabilities are inferred from endpoint results.
    expect(result.planFeatures).toEqual({});

    // The email-scoped profile response is never fetched or reflected.
    expect(result.responseFields.currentUserData).toBeUndefined();

    expect(result.responseFields.summaries).toEqual(["data", "end", "start"]);
    expect(result.responseFields.summaries).not.toContain("internal_db_connection_string");
    expect(result.responseFields.summaries).not.toContain("confidential_contractor@domain.com");

    // Formatted outputs do not leak unexpected property keys
    const text = formatDiscoveryText(result);
    const json = formatDiscoveryJson(result);

    expect(text).not.toContain("victim_email_address@secretcorp.internal");
    expect(text).not.toContain("api_key_leak_secret_998877");
    expect(text).not.toContain("internal_db_connection_string");
    expect(text).not.toContain("confidential_contractor@domain.com");

    expect(json).not.toContain("victim_email_address@secretcorp.internal");
    expect(json).not.toContain("api_key_leak_secret_998877");
    expect(json).not.toContain("internal_db_connection_string");
    expect(json).not.toContain("confidential_contractor@domain.com");

    expect(text).toContain("hasBasicFeatures=unknown");
  });

  // Requirement 5 & 6: Strictly validate --probe-date as a real UTC calendar date
  it("strictly validates probe-date as a real UTC calendar date and rejects invalid dates without network calls", async () => {
    // 1. Unit validation of isValidCalendarDate
    // Leap year checks
    expect(isValidCalendarDate("2024-02-29")).toBe(true); // 2024 is leap
    expect(isValidCalendarDate("2020-02-29")).toBe(true); // 2020 is leap
    expect(isValidCalendarDate("2000-02-29")).toBe(true); // 2000 is leap (divisible by 400)
    expect(isValidCalendarDate("2026-02-29")).toBe(false); // 2026 is non-leap
    expect(isValidCalendarDate("2023-02-29")).toBe(false); // 2023 is non-leap
    expect(isValidCalendarDate("1900-02-29")).toBe(false); // 1900 is non-leap (century non-400)

    // Month boundary checks
    expect(isValidCalendarDate("2026-04-30")).toBe(true);
    expect(isValidCalendarDate("2026-04-31")).toBe(false); // April has 30 days
    expect(isValidCalendarDate("2026-06-31")).toBe(false); // June has 30 days
    expect(isValidCalendarDate("2026-09-31")).toBe(false); // Sept has 30 days
    expect(isValidCalendarDate("2026-11-31")).toBe(false); // Nov has 30 days
    expect(isValidCalendarDate("2026-01-31")).toBe(true); // Jan has 31 days
    expect(isValidCalendarDate("2026-02-28")).toBe(true); // Feb has 28 days

    // Month / day ranges
    expect(isValidCalendarDate("2026-00-10")).toBe(false); // Month 0
    expect(isValidCalendarDate("2026-13-01")).toBe(false); // Month 13
    expect(isValidCalendarDate("2026-05-00")).toBe(false); // Day 0
    expect(isValidCalendarDate("2026-05-32")).toBe(false); // Day 32

    // Format errors
    expect(isValidCalendarDate("2026-9-5")).toBe(false);
    expect(isValidCalendarDate("not-a-date")).toBe(false);
    expect(isValidCalendarDate("")).toBe(false);
    expect(isValidCalendarDate("2026/09/05")).toBe(false);

    // 2. CLI argument validator strictly rejects invalid calendar dates
    expect(() => validateDiscoveryArgs(["--probe-date", "2026-02-31"])).toThrow(
      /must be a valid UTC calendar date/
    );
    expect(() => validateDiscoveryArgs(["--probe-date=2026-04-31"])).toThrow(
      /must be a valid UTC calendar date/
    );
    expect(() => validateDiscoveryArgs(["--probeDate=2026-13-01"])).toThrow(
      /must be a valid UTC calendar date/
    );
    expect(() => validateDiscoveryArgs(["--probe-date", "invalid-str"])).toThrow(
      /must be a valid UTC calendar date/
    );

    // Valid dates pass CLI validation
    const validParsed = validateDiscoveryArgs(["--probe-date", "2024-02-29"]);
    expect(validParsed.probeDate).toBe("2024-02-29");

    // 3. CLI runner prints error and exits 1 on invalid date without network calls
    const fetchMock = vi.fn();
    const stderrMock = vi.fn();
    const cliExit = await runDiscoveryCli(["--probe-date", "2026-02-31"], {
      accessToken: secretAccessToken,
      fetch: fetchMock as unknown as typeof fetch,
      stderr: stderrMock
    });

    expect(cliExit).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderrMock.mock.calls[0][0]).toContain("must be a valid UTC calendar date");

    // 4. Direct runner rejects invalid calendar date without network calls
    const directResult = await runWakaTimeDiscovery({
      accessToken: secretAccessToken,
      probeDate: "2026-02-31",
      fetch: fetchMock as unknown as typeof fetch
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(directResult.ok).toBe(false);
    expect(directResult.errors).toContainEqual({
      endpoint: "probeDate",
      status: undefined,
      errorName: "InvalidCalendarDateError"
    });
  });
});
