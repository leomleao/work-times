# Work Times — Architecture and Implementation Plan

Status: implementation in progress

Last updated: 2026-09-06

Implementation alignment decisions:

- Preserve the agreed delivery order: importer, API sync, admin UI, application
  API keys, OAuth, then MCP and analytics.
- Use Svelte 5 and SvelteKit with `@sveltejs/adapter-node` wrapped in a custom
  Node entry point (`server/index.mjs`) hosting the SvelteKit request handler,
  native JSON admin API endpoints, Streamable HTTP MCP at `/mcp`, OAuth routes,
  and the background synchronization scheduler in a single unified Node process.
- Adopt a dark-first UI aesthetic inspired by Svelte Bits (bits-ui), providing
  dense, accessible controls and establishing a componentized foundation for
  future visualizations (such as Svelte-native interactive timeline and slice
  distribution components).
- Adopt an exact three-state classification model: activity is classified
  strictly into `work`, `personal`, or `unclassified` (eliminating the legacy
  `ignored` classification).
- Maintain classification as an immutable overlay over raw imported WakaTime
  facts; re-imports or API sync reconciliations never mutate or erase
  classification decisions, and all rule/allocation changes record append-only
  revision logs.
- Use the complete identity selector set for classification rules: computer/machine
  exact identity, editor exact identity, application exact identity, domain
  exact identity, project/repo exact identity, folder path prefix with
  path-boundary semantics and longest-prefix specificity, and exact
  file/window/entity. Selectors based on language, WakaTime category, branch,
  or dependencies are strictly disallowed.
- Rules apply globally across all historical and future incoming activity by
  default.
- Official additive slices are day/project/entity rows from daily
  `project.entities`, enriched with observed raw-heartbeat identity
  associations (machine and editor) without deriving duration from heartbeats.
- Evaluate classification rules by strict precedence: 1) whole-slice override,
  2) explicit manual priority, 3) selector specificity (exact entity > folder
  prefix > project/repo > machine/editor/application/domain), and 4) longest
  matching folder prefix. Deterministic sort fields may order display lists but
  must never silently decide a work/personal tie; equal-precedence conflicting
  matches leave the slice unclassified.
- Enable multi-tier classification scenarios, such as classifying a work laptop
  as work by machine identity while overriding a personal repository as personal
  by project or folder specificity.
- Specificity governs rule evaluation; rule changes require an explicit dry-run
  preview showing affected dates, slices, and seconds before the operator
  confirms reclassification.
- Manual overrides operate strictly as whole-slice one-offs (assigning all
  seconds of a day/project/entity slice to work or personal) without intra-slice
  fractional guessing.
- Resolve ambiguity conservatively: unassigned activity or equal-precedence
  conflicts default to `unclassified`, which never silently counts as work.
- Provide a suggestion-only broad-to-narrow triage flow in the admin UI,
  recommending broad machine, project, or folder rules first down to narrow
  slice exceptions, never auto-applying classifications silently.
- Guarantee work-only MCP privacy: MCP tools and resources expose `work` activity
  exclusively; `personal` and `unclassified` activity are strictly private to
  the operator and never exposed or leaked through MCP endpoints.
- Use the published MCP TypeScript SDK v2 package split
  (`@modelcontextprotocol/server` and `@modelcontextprotocol/node`), not the
  separate `@modelcontextprotocol/sdk` v1 line used by existing sibling apps.
- Canonicalize dependency arrays as set-like values before hashing heartbeat
  records.
- Use a guarded native JSON parser for the supplied dumps; keep a parser
  abstraction so streaming can be added when file size or memory evidence
  requires it.
- Treat summaries, durations, and heartbeats as independently available API
  capabilities and allow a useful partial sync when a Free-plan endpoint is
  unavailable.
- Require scope and dimension predicates in every breakdown query so
  account-level and project-nested rows cannot be double-counted.
- Use one application container with transactional SQLite migrations during
  startup.

## 1. Objective

Build a private, always-on service that:

1. Archives the owner's WakaTime activity into a locally controlled database.
2. Imports the existing WakaTime daily and raw-heartbeat exports with an
   explicit input-size guard, measured memory budget, and replaceable parser.
3. Periodically reconciles the archive with the WakaTime API.
4. Adds a durable local classification layer that separates activity into
   exactly `work`, `personal`, and `unclassified` states as an immutable overlay
   without changing imported WakaTime facts.
5. Provides a small authenticated Svelte 5 / SvelteKit administrator interface
   (dark-first, Svelte Bits-inspired, with a component-based visualization path)
   for sync operations, classification rules, whole-slice overrides, settings,
   API keys, OAuth clients, access grants, and operational status.
6. Exposes a read-only Model Context Protocol (MCP) service with strict work-only
   privacy that helps agents answer questions about work performed on a day,
   week, project, branch, language, or category and prepare evidence for
   timesheet entries without leaking personal or unclassified data.
7. Runs as a hardened Docker image on the home server, with persistent data,
   private secrets, health checks, backups, and access through the existing
   reverse-proxy/Cloudflare pattern.

The application is a personal archive and analysis service, not a replacement
WakaTime client and not a multi-user employee-monitoring product.

## 2. Product boundaries

### In scope

- Historical import from WakaTime daily and heartbeat data dumps.
- Incremental read-only WakaTime API synchronization.
- WakaTime-compatible daily totals and breakdowns.
- Raw activity evidence for detailed local queries.
- Daily, weekly, and arbitrary date-range analysis.
- Manual and rule-based classification into exactly `work`, `personal`, and
  `unclassified` states via an immutable overlay using identity selectors only
  (computer/machine, editor, application, domain, project/repo, folder path
  prefix with path-boundary semantics, and exact file/window/entity), global
  history+future rules, preview-confirmed reclassification, and whole-slice
  one-offs.
- Work-only timesheet evidence grouped by day and project.
- Work-only MCP privacy ensuring personal and unclassified activity is strictly
  excluded from all agent-facing queries and resources.
- A single-operator Svelte 5 + SvelteKit dark-first admin login and web interface
  (Svelte Bits-inspired).
- Scoped application API keys for MCP clients.
- Standards-based OAuth onboarding for remote MCP clients.
- Docker deployment, database migration, backup, restore, and monitoring.

### Out of scope for the first release

- Sending or editing WakaTime heartbeats.
- Organization/team dashboards or other people's WakaTime data.
- A complete clone of the WakaTime dashboard.
- Arbitrary SQL exposed through MCP.
- Inferring completed outcomes solely from elapsed time.
- Disallowed classification selectors: language, WakaTime category, branch,
  or dependency selectors (identity selectors only).
- Regex, glob, substring, or loose pattern matching for classification rules
  (folder prefix requires path-boundary semantics; machine, editor, application,
  domain, project/repo, and entity require exact identity matching).
- Silent auto-classification, guessing, or arbitrary tie-breaking for ambiguous
  activity (conservative ambiguity requires an explicit unclassified default
  when equal-precedence rules conflict).
- Git commit, pull-request, calendar, or issue-tracker correlation. These are
  valuable future enrichments, because WakaTime alone shows activity rather
  than proving what was delivered.
- Automatically submitting or editing entries in an external timesheet system.
  The first release provides evidence and draftable totals only.

## 3. Research and licensing position

WakaTime documents API-key and OAuth access, read-only summaries, durations,
heartbeats, projects, stats, insights, and full data dumps. Its data-dump API
can produce daily or heartbeat exports covering activity since account
creation. As of 2026-09-06, WakaTime's pricing page lists one week of dashboard
history on Free and separately states that older Free-plan stats remain stored
and exportable. That statement supports the dump-first archive design, but it
does not guarantee that every historical API endpoint is available to every
plan; live discovery must still probe each capability independently.

The reviewed WakaTime terms do not expose a separate API licence or an express
prohibition on privately archiving and analysing one's own exported activity.
They grant revocable access, require lawful use, prohibit overloading the
service, and reserve WakaTime intellectual property and trademarks. This makes
the proposed private use technically and practically supportable, but this
document is not legal advice. A new review is required before making the
service commercial, ingesting other users' information, or redistributing
WakaTime-derived data.

