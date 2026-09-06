# WakaTime Dump Data Contract

Status: verified against live dumps 2026-09-05

This document specifies the structural contract for the two WakaTime export
files consumed by the importer.  It is derived from bounded aggregate
inspection of the actual dumps without copying personal values.

---

## 1. File inventory

| File                  | Logical name  | Size   |
|-----------------------|---------------|--------|
| `*-daily.json`        | daily dump    | ~24 MB |
| `*-heatbeat .json`    | heartbeat dump| ~67 MB |

Both files share an identical top-level envelope.  The heartbeat filename
contains a space before `.json` (typo in the WakaTime export).

---

## 2. Top-level envelope

```
{
  "user":  User,
  "range": Range,
  "days":  Day[]       // exactly one entry per calendar day, contiguous
}
```

### Range

| Field   | Type  | Description                       |
|---------|-------|-----------------------------------|
| `start` | int   | Unix epoch seconds, midnight UTC  |
| `end`   | int   | Unix epoch seconds, 23:59:59 UTC  |

### Shared envelope invariants

- Both dumps carry the same `user.id`, `range.start`, `range.end`, and
  `days` count.
- Both `days` arrays are aligned: identical dates in identical order.
- Observed: **3 593** contiguous days from `2016-11-04` to `2026-09-05`
  with zero gaps.

---

## 3. User object

The `user` object is a point-in-time snapshot of account settings.  It
appears identically in both dumps.

### PII / privacy-sensitive fields

| Field              | Type     | Nullable | Privacy note                    |
|--------------------|----------|----------|---------------------------------|
| `id`               | string   | no       | WakaTime user UUID              |
| `email`            | string   | no       | Account email                   |
| `display_name`     | string   | no       | Public display name             |
| `full_name`        | string   | yes      | Legal name                      |
| `photo`            | string   | no       | Avatar URL                      |
| `profile_url`      | string   | no       | Public profile                  |
| `profile_url_escaped`| string | no       | URL-encoded profile             |
| `github_username`  | string   | yes      | Linked GitHub                   |
| `linkedin_username`| string   | yes      | Linked LinkedIn                 |
| `twitter_username` | string   | yes      | Linked Twitter                  |
| `website`          | string   | yes      | Personal website                |
| `public_email`     | string   | yes      | Public contact email            |
| `bio`              | string   | yes      | Bio text                        |
| `city`             | string   | yes      | City                            |
| `location`         | string   | yes      | Location text                   |
| `last_project`     | string   | no       | Most-recent project name        |
| `last_branch`      | string   | no       | Most-recent branch              |
| `last_language`    | string   | no       | Most-recent language            |
| `last_plugin`      | string   | no       | Editor plugin string            |
| `last_plugin_name` | string   | no       | Editor plugin name              |
| `username`         | string   | yes      | WakaTime username               |

### Non-PII account settings (subset)

`timezone` (string), `timeout` (int, heartbeat gap seconds),
`weekday_start` (int), `writes_only` (bool), `plan` (string),
`has_premium_features` (bool), `color_scheme`, `date_format`,
`time_format_24hr`, `time_format_display`, `created_at` (ISO 8601),
`modified_at` (ISO 8601), `last_heartbeat_at` (ISO 8601), and various
`*_public` / `is_*` booleans.

### Privacy requirements

1. **MUST NOT** persist `user.email`, `user.photo`, `user.profile_url`,
   `user.display_name`, or any social-username field in logs, error messages,
   or analytics tables.
2. **MUST** store `user.id` as the owner identifier.
3. **MUST** treat the entire `user` object as PII for backup encryption
   and access-control purposes.
4. **MAY** persist `timezone`, `timeout`, `weekday_start`, `writes_only`,
   `plan`, and `has_premium_features` as import-time configuration facts.

---

## 4. Daily dump — `Day` type

Each element in `days`:

```
{
  "date":              string,         // "YYYY-MM-DD", always present
  "grand_total":       GrandTotal,
  "categories":        CategoryBreakdown[],
  "editors":           EditorBreakdown[],
  "languages":         LanguageBreakdown[],
  "machines":          MachineBreakdown[],
  "operating_systems": OSBreakdown[],
  "dependencies":      DependencyBreakdown[],
  "projects":          Project[]
}
```

