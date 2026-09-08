# Wildcard Classification Rules & Manifest Consolidation

This document describes the design, matching semantics, precedence ordering, and consolidation protocol for wildcard (`glob`) classification rules in Work Times.

---

## 1. Overview & Match Modes

Classification rules map telemetry slices (machines, editors, applications, domains, projects, folder prefixes, and entities) to either `work` or `personal` categories.

Every classification rule has a `match_mode` attribute:
- **`exact`** (default): Performs an exact equality or boundary-aware prefix match.
- **`glob`**: Performs pattern matching using wildcard tokens (`*` and `?`).

```sql
ALTER TABLE classification_rules ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'exact' CHECK (match_mode IN ('exact', 'glob'));
```

---

## 2. Glob Syntax & Semantics

### Wildcard Tokens
- `*`: Matches zero or more Unicode characters. Crucially, `*` **crosses path separators (`/`) universally**, allowing single patterns like `*u081715*` or `*/internal-tools/*` to match across deep directory structures.
- `?`: Matches exactly one Unicode character.

### Bracket Escaping
Only two bracket sequences are recognized as escapes in `glob` mode:
- `[*]`: Matches a literal asterisk `*`.
- `[?]`: Matches a literal question mark `?`.

All other brackets (such as `[draft]`, `[0-9]`, or unclosed brackets) are treated as **literal characters**, avoiding regex injection, character class bugs, and unexpected pattern syntax errors. Exact mode has zero escape sequences; brackets in exact mode are always literal.

### Safety & Complexity Bounds
- Maximum pattern length: **500 characters** (`MAX_PATTERN_LENGTH = 500`). Patterns exceeding this limit fail compilation.
- Greedy linear backtracking matcher over Unicode code points (`Array.from(candidate)`). ReDoS-free and immune to catastrophic backtracking.

### Path Normalization & Casing Rules
Matching respects the canonical normalization rules of the telemetry pipeline:
1. **Windows Drive Paths**: Normalized with forward slashes and lowercased (`C:/path/...` → `c:/path/...`).
2. **Unix & Relative Paths**: Slashes normalized to forward slashes; **case is preserved**.
3. **Selector Casing**:
   - `machine`, `editor`, `application`, `domain`: Case-insensitive.
   - `project`: Case-sensitive.
   - `folder_prefix`, `entity`: Case preserved (except Windows drive root lowercased).
4. **Selector Scope for Glob Folder Prefix**:
   - In `exact` mode, `folder_prefix` matches file slices and project root slices.
   - In `glob` mode, `folder_prefix` matches **file slices only** (`slice.entityType === 'file'`).

### Canonical-Only Identity Matching
- The classification engine matches `machine` selectors strictly against canonical machine IDs (`slice.machineIds`). No friendly hostname heuristics are applied inside the matching engine.
- The classification engine matches `editor` selectors strictly against canonical editor IDs (`slice.editors`).

---

## 3. Transitive Precedence Order

Rule precedence is determined by a strict, transitive 4-tuple lexicographic key:

$$\text{precedenceKey} = (\text{priority}, \text{selectorSpecificity}, \text{matchModeRank}, \text{modeSpecificity})$$

When comparing two rules $A$ and $B$, the rule with the greater lexicographic tuple takes precedence:

1. **`priority`** (Integer, descending):
   - Manual override set by the user (default: 0).
2. **`selectorSpecificity`** (Integer, descending):
   - `entity`: 60
   - `folder_prefix`: 50
   - `project`: 40
   - Identity tier (`machine`, `editor`, `application`, `domain`): 10
3. **`matchModeRank`** (Integer, descending):
   - `exact`: 1
   - `glob`: 0
   - *In the same selector specificity tier, an `exact` rule strictly outranks a `glob` rule.*
