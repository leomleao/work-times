# Review of the original next-milestone draft

Reviewed: 2026-09-09. Code baseline: `0376033` plus existing local edits.
Revised handoff: [NEXT-MILESTONE.md](./NEXT-MILESTONE.md).

## Assessment

The original agent produced a useful feature outline and a sensible first
decomposition, but the document was not ready for an orchestrator to execute.
It correctly recognized the independent MCP page, reusable OAuth/client work,
registry-based editor labels, and the need for cancellation and transactional
sync. It did not verify several implementation claims against the repository.

The most serious issue was treating live sync as an adapter plus a timer. The
actual design problem is reconciling sources of different fidelity while
preserving classification decisions and truthful work-only output. Incorrect
assumptions here can destroy user decisions or quietly misstate work time even
when the scheduler and UI appear to work.

This assesses the artifact, not the model's intelligence. There is no basis to
infer the originating model's general capability from one plan.

## What the original got right

- The two requested product outcomes are useful and largely independent.
- Keeping a single-process architecture suits the current personal archive.
- The HTTP client, OAuth service, source canonicalization, and classification
  engine should be reused.
- Editor UUIDs should resolve through the authoritative registry, with explicit
  unresolved historical identities.
- Per-date atomicity, restricted capability handling, restart recovery, and
  progress visibility belong in acceptance criteria.
- A DAG is the right handoff format for later parallel implementation.

## Findings that change the implementation

| Priority | Original assumption or omission | Evidence | Consequence / revised decision |
| --- | --- | --- | --- |
| Critical | Replace a day's slices while preserving classification | [Allocation schema](../migrations/002-application-state.sql) has a composite slice FK with `ON DELETE CASCADE` | Deleting slices erases whole-slice decisions. Detach decisions from source lifetime, preserve IDs/history, and define removal and changed-duration behavior. |
| Critical | API summaries contain dump-compatible nested project detail | Local [API schemas](../src/lib/server/wakatime/schemas.ts) default absent detail arrays; dump [parser](../src/lib/server/import/parse.ts) expects richer structure | Distinguish missing detail from complete empty data. Add explicit coarse project slices and conservative classification; refuse silent detail downgrade. |
| High | Reuse `processDailyDay()` and `processHeartbeatDay()` | Neither exists; [importer](../src/lib/server/import/importer.ts) is one coupled writer inside a whole-import transaction | Extract source-neutral normalization/reconciliation deliberately and preserve importer behavior through regression tests. |
| High | A token-provider bridge is missing | [OAuth service](../src/lib/server/wakatime/oauth.ts) already implements both provider methods; [discovery](../src/lib/server/wakatime/discovery.ts) already injects it | Remove duplicate token logic. Spend that effort on deadlines, pacing, cancellation, and disconnect/refresh races. |
| High | Existing schema already supports the lifecycle | [Migration 002](../migrations/002-application-state.sql) allows only four run states; [sanitizers](../src/lib/server/admin/sanitize.ts) repeat those enums | Explicit forward migrations are prerequisites for cancellation, interruption, queueing, and reliable progress. |
| High | One request per second and bounded shutdown are already available | [Client](../src/lib/server/wakatime/client.ts) has retries but no pacing, signal, body limit, or whole-request timeout; Retry-After is capped | Add one shared request gate with abortable deadlines and full upstream wait semantics; test actual request-start spacing. |
| High | A global capability record can select every date | [CapabilityPolicy](../src/lib/server/sync/capabilities.ts) tracks endpoint-wide state | Historical restriction must not suppress recent accessible dates. Add per-date retry/freshness state. |
| High | Existing outcome helpers aggregate a range | Named helpers do not exist; `evaluateSyncRun()` selects the first summaries result | Aggregate durable date outcomes and explicitly define all-restricted, cancelled, interrupted, and partial results. |
| High | Catch up from newest archived date | [Daily totals](../migrations/001-import-schema.sql) and [sync tables](../migrations/002-application-state.sql) represent different histories | A maximum date misses holes and current-day changes; a missing sync record does not mean a dump day is absent. Use coverage and durable retry state. |
| High | Start a singleton from the custom entry point | [Entry point](../server/index.mjs) imports only the built handler; [runtime](../src/lib/server/runtime.ts) owns services and database | Specify one runtime lifecycle, build guards, readiness, a process lock, and the shutdown bridge. |
| High | Identical JSON suits Codex, Claude Code, and Desktop | Client-specific official references below | Provide distinct recipes and validate the rendered copy text; key prefixes cannot recover plaintext keys. |
| Medium | Commit registry pages while preserving the previous complete publication | Those requirements do not guarantee atomic publication together | Stage the entire bounded refresh, publish atomically, retain historical UUID mappings. |
| Medium | Re-evaluate and persist classification after sync | [Classification service](../src/lib/server/classification/sqlite.ts) evaluates at query time and has telemetry-aware preview digests | Preserve this architecture; reconcile source inputs, handle evidence gaps conservatively, and invalidate only relevant state. |
| Medium | Verification is a final phase | Original DAG deferred most checks until after scheduler/UI | Put preservation, privacy, replay, and lifecycle gates before dependent packages are accepted. |
| Medium | The UI is roughly a few files plus buttons | New fidelity/lifecycle states affect admin readers, activity, allocations, previews, analytics, and MCP quality reporting | Assign shared-file ownership and include cross-cutting consumers in the DAG. |