### 4.1 GrandTotal

| Field                                  | Type     | Nullable | Notes                               |
|----------------------------------------|----------|----------|-------------------------------------|
| `total_seconds`                        | float    | no       | Authoritative duration              |
| `decimal`                              | string   | no       | Formatted hours "H.HH"             |
| `digital`                              | string   | no       | Formatted "H:MM"                    |
| `hours`                                | int      | no       | Integer hours component             |
| `minutes`                              | int      | no       | Integer minutes component           |
| `text`                                 | string   | no       | Human-readable "X hrs Y mins"       |
| `human_additions`                      | int      | no       | Lines added by human                |
| `human_deletions`                      | int      | no       | Lines deleted by human              |
| `ai_additions`                         | int      | no       | Lines added by AI                   |
| `ai_deletions`                         | int      | no       | Lines deleted by AI                 |
| `ai_sessions`                          | int      | no       | AI session count                    |
| `ai_prompt_events_total`               | int      | no       |                                     |
| `ai_prompt_events_avg_per_session`     | int      | no       |                                     |
| `ai_prompt_events_median_per_session`  | int      | no       |                                     |
| `ai_prompt_length_avg`                 | int      | no       |                                     |
| `ai_prompt_length_avg_per_session`     | int      | no       |                                     |
| `ai_prompt_length_median_per_session`  | int      | no       |                                     |
| `ai_prompt_length_sum`                 | int      | no       |                                     |
| `ai_input_tokens`                      | int      | no       |                                     |
| `ai_cached_input_tokens`               | int      | no       |                                     |
| `ai_output_tokens`                     | int      | no       |                                     |
| `ai_model_total_cost`                  | int/float| no       | Total cost across models            |
| `ai_model_breakdown`                   | array    | no       | `[{name: string, cost: float, lines: int}]` |
| `ai_model_costs`                       | object   | no       | `{model_name: float}`              |
| `ai_model_line_changes`                | object   | no       | `{model_name: int}`                |

All AI fields are zero-valued on days without AI activity; they are never
absent or null.

### 4.2 TimeBreakdown (shared shape)

Used by: `categories`, `languages`, `operating_systems`, `dependencies`,
and `projects[].branches`, `projects[].categories`, `projects[].languages`,
`projects[].operating_systems`, `projects[].dependencies`.

| Field           | Type    | Nullable | Notes                            |
|-----------------|---------|----------|----------------------------------|
| `name`          | string  | no       | Dimension value                  |
| `total_seconds` | float   | no       | Authoritative duration           |
| `percent`       | float   | no       | Relative share within dimension  |
| `decimal`       | string  | no       | "H.HH"                          |
| `digital`       | string  | no       | "H:MM"                           |
| `hours`         | int     | no       | Integer hours component          |
| `minutes`       | int     | no       | Integer minutes component        |
| `seconds`       | int     | no       | Integer seconds component        |
| `text`          | string  | no       | Human "X hrs Y mins"             |

### 4.3 EditorBreakdown (extended TimeBreakdown)

Used by: `editors`, `projects[].editors`.

Inherits all TimeBreakdown fields **plus** the full AI fields from
GrandTotal (`ai_additions`, `ai_deletions`, `ai_sessions`,
`ai_prompt_events_*`, `ai_model_breakdown`, `ai_model_costs`,
`ai_model_line_changes`, `ai_input_tokens`, `ai_cached_input_tokens`,
`ai_output_tokens`, `ai_prompt_length_*`, `human_additions`,
`human_deletions`, `ai_model_total_cost`).

None of these fields are nullable; zero-valued when absent.

### 4.4 MachineBreakdown

TimeBreakdown fields **plus**:

| Field              | Type    | Nullable | Notes                          |
|--------------------|---------|----------|--------------------------------|
| `machine_name_id`  | string  | **yes**  | Null in 1/965 observed items   |

### 4.5 EntityBreakdown (in `projects[].entities`)

EditorBreakdown shape **plus**:

| Field               | Type    | Nullable | Notes                            |
|---------------------|---------|----------|----------------------------------|
| `type`              | string  | no       | `"file"`, `"app"`, or `"domain"` |
| `project_root_count`| int     | **yes**  | Null in 7 296/14 128 items       |

### 4.6 Project