Operational rules derived from that review:

- Do not use WakaTime logos or imply endorsement.
- Do not copy WakaTime service code. The application consumes documented data.
- Keep API traffic well below the documented limit of fewer than 10 requests
  per second averaged over five minutes. The synchronizer will serialize calls
  and normally stay at or below one request per second.
- Use OAuth rather than a personal API key if the product ever supports other
  WakaTime users.
- Keep real exports, API responses, and personal data out of the source
  repository and distributable Docker image.
- Select the Work Times source-code licence separately. A private/proprietary
  repository requires no public distribution choice; MIT is a reasonable
  option if the code is later open-sourced.
- Generate a dependency licence report and software bill of materials as part
  of release verification.

Primary references:

- <https://wakatime.com/developers/>
- <https://wakatime.com/faq>
- <https://wakatime.com/pricing>
- <https://wakatime.com/legal/terms-of-service>
- <https://wakatime.com/legal/privacy-policy>
- <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports>
- <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/README.md>
- <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md>

## 4. Existing export inspection

The supplied exports were inspected using compact aggregate queries. No email,
project name, branch, entity/file path, machine name, token, or raw heartbeat
was copied into this document.

### 4.1 Shared envelope

Both exports use this top-level structure:

```text
{
  user: { ... },
  range: { start, end },
  days: [ ... ]
}
```

Observed properties:

- Daily export size: approximately 24 MB.
- Heartbeat export size: approximately 67 MB.
- Export period: 2016-11-04 through 2026-09-05.
- Both exports contain 3,593 calendar-day entries, including empty days.
- The embedded user object has 59 fields and includes private profile and
  account configuration. Only required fields will be normalized; the full
  object remains private source data and is never exposed through MCP.

### 4.2 Daily export

Each day may contain:

- `date`
- `grand_total`
- `categories[]`
- `dependencies[]`
- `editors[]`
- `languages[]`
- `machines[]`
- `operating_systems[]`
- `projects[]`

There are 571 days with a non-zero daily total and 3,022 zero-total days.

Most breakdown rows contain a stable metric shape:

```text
name
total_seconds
percent
hours / minutes / seconds
decimal / digital / text
```

The formatted duration fields are redundant. The normalized database will use
`total_seconds` as the canonical numeric measure and keep the original row JSON
for lossless preservation.

Project rows are hierarchical. A project contains its own `grand_total` and
nested breakdowns for:

- branches
- categories
- dependencies
- editors
- entities
- languages
- machines
- operating systems

Editor, entity, project-total, and account-total records may also carry AI and
human contribution information, including:

- AI and human line additions/deletions
- input, cached-input, and output tokens
- prompt counts and prompt-length statistics
- AI session counts
- per-model line changes and costs
- aggregate estimated AI cost

Per-model breakdown objects currently contain `name`, `lines`, and `cost`.
These structures must remain forward-compatible because new AI fields or
models may appear without notice.

### 4.3 Heartbeat export

Observed totals:

- 82,318 heartbeat rows.
- 664 days containing at least one heartbeat.
- A maximum of 2,404 heartbeats on one day.
- 2,929 empty heartbeat days.
- 68,548 timestamps have a fractional-second component.

Observed heartbeat fields:

```text
id
user_id
time
created_at
entity
type
category
project
project_root_count
branch
language
dependencies[]
machine_name_id
user_agent_id
lines
lineno
cursorpos
is_write
ai_line_changes
human_line_changes
ai_input_tokens
ai_cached_input_tokens
ai_output_tokens
ai_prompt_length
ai_session
ai_subscription_plan
```

`dependencies` is always an array in the observed export and its elements are
strings. Many other fields are nullable, particularly branch, language,
cursor position, line number, project-root count, AI metadata, and human line
changes. Import validators must accept documented nullability while rejecting
wrong non-null types.

Heartbeat time will be normalized to an integer epoch-microsecond value for
exact ordering while preserving the original numeric representation in raw
JSON. The WakaTime heartbeat ID remains the primary external identity.

### 4.4 Important anomalies and resulting decisions

The export contains 42 duplicated heartbeat IDs. Before canonicalization:

- 41 duplicate pairs are exact record duplicates.
- One duplicate pair contains exactly the same dependencies in a different
  array order.
- No observed ID occurs more than twice.

Dependencies are semantically a set for this archive. The canonicalizer will
trim/validate dependency strings, remove exact repeated items, sort the array
using a deterministic ordinal comparator, and use that canonical array when
constructing the record hash. Stable object-key ordering is also required for
the hash input. After this normalization, all 42 duplicate-ID groups are exact
duplicates and there are no conflicting payload groups in the supplied dump.

The importer must still not rely on a simple `INSERT ... ON CONFLICT id` that
silently discards an unexamined payload. It will:

1. Preserve a hash-addressed variant for every distinct payload seen for an
   external heartbeat ID.
2. Deduplicate canonically identical repeated payloads while recording their
   occurrence count.
3. Quarantine and report future post-canonicalization conflicts that differ in
   core fields.
4. Display duplicate and conflict counts in the admin import report.

There are also 93 days containing raw heartbeats while the daily export reports
zero calculated time. Those days contain only 113 heartbeats in total, which
indicates sparse events that WakaTime did not turn into duration. Consequently:

- Daily-export/API summaries are authoritative for elapsed-time totals.
- Heartbeats are authoritative evidence of activity events and fine-grained
  context.
- The application must never estimate work duration by counting heartbeats.
- A daily summary and its heartbeats are related datasets, not interchangeable
  representations.

## 5. Target architecture

```text
                                 +-------------------------+
Browser -- admin session ------> | Admin UI + admin API    |
                                 | /login, /admin, /api/*  |
                                 +------------+------------+
                                              |
Agents -- OAuth/Bearer ----------> MCP /mcp   |
                                              |
                                  +-----------v-------------+
                                  | Work Times application  |
                                  |                         |
                                  | - scheduler             |
                                  | - WakaTime client       |
                                  | - guarded dump importer |
                                  | - classification engine |
                                  | - analytics service     |
                                  | - auth/OAuth service    |
                                  +-----------+-------------+
                                              |
                                   SQLite WAL /data/work-times.sqlite
                                              |
                                      WakaTime HTTPS API
```

### 5.1 Application shape

Use one TypeScript/Node application and one Docker runtime container:

- HTTP server for the SvelteKit admin UI, admin JSON API, OAuth endpoints,
  Streamable HTTP MCP endpoint at `/mcp`, and minimal health endpoint.
- In-process scheduler for incremental synchronization.
- SQLite database in WAL mode for concurrent sync writes and MCP/admin reads.
- Guarded native JSON importer for the current dump sizes, behind a parser
  interface that permits a streaming implementation when evidence requires it.
- Svelte 5 + SvelteKit admin application compiled with `@sveltejs/adapter-node`
  and mounted within the custom Node entry point (`server/index.mjs`). This single
  Node process serves the SvelteKit SSR frontend, static assets, native JSON
  admin API endpoints, OAuth endpoints, Streamable HTTP MCP at `/mcp`, and the
  in-process background sync scheduler; no separate frontend service.
- Dark-first Svelte Bits-inspired UI architecture: built with Svelte 5 runes,
  accessible primitive foundations (bits-ui / Svelte Bits design principles),
  dense data tables, responsive layouts, and an extensible component-based
  visualization path for time distributions, day/week activity breakdowns, and
  future interactive timeline components.
- Published MCP TypeScript SDK v2 packages `@modelcontextprotocol/server` and
  `@modelcontextprotocol/node`, pinned with exact lockfile versions. As verified
  on 2026-09-05, both are published at `2.0.0`; the monolithic
  `@modelcontextprotocol/sdk@1.30.0` is the v1 release line.

SQLite is appropriate because this is a single-user service with one ingestion
writer and modest concurrent reads. Introduce PostgreSQL only if the product
becomes multi-user or query concurrency materially exceeds this design.

### 5.2 Module boundaries

