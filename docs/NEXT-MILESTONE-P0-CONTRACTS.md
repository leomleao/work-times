# Next Milestone P0 — Contracts Foundation Specification

Status: Complete and frozen.
Reviewed: 2026-09-09. Baseline commit: `9c00d70` (`chore: preserve next milestone baseline`).
Owning Package: `P0 (Contracts and Evidence)`. Gate: `G0 (Contracts Gate)`.

This document establishes the frozen interfaces, pure calendar arithmetic, synthetic fixture compatibility boundaries, forward migration specification, and process lifecycle contract required by [NEXT-MILESTONE.md §2, 3, 4, 6](./NEXT-MILESTONE.md).

---

## 1. Executive Summary & G0 Gate Status

Package P0 provides the pure foundation for the sync milestone without touching production ingestion or editing locked migrations.

### Frozen Artifacts and Deliverables

| File | Purpose | Verification Status |
| --- | --- | --- |
| `src/lib/server/sync/contracts.ts` | Shared types, lifecycle transitions, truthful Run aggregation, API DTOs, limits, and quality projections | 46 unit tests passing; typecheck clean |
| `src/lib/server/sync/calendar.ts` | Source-timezone calendar arithmetic, DST-safe day calculations, cadence windows, and startup catch-up selector | 30 unit tests passing; typecheck clean |
| `src/lib/server/sync/fixtures/index.ts` | 11 synthetic compatibility fixtures distinguishing edge cases and upstream response variants | Fully verified in targeted tests |
| `src/lib/server/sync/contracts.test.ts` | Unit tests for contracts, transition helpers, outcome aggregation, and fixtures | 46 tests passing |
| `src/lib/server/sync/calendar.test.ts` | Unit tests for calendar arithmetic, DST transitions, cadence slots, and gap selection | 30 tests passing |
| `docs/NEXT-MILESTONE-P0-CONTRACTS.md` | Authoritative reference specification for downstream packages (P1–P10) | Frozen |

Targeted verification: **76/76 tests passed** in `src/lib/server/sync/*.test.ts`.
Repository verification: **646/646 tests passed across 36 test files**; `pnpm check` reports **0 errors, 0 warnings**.

---

## 2. Frozen Contracts Reference (`sync/contracts.ts`)

### 2.1 LayerResult and DayCandidate

```ts
export type LayerResult<T> =
  | { kind: 'complete'; value: T; contentHash: string; observedAt: string }
  | { kind: 'restricted'; code: string; retryAt: string }
  | { kind: 'failed'; code: string; retryAt: string | null }
  | { kind: 'skipped'; reason: string };

export type DayCandidate = {
  date: string;
  timezone: string;
  connectionGeneration: number;
  summaries: LayerResult<NormalizedSummaryDay>;
  heartbeats: LayerResult<NormalizedHeartbeatDay>;
};
```

### 2.2 Normalized Models, Fidelity, and Scope Completeness

Fidelity distinguishes what the API actually returned versus an authoritative dump:

- `'entity_detail'`: Projects contain explicit, official file/app/domain entity breakdowns (`projects[].entities[]`).
- `'coarse_project'`: Projects contain total duration only (`projects[].total_seconds`); entity detail arrays are absent from the upstream response.
- `'verified_zero'`: Authoritative response with `total_seconds: 0.0` and empty projects array.

#### Per-Project Entity Detail Presence:
To prevent missing detail from being defaulted to a complete empty array, each project explicitly tracks `entityDetailState`:
- `'present'`: entity breakdown array was returned with entries.
- `'empty'`: entity breakdown array was explicitly returned as empty `[]` (authoritative zero entities).
- `'absent'`: entity breakdown array was omitted/undefined in upstream response (flat summary).

`coversRetainedScopes(incoming, accepted)` verifies that every previously accepted project scope is present in the replacement and has not suffered detail downgrade from `present` or `empty` to `absent`.

#### Slices and Attribution:

```ts
export type SliceKind = 'entity' | 'project_summary' | 'unattributed_residual';

export interface NormalizedSlice {
  projectName: string;
  entity: string;
  entityType: 'file' | 'app' | 'domain' | 'unattributed';
  totalSeconds: number;
  kind: SliceKind;
  isUnattributed: boolean;
  projectRootCount?: number | null;
  humanAdditions: number;
  humanDeletions: number;
  aiAdditions: number;
  aiDeletions: number;
  aiSessions: number;
}
```