```
{
  "name":              string,             // project name, never null
  "grand_total":       GrandTotal,         // same shape as day grand_total
                                           //   (adds `percent` field: float)
  "branches":          TimeBreakdown[],
  "categories":        TimeBreakdown[],
  "dependencies":      TimeBreakdown[],
  "editors":           EditorBreakdown[],
  "entities":          EntityBreakdown[],
  "languages":         TimeBreakdown[],
  "machines":          MachineBreakdown[],
  "operating_systems": TimeBreakdown[]
}
```

---

## 5. Heartbeat dump — `Day` type

Each element in `days`:

```
{
  "date":       string,         // "YYYY-MM-DD"
  "heartbeats": Heartbeat[]     // may be empty
}
```

### 5.1 Heartbeat

| Field                   | Type     | Nullable | Notes                                         |
|-------------------------|----------|----------|-----------------------------------------------|
| `id`                    | string   | no       | WakaTime heartbeat UUID                       |
| `user_id`               | string   | no       | Owner UUID                                    |
| `entity`                | string   | no       | Absolute file path, app name, or domain       |
| `type`                  | string   | no       | `"file"`, `"app"`, or `"domain"`              |
| `category`              | string   | no       | `"Coding"`, `"AI Coding"`, `"Writing Docs"`, `"Writing Tests"` |
| `project`               | string   | **yes**  | Null in 2 539/82 318                          |
| `branch`                | string   | **yes**  | Null in 13 392/82 318                         |
| `language`              | string   | **yes**  | Null in 7 427/82 318                          |
| `dependencies`          | string[] | no       | May be empty `[]`; items are plain strings    |
| `lines`                 | int      | **yes**  | Null in 5 682/82 318                          |
| `lineno`                | int      | **yes**  | Null in 66 340/82 318                         |
| `cursorpos`             | int      | **yes**  | Null in 47 349/82 318                         |
| `is_write`              | bool     | no       | 25 096/82 318 true                            |
| `time`                  | float    | no       | Unix epoch seconds (fractional)               |
| `created_at`            | string   | no       | ISO 8601 `"YYYY-MM-DDTHH:MM:SSZ"`            |
| `machine_name_id`       | string   | **yes**  | Null in 82/82 318                             |
| `user_agent_id`         | string   | no       | Editor/plugin identifier                      |
| `project_root_count`    | int      | **yes**  | Null in 46 247/82 318                         |
| `ai_session`            | string   | **yes**  | UUID; null in 48 471/82 318                   |
| `ai_subscription_plan`  | string   | **yes**  | Null in 76 354/82 318                         |
| `ai_line_changes`       | int      | **yes**  | Null in 74 568/82 318                         |
| `human_line_changes`    | int      | **yes**  | Null in 81 401/82 318                         |
| `ai_input_tokens`       | int      | no       | Zero when no AI activity                      |
| `ai_cached_input_tokens`| int      | no       | Zero when no AI activity                      |
| `ai_output_tokens`      | int      | no       | Zero when no AI activity                      |
| `ai_prompt_length`      | int      | no       | Zero when no AI activity                      |

---

## 6. Canonicalization rules

### 6.1 Dates

- Format: `YYYY-MM-DD` (ISO 8601 date only), always present, never null.
- Days are contiguous with zero gaps across the full range.
- Heartbeat `time` values fall within their enclosing day (verified on
  sampled data).

### 6.2 Timestamps

| Location            | Format                     | Precision      |
|---------------------|----------------------------|----------------|
| `range.start/end`   | Unix epoch seconds (int)   | 1 s            |
| `heartbeat.time`    | Unix epoch seconds (float) | sub-second     |
| `heartbeat.created_at` | ISO 8601 `…Z`          | 1 s            |
| `user.created_at`   | ISO 8601                   | variable       |
| `user.modified_at`  | ISO 8601                   | variable       |
| `user.last_heartbeat_at` | ISO 8601              | variable       |

### 6.3 Dependencies (heartbeat)

`dependencies` is an array of plain strings.  The importer **MUST**
canonicalize as a sorted, deduplicated set before hashing or comparing
heartbeat records (per IMPLEMENTATION-PLAN.md).

### 6.4 Entity paths

