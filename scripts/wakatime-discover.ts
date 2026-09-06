#!/usr/bin/env tsx
/**
 * Safe, opt-in WakaTime API capability discovery.
 *
 * Usage:
 *   pnpm wakatime:discover [--json] [--probe-date YYYY-MM-DD]
 *
 * Security:
 *   The API key is read strictly from WAKATIME_API_KEY in .env or WAKATIME_API_KEY_FILE.
 *   Passing API keys in CLI arguments is forbidden and will fail execution immediately.
 *   Reports and errors never contain API keys, authorization headers, PII, or entity paths.
 */

import { runDiscoveryCli } from "../src/lib/server/wakatime/discovery.js";

process.umask(0o077);

try {
  const exitCode = await runDiscoveryCli(process.argv.slice(2));
  process.exit(exitCode);
} catch (err) {
  const msg = err instanceof Error ? err.message : "Discovery failed";
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}
