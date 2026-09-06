# Work Times

A private, local-first telemetry archive, activity classification overlay, and Model Context Protocol (MCP) server for developer time tracking.

Work Times ingests historical activity exports from WakaTime into a locally owned SQLite database, applies a deterministic three-state classification overlay (`work`, `personal`, `unclassified`), and exposes a read-only MCP service. Authorized local or remote AI coding agents can query timesheet evidence and work summaries over HTTP while personal activities and non-work identifying details remain strictly quarantined.

---

## Key Features & Architecture

### 1. Local-First Activity Archive
All activity records, daily summaries, heartbeats, and classification rules live in a single local SQLite database running in Write-Ahead Logging (WAL) mode (`journal_mode=WAL`, `synchronous=NORMAL`). All imported telemetry, database records, and classification configurations are stored and processed locally under operator control. Security at rest relies on host-level file permissions (`chmod 0700` directories, `chmod 0600` database files), non-root container execution (`USER node`, UID 1000), and encrypted host storage/backups (no application-level database encryption).

### 2. Three-State Classification Overlay
Activity is categorized into exactly three states:
- **`work`**: Professional billable or project work. Exclusively aggregated and exposed across the MCP boundary.
- **`personal`**: Personal projects, browsing, or hobbies. Strictly quarantined and excluded from MCP output.
- **`unclassified`**: Default state for unmatched activity or ambiguous ties. Never silently counts as work.

Classification operates as an **immutable overlay** over raw imported WakaTime facts:
- Re-imports and reconciliations never erase or mutate classification decisions.
- All rule and allocation modifications write append-only audit revision logs.
- Rules match by selector types: `machine`, `editor`, `application`, `domain`, `project`, `folder_prefix`, and `entity`.
- Evaluation follows strict precedence:
  1. Whole-slice manual override (`source: 'override'`).
  2. Explicit operator priority.
  3. Selector specificity (`entity` > `folder_prefix` > `project` > `machine` / `editor` / `application` / `domain`).
  4. Longest matching folder prefix.
- Conflicting rules of equal precedence fall back safely to `unclassified` (`source: 'ambiguous'`).

### 3. Dump-Backed Ingestion Engine
Work Times currently operates as a **dump-backed archive**. It parses and ingests official WakaTime historical exports:
- Daily summary exports (`*-daily.json`): Aggregate totals, project breakdowns, categories, languages, and editors.
- Raw heartbeat exports (`*-heatbeat .json` — including the upstream space typo): Fine-grained activity events (encompassing both write and non-write interactions) and machine telemetry.

The ingestion engine deduplicates heartbeats idempotently by UUID, calculates canonical dependency hashes (`deps_hash`), redacts personal identifiers to short SHA-256 fingerprints in logs, and enforces a direct-parse memory safety ceiling (`MAX_DIRECT_IMPORT_BYTES`, default 96 MB).

> [!IMPORTANT]
> Live background synchronization against the WakaTime REST API using `WAKATIME_API_KEY` is **deferred** in this release. The application currently functions as a dump-backed archive; live polling reconciliation routes and background sync workers are not yet mounted.

### 4. Work-Only MCP Privacy Boundary
Work Times provides a read-only Streamable HTTP Model Context Protocol (MCP) endpoint at `/mcp` for AI assistants (such as Claude, Orca, and Cursor):
- **Privacy Contract**: MCP tools query only effective `work` slices. `personal` activity and all personal/unclassified identifying details (projects, categories, languages, entities, and file paths) are strictly excluded. However, MCP responses intentionally return aggregate unclassified-seconds warnings (`unclassifiedSeconds`, `hasUnclassified`) across the requested range or day so agents are alerted to incomplete classification coverage without leaking non-work identities or personal time. Exact file paths are excluded from evidence payloads to prevent accidental code disclosure.
- **Tools Provided**:
  - `get_work_summary`: Returns work-only seconds grouped by calendar day and project across a date range (`start` to `end`), along with aggregate unclassified warnings.
  - `get_work_evidence`: Returns work-only project, category, and language breakdowns for a specific `date` (and optional `project`) for timesheet preparation, along with aggregate unclassified warnings.