`entity` values are predominantly absolute filesystem paths (observed
in 97.9% of sampled heartbeats).  For `type: "app"` they are application
names; for `type: "domain"` they are domain strings.  The importer
**SHOULD** normalize path separators to `/` and strip trailing slashes.

---

## 7. Additive invariants

### 7.1 Strictly additive (verified, zero violations)

| Invariant                                               | Verified across |
|---------------------------------------------------------|-----------------|
| `day.grand_total.total_seconds == sum(day.categories[].total_seconds)` | 3 593 days |
| `project.grand_total.total_seconds == sum(project.entities[].total_seconds)` | 1 460 projects |
| `sum(day.categories) == sum(projects.categories)` by name | 664 project-bearing days |
| `sum(day.languages) == sum(projects.languages)` by name   | 664 project-bearing days |
| `sum(day.editors) == sum(projects.editors)` by name       | 664 project-bearing days |

### 7.2 Nearly additive (1 violation)

| Invariant                                               | Violations |
|---------------------------------------------------------|------------|
| `day.grand_total.total_seconds == sum(day.projects[].grand_total.total_seconds)` | 1/3 593 (delta = 900 s on 2026-04-30) |

The importer **MUST** tolerate this: accept the day-level `grand_total` as
authoritative and log a warning when the project sum diverges.

### 7.3 Percent fields

- Within each breakdown dimension, `percent` values sum to 100 for most
  days.
- **93 days** have project records but zero `total_seconds`, with WakaTime
  reporting `percent: 0` for every category.
- **14 days** have rounding deviations of ±0.01 from 100.
- The importer **SHOULD NOT** recompute `percent` from `total_seconds`;
  treat as display-only and not authoritative.

---

## 8. Acceptance counts

| Metric                         | Count     |
|--------------------------------|-----------|
| Total calendar days            | 3 593     |
| Days with positive time        | 571       |
| Days with project records      | 664       |
| Days with zero `total_seconds` | 3 022     |
| Days with 0 secs but projects  | 93        |
| Total heartbeats               | 82 318    |
| Total daily projects           | 1 460     |
| Total daily entities           | 14 128    |
| Distinct project names (daily) | 237       |
| Distinct project names (hb)    | 236       |
| Distinct languages             | 65        |
| Distinct editors               | 19        |
| Distinct OS names              | 4         |
| Distinct machine names         | 189       |
| Distinct branch names (daily)  | 132       |
| Distinct branch names (hb)     | 134       |
| Distinct daily dependencies    | 3 763     |
| Days with AI activity          | 116       |

---

## 9. Classification attribution rules

### 9.1 Category

Heartbeats carry exactly one `category` from the closed set:
`Coding`, `AI Coding`, `Writing Docs`, `Writing Tests`.

Daily breakdowns aggregate these into day-level and project-level
`categories[]` arrays.  The sums match exactly (§7.1).

### 9.2 Entity type → category relationship

| `type`     | Typical `category`     | Heartbeat count |
|------------|------------------------|-----------------|
| `file`     | Coding, AI Coding, Writing Docs, Writing Tests | 79 379 |
| `app`      | Coding, AI Coding      | 2 857           |
| `domain`   | Coding, AI Coding      | 82              |

There is no 1:1 mapping from `type` to `category`; the category is
assigned by the WakaTime plugin at capture time.

### 9.3 Editor → AI attribution

AI metrics (additions, deletions, tokens, sessions, model breakdown) are
attached at the **editor** breakdown level in the daily dump, not at the
category or language level.  A consumer querying AI contribution must
aggregate from `editors` or `projects[].editors`.

### 9.4 Day-level vs project-level

Day-level breakdowns (`categories`, `languages`, `editors`, `machines`,
`operating_systems`) are exact sums of the corresponding project-level
breakdowns (verified §7.1).  They are denormalized rollups, not independent
measurements.  The importer **MAY** skip storing day-level breakdowns and
recompute from project-level data.

---

## 10. Empty-day semantics

- **Zero-activity days**: `grand_total.total_seconds == 0`, all breakdown
  arrays are `[]`, `projects` is `[]`.  All AI counters are `0`, all
  formatted fields are `"0.00"` / `"0:00"` / `"0 secs"`.  Heartbeat dump
  has `heartbeats: []`.