- Coarse project totals produce one explicitly typed `project_summary` slice per project (`entity = projectName`, `kind = 'project_summary'`).
- A positive residual between daily total and project sums produces one `unattributed_residual` slice (`entity = '__unattributed__'`, `kind = 'unattributed_residual'`).
- Coarse slices remain unclassified by default. Automatic classification of coarse data is deferred.

### 2.3 ReconcileResult, Dispositions, and Complete Advisory Codes

```ts
export type ReconcileDisposition = 'updated' | 'unchanged' | 'preserved' | 'rejected';
export type ReconcileDayStatus = 'succeeded' | 'partial' | 'failed' | 'skipped';

export interface ReconcileResult {
  disposition: ReconcileDisposition;
  dayStatus: ReconcileDayStatus;
  codes: string[];
}
```

Every documented code used across reconciliation, execution limits, and transport policies is frozen in `RECONCILE_CODES`:
- `DETAIL_DOWNGRADE`: Ingesting lower-detail summary against an existing richer day; archive snapshot retained.
- `CURRENT_DAY_PROVISIONAL`: Active day in source timezone; provisional until source day closes.
- `TIMEZONE_CHANGED` / `TIMEZONE_MISMATCH`: Upstream timezone conflicts with pinned account timezone.
- `OVERCOUNT_TOLERANCE_EXCEEDED`: `sum(slices) - daily_total > 0.001s`; rejected, never clamped.
- `NEGATIVE_RESIDUAL`: Mathematical discrepancy; rejected.
- `MATHEMATICAL_INVARIANT_VIOLATION`: Violation of duration equations.
- `MISSING_REQUESTED_DATE`: Upstream response did not contain requested date.
- `INCOMPLETE_BODY`: Truncated or malformed response body.
- `VERIFIED_ZERO_ACCEPTED`: Authoritative zero accepted.
- `STALE_CONNECTION_GENERATION`: Token refresh or update attempted under obsolete generation.
- `STALE_SNAPSHOT_VERSION`: Candidate based on stale snapshot version.
- `RUN_CANCELLED`: Explicit cancellation by operator.
- `NO_DATES_UPDATED`: All dates restricted or skipped; run outcome marked partial.
- `SYNC_QUEUE_FULL`: More than 10 nonterminal runs queued in SQLite.
- `RESPONSE_SIZE_EXCEEDED`: Upstream response exceeds 16 MiB limit.
- `STAGED_DAY_SIZE_EXCEEDED`: Staged single-day SQLite transaction exceeds 64 MiB limit.
- `REGISTRY_PAGE_LIMIT_EXCEEDED`: Registry refresh exceeds 100 pages.
- `REGISTRY_ROW_LIMIT_EXCEEDED`: Registry refresh exceeds 10,000 rows.
- `REGISTRY_BYTE_LIMIT_EXCEEDED`: Registry refresh exceeds 16 MiB.
- `DAY_EXECUTION_TIMEOUT`: Single day execution exceeds 5-minute budget.
- `REQUEST_TIMEOUT`: Upstream HTTP request exceeds 30-second deadline.
- `UPSTREAM_RETRY_AFTER_EXCEEDED`: Upstream `Retry-After` exceeds remaining day budget.
- `UNSUPPORTED_HEARTBEAT_ID`: Heartbeat external ID is not a valid UUID.
- `UNSUPPORTED_HEARTBEAT_ENVELOPE`: Heartbeat response envelope violates schema.
- `UNSUPPORTED_HEARTBEAT_DEPENDENCY`: Dependency array contains invalid or non-string items.
- `HEARTBEAT_PAYLOAD_CONFLICT`: Conflicting payload observed for existing external ID.
- `REGISTRY_PAGE_REPETITION`: Registry pagination repeated an already seen page.
- `REGISTRY_CONFLICTING_ID`: Registry returned contradictory attributes for an existing UUID.
- `REGISTRY_INVALID_PAGINATION`: Registry pagination envelope numbers are inconsistent.

### 2.4 Lifecycle States and Transition Helpers

#### Run Lifecycle:
`queued` $\rightarrow$ `running` $\rightarrow$ `succeeded` | `partial` | `failed` | `cancelled` | `interrupted`

- Terminal states (`succeeded`, `partial`, `failed`, `cancelled`, `interrupted`) cannot transition.
- Validated via `isValidRunTransition(from, to)` and `assertValidRunTransition(from, to)`.

#### Date Lifecycle:
`pending` $\rightarrow$ `running` $\rightarrow$ `succeeded` | `partial` | `failed` | `skipped` | `cancelled` | `interrupted`