```text
src/
  config/           validated environment and runtime settings
  db/               migrations, schema, connection, repositories
  wakatime/         API client, response contracts, rate limiting
  import/           guarded daily/heartbeat dump importers
  sync/             scheduler, reconciliation, run state
  classification/   immutable overlay engine, identity rules, preview calculator, allocations, coverage
  analytics/        daily/weekly/project/timeline queries (work-only MCP privacy filtering)
  auth/             admin sessions, CSRF, API keys, OAuth
  admin-api/        cookie-authenticated control-plane routes
  mcp/              tools, resources, prompts, transport
  web/              SvelteKit admin UI (Svelte 5 runes, Svelte Bits-inspired components, visualization path)
  observability/    safe structured logs, metrics, audit events
  cli/              password hash, import, sync, backup, checks
```

The WakaTime client is available only to import/sync code. MCP handlers query
the local analytics layer (which strictly filters on work-classified activity)
and cannot make upstream WakaTime requests.

## 6. Data architecture

### 6.1 Source and lineage tables

`source_imports`

- source type: `daily_dump`, `heartbeat_dump`, or API endpoint
- SHA-256 source hash
- covered range
- file size or response size
- import start/end timestamps and outcome
- counts, duplicate counts, conflict counts, and error summary
- no source filename, because supplied names may contain personal information

`source_payloads`

- source import/run ID
- endpoint and covered day/range
- source payload SHA-256 hash
- original JSON payload or lossless per-record JSON
- first/last seen timestamps

This raw layer preserves fields that do not yet have normalized columns.

### 6.2 Account and projects

`account_settings`

- WakaTime user ID
- timezone
- weekday start
- keystroke timeout
- writes-only setting
- plan capability flags needed to interpret API behavior
- source JSON kept private

Do not normalize unrelated profile fields such as email, social handles, bio,
photo URL, or billing-related settings unless a later feature explicitly needs
them.

`projects`

- stable internal ID
- WakaTime project identity/name
- first and last activity dates
- first and last sync timestamps
- optional source metadata

### 6.3 Heartbeats

`heartbeats`

- internal primary key
- unique external heartbeat ID
- occurred-at epoch microseconds and UTC timestamp
- WakaTime local date
- entity, type, category, project, branch, language
- project-root count, machine and user-agent IDs
- line/cursor/write fields
- AI/human line-change and token fields
- canonical raw JSON
- first and last seen timestamps

`heartbeat_dependencies`

- heartbeat internal ID
- dependency name
- unique pair constraint
- 220,103 source relationships in the supplied heartbeat export before
  canonical duplicate elimination

`heartbeat_variants`

- external heartbeat ID
- canonical payload SHA-256 hash
- raw JSON
- occurrence count
- first/last seen
- conflict classification

Dependencies remain present in each heartbeat's lossless raw JSON, but the
normalized relationship table is the indexed query path. Initial import uses
prepared/batched inserts inside bounded transactions; it must not execute
220,103 individually committed inserts. `json_each()` remains useful for
diagnostics but is not the primary MCP dependency-search path because it cannot
provide the same direct lookup index.

Canonically identical duplicate payloads increment the occurrence count. A
future conflict never overwrites its other variant.

### 6.4 WakaTime-derived totals

`daily_totals`

- local date and timezone
- authoritative WakaTime `total_seconds`
- normalized AI/human totals
- per-model data JSON
- complete raw `grand_total` JSON
- source hash and last reconciliation timestamp

`daily_dimension_totals`

- local breakdown date
- scope: account or project
- optional project ID/name
- dimension: project, category, dependency, editor, entity, language, machine,
  operating system, or branch
- dimension name and optional entity type/machine ID/project-root count
- `total_seconds` and percentage
- normalized AI/human metrics when present
- raw row JSON

This generic representation supports the observed account-level and nested
project-level shapes without creating a separate table for every dimension.
Indexed generated/query columns will cover the frequent date, project,
dimension, and name filters.

The supplied daily dump contains 19,842 account-scope breakdown rows (including
account-level project rows) and 40,219 project-scope nested rows. These are two
views of related activity and must never be added together. Query invariants:

- elapsed-time totals come from `daily_totals`, not by summing every dimension;
- every breakdown query supplies an explicit `scope` and `dimension` predicate;
- account project totals use
  `WHERE scope = 'account' AND dimension = 'project'`;
- nested project analysis uses
  `WHERE scope = 'project' AND project_id = ? AND dimension = ?`;
- repository query helpers require `scope` as a non-optional typed argument;
- tests intentionally combine both scopes and fail if a query double-counts.

### 6.5 Local classification overlay

Classification is locally authored metadata. It is not inferred as a permanent
fact from WakaTime, written back upstream, or stored directly on imported rows.
This separation ensures a re-import or API reconciliation cannot erase an
operator decision.

The fixed top-level classifications are exactly:

```text
work          eligible for work-only MCP and timesheet evidence
personal      explicitly personal activity; strictly private and excluded from MCP
unclassified  no decision yet; excluded from work totals and MCP
```

The legacy `ignored` status is eliminated: noise or non-work items are classified
as `personal` or left `unclassified`. Custom display labels and an optional
`timesheet_code` may refine work entries, but they do not replace the fixed
classification semantics. This keeps filters and authorization predictable.

#### Core classification principles

- **Immutable overlay**: Classification decisions are layered over WakaTime
  facts without altering source rows, daily summaries, or heartbeats. Re-imports
  or API syncs preserve all classifications. Every mutation writes an
  append-only revision record (`classification_revisions`).
- **Complete identity selector set**: Classification rules match against
  real-world identity boundaries, not descriptive code properties. The complete
  supported selector set is:
  1. `computer/machine`: exact computer or machine identity (`machine_name_id`
     or machine hostname/ID).
  2. `editor`: exact editor identity (e.g. VS Code, Cursor, Xcode).
  3. `application`: exact application identity (e.g. browser, terminal, desktop app).
  4. `domain`: exact domain identity (e.g. `github.com`, `linear.app`, internal company hostname).
  5. `project/repo`: exact project or repository identity.
  6. `folder_prefix`: folder path prefix with path-boundary semantics (e.g.
     `/Users/leo/work/` matching subpaths strictly terminating on `/` path
     boundaries) and longest-prefix specificity.
  7. `entity`: exact file path, window title, or entity identifier.
- **Disallowed selectors**: Selectors based on programming language, WakaTime
  category (e.g. `coding`, `building`, `debugging`), git branch, or dependencies
  are strictly forbidden. These dimensions are descriptive attributes of code
  rather than definitive identity boundaries, and their use causes false
  cross-cutting misclassifications.
- **Global history + future scope**: Rules apply globally across all historical
  dates and future incoming sync data by default, providing consistent
  classification across the entire timeline unless an explicit whole-slice
  one-off allocation exists.
- **Evaluation precedence**: When evaluating candidate rules for an activity
  slice, precedence is strictly resolved in the following order:
  1. Whole-slice one-off override (`daily_time_allocations` for that exact
     day/project/entity slice).
  2. Explicit manual priority (integer priority set on the rule by the operator;
     higher priority evaluated first).
  3. Selector specificity hierarchy:
     `exact entity` > `folder_prefix` (longest matching prefix wins) >
     `project/repo` > `computer/machine`, `editor`, `application`, `domain`.
  4. Longest matching folder prefix: when multiple `folder_prefix` rules match
     at equal priority, the rule with the longest path prefix takes precedence.
- **Conflict resolution and conservative ambiguity**: If rule evaluation
  results in conflicting matches (`work` vs `personal`) at equal precedence,
  arbitrary tie-breaking is strictly forbidden. Deterministic sort fields
  (such as rule ID, rule name, or timestamp) may order display lists in the
  admin UI, but must never silently decide a work/personal tie. Conflicting
  matches default conservatively to `unclassified`. Unclassified time never
  silently counts as work.