- **Near-zero days** (93 observed): `projects` is non-empty but every
  project has `grand_total.total_seconds == 0`.  Category percents are
  all `0`.  These represent activity too brief to accumulate measurable
  seconds.  The importer **MUST** still import these days and their
  project associations.

---

## 11. Privacy requirements summary

### Must redact / never log

- `user.email`, `user.display_name`, `user.full_name`, `user.photo`
- `user.profile_url`, `user.profile_url_escaped`
- Social usernames (`github_username`, `linkedin_username`,
  `twitter_username`, `wonderfuldev_username`, `username`)
- `heartbeat.entity` (contains absolute filesystem paths)
- `heartbeat.user_id`, `heartbeat.user_agent_id`,
  `heartbeat.machine_name_id`

### Must protect at rest

- Raw dumps, SQLite archives, and backups contain identity-bearing values and
  must be owner-readable only. Use storage-level encryption for the host volume
  and backup destination where available.
- The importer stores only the non-PII account settings it needs, not the full
  top-level `user` object.
- Exact `heartbeat.entity` values are retained because folder/entity
  classification requires them; they must never be logged or exposed through
  work-only MCP responses unless an explicitly authorized work-detail operation
  is implemented.
- The dump files themselves (they are single-user PII archives)

### Safe to log (non-PII dimension names)

- `category`, `language`, `editor`, `operating_system` names
- `project` names (treat as semi-private; may contain employer info)
- `branch` names (treat as semi-private)
- `date` values

---

## 12. Synthetic fixture matrix

Minimal test fixtures covering edge cases.  All values are synthetic;
no personal data.

### 12.1 Daily dump fixture axes

| Axis                   | Fixture values                                        |
|------------------------|-------------------------------------------------------|
| Day activity           | zero-activity, near-zero (projects but 0 secs), normal|
| Project count          | 0, 1, many (≥3)                                      |
| Category mix           | single (Coding), multi (Coding + AI Coding + Writing Docs + Writing Tests) |
| Entity types           | file-only, file + app, file + app + domain            |
| AI activity            | none (all zeros), present (sessions > 0)              |
| Dependencies           | empty, non-empty                                      |
| Machine nullability    | `machine_name_id` present, `machine_name_id` null     |
| Entity root nullability| `project_root_count` present, `project_root_count` null |
| Percent edge cases     | sums to 100, all zeros, ±0.01 rounding                |
| Project sum divergence | matches grand_total, diverges by known delta           |

### 12.2 Heartbeat dump fixture axes

| Axis                    | Fixture values                                       |
|-------------------------|------------------------------------------------------|
| Core nullability combo  | all-fields-present, project null, branch null, language null, all-nullable-null |
| Entity type             | file (abs path), app (name), domain (hostname)       |
| Category                | each of the 4 categories                             |
| is_write                | true, false                                          |
| AI fields               | all-zero, ai_session present + tokens > 0, ai_line_changes present |
| human_line_changes      | null, non-null                                       |
| Dependencies            | empty, single, multiple (for canonicalization test)   |
| Time precision          | integer epoch, fractional epoch                      |
| lines/lineno/cursorpos  | all present, all null, mixed                         |

### 12.3 Cross-dump fixture scenarios

| Scenario                              | Daily                          | Heartbeat                     |
|---------------------------------------|--------------------------------|-------------------------------|
| Empty day alignment                   | 0 secs, empty arrays           | empty heartbeats              |
| Near-zero day                         | 0 secs, 1 project              | 1-2 heartbeats                |
| Normal day, single project            | 1 project, multiple entities   | matching heartbeats           |
| Multi-project day                     | 3+ projects                    | heartbeats across projects    |
| AI-heavy day                          | AI metrics in grand_total/editors | heartbeats with ai_session  |
| Day with project-sum divergence       | grand_total ≠ sum(projects)    | heartbeats (normal)           |
| Day with dependency canonicalization  | deps in project breakdown      | heartbeats with unsorted deps |

### 12.4 Fixture count

- **Daily days**: 7 (zero, near-zero, normal-single, normal-multi,
  AI-heavy, divergent-sum, deps-heavy)
- **Heartbeat days**: 7 (aligned with daily days)
- **Heartbeat items**: ~15-20 total across all fixture days
- **Total fixture files**: 2 (one daily, one heartbeat), each ≤ 5 KB