The official API reference documents flat project summary totals, summary timezone
parameters, and heartbeat fields that differ from the local dump-oriented
expectations. Its user-agent example does not settle the locally assumed
pagination envelope. These facts justify compatibility fixtures; they do not
prove what the connected account currently returns.
[WakaTime API documentation](https://wakatime.com/developers/)

Codex's supported configuration uses TOML and a bearer-token environment setting.
[Official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
Claude Code supports its own HTTP JSON configuration.
[Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)
Claude Desktop remote connectors use connector settings and a hosted connection.
[Claude remote-connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

## High-level design improvements

The revised design separates three different truths:

1. **What upstream returned:** a validated observation with provenance and a
   completeness/fidelity verdict.
2. **What the archive accepts:** a coherent per-date snapshot, which may retain
   an older detailed version when the new observation cannot replace it safely.
3. **What the operator decided:** durable classifications and whole-slice
   overrides whose lifetime does not depend on a source row remaining present.

That separation makes the important failure cases explicit. A newer summary
can disagree with an older detailed archive without destroying it. A vanished
entity can stop contributing time while its decision remains auditable.
Missing heartbeat identity cannot silently promote personal activity into work.

The execution model is bounded: one coordinator, SQLite persistence, a serialized
request gate, one date transaction at a time, and polling for UI progress. It
does not need Redis, a distributed scheduler, SSE, or a materialized
classification engine.

The product tradeoff is explicit: a live project total without file-level
attribution is useful archive data, but it remains unclassified until the
operator makes a whole-project/day decision. This can require manual work for
coarse days. The plan prefers that visible limitation to inferred timesheet
precision. Later automatic coarse classification needs a separate design for
handling finer personal/work exceptions.

The scope is larger than the original estimate because it changes data
reconciliation and lifecycle semantics. The revised plan contains eleven work
packages, five gates, a Mermaid DAG, an equivalent adjacency list, and a
three-worker dispatch sequence. The MCP page can land independently after
contracts; safe ingestion is the sync critical path.

## Evidence collected and limits

During this planning review:

- Inspected the milestone and parent plans, schema/migrations, importer,
  canonicalization interfaces, classification/analytics, OAuth/client,
  capability policy, runtime/hooks, admin views, and relevant tests.
- Checked official WakaTime, OpenAI, Claude, and SvelteKit documentation.
- Ran `pnpm test`: **570 tests passed across 34 files**.
- Ran `pnpm check`: **zero errors and zero warnings**.

These are baseline checks, not tests of the proposed implementation. No live
WakaTime ingestion, private credential access, production migration, deployment,
or client configuration was performed. Exact live payload compatibility,
file-lock native build compatibility, and end-to-end client authentication
remain implementation/release gates.

Only planning documents were changed during this review. Existing edits to the
Classify page were preserved.