- **Work laptop + personal repo override**: Multi-tier selector rules cleanly
  handle hybrid development environments. An operator can define a broad machine
  rule classifying all activity on a work laptop as `work`, while defining a
  project/repo rule (or folder prefix rule like `/Users/leo/dev/personal/`)
  classifying a personal repository as `personal`. Because project and
  folder-prefix selectors have higher specificity than computer/machine
  selectors, personal repo activity on the work laptop is correctly classified
  as `personal` without requiring daily manual adjustments. Conversely, a
  whole-slice one-off allocation on a specific date takes absolute precedence
  over all rules.
- **Specificity with preview-confirmed reclassification**: Creating, updating,
  or deleting a rule triggers a dry-run reclassification preview that calculates
  the exact impacted dates, day/project/entity slices, and shifted seconds
  across the entire dataset. The operator must review and confirm this preview
  before the rule takes effect.
- **Whole-slice one-offs**: For specific day/project/entity slice combinations
  requiring an exception, the operator records a whole-slice one-off allocation
  in `daily_time_allocations`. Overrides operate strictly at the granularity of
  the whole slice (all seconds of that slice assigned to work or personal)
  without fractional intra-slice guessing.
- **Suggestion-only broad-to-narrow UI**: The admin interface presents
  classification assistance via suggestion-only workflows, moving from broad
  (high-volume unclassified machines, projects, or folder prefixes) to narrow
  (individual date/slice exceptions), but never automatically applies rules or
  guesses classifications without explicit operator confirmation.
- **Work-only MCP privacy**: MCP tools filter strictly on `work` classification.
  `personal` and `unclassified` projects, files, branches, and durations are
  completely hidden from agents. Responses report unclassified coverage metrics
  (such as `unclassified_seconds` and `coverage_percentage`) so agents can
  assess whether timesheet evidence is complete, without exposing private
  project identities.

#### Additive time slices

Calculated classification totals must use mutually exclusive, additive slices:

1. Official additive slices are day/project/entity rows from daily
   `project.entities` in the WakaTime daily summary data.
2. Each daily project.entity row provides an authoritative `total_seconds`
   duration.
3. Slices are enriched with observed raw-heartbeat identity associations
   (computer/machine and editor) for that date, project, and entity, without
   deriving duration from heartbeats. Elapsed time is never estimated or
   accumulated from heartbeat counts; duration strictly comes from daily summary
   rows.
4. Create an `unattributed` slice for any positive difference between
   `daily_totals.total_seconds` and the sum of that day's project.entities
   slices.
5. Apply the precedence hierarchy: 1) manual whole-slice override, 2) explicit
   manual priority, 3) selector specificity, 4) longest matching folder prefix.
6. If matching rules produce equal-precedence conflicting work/personal matches,
   leave the slice `unclassified`.
7. Manual overrides operate strictly as whole-slice one-offs (allocating all
   seconds of that day/project/entity slice to `work` or `personal`).
   Intra-slice fractional guessing is forbidden; any slice without a definitive
   rule or whole-slice allocation defaults to `unclassified`.

This model prevents category, language, entity, branch, and project views from
being summed together. Those dimensions describe the classified time slice;
they are not additional time.

Raw heartbeat evidence inherits the effective classification of its local
day/project/entity slice. A heartbeat-specific annotation may change which
evidence is displayed, but it must not manufacture or reallocate
WakaTime-derived seconds. Fine-grained time splits require a future
duration-level source with proven additive semantics.

#### Classification schema tables

`classification_rules`

- stable UUID/text primary key and operator-facing name
- rule classification (`work` or `personal`)
- selector type enum: `machine`, `editor`, `application`, `domain`, `project`, `folder_prefix`, `entity`
- selector value (exact identifier, domain name, project identity, folder path prefix with path boundaries, or exact entity path)
- rule priority integer (explicit manual priority, higher values evaluated first)
- enabled state boolean
- optional timesheet code / display label
- rule creation and update timestamps
- check constraint enforcing allowed selector types (disallowing language, category, branch, dependency)

`daily_time_allocations`

- stable allocation primary key
- calendar date
- project ID or the unattributed pseudo-project
- entity path (exact file path or `__unattributed__`)
- slice allocation classification (`work` or `personal`)
- allocated seconds (exact match to day/project/entity slice total)
- optional timesheet code and operator note
- allocation creation and update timestamps
- unique constraint on `(date, project_id, entity)` enforcing whole-slice exclusivity

`classification_revisions`

- monotonically increasing revision integer
- mutation type (`rule_created`, `rule_updated`, `rule_deleted`, `allocation_created`, `allocation_deleted`)
- target entity type and safe target identifiers
- prior and new classification metadata (lossless JSON)
- affected summary (JSON: affected dates, slice count, shifted seconds)
- actor identifier and timestamp

Every classification mutation increments the revision and invalidates derived
classification caches. Imported/source rows remain unchanged.

Classification invariants:

- `work + personal + unclassified = daily_totals.total_seconds` for every
  imported summary day, within a documented sub-second tolerance;
- unclassified time never silently counts as work;
- personal and unclassified activity are strictly hidden from MCP clients
  (work-only privacy);
- sync and re-import preserve rules, allocations, and revision history;
- a deleted or renamed upstream project retains its historical classification;
- rule changes provide a dry-run preview of affected dates, projects, and
  seconds before confirmation;
- timesheet and summary queries report unclassified time and coverage percentage
  in the requested range so the operator or agent knows when the result is
  incomplete.

### 6.6 Operational and security tables

- `sync_runs`
- `sync_days`
- `app_settings`
- `admin_sessions`
- `api_keys`
- `oauth_clients`
- `oauth_grants`
- `oauth_authorization_codes`
- `oauth_token_families`
- `classification_rules`
- `daily_time_allocations`
- `classification_revisions`
- `audit_events`

All schema changes use versioned migrations. The application refuses to serve
against an older or partially applied schema.

## 7. Import and synchronization

### 7.1 Guarded historical import

A local Node 24 benchmark parsed the approximately 67 MB heartbeat export with
native `JSON.parse` in roughly 124 ms and approximately 66 MB of parser heap.
At the current single-user scale, a streaming SAX dependency and its additional
state-machine complexity are not justified by that evidence.

The first implementation will use native parsing with explicit safety limits:

- inspect file size before reading;
- parse one export file at a time;
- default `MAX_DIRECT_IMPORT_BYTES` to 96 MiB, above the current largest dump
  but well below the container memory allowance;
- reject a larger input with a clear diagnostic unless a tested streaming
  reader is enabled;
- validate and persist one day at a time after parsing, without building extra
  whole-export maps or duplicate arrays;
- release source buffers/document references before opening the next dump;
- measure peak RSS in the real import acceptance test.

The importer exposes a reader interface so a streaming implementation can be
added without changing normalization or persistence. Add it only when an
export exceeds the direct-parser threshold or observed peak memory fails the
container budget. Do not implement an ad-hoc brace-counting/day-chunk parser;
native parsing or a well-tested streaming parser are the acceptable paths.

Import algorithm:

1. Open the file read-only, enforce the size limit, and calculate its SHA-256
   over the exact source bytes.
2. Validate the envelope and account/range metadata.
3. Process one day and bounded record batch at a time.
4. Commit at day boundaries or safe bounded batches.
5. Store normalized rows and lossless raw JSON.
6. Record duplicate variants and quarantined conflicts.
7. Verify row counts and covered dates before marking the import successful.
8. A repeated import of the same source hash becomes an idempotent no-op unless
   explicitly forced.

The real dumps remain local and ignored. Tests use small synthetic and fully
anonymized fixtures representing all observed shapes and anomalies.

### 7.2 Safe live API discovery

Repository safety must precede credential creation:

1. Commit `.gitignore` and `.dockerignore` entries for `.env`, `.local/`,
   dumps, API samples, database files, WAL/SHM files, and backups.
2. Commit an `.env.example` with empty placeholders only.
3. Create an ignored `.env` with mode `0600` for the operator to populate.
4. Verify the paths using `git check-ignore` before accepting a credential.
5. Load `WAKATIME_API_KEY` inside the process.

The discovery command will use HTTP Basic authorization in memory. It will not
put the key or its reversible Base64 encoding in a URL, command-line argument,
error object, or log message.

Initial read-only discovery calls:

- current user/account
- projects
- recent summaries
- a recent non-empty duration/day
- heartbeats for a recent active day
- recent stats and insights
- existing data-dump list

Private samples go under `.local/wakatime-discovery/` with directory mode
`0700` and file mode `0600`. Console output contains only status, counts, field
names, and validation results. Sanitized synthetic fixtures are produced from
the learned shape; real values are never committed.

### 7.3 Incremental sync policy

- On startup: identify and catch up missing dates.
- Hourly: refresh today and yesterday.
- Nightly: replace/reconcile the previous 14 days.
- Weekly: compare broader summary totals and flag inconsistencies.
- Manually: support bounded `sync`, `backfill`, and `reconcile` date ranges.

For every reconciled date, stage incoming records and replace that date inside
one database transaction. This removes activity that WakaTime deleted or
reclassified instead of leaving stale local rows.

Requests are serialized and use:

- explicit connection and response timeouts
- bounded exponential backoff with jitter for `429` and temporary `5xx`
- `Retry-After` when provided
- a conservative maximum of one request per second
- persisted progress so a restart resumes safely
- no automatic retry of permanent `4xx` responses

The WakaTime account timezone defines source-day boundaries. Store UTC event
time, source local date, and timezone together so daylight-saving transitions
remain interpretable.

### 7.4 Plan-aware capability degradation

The supplied account metadata reports neither Basic nor Premium features.
WakaTime API availability may therefore differ by endpoint: recent summaries
can remain available while durations or raw heartbeats return an endpoint-level
payment/permission response. The sync engine treats availability as a
capability matrix rather than one all-or-nothing connection state:

```text
summaries   required baseline for calculated time
durations   optional finer-grained calculated activity
heartbeats  optional raw incremental evidence
```

Behavior:

- Probe each capability independently during discovery.
- Distinguish a bad global credential (for example, `users/current` also
  fails) from an endpoint-specific `402`/`403` plan restriction.
- A plan-restricted duration or heartbeat endpoint is not retried in a tight
  loop and does not fail an otherwise successful summary sync.
- Record the run as `partial` with a stable advisory code, not `failed`.
- Show the restriction and its impact in the admin UI without including the
  upstream response body when it could contain private information.
- Retry a restricted capability only on a conservative scheduled probe or an
  explicit admin `Test access` action.
- Track `summary_fresh_through`, `duration_fresh_through`, and
  `heartbeat_fresh_through` separately.
- Include layer-specific freshness in MCP results. An agent must be told when
  totals are current but raw entity/timeline evidence ends at the dump date.

The existing heartbeat dump remains the historical raw baseline. If only a
recent summaries window is available, the hourly schedule archives those
summaries permanently before they age out. A downtime gap beyond the available
window is surfaced explicitly and can later be repaired with a new data dump.

## 8. Admin application

The admin application is part of the first complete release. It is a control
plane, not merely an activity dashboard. Built with Svelte 5 (using runes) and
SvelteKit via `@sveltejs/adapter-node`, it is embedded directly into the custom
Node server entry.

The user interface follows a dark-first aesthetic inspired by Svelte Bits
(bits-ui primitives, Tailwind CSS, Lucide Svelte icons), emphasizing dense,
accessible layouts, clean data tables, keyboard shortcuts, and a componentized
visualization path for time distribution and timeline scrubbing.

### 8.1 Administrator authentication

Configuration:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- `SESSION_SECRET_FILE` or local-development `SESSION_SECRET`
- `COOKIE_SECURE`
- `PUBLIC_URL`

Provide a CLI command that generates a versioned strong password hash. Never
store the administrator's plaintext password.

Session requirements:

- opaque server-side, revocable sessions
- only a session-token hash stored in SQLite
- `HttpOnly`, `Secure`, `SameSite=Lax` cookie in production
- session rotation after successful login
- idle and absolute expiry
- logout and logout-all-sessions
- CSRF tokens on every browser state-changing route
- login throttling and temporary lockout
- restrictive security headers and content-security policy
- no open redirect after login/OAuth consent

MCP Bearer credentials cannot call admin routes. An admin cookie does not
automatically authorize MCP calls; it is used only for the admin UI and the
explicit OAuth consent flow.

### 8.2 Admin navigation

#### Overview

- process, database, scheduler, and WakaTime connectivity status
- last successful sync and current run
- oldest/newest archived dates
- heartbeat, active-day, project, and anomaly counts
- missing/failed dates
- application and schema version
- recent safe audit events
- `Sync now`

#### Activity

- daily and weekly totals with classification breakdown (`work`, `personal`, `unclassified`)
- component-based visual timeline preview and project distribution (Svelte Bits-inspired)
- date and project filters
- freshness and source semantics
- exact entity/file paths hidden by default

This screen exists to validate and understand the archive; it provides an
extensible visualization path for time distributions without needing to clone
every WakaTime chart.

#### Classification

- view and manage global classification rules across all 7 supported identity selector types (`machine`, `editor`, `application`, `domain`, `project`, `folder_prefix`, `entity`), with validation strictly rejecting disallowed selectors (language, category, branch, dependency)
- suggestion-only broad-to-narrow triage: surface high-volume unclassified projects and entities first, suggest coarse rules (e.g. machine, domain, project), then guide operator to narrow folder-prefix or entity exceptions
- dry-run preview before confirmation: calculating exact affected dates, day/project/entity slices, and total shifted seconds across history and future data before rule changes take effect
- whole-slice one-off allocation editor: override individual day/project/entity slices without fractional guessing
- conflict and ambiguity inspector: surface equal-precedence ties (e.g. opposing work vs personal rules matching at the same priority level) that default conservatively to `unclassified`
- classification coverage metrics: visual progress gauges showing work, personal, and unclassified proportions across selectable time ranges
- unclassified backlog list: inspect unclassified days, projects, and entities requiring operator attention
- immutable revision history: review the append-only audit trail of classification mutations

#### Synchronization

- enable/disable scheduled synchronization
- edit allowed schedule settings
- run incremental sync
- backfill or reconcile a date range
- show expected date/request count before starting
- cancel queued work and safely stop between date transactions
- inspect run history and per-day sanitized failures
- retry selected failures
- inspect dump-import reports and anomalies
- show WakaTime credential as configured/valid/last-validated only

The WakaTime key is never readable or editable through the browser. Production
rotation is performed through the Docker secret and container restart.

#### API keys

- create a named application API key
- select scopes and optional expiry
- reveal/copy the complete key once
- list only prefix, name, scopes, creation, expiry, and last-use time
- revoke immediately
- audit creation and revocation

Store only a SHA-256 or stronger keyed hash of generated high-entropy tokens,
and compare in constant time. Key generation/revocation routes require an
interactive admin cookie and CSRF token; MCP credentials cannot mint other
credentials.

#### OAuth clients

- list registered clients and connected authorizations
- client name, ID, registration mechanism, and exact redirect URIs
- granted scopes, authorization time, last use, and token-family status
- revoke one authorization or every grant for a client
- disable/delete a client registration
- enable/disable dynamic client registration
- display sanitized authorization failures
- never display access tokens, refresh tokens, codes, or code challenges

#### Settings and privacy

- account timezone and Monday-based week behavior
- sync schedules and reconciliation window
- MCP work-only privacy configuration and unclassified coverage thresholds
- MCP result-size defaults and maximums
- whether detailed entity/file data may be granted
- retention for source payloads, audit events, sessions, and sync runs
- OAuth registration policy
- backup and last restore-test status
- safe diagnostic-report export

Destructive actions require an explicit confirmation describing exactly what
will be deleted. Database deletion is never combined with an ordinary logout,
client revocation, container stop, or Compose teardown.

### 8.3 Admin API outline

Cookie-authenticated routes:

```text
POST   /api/admin/session
GET    /api/admin/session
DELETE /api/admin/session
POST   /api/admin/session/revoke-all

GET    /api/admin/status
GET    /api/admin/activity
GET    /api/admin/sync-runs
POST   /api/admin/sync-runs
POST   /api/admin/sync-runs/:id/cancel
POST   /api/admin/sync-days/:date/retry

GET    /api/admin/classification/rules
POST   /api/admin/classification/rules
POST   /api/admin/classification/rules/preview
PATCH  /api/admin/classification/rules/:id
DELETE /api/admin/classification/rules/:id
GET    /api/admin/classification/allocations
POST   /api/admin/classification/allocations
DELETE /api/admin/classification/allocations/:id
GET    /api/admin/classification/coverage
GET    /api/admin/classification/revisions

GET    /api/admin/api-keys
POST   /api/admin/api-keys
DELETE /api/admin/api-keys/:id

GET    /api/admin/oauth-clients
PATCH  /api/admin/oauth-clients/:id
DELETE /api/admin/oauth-clients/:id
DELETE /api/admin/oauth-grants/:id

GET    /api/admin/settings
PATCH  /api/admin/settings
GET    /api/admin/audit-events
```

Responses never include WakaTime credentials, password/session hashes, API-key
hashes, OAuth token/code hashes, full source payloads, or raw file paths unless
the specific authenticated activity-detail operation requires them.

## 9. MCP and authorization

### 9.1 Transport

- Canonical remote endpoint: Streamable HTTP at `/mcp`.
- Use `createMcpHandler` and `McpServer` from the published
  `@modelcontextprotocol/server` v2 package, with the Node adapter from
  `@modelcontextprotocol/node`. The old package name
  `@modelcontextprotocol/sdk` remains on v1 and is not selected for this
  greenfield service.
- Do not copy the v1 `StreamableHTTPServerTransport` session map from
  LinkedIn Studio or TRS MCP. Their implementations remain useful behavioral
  references for authentication, tools, logging, and deployment, not the
  dependency choice for a new repository.
- Prefer stateless JSON responses for bounded read-only operations.
- Validate the `Origin` header according to the MCP transport specification.
- Expose POST/GET/DELETE behavior required by the selected stable protocol and
  SDK; reject legacy standalone SSE endpoints.
- Keep server/database pools at module scope and per-request MCP registration
  cheap and caller-scoped.
- Pin the SDK packages exactly and prove compatibility using a real v2 SDK
  client plus each intended agent client before deployment. If that acceptance
  uncovers an actual client incompatibility, document it and evaluate a
  deliberate v1 compatibility arm rather than silently changing the server.

### 9.2 Authentication model

Reuse the security contract proven in LinkedIn Studio:

- `Authorization: Bearer ...` only.
- RFC protected-resource metadata and `WWW-Authenticate` discovery.
- OAuth authorization-server metadata.
- Client ID Metadata Documents where supported.
- Strict dynamic client registration as fallback.
- exact registered redirect URI matching.
- S256 PKCE only.
- OAuth `resource` parameter and access-token audience binding.
- escaped consent UI with CSRF protection.
- one-hour access tokens.
- rotating refresh tokens with 90-day inactivity expiry.
- token-family revocation on refresh-token reuse.
- standard token revocation endpoint.
- manual application API-key fallback.

OAuth routes include:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
/oauth/authorize
/oauth/token
/oauth/revoke
/oauth/register
```

### 9.3 Scopes

Strict work-only MCP privacy is enforced across all scopes. Personal and
unclassified activity are strictly excluded from all MCP responses to protect
operator privacy.

`activity:read`

- totals, projects, categories, languages, editors, sanitized timelines, and
  comparisons for work-classified activity only
- aggregate responses include unclassified coverage metadata
  (`unclassified_seconds` and `coverage_percentage`) so agents know whether
  work evidence is complete for a requested range, without disclosing personal
  project identities or details

`activity:detail`

- exact entities/file paths, branches, dependencies, machine identifiers, and
  raw-evidence detail for work-classified activity only
- personal and unclassified raw events and file paths are never exposed

`operations:read`

- data coverage, classification coverage ratios, freshness, and sanitized sync status

No MCP scope permits changing WakaTime or modifying the local archive. Sync and
credential controls remain admin-cookie operations.

### 9.4 Initial tools

`get_activity_summary`

- inclusive start/end local dates
- group by day, week, project, category, language, or editor for work-classified
  activity only
- return WakaTime-derived work totals, freshness, and unclassified coverage
  indicators (`unclassified_seconds`, `coverage_percentage`)

`get_activity_timeline`

- a day's or week's ordered activity blocks/evidence for work-classified
  projects only
- project filter (work projects only)
- sanitized entity by default; exact entity requires `activity:detail`

`search_activity`

- bounded search/filter over work-classified project, branch, language,
  category, dependency, and optionally entity

`list_projects`

- lists only projects that contain work-classified activity: first/last work
  activity, total work time, recent activity, and project identity

`compare_periods`

- compare work activity between two explicit ranges or this week versus the
  preceding week

`get_sync_status`

- freshness, data coverage, classification coverage percentage, last successful
  run, and missing/problem dates

All tools are read-only, bounded, paginated where appropriate, and return
structured content containing:

- source timezone
- inclusive requested range
- Monday week-start semantics
- `data_fresh_through`
- last sync timestamp
- work totals in seconds rather than formatted strings
- unclassified coverage metadata indicating completeness
- strict work-only privacy guarantees (zero leakage of personal or unclassified
  names, files, or times)
- evidence/limitations needed to prevent false conclusions

Do not expose arbitrary SQL. Do not let an agent's query trigger live WakaTime
traffic.

### 9.5 Resources and prompts

Resources:

- `work-times://schema`
- `work-times://data-semantics` (documents the three-state immutable overlay,
  additive time slice rules, and work-only MCP privacy invariant)
- `work-times://freshness`

Prompts:

- `daily-review`
- `weekly-review`

Prompt instructions must state that time and touched files demonstrate
work activity, not completion or business outcome. Agents should distinguish
observed facts from inference, note any unclassified coverage warnings, and
never attempt to infer or query personal activity.

## 10. Secret and privacy contract

### 10.1 Local development

`.env` is used only for local discovery/development and has mode `0600`.
Expected variables include:

```text
WAKATIME_API_KEY=
ADMIN_USERNAME=
ADMIN_PASSWORD_HASH=
SESSION_SECRET=
PORT=3002
PUBLIC_URL=http://localhost:3002
COOKIE_SECURE=false
```

The committed `.env.example` contains no real or realistic secret values.

### 10.2 Production

Prefer file-backed Docker secrets:

```text
WAKATIME_API_KEY_FILE=/run/secrets/wakatime_api_key
SESSION_SECRET_FILE=/run/secrets/session_secret
```

The application supports direct environment values for development but gives
`*_FILE` precedence in production.

The WakaTime key, MCP/API tokens, OAuth codes/tokens, session cookies, and
pre-signed data-dump URLs are all credentials. They must never appear in:

- URLs or query strings
- command-line arguments
- Docker image layers
- Compose-rendered configuration
- logs, metrics, traces, audit events, or error serialization
- admin JSON responses after one-time API-key creation
- MCP tools, resources, prompts, or errors
- committed fixtures or snapshots

Raw exports contain absolute file paths, project/branch names, dependency
information, machine identifiers, and AI session metadata. Protect the data
directory and backups with host permissions and storage-level encryption where
available. Default MCP tools to aggregate/sanitized output.

## 11. Docker and home-server deployment

### 11.1 Image

- Multi-stage build with exact lockfile installation.
- Compile Svelte 5 + SvelteKit admin client (via `@sveltejs/adapter-node`) and
  the custom Node entry point in the builder stage.
- Runtime stage contains production dependencies and built artifacts only.
- Run as a dedicated non-root user.
- Read-only root filesystem.
- Drop all Linux capabilities and set `no-new-privileges`.
- Writable persistent `/data` and ephemeral `/tmp` only.
- Built-in health check against a minimal `/health` response.
- Graceful shutdown waits for the current database transaction, then records an
  interrupted sync for safe startup recovery.

Publish a private immutable GHCR image tagged by commit SHA. This avoids placing
a GitHub PAT inside an interpolated remote Docker build-context URL. The home
server needs only a read-only registry credential.

### 11.2 Compose topology

```text
work-times  startup migrations + admin + sync + MCP
```