- Validated via `isValidDateTransition(from, to)` and `assertValidDateTransition(from, to)`.

#### Truthful Multi-Date Run Outcome Aggregation:
Computed across **all dates** in the run via `aggregateRunOutcome(dateResults, options)`:
1. Rejects nonterminal date input (`pending` or `running`) with an explicit error.
2. Explicit cancellation or interruption wins for the run outcome.
3. **Never reports `succeeded`** if:
   - ANY date has disposition `'preserved'` (forces `partial`).
   - ANY date has disposition `'rejected'` (forces `partial` or `failed`).
   - ANY date has a degraded capability or detail warning code (`DETAIL_DOWNGRADE`, `*_PLAN_RESTRICTED`, `*_ERROR`, `UNSUPPORTED_*`).
   - ANY date with status `'succeeded'` lacks an explicit disposition (`disposition === 'updated' || disposition === 'unchanged'`). Missing disposition is not proof of success and forces `partial`.
4. All dates succeeded/unchanged with detail met, explicit updated/unchanged disposition, and no degradation: `succeeded`.
5. All dates restricted/skipped: `partial` with `NO_DATES_UPDATED` (never `succeeded`).
6. No useful update and failures present: `failed`.

### 2.5 RunRequest, Idempotency, and Admin API DTOs

`RunRequest`:
- `mode`: `'recent' | 'backfill' | 'compare' | 'retry' | 'registry'`
- `trigger`: `'manual' | 'scheduled' | 'startup' | 'catchup'`
- `idempotencyKey`: string
- `rangeStartDate`, `rangeEndDate`, `retryDates`, `resumedFromRunId`

`computeRunRequestPayloadHash(req: RunRequest): string`:
- Generates a SHA-256 hash of canonicalized semantic request parameters.
- Replaying the same key with the same payload returns the original run; replaying the same key with a different payload returns `409 Conflict`.

Admin endpoints specified:
- `POST /api/admin/sync-runs` $\rightarrow$ `202 Accepted` (`CreateSyncRunResponseBody`)
- `GET /api/admin/sync-runs/:id` $\rightarrow$ `SyncRunDetailResponseBody`
- `POST /api/admin/sync-runs/:id/cancel` $\rightarrow$ `CancelSyncRunResponseBody`
- `POST /api/admin/sync-runs/:id/retry` $\rightarrow$ `RetrySyncRunResponseBody`
- `POST /api/admin/sync-settings` $\rightarrow$ `UpdateSyncSettingsResponseBody`
- `POST /api/admin/sync-registry/refresh` $\rightarrow$ `RefreshRegistryResponseBody`

### 2.6 MCP Data Quality Projection Contract

`McpDataQuality`:
- `asOf`: oldest required summary verification timestamp, or `null` if coverage has missing days.
- `hasMissingDays`: boolean.
- `hasStaleDays`: boolean.
- `hasLimitedDetail`: boolean.
- `advisoryCodes`: filtered allowlist of codes (`DETAIL_*`, `CURRENT_DAY_*`, `TIMEZONE_*`, `NO_DATES_*`, `RESIDUAL_*`, `STALE_*`).
- Scrubs non-work identities, personal seconds, raw upstream errors, and internal registry IDs.

---

## 3. Pure Calendar & Scheduling Specification (`sync/calendar.ts`)

### 3.1 Principles
1. Day boundaries strictly adhere to the source account timezone (`Europe/London`, `America/New_York`, etc.), never the host server's local timezone.
2. Date arithmetic operates purely in integer calendar day units via `addDays(date, n)` and `differenceInDays(from, to)`. It never uses millisecond offsets, preventing DST jump anomalies (e.g., 23-hour spring forward and 25-hour fall back days).
3. Dates are validated using `isValidDateString(str)` against real Gregorian calendar rules, including leap years.

### 3.2 Cadence Definitions

| Cadence Intent | Schedule | Target Date Window |
| --- | --- | --- |
| `recent` | Hourly at minute 00 | Today and yesterday (`[today - 1, today]`) in source timezone |
| `reconcile` | Daily at 03:00 source time | Previous 14 completed days (`[today - 14, ..., today - 1]`) |
| `compare` | Weekly on Monday at 04:00 source time | Previous 90 completed days (`[today - 90, ..., today - 1]`) |
| `startup` | Once after recovery | Today/yesterday, 7-day policy window gaps, then older gaps (capped at 31 dates) |
| `backfill` | On manual request | Inclusive date range (capped at 366 dates) |