- **Authentication**: Protected by Bearer token authorization (`Authorization: Bearer <generated-api-key>`) requiring the `activity:read` scope. API keys are generated from the web administration console.
- **OAuth Status**: Discovery metadata endpoints exist at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp`, but interactive OAuth protocol endpoints (`/oauth/authorize`, `/oauth/token`) are deferred and not mounted as live HTTP routes. API keys (`<generated-api-key>`) are the active authentication mechanism.

### 5. Security & Session Model
- **Authentication**: Administrator access is protected by `scrypt` password hashing and login rate limiting (5 consecutive failures per 15-minute window per IP).
- **Admin Sessions**: Sessions are opaque server-side database records stored in SQLite and tracked in the browser using an `HttpOnly; SameSite=Lax` cookie named `work_times_session`.
- **Session Secret**: `SESSION_SECRET` (or `SESSION_SECRET_FILE`) authenticates session-bound HMAC CSRF tokens for administrative mutations; admin sessions themselves are opaque server-side records, not signed cookies.
- **One-Time Secrets**: Plaintext API keys (prefixed with `wtk_`) and OAuth client secrets (prefixed with `wcs_`) are transiently rendered once in the browser upon creation and never persisted to database storage (only cryptographic hashes are saved in SQLite). They disappear permanently upon navigation or page reload.

---

## Technology Stack

- **Runtime**: Node.js (`>=24.0.0`) with `pnpm` (`11.x`)
- **Web Framework**: Svelte 5 and SvelteKit (`@sveltejs/kit`)
- **Node Server Adapter**: `@sveltejs/adapter-node` wrapped in a custom Polka HTTP server (`server/index.mjs`)
- **Database**: SQLite via `better-sqlite3` in WAL mode with in-process transactional migrations
- **MCP Framework**: Official TypeScript MCP SDK v2 (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`)
- **Styling & UI**: Custom dark-first aesthetic inspired by Svelte Bits with `@lucide/svelte` icons
- **Validation & Crypto**: Zod (`zod`), native Node `crypto` (`scrypt`, `timingSafeEqual`, `randomBytes`, `createHmac`)
- **Containerization**: Multi-stage Dockerfile (`node:24-bookworm-slim`), Docker Compose
- **Ingress**: Reverse proxy via Traefik and Cloudflare Tunnel / Access

---

## Quickstart

### Prerequisites
- Node.js `>= 24.0.0`
- pnpm `>= 11.0.0` (`corepack enable`)

### 1. Clone and Install Dependencies
```bash
git clone <repo-url> work-times
cd work-times
pnpm install
```

### 2. Configure Environment
Copy the sample environment file and set restrictive file permissions:
```bash
cp .env.example .env
chmod 600 .env
```

Generate the administrator password hash using the hidden-stdin utility (minimum 12 characters):
```bash
pnpm admin:hash-password
# Enter your desired administrator password when prompted (input is hidden)
```
Add the output hash (`scrypt$32768$8$1$...`) to `ADMIN_PASSWORD_HASH` in `.env`.

Configure the session secret (minimum 32 characters) for HMAC CSRF token authentication. Because `.env.example` already defines empty `SESSION_SECRET=` and `SESSION_SECRET_FILE=` placeholders, do not append a duplicate line with `>> .env`. Instead, replace the placeholder or prefer `SESSION_SECRET_FILE`:

```bash
# Option A: Use a protected secret file (Recommended)
mkdir -p secrets && chmod 700 secrets
openssl rand -hex 32 > secrets/session_secret
chmod 600 secrets/session_secret
# In .env, set: SESSION_SECRET_FILE=./secrets/session_secret

# Option B: Replace the empty SESSION_SECRET placeholder in .env directly
sed -i.bak "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" .env && rm -f .env.bak
```