For SQLite, a separate migration container adds coordination without useful
role isolation. The single process performs this startup sequence:

1. open `/data/work-times.sqlite`;
2. acquire the application/startup lock;
3. apply versioned migrations transactionally;
4. run integrity/configuration checks;
5. start the scheduler;
6. bind the HTTP listener.

A migration failure exits non-zero before any route becomes reachable. The
single-replica deployment and process lock prevent concurrent migrators.

Use the reserved Work Times port consistently inside and outside the container:

```text
127.0.0.1:3002:3002
/home/leo/work-times/data:/data
```

Set `PORT=3002`, attach the service to the existing external `traefik-net`, and
add a Traefik router for `work-times.home` with load-balancer port `3002`.
The Cloudflare Tunnel targets `http://127.0.0.1:3002` for the public HTTPS
origin. No database or diagnostic port is published. Another container using
port 3002 internally is not a collision because Traefik routes by service and
container identity; only the host loopback binding must be unique.

Cloudflare Access requires path-specific Bypass policies for the machine-facing
protocol surface:

```text
/.well-known/*
/oauth/*
/mcp
```

Without those policies, an MCP client can receive a Cloudflare HTML login
redirect instead of OAuth metadata, token JSON, or an MCP response. Bypass here
means only bypassing Cloudflare Access authentication: application OAuth,
Bearer validation, PKCE, redirect checks, Origin/Host validation, rate limits,
and the Tunnel still protect the endpoints. Admin routes remain behind both
Cloudflare Access and the application's own login when Access is enabled.

### 11.3 Health and logs

Unauthenticated `/health` returns only a status and no personal or operational
detail. Authenticated admin status provides deeper checks.

Structured logs may include:

- event name
- request/run correlation ID
- HTTP status
- operation/tool name
- duration
- count and outcome

They must not include request bodies, MCP arguments/results, project names,
entities, source JSON, IP-derived identity, or credentials. Security-sensitive
routes receive dedicated throttles.

### 11.4 Backup and restore

Do not copy only a live SQLite main file while WAL mode is active. Provide a CLI
that uses SQLite's online backup mechanism to create a consistent snapshot,
then let the home-server backup process archive that snapshot and secret files
separately.

Acceptance requires:

- automated backup creation
- checksum verification
- restore into a disposable data directory
- migration/health startup against the restored copy
- count and date-range comparison with the source database

Compose teardown never deletes `/data`.

## 12. Implementation phases

### Phase 0 — Plan and repository safety

- Commit this plan.
- Add ignore rules before creating any `.env`, dump, sample, database, or backup
  inside the worktree.
- Establish TypeScript, formatting, linting, tests, and CI for the SvelteKit
  and custom Node application.
- Add threat model and architecture decision records for SQLite, the SvelteKit
  adapter-node custom Node entry, the immutable classification overlay, and
  work-only MCP privacy.

Exit criteria: secret/data paths are demonstrably ignored and CI is green.

### Phase 1 — Dump contracts and guarded importer

- Define runtime schemas from the observed daily and heartbeat shapes.
- Implement the parser interface, guarded native parsing, source hashing, and
  memory acceptance instrumentation.
- Add migrations for source lineage, daily totals/breakdowns, heartbeats,
  dependencies, variants, and classification overlay tables
  (`classification_rules` supporting the 7 identity selector types with CHECK constraints rejecting disallowed selectors,
  `daily_time_allocations` keyed on `(date, project_id, entity)` for whole-slice overrides,
  and `classification_revisions` for append-only audit logging).
- Implement stable dependency sorting/set canonicalization, exact duplicate,
  and future conflicting-variant behavior.
- Batch the 220,103 observed heartbeat/dependency relationships inside database
  transactions and index the normalized lookup path.
- Add mandatory scope/dimension query helpers and double-counting tests for the
  19,842 account rows and 40,219 project-nested rows.
- Implement additive time slice calculation: day/project/entity slices derived from
  daily `project.entities` summary dumps/API, enriched with observed raw-heartbeat
  machine/editor identity without deriving duration from heartbeats.
- Implement classification precedence evaluator (whole-slice override > explicit manual
  priority > selector specificity [`entity` > `folder_prefix` > `project/repo` > `machine`/`editor`/`application`/`domain`] >
  longest matching folder prefix) with conservative default to `unclassified` on equal-precedence
  work vs personal ties (deterministic sort never breaks ties), and invariant
  `work + personal + unclassified = daily_totals.total_seconds` within sub-second tolerance.
- Import both local dumps and produce a private validation report.
- Generate only synthetic/anonymized committed fixtures.

Exit criteria for the currently supplied files:

- 3,593 day envelopes recognized in each export.
- 82,318 heartbeat occurrences recognized.
- 82,276 unique external heartbeat IDs recognized.
- 42 duplicate-ID groups reported.
- all 42 groups canonically identical after deterministic dependency sorting.
- zero post-canonicalization conflicts in the supplied dump.
- 571 non-zero daily-total days recognized.
- 93 heartbeat-present/zero-daily-total days preserved without inventing time.
- repeated import is idempotent.
- direct parser stays under the explicit import memory/container budget and
  refuses inputs above its configured size limit.
- additive classification slice totals match daily totals within sub-second tolerance.

### Phase 2 — Safe WakaTime API client and scheduler

- Create the ignored blank `.env` and credential loader.
- Run read-only live discovery after the operator adds the key.
- Validate API responses against dump-derived contracts.
- Add serialized rate limiting, retries, timeouts, and redaction.
- Implement startup catch-up, hourly refresh, nightly reconciliation, and manual
  bounded sync.
- Add per-day transactional replacement and progress persistence.
- Ensure re-imports and reconciliation preserve immutable classification overlay
  rules and whole-slice one-offs without erasing operator decisions.
- Add independent summary/duration/heartbeat capability state, partial-success
  semantics, layer-specific freshness, and endpoint-plan advisories.

Exit criteria: a restarted sync resumes safely, repeated sync is idempotent,
summary sync remains useful when optional endpoints are plan-restricted,
the classification overlay survives reconciliation, and no secret appears in
process arguments, git, image history, logs, or error snapshots.

### Phase 3 — Admin authentication, SvelteKit UI foundation, and classification engine

- Implement password-hash CLI, login, sessions, CSRF, logout, and lockout.
- Mount the Svelte 5 + SvelteKit admin application via `@sveltejs/adapter-node`
  into the custom Node entry point.
- Build the dark-first Svelte Bits-inspired UI shell, overview page, and
  activity page with component-based visualization path.
- Implement the complete classification engine:
  - global rules across all 7 supported identity selector types (`machine`, `editor`, `application`, `domain`, `project`, `folder_prefix`, `entity`) with strict validation rejecting disallowed selectors (language, category, branch, dependency);
  - multi-tier precedence evaluator (whole-slice override > explicit manual priority > selector specificity > longest folder prefix) with conservative default to `unclassified` on equal-precedence work vs personal ties (deterministic sort never breaks ties);
  - suggestion-only broad-to-narrow triage flow;
  - dry-run preview before confirmation calculating affected dates, day/project/entity slices, and shifted seconds across history and future data;
  - whole-slice one-off allocation editor and unclassified backlog viewer for day/project/entity slices;
  - conflict and ambiguity inspector surfacing equal-precedence ties;
  - classification coverage metrics and immutable revision audit log.
- Add protected sync controls, settings, and safe diagnostic APIs.
- Add audit events for administrative and classification mutations.

Exit criteria: browser tests cover successful login, invalid login throttling,
CSRF rejection, session expiry/revocation, visible sync controls, rule dry-run
preview with confirmation, conflict resolution defaulting ties to unclassified,
and whole-slice one-offs on day/project/entity slices.

### Phase 4 — Application API keys

- Add scoped high-entropy key generation.
- Implement one-time reveal, hashed storage, constant-time verification,
  expiry, last-use checkpointing, and revocation.
- Enforce work-only privacy boundaries for issued keys.
- Build API-key admin controls in the SvelteKit UI.
- Ensure generated keys cannot access the admin control plane.

