import { describe, it, expect, vi } from "vitest";
import {
  runWakaTimeDiscovery,
  runDiscoveryCli,
  validateDiscoveryArgs,
  formatDiscoveryText,
  formatDiscoveryJson
} from "./discovery.js";

describe("WakaTime API Discovery", () => {
  const secretApiKey = "waka_sec_999888777_super_secret_token";

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

  // Requirement 1 & 6: Missing key causes zero fetch calls and safe error
  it("missing-key makes zero network calls and exits non-zero", async () => {
    const fetchMock = vi.fn();
    const stdoutMock = vi.fn();
    const stderrMock = vi.fn();

    // Direct runner with null key
    const directResult = await runWakaTimeDiscovery({
      apiKey: null,
      fetch: fetchMock as unknown as typeof fetch
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(directResult.ok).toBe(false);
    expect(directResult.credentialStatus).toBe("missing");

    // CLI runner with empty key
    const exitCode = await runDiscoveryCli([], {
      apiKey: "",
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdoutMock,
      stderr: stderrMock
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(stderrMock).toHaveBeenCalledTimes(1);
    const errText = stderrMock.mock.calls[0][0];
    expect(errText).toContain("No WakaTime API key configured");
    expect(errText).toContain("WAKATIME_API_KEY");
    expect(errText).toContain("WAKATIME_API_KEY_FILE");
  });

  // Requirement 6: CLI args cannot carry a key
  it("strictly rejects any CLI argument attempting to pass an API key", async () => {
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
        /Passing API keys via CLI arguments is strictly forbidden/
      );

      const stderrMock = vi.fn();
      const exitCode = await runDiscoveryCli(args, {
        apiKey: secretApiKey,
        stderr: stderrMock
      });
      expect(exitCode).toBe(1);
      expect(stderrMock.mock.calls[0][0]).toContain(
        "Passing API keys via CLI arguments is strictly forbidden"
      );
    }
  });

  // Requirement 4 & 6: API key absent from output/errors/JSON
  it("guarantees API key is absent from text output, JSON, and errors", async () => {
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
      apiKey: secretApiKey,
      fetch: fetchMock as unknown as typeof fetch
    });

    const textOutput = formatDiscoveryText(result);
    const jsonOutput = formatDiscoveryJson(result);
    const base64Key = Buffer.from(secretApiKey).toString("base64");

    // The key must never appear in raw or encoded form in text or json
    expect(textOutput).not.toContain(secretApiKey);
    expect(textOutput).not.toContain(base64Key);
    expect(jsonOutput).not.toContain(secretApiKey);
    expect(jsonOutput).not.toContain(base64Key);

    // Errors must not contain the key
    for (const err of result.errors) {
      expect(JSON.stringify(err)).not.toContain(secretApiKey);
    }
  });

  // Requirement 4 & 6: PII and entity/path values absent
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
      apiKey: secretApiKey,
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
    expect(result.planFeatures.hasPremiumFeatures).toBe(false);
    expect(result.planFeatures.writesOnly).toBe(true);
    expect(result.dumps.count).toBe(2);
    expect(result.dumps.types).toEqual(["daily", "heartbeats"]);
    expect(result.dumps.statuses).toEqual(["completed"]);
    expect(result.dumps.items).toEqual([
      { type: "daily", status: "completed" },
      { type: "heartbeats", status: "completed" }
    ]);
  });

  // Requirement 3 & 6: Soft-degraded heartbeat/duration restrictions do not fail discovery
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
      apiKey: secretApiKey,
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
      apiKey: secretApiKey,
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdoutMock
    });
    expect(exitCode).toBe(0);
    expect(stdoutMock.mock.calls[0][0]).toContain("durations   : restricted (HTTP_402)");
    expect(stdoutMock.mock.calls[0][0]).toContain("heartbeats  : restricted (HTTP_403)");
  });

  // Requirement 6: Auth rejection is non-zero
  it("auth rejection (HTTP 401) results in rejected credential status and non-zero exit code", async () => {
    const fetchMock = vi.fn(async () => {
      return createJsonResponse(401, { error: "Unauthorized" });
    });

    const result = await runWakaTimeDiscovery({
      apiKey: secretApiKey,
      fetch: fetchMock as unknown as typeof fetch
    });

    expect(result.ok).toBe(false);
    expect(result.credentialStatus).toBe("rejected");
    expect(result.errors).toContainEqual({
      endpoint: "/users/current",
      status: 401,
      errorName: "WakaTimeAuthError"
    });

    const stdoutMock = vi.fn();
    const stderrMock = vi.fn();
    const exitCode = await runDiscoveryCli([], {
      apiKey: secretApiKey,
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdoutMock,
      stderr: stderrMock
    });
    expect(exitCode).toBe(1);
  });

  // Requirement 3 & 5: Read-only dump listing, no dump creation, and avoids duplicate getCurrentUser calls
  it("lists dumps read-only with GET and avoids duplicate getCurrentUser calls", async () => {
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
      apiKey: secretApiKey,
      fetch: fetchMock as unknown as typeof fetch
    });

    expect(result.ok).toBe(true);

    // Verify all requests were GET, never POST/PUT/DELETE
    expect(requestedEndpoints.every((r) => r.method === "GET")).toBe(true);

    // Verify currentUser was requested exactly once (no duplicate calls)
    const currentUserRequests = requestedEndpoints.filter(
      (r) => r.url.endsWith("/users/current") || r.url.endsWith("/users/current/")
    );
    expect(currentUserRequests.length).toBe(1);

    // Verify data_dumps was requested with GET only
    const dumpRequests = requestedEndpoints.filter((r) => r.url.includes("/data_dumps"));
    expect(dumpRequests.length).toBe(1);
    expect(dumpRequests[0].method).toBe("GET");
  });
});