### 3.3 Startup Catch-Up Gap Selection Specification

Rules for `selectStartupCatchupDates(options)`:
1. Represents internal missing coverage (gaps within archive history), eligible retryable failures, and unfinished dates from interrupted runs.
2. **Coexistence with Archive Data**: Includes due retryable failures and unfinished (pending/interrupted) dates even when `archiveDates` already contains accepted daily data, because daily summaries can coexist with unfinished optional evidence (e.g., heartbeats) or retryable comparison.
3. **Retry Deferral & Fail-Closed Timestamps**: Dates with future `next_retry_at` are skipped until due. Invalid or unparseable retry timestamps do not prove eligibility and are skipped for operator repair; future source-calendar dates are never selected.
4. **Bounded Gap Scanning**: Uses `coverageRange.end` to bound older gap scanning when supplied, preventing phantom gap generation beyond the requested coverage range.
5. **Strict Priority Ordering**:
   a. `today` in source timezone.
   b. `yesterday` in source timezone.
   c. Oldest uncovered dates in the recent 7-day policy window (`[today - 6, ..., today - 2]`), oldest first.
      *(An empty archive is seeded in this exact same order).*
   d. Older eligible work: internal missing coverage gaps, unfinished dates, and due retryable failures (chronological, oldest first).
6. **Deduplication & Cursor**: Deduplicates overlapping dates across sources, bounds batch to `maxDates` (31), and retains a durable continuation cursor pointing to the next date that could not fit.

### 3.4 Truthful Freshness Thresholds and Staleness Evaluation

Rules for `evaluateDateFreshness(date, record, now, timezone)`:
1. **Strict Date Validation**: Validates requested `date` against canonical Gregorian calendar rules; invalid date strings fail closed as STALE (`INVALID_DATE_STRING`).
2. **Future Requested Dates**: Dates after today in the source timezone fail closed as STALE (`FUTURE_REQUESTED_DATE`) and are not treated as recent.
3. **Coarse Project Freshness**: Newly accepted `coarse_project` days remain FRESH within normal age thresholds if no downgrade occurred; only an actual downgrade or preservation signal (`hasDetailDowngrade === true` or `statusCode === 'DETAIL_DOWNGRADE'`) marks a date stale with `DETAIL_DOWNGRADE_PRESERVED`.
4. **Unresolved restriction, failure, mismatch, or detail downgrade remains STALE regardless of age.**
5. A record explicitly marked `isStale` remains STALE.
6. Invalid timestamps, missing success timestamps, and future timestamps fail closed as STALE.
7. Disagreement between evidence and summary (`evidenceMatchesSummary === false`), or verified timezone and current timezone, is STALE.
8. Today returns `CURRENT_DAY_PROVISIONAL` until a successful check after its source-calendar day closes.
9. Standard age thresholds:
   - **Recent window** (today, yesterday): fresh within 2 hours.
   - **Reconciliation window** (dates 2–14 days back): fresh within 26 hours.
   - **Comparison window** (dates 15–90 days back): fresh within 8 days.
   - Older than 90 days: historical, not automatically overdue unless mismatch/downgrade/failure.

---

## 4. Synthetic Fixture Matrix & Compatibility Boundaries (`sync/fixtures/index.ts`)

The synthetic fixtures define and prove the 11 compatibility boundary edge cases:

| Fixture ID | Characteristic Upstream Shape | Preserved Invariant / Behavior |
| --- | --- | --- |
| `flat_project_summary` | `projects[].total_seconds` present; `projects[].entities` missing (`entityDetailState: 'absent'`) | Generates `project_summary` coarse slices; unclassified by default; does not default entities to empty array. |
| `verified_zero_day` | `grand_total.total_seconds: 0.0`, `projects: []`, complete range | Accepted as zero day; retires absent slices while preserving manual decisions; distinct from empty data. |
| `missing_requested_date` | `data: []` or returns date different from requested | Rejected with `MISSING_REQUESTED_DATE`; never assumed to be zero. |
| `incomplete_body` | Truncated JSON or missing `grand_total` | Fails closed with `INCOMPLETE_BODY`; existing archive retained. |
| `detail_downgrade` | Existing archive has entity detail; incoming summary is coarse | Preserves accepted entity detail snapshot; incoming observation recorded for lineage; disposition: `preserved`, code: `DETAIL_DOWNGRADE`. |
| `unsupported_heartbeats` | Malformed UUID, non-array envelope, non-string dependency array, or conflicting payload for existing ID | Rejects layer with bounded compatibility code (`UNSUPPORTED_HEARTBEAT_*`, `HEARTBEAT_PAYLOAD_CONFLICT`); never manufactures fake UUIDs. |
| `registry_pagination` | Page repetition loop, duplicate conflicting ID, inconsistent total | Detects anomaly and aborts whole refresh; previously published registry retained unchanged. |
| `timezone_mismatch` | `range.timezone` differs from pinned account timezone | Rejects observation with `TIMEZONE_MISMATCH`; prevents silent historical rebucketing. |
| `overcount_day` | `sum(project_totals) - total_seconds > 0.001s` | Rejects candidate with `OVERCOUNT_TOLERANCE_EXCEEDED`; never clamps away material discrepancy. |
| `tiny_positive_residual` | `total_seconds - sum(project_totals) = 0.005s` | Retains positive residual in `__unattributed__` residual slice; preserves sub-second amounts. |
| `connection_generation` | Background worker generation < active connection generation | Aborts token write with `STALE_CONNECTION_GENERATION`; prevents obsolete workers from corrupting reconnected account. |