Exit criteria: cleartext keys exist only in the one creation response and the
client's own storage; scope, revocation, and work-only isolation tests pass.

### Phase 5 — OAuth authorization server

- Implement protected-resource and authorization-server discovery.
- Add strict client metadata/DCR, authorization, escaped SvelteKit consent UI
  with CSRF protection, PKCE exchange, refresh rotation, reuse detection,
  revocation, and resource binding.
- Build OAuth client/grant controls in the SvelteKit admin UI.
- Test URL-only onboarding with the intended agent clients.

Exit criteria: authentication works from a clean client using only the MCP URL,
and adversarial redirect, PKCE, CSRF, scope, audience, expiry, replay, and
revocation tests pass.

### Phase 6 — MCP and analytics

- Implement daily/weekly/project/timeline query services enforcing strict
  work-only privacy (personal and unclassified activity strictly excluded).
- Register bounded read-only tools (`get_activity_summary`, `get_activity_timeline`,
  `search_activity`, `list_projects`, `compare_periods`, `get_sync_status`),
  resources, and prompts.
- Thread unclassified coverage indicators (`unclassified_seconds`, `coverage_percentage`)
  into summary and status outputs without leaking personal metadata.
- Enforce `activity:read`, `activity:detail`, and `operations:read` scopes.
- Add freshness, Monday week-start semantics, and data boundaries to every response.
- Run MCP SDK-client conformance and end-to-end tests.

Exit criteria: representative daily and weekly agent questions are answered
from the local database without WakaTime traffic, without leaking detailed
entities to aggregate-only clients, and with zero leakage of personal or
unclassified records.

### Phase 7 — Docker and home-server deployment

- Build and scan the hardened multi-stage image compiling SvelteKit adapter-node
  frontend and custom Node server.
- Publish an immutable private GHCR image.
- Add a companion deployment directory to `home-server-docker`.
- Configure in-process startup migrations, `127.0.0.1:3002:3002`, persistent
  `/data`, Docker secrets, `traefik-net`, `work-times.home`, health checks,
  resource limits, Cloudflare Tunnel, and Access Bypass rules for the protocol
  paths (`/.well-known/*`, `/oauth/*`, `/mcp`).
- Add backup/restore commands and deployment documentation.

Exit criteria: update, restart, rollback, backup, and restore preserve the
database and classification overlay; only intended HTTPS routes are reachable.

### Phase 8 — Full acceptance and operational handoff

- Compare selected days and weeks with WakaTime.
- Exercise import, incremental sync, deletion reconciliation, and anomaly
  reporting.
- Exercise the SvelteKit dark-first admin UI, classification rule dry-run
  preview and reclassification confirmation across all 7 selector types,
  the work laptop (`machine = work`) + personal repo (`project/folder = personal`)
  multi-tier override scenario, conflict resolution defaulting equal-precedence ties
  to `unclassified`, whole-slice one-off overrides on day/project/entity slices,
  and unclassified backlog triage.
- Exercise every credential lifecycle (admin session, API key, OAuth client/tokens)
  and every MCP tool.
- Adversarial MCP privacy test: verify zero leakage of personal or unclassified
  projects, entities, or file paths across all tools and resources.
- Restart during a sync and during an MCP request.
- Scan git history, build context, image history, logs, telemetry, and backups
  for known test secrets.
- Run dependency vulnerability/licence checks and produce an SBOM.
- Complete a restore drill and record the result in the admin status page.

The release is complete only when automated tests, browser tests, live API
checks, authenticated MCP calls, Docker checks, and restore verification all
pass.

## 13. Testing strategy

### Unit and contract tests

- daily and heartbeat runtime schemas
- nullable and newly introduced fields
- microsecond timestamp conversion
- summary normalization and project nesting
- exact duplicates and payload conflicts
- date/week/timezone boundaries, including DST
- retry/backoff classification
- password, session, API-key, OAuth, and scope logic
- result redaction and MCP output bounds
- 7 identity selector types matching: machine, editor, application, domain, project, folder_prefix (strict path-boundary `/` matching), and entity (strict equality, rejection of regex/substrings)
- strict schema and runtime validation rejecting disallowed selectors (language, category, branch, dependency)
- precedence hierarchy evaluation: 1) whole-slice override, 2) explicit manual priority, 3) selector specificity (`entity` > `folder_prefix` > `project/repo` > `machine`/`editor`/`application`/`domain`), 4) longest matching folder prefix
- multi-tier override test case: work laptop machine rule (`machine = work`) overridden by personal repository project/folder rule (`project/folder = personal`)
- conservative tie-breaking: equal-precedence conflicts between opposing classifications (`work` vs `personal`) strictly default to `unclassified`; deterministic sort fields never silently decide classification
- additive time slice invariant: day/project/entity slices derived from daily `project.entities` enriched with observed raw-heartbeat identity associations (machine and editor) without deriving duration from heartbeats; `work + personal + unclassified = daily_totals.total_seconds` within sub-second tolerance
- conservative default: unmatched slices evaluate to `unclassified`
- whole-slice one-off allocation override logic taking precedence over global rules for specific `(date, project_id, entity)` slices

### Integration tests

- guarded dump import into a temporary SQLite database
- interrupted import and resume
- transactional day replacement including deletion
- scheduler restart and catch-up
- SvelteKit adapter-node custom Node server routing (admin UI, admin API, OAuth, `/mcp`, health)
- admin routes with real cookies and CSRF
- classification rule creation, modification, dry-run preview calculation across day/project/entity slices, and confirmed execution
- conflict detection surfacing equal-precedence ties defaulting to `unclassified`
- append-only revision logging and cache invalidation
- OAuth authorization-code and refresh-token flows
- MCP initialization, tool listing, calls, denial, and revocation
- MCP work-only privacy guarantee: automated tests verifying personal and unclassified activity are completely excluded from tool and resource outputs
- online backup and disposable restore

### Browser tests

- login/logout and expired session
- dark-first Svelte Bits-inspired UI components and keyboard accessibility
- overview and activity filters with component-based visualization
- classification management: global rules list across all 7 selector types, suggestion-only broad-to-narrow flow, dry-run preview modal confirmation, conflict inspector, and whole-slice one-off overrides on day/project/entity slices
- sync/backfill confirmation and progress
- API-key one-time reveal and revocation
- OAuth client/grant listing and revocation
- settings validation and destructive-action confirmation
- responsive and keyboard-accessible UI

### Live acceptance

- one read-only WakaTime discovery run
- import supplied daily and heartbeat dumps
- incremental API reconciliation of selected historical/recent dates
- comparison of stored totals with WakaTime responses
- rule creation with dry-run preview confirmation and verification of reclassification across historical dump data
- one URL-only OAuth MCP connection
- one fallback API-key MCP connection
- representative daily and weekly agent queries verifying work-only evidence and privacy enforcement

## 14. Future extensions

- Future visualization path: rich interactive visualization dashboards
  (scrubbable interactive timelines, multi-week heatmaps, chord/sankey project
  distribution) extending the Svelte Bits visualization foundation.
- Git repository and commit correlation.
- GitHub/GitLab pull-request correlation.
- Calendar and ticket-system context.
- Optional local annotations such as “what outcome did this work produce?”.
- Saved weekly-review reports.
- Additional personal time sources.
- PostgreSQL only if multi-user or high-concurrency requirements emerge.

Each enrichment should retain provenance so an agent can distinguish WakaTime
facts, external-system facts, user annotations, and generated inference.

## 15. Immediate next step

Implement Phase 0 and the smallest part of Phase 1:

1. Add ignore rules and project scaffolding with Svelte 5 + SvelteKit
   adapter-node custom Node entry.
2. Add the guarded native parser behind a reader interface and the shape-only
   validation command.
3. Create initial migrations including core tables and classification overlay
   tables (`classification_rules`, `daily_time_allocations`, `classification_revisions`).
4. Import the supplied dumps locally and verify the documented acceptance
   counts.
5. Only after the dump importer is stable, create the ignored `.env` for the
   operator's WakaTime API key and begin read-only live discovery.