### 3. Run Database Migrations
Apply database schema migrations to create the SQLite tables:
```bash
pnpm db:migrate
```
Verify the migration status:
```bash
pnpm db:migrate --status
```

### 4. (Optional) Ingest Historical WakaTime Dumps
Validate your export dumps in dry-run mode before executing the live database import:
```bash
pnpm import:dumps \
  --daily /path/to/wakatime-*-daily.json \
  --heartbeats "/path/to/wakatime-*-heatbeat .json" \
  --dry-run
```
Execute the live database import:
```bash
pnpm import:dumps \
  --daily /path/to/wakatime-*-daily.json \
  --heartbeats "/path/to/wakatime-*-heatbeat .json"
```

### 5. Run Development Server
```bash
pnpm dev
```
Open [http://127.0.0.1:3002](http://127.0.0.1:3002) in your browser:
- Log in at `/login` using your configured admin credentials.
- Navigate to `/admin/api-keys` to create an MCP Bearer token.
- Inspect classifications and manage activity at `/admin/classify`.

### 6. Production Build & Start
```bash
pnpm build
pnpm start
```

### 7. Docker Compose Deployment
The service includes a production-ready `Dockerfile` and `docker-compose.yml` backed by a named Docker volume (`work-times-data`) mapped to `/data`:

```bash
# Build and start container
docker compose up -d --build

# Inspect startup logs and automatic in-process migrations
docker compose logs -f work-times
```

#### Seeding a Locally Imported Database into the Docker Volume
If you ran historical dump ingestion locally on the host (`DATABASE_PATH=./data/work-times.sqlite pnpm import:dumps ...`) before deploying under Docker Compose, seed the resulting SQLite database into the named volume `work-times-data`:

1. Ensure the application container is stopped:
   ```bash
   docker compose stop work-times
   ```
2. Create the container without starting it (if not yet created):
   ```bash
   docker compose create
   ```
3. Copy the local database into the named volume via the container mount point:
   ```bash
   docker compose cp ./data/work-times.sqlite work-times:/data/work-times.sqlite
   ```
4. Restore ownership to UID 1000 (`node`) and restrict permissions:
   ```bash
   docker compose run --rm --entrypoint sh -u root work-times -c "
     chown -R 1000:1000 /data &&
     chmod 700 /data &&
     chmod 600 /data/work-times.sqlite*
   "
   ```
5. Start the service:
   ```bash
   docker compose up -d
   ```

#### Database Backups
Because SQLite runs in WAL mode, take online backups using the SQLite backup API inside the container, then copy the backup outside the named volume:
```bash
docker compose exec work-times node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/data/work-times.sqlite');
  db.backup('/data/work-times-backup.sqlite')
    .then(() => process.stdout.write('Backup successful\n'))
    .catch((err) => { process.stderr.write(err.message + '\n'); process.exit(1); });
"
mkdir -p ./backups
docker compose cp work-times:/data/work-times-backup.sqlite ./backups/work-times-$(date +%Y%m%d_%H%M%S).sqlite
docker compose exec work-times rm /data/work-times-backup.sqlite
```

---

## Testing & Quality Assurance

```bash
# Run unit and contract test suites with Vitest
pnpm test

# Run Svelte and TypeScript static type analysis
pnpm check

# Run Playwright end-to-end browser test suite
pnpm test:e2e
```

---

## Documentation Links

- **[Operations & Deployment Guide](docs/OPERATIONS.md)**: Full production deployment manual, Docker Compose setup, secret storage, backup/restore procedures, Cloudflare Access Bypass configuration, and troubleshooting.
- **[WakaTime Dump Data Contract](docs/DUMP-DATA-CONTRACT.md)**: Structural specifications, envelope invariants, and privacy boundaries for daily and raw heartbeat dump archives.
- **[Architecture & Implementation Plan](docs/IMPLEMENTATION-PLAN.md)**: Deep architectural decisions, data models, precedence hierarchies, and roadmap.