---

## 5. Orchestrator-Frozen Forward Migrations Specification (for Package P1)

Existing migrations 001–004 must not be modified. Package P1 will implement the following sequential migrations using these exact filenames:

### 1. `005-sync-lifecycle.sql`
- **Tables Modified / Created**: `sync_runs`, `sync_days`, `sync_layer_state`.
- **Accepted vs Observed Per-Layer State**:
  - `sync_layer_state` tracks both accepted layer snapshot metadata (version, content hash, fidelity, source reference) and last observed attempt (status, code, retry_at, observed_at) per date and layer (`summaries`, `durations`, `heartbeats`).
- **`sync_runs` Extensions**:
  - Add `mode TEXT NOT NULL CHECK (mode IN ('recent', 'backfill', 'compare', 'retry', 'registry'))`.
  - Rebuild table to expand `status` constraint to 7 states: `CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted'))`.
  - Add `idempotency_key TEXT`, `payload_hash TEXT`.
  - Add `resumed_from_run_id INTEGER REFERENCES sync_runs(id)`.
  - Add `cancel_requested_at TEXT`.
  - Add unique partial index ensuring at most one `running` run: `CREATE UNIQUE INDEX idx_sync_runs_single_running ON sync_runs(status) WHERE status = 'running'`.
  - Trigger enforcing max 10 queued nonterminal runs (`SYNC_QUEUE_FULL`).
- **`sync_days` Extensions**:
  - Rebuild table to expand `status` constraint: `CHECK (status IN ('pending', 'running', 'succeeded', 'partial', 'failed', 'skipped', 'cancelled', 'interrupted'))`.
  - Add `disposition TEXT CHECK (disposition IN ('updated', 'unchanged', 'preserved', 'rejected'))`.
  - Add `advisory_codes_json TEXT`.
- **Rebuild Preservation**: Table rebuilds must be performed inside a single transaction with foreign keys enabled, preserving existing IDs, child rows, indexes, and triggers.

### 2. `006-reconciliation-overlay.sql`
- **Tables Modified / Created**: `day_project_entity_slices`, `daily_time_allocations`, `heartbeat_memberships`, `classification_revisions`.
- **`day_project_entity_slices`**:
  - Add `kind TEXT NOT NULL DEFAULT 'entity' CHECK (kind IN ('entity', 'project_summary', 'unattributed_residual'))`.
  - Add `snapshot_version INTEGER NOT NULL DEFAULT 1`.
- **`daily_time_allocations` Detachment & Semantic Identity**:
  - Remove `ON DELETE CASCADE` foreign key. Allocation is permanently bound to semantic identity `(date, project_id, entity)`.
  - Add `state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'detached'))`.
  - Add `detached_at TEXT`, `reattached_at TEXT`.
  - Update allocation duration check trigger so detached allocations retain their last-known duration without requiring a matching slice.
  - Append-only reconciliation revisions: update `classification_revisions` mutation types to include `reconciliation_adjusted`, `allocation_detached`, and `allocation_reattached`.
- **`heartbeat_memberships`**:
  - `(date TEXT NOT NULL, heartbeat_id INTEGER NOT NULL REFERENCES heartbeats(id) ON DELETE CASCADE, active INTEGER NOT NULL CHECK (active IN (0, 1)), PRIMARY KEY (date, heartbeat_id))`.
  - Seed memberships during migration from all existing migration 001 heartbeats with `active = 1`.