4. **`modeSpecificity`** (Integer, descending):
   - For `exact folder_prefix`: Length of the normalized prefix string.
   - For `glob` rules (any selector): Number of literal characters in the pattern (excluding wildcards `*` and `?`).
   - For all other `exact` rules: **0**. This ensures that broad exact identity rules of varying lengths remain in equal-precedence ties.

### Conservative Ambiguity Invariant
If two active rules with equal effective precedence key (ignoring `createdAt` and `id`) match the same slice:
- If both rules assign the **same classification** (e.g. both `work`), the tie is broken deterministically by `createdAt ASC, id ASC`.
- If the rules assign **conflicting classifications** (one `work`, one `personal`), the slice is classified as **`unclassified` (ambiguous)**.
- User slice allocations (`daily_time_allocations`) always take absolute precedence over all automated rules.

---

## 4. Unclassified Hostname Suggestions

Unclassified activity grouping automatically identifies remote connection patterns:
1. Matches suggestion text against `^(.*)\s+from\s+(\S+)$`.
2. Validates remote address using `node:net.isIP(ip) !== 0` (IPv4 or IPv6).
3. If valid, generates a glob proposal with `matchMode: 'glob'` and `selector_value: '${hostname}*'`.
4. Deduplicates slice contributions by `slice.id` to prevent double-counting of seconds and counts.

---

## 5. Manifest-Driven Consolidation CLI

The rule consolidation CLI tool allows bulk retirement of redundant rules and creation of consolidated wildcard rules.

### Signatures

```bash
# Dry-Run Preview: inspects changes without writing to DB
pnpm rules:consolidate --db <path> --manifest <manifest-path>

# Explicit Apply: requires --apply, explicit DB path, manifest, and non-existing backup path
pnpm rules:consolidate --db <path> --manifest <manifest-path> --apply --backup <backup-path>
```

### Safety Requirements
- `--db <path>` is **strictly required**. The CLI never defaults to the live database.
- **Strict Manifest Schema Validation**:
  - Top-level keys restricted to `createRules` and `deleteRuleIds`; unknown keys are rejected.
  - Create-rule keys restricted to `id`, `name`, `classification`, `selectorType`, `selectorValue`, `matchMode`, `priority`, `enabled`, and `timesheetCode`; unknown keys are rejected.
  - Supplied `id` must be a non-empty string.
  - Supplied `timesheetCode` must be string or null (empty string normalizes to null).
  - Duplicate explicit create IDs are rejected.
  - Any explicit create ID also present in `deleteRuleIds` is rejected.
  - Duplicate delete IDs are rejected; non-empty strings required.
  - Pattern length bound enforced: `MAX_PATTERN_LENGTH = 500`.
- **Truly Read-Only Preflight**:
  - In **both dry-run and apply** modes, a strictly non-mutating preflight connection (`readonly: true, migrate: false, wal: false`) inspects the target database before any backup or migration.
  - Safe on databases in any journal mode (including `DELETE` journal mode); read-only connections never attempt `PRAGMA journal_mode = WAL` or header mutations.
  - Verifies that all rules in `deleteRuleIds` exist in the target database.
  - Verifies that every explicit create ID in `createRules` does not already exist in the target database.
  - If preflight fails in `--apply` mode against a pre-004 database, zero side effects occur: the target remains pre-004 and no backup file is created.
- **Apply Protocol**:
  1. Complete target preflight succeeds read-only.
  2. The target backup file `--backup <backup-path>` must not already exist (refuses overwrite).
  3. Opens source database read-only (`readonly: true, migrate: false, wal: false`) to capture a genuine pre-migration backup via `await sourceDb.backup(backupPath)`.
  4. Verifies backup file integrity via `PRAGMA integrity_check;`.
  5. Opens target database with `migrate: true` to run pending migrations (advancing to schema 004).
  6. Executes all rule deletions and creations inside a single atomic SQLite transaction via `consolidateRules`.
  7. Records append-only `classification_revisions` audit records for every mutation.