### 3. `007-user-agent-registry.sql`
- **Tables Created**: `user_agent_registry`, `user_agent_registry_staging`.
- **Columns**: `id TEXT PRIMARY KEY` (canonical UUID), `editor TEXT NOT NULL`, `user_agent_value TEXT NOT NULL`, `os TEXT NOT NULL`, `version TEXT`, `ai_model TEXT`, `ai_model_version TEXT`, `ai_model_complexity TEXT`, `is_browser_extension INTEGER`, `is_desktop_app INTEGER`, `first_seen_at TEXT`, `last_seen_at TEXT`, `is_historical INTEGER NOT NULL DEFAULT 0`.
- **Staging Table**: Identical schema for staging complete bounded refreshes prior to atomic publication.
- **Historical Mapping Retention**: Historical UUID mappings absent from newer upstream responses remain queryable with `is_historical = 1`.

### 4. `008-connection-lifecycle.sql`
- **Tables Modified**: `wakatime_oauth_connection`.
- **Columns**:
  - `generation INTEGER NOT NULL DEFAULT 1`.
  - `bound_archive_identity TEXT`.
  - `rebound_at TEXT`.
- **Triggers**: Enforce CAS validation on token refresh updates (`WHERE generation = NEW.generation`).

---

## 6. Process Lock & Runtime Lifecycle Specification

### 6.1 Lifecycle Contract
- The runtime registers a process-local handle on `globalThis[Symbol.for('work-times.lifecycle')]`.
- Exposes:
  - `start(): Promise<void>`
  - `stop(reason: 'shutdown', deadlineMs: number): Promise<void>`
  - `getReadiness(): RuntimeReadiness`
- The custom entry point (`server/index.mjs`) awaits readiness before accepting traffic, and calls `stop()` upon `SIGTERM` / `SIGINT` with a 20-second deadline.

### 6.2 Process Lock & `fs-ext` Compatibility Evidence
- Single-process ownership is enforced using an exclusive nonblocking file lock on `${databasePath}.lock`.
- In-memory test databases use an injected mock lock (`InjectedProcessLock`).
- On production Linux / macOS, `fs-ext`'s `flockSync(fd, 'exnb')` is specified.

#### Disposable Compatibility Proof (Node 24 & Docker):
A disposable compatibility test was executed outside tracked files:
1. **Host macOS Node 24.15.0**:
   - `fs-ext` installed and compiled in 4s.
   - `flockSync(fd, 'exnb')` and `flockSync(fd, 'un')` succeeded with expected semantics.
2. **Docker `node:24-bookworm-slim`** (matching project `Dockerfile` base image):
   - Built with native compiler tools (`python3 make g++`).
   - `flockSync(fd, 'exnb')` and unlock succeeded cleanly.
3. **No Lockfile Changes**:
   - The test was executed in disposable `/tmp` directories. `package.json` and `pnpm-lock.yaml` remain 100% untouched.

---

## 7. Verification Evidence & Downstream Handoff

### Targeted Test Evidence
Command: `pnpm vitest run src/lib/server/sync/contracts.test.ts src/lib/server/sync/calendar.test.ts`
```
 ✓ src/lib/server/sync/calendar.test.ts (30 tests)
 ✓ src/lib/server/sync/contracts.test.ts (46 tests)
 Test Files  2 passed (2)
      Tests  76 passed (76)
```

### Full Repository Verification
Command: `pnpm test && pnpm check && DATABASE_PATH=:memory: pnpm build`
```
 Test Files  36 passed (36)
      Tests  646 passed (646)
 Duration    1.14s
 svelte-check found 0 errors and 0 warnings
 vite build complete: build output generated cleanly
```

### Downstream Package Guidance:
- **P1 (Schema & Repositories)**: Implement exact migrations `005-sync-lifecycle.sql`, `006-reconciliation-overlay.sql`, `007-user-agent-registry.sql`, and `008-connection-lifecycle.sql` as specified in §5.
- **P2 (HTTP & OAuth)**: Implement request gating with `MIN_UPSTREAM_REQUEST_SPACING_MS` (1000ms), 30s deadline, full `Retry-After`, and connection generation CAS.
- **P3 (Ingestion & Fidelity)**: Implement pure normalizer mapping `flatProjectSummary` to `project_summary` slices, tracking `EntityDetailState` and scope completeness.
- **P9 (MCP Setup)**: Consume `McpDataQuality` and setup recipes using clean public URLs.
