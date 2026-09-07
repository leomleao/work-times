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
- Rules match by seven identity selector types: `machine`, `editor`, `application`, `domain`, `project`, `folder_prefix` (with path-boundary `/` semantics), and `entity`. Selectors based on language, category, branch, or dependencies are strictly disallowed.
- Evaluation follows strict precedence:
  1. Whole-slice manual override (`source: 'override'`).
  2. Explicit operator priority.
  3. Selector specificity (`entity` > `folder_prefix` > `project` > `machine` / `editor` / `application` / `domain`).
  4. Longest matching folder prefix.
- Conflicting rules of equal precedence fall back safely to `unclassified` (`source: 'ambiguous'`).

### 3. Dump-Backed Ingestion Engine & Verified Facts
Work Times currently operates as a **dump-backed archive**. It parses and ingests official WakaTime historical exports:
- Daily summary exports (`*-daily.json`): Aggregate totals, project breakdowns, categories, languages, and editors.
- Raw heartbeat exports (`*-heatbeat .json` — including the upstream space typo): Fine-grained activity events (encompassing both write and non-write interactions) and machine telemetry.

The ingestion engine deduplicates heartbeats idempotently by UUID, calculates canonical dependency hashes (`deps_hash`), redacts personal identifiers to short SHA-256 fingerprints in logs, and enforces a direct-parse memory safety ceiling (`MAX_DIRECT_IMPORT_BYTES`, default 96 MB).

#### Verified Dataset Metrics (Historical Archive)
Real export verification confirms the following aggregate baseline facts (no dump filenames, emails, hashes, paths, identities, or secrets):
- **Calendar Envelopes**: 3,593 calendar rows across the archive period.
- **Activity Days**: 571 positive activity days (non-zero daily totals) and 3,022 zero-total days.
- **Normalized Time Slices**: 14,762 normalized slices derived from day/project/entity summaries enriched with heartbeat machine/editor identity.
- **Heartbeat Events**: 82,276 unique heartbeats recognized.
- **Duplicate Handling**: 42 canonical duplicate occurrences identified; all 42 pairs are canonically identical after deterministic dependency sorting.
- **Heartbeat Conflicts**: Zero heartbeat conflicts in the archive.
- **Dependency Canonicalization**: 220,067 canonical dependency rows stored.
- **Identity Selectors**: 74,739 identity rows across the seven selector types.
- **Mathematical Invariant**: Exact equality between daily total seconds and slice total seconds across all days (`work + personal + unclassified = daily_total_seconds`), with exactly one historical 900-second unattributed divergence between summary entities and daily grand total.

> [!IMPORTANT]
> Live background synchronization against the WakaTime REST API is **deferred** in this release. The application currently functions as a dump-backed archive; recurring polling reconciliation workers and background schedulers are not yet mounted. The WakaTime OAuth connection and safe read-only discovery command are available now.

### 4. Safe Read-Only WakaTime Capability Discovery
The discovery tool uses the encrypted WakaTime OAuth connection to probe plan-gated capabilities safely. Run `pnpm wakatime:discover` for a host-run app or `docker compose run --rm --build work-times-tools wakatime:discover` for local Docker:
- **Zero Network Calls Without a Connection**: When WakaTime has not been authorized, the command performs zero network calls and directs the operator to `/integrations/wakatime`.
- **Credential Storage**: Access and refresh tokens are encrypted with AES-256-GCM using key material derived from the persistent `SESSION_SECRET`; plaintext tokens never enter browser storage.
- **No CLI Credentials**: Passing access tokens or API keys via command-line arguments is forbidden to prevent leakage into shell histories, process listings, or logs.
- **Bounded Non-PII Reporting**: Reports are strictly bounded:
  - Dumps listing is capped to at most 10 items (`MAX_DUMP_ITEMS = 10`) with aggregate total counts and a truncation indicator (`truncated: boolean`).
  - Dump types and statuses are mapped strictly to known safe values (`daily`, `heartbeats`, `pending`, `processing`, `completed`, `failed`) or `"unknown"`; arbitrary upstream strings are never echoed.
  - Response field names are filtered against explicit schema allowlists (`RECOGNIZED_RESPONSE_FIELDS`), redacting unexpected passthrough keys.
  - `--probe-date` is strictly validated as a real UTC calendar date (rejecting invalid dates like `2026-02-31`).
  - Zero PII: Output strictly excludes user IDs, emails, usernames, entity paths, project names, machines, download URLs, raw response bodies, and authorization headers.
- **Soft-Degraded Results**: Plan restrictions returning HTTP 402 or 403 on durations or heartbeats record `status: "restricted"` with `restrictionCode: "HTTP_402"` or `"HTTP_403"` without failing discovery if baseline summaries succeed.
- **Read-Only Invariant**: Probes existing data dumps via `GET /users/current/data_dumps` only; never creates dumps or triggers background sync.

### 5. Work-Only MCP Privacy Boundary
Work Times provides a read-only Streamable HTTP Model Context Protocol (MCP) endpoint at `/mcp` for AI assistants (such as Claude, Orca, and Cursor):
- **Privacy Contract**: MCP tools query only effective `work` slices. `personal` activity and all personal/unclassified identifying details (projects, categories, languages, entities, and file paths) are strictly excluded. However, MCP responses intentionally return aggregate unclassified-seconds warnings (`unclassifiedSeconds`, `hasUnclassified`) across the requested range or day so agents are alerted to incomplete classification coverage without leaking non-work identities or personal time. Exact file paths are excluded from evidence payloads to prevent accidental code disclosure.
- **Tools Provided**:
  - `get_work_summary`: Returns work-only seconds grouped by calendar day and project across a date range (`start` to `end`), along with aggregate unclassified warnings.
  - `get_work_evidence`: Returns work-only project, category, and language breakdowns for a specific `date` (and optional `project`) for timesheet preparation, along with aggregate unclassified warnings.
- **Authentication**: Protected by Bearer token authorization (`Authorization: Bearer <token>`) requiring the `activity:read` scope. Clients authenticate using either a generated application API key (`wtk_...`) or an OAuth 2.0 access token (`wto_...`).

### 6. OAuth 2.0 Authorization Server & Authentication
Work Times implements standards-compliant OAuth 2.0 authorization server routes:
- **Discovery Metadata**: RFC 8414 metadata at `GET /.well-known/oauth-authorization-server` and RFC 9728 protected resource metadata at `GET /.well-known/oauth-protected-resource/mcp`.
- **Interactive Admin Consent (`/oauth/authorize`)**: Renders a dedicated SvelteKit consent screen requiring an active administrator session and valid CSRF token. Displays requesting client details and requested scopes before authorization.
- **Mandatory PKCE**: Enforces Proof Key for Code Exchange (RFC 7636) with `S256` code challenges for public clients.
- **Exact Redirect & Resource Binding**: Redirect URIs must match registered client URIs exactly (no wildcards or path traversal). Authorizations and tokens are strictly bound to the MCP resource indicator (`resource=${PUBLIC_URL}/mcp`).
- **Token Issuance (`/oauth/token`)**: Supports authorization code exchange and refresh token grants for both public clients (`client_id` with PKCE) and confidential clients (authenticated via HTTP Basic `Authorization: Basic ...` or `client_secret_post`).
- **Refresh Token Rotation & Reuse Detection**: Refresh tokens rotate on every exchange. If an old refresh token is reused, the entire authorization family is revoked immediately to prevent replay attacks.
- **Token Revocation (`/oauth/revoke`)**: RFC 7009 endpoint revoking access and refresh tokens.
- **Constrained Dynamic Registration (`/oauth/register`)**: RFC 7591 dynamic client registration endpoint for public clients, protected by IP-based rate limiting, strict redirect URI validation, and constrained client names.
- **Cloudflare Access Ingress**: When deployed behind Cloudflare Access, bypass rules must be configured for machine protocol paths (`/oauth/*`, `/.well-known/*`, `/mcp`) and the public WakaTime install page (`/integrations/wakatime`). Application authentication still protects every privileged operation.

### 7. Security & Session Model
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

Generate the administrator password hash using the hidden-stdin utility (minimum 10 characters):
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

### 4. Connect WakaTime with OAuth

Create an app at <https://wakatime.com/apps>. For a production origin of `https://time.byleo.uk`, register:

```text
Install URL: https://time.byleo.uk/integrations/wakatime
Authorized Redirect URI: https://time.byleo.uk/oauth/wakatime/callback
Authorized Redirect URI: http://localhost:3002/oauth/wakatime/callback
```

If the final production hostname changes, replace `time.byleo.uk` in both production URLs. Redirect URIs must match `PUBLIC_URL` exactly. Configure the App ID and App Secret locally:

```dotenv
PUBLIC_URL=http://localhost:3002
WAKATIME_OAUTH_CLIENT_ID=your-app-id
WAKATIME_OAUTH_CLIENT_SECRET=your-app-secret
```

Keep a persistent `SESSION_SECRET`; changing it makes existing encrypted WakaTime tokens unreadable and requires reconnecting. Start the app, sign in, then open <http://localhost:3002/integrations/wakatime> and choose **Authorize with WakaTime**.

To probe the connected account without modifying upstream state:

```bash
# Local Docker (uses the named-volume database connected by the web app)
docker compose run --rm --build work-times-tools wakatime:discover

# Direct host run (uses DATABASE_PATH from the host environment)
pnpm wakatime:discover
```
To emit a bounded JSON report:
```bash
docker compose run --rm --build work-times-tools wakatime:discover --json
```

### 5. (Optional) Ingest Historical WakaTime Dumps
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

### 6. Run Development Server
```bash
pnpm dev
```
Open [http://127.0.0.1:3002](http://127.0.0.1:3002) in your browser:
- Log in at `/login` using your configured admin credentials.
- Navigate to `/admin/api-keys` to create an MCP Bearer token.
- Manage OAuth clients at `/admin/oauth-clients`.
- Inspect classifications and manage activity at `/admin/classify`.

### 7. Production Build & Start
```bash
pnpm build
pnpm start
```

### 8. Local Docker Compose
The service includes a production-ready `Dockerfile` and a local-development `docker-compose.yml` backed by a named Docker volume (`work-times-data`) mapped to `/data`:
- **Build Stage**: The multi-stage build installs native compilation tools (`python3`, `make`, `g++`) to build native `better-sqlite3` bindings before assembling the minimal runtime container.
- **Non-Root Execution**: Runs under non-root user `node` (UID 1000).
- **In-Process Migrations**: The container automatically executes pending migrations in-process on boot before listening on port 3002.
- **Local Credentials**: Compose loads the ignored local `.env` directly. Keep the `*_FILE` variables empty and use the direct OAuth, admin-hash, and session-secret variables for this local container.
- **Loopback Only**: The service binds to `127.0.0.1:3002` and has no reverse-proxy labels or external network dependency. Production proxy configuration will live in a separate deployment definition.
- **One-Shot Tools Image**: The profile-gated `work-times-tools` service retains development tooling for operator commands while sharing the application database volume; it never starts with the web service.
- **No Background Sync**: Live recurring background API synchronization is not active.

```bash
# Build and start container
docker compose up -d --build

# Inspect startup logs and automatic in-process migrations
docker compose logs -f work-times
```

#### Seeding a Locally Imported Database into the Docker Volume
If you ran historical dump ingestion locally on the host (`DATABASE_PATH=./data/work-times.sqlite pnpm import:dumps ...`) before starting Docker Compose, seed the resulting SQLite database into the named volume `work-times-data`:

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

---

## Upstream References & Licensing Position

Work Times is an unofficial, personal archive built on the operator's own exported
WakaTime activity. It is not affiliated with, endorsed by, or sponsored by WakaTime, and
it uses no WakaTime branding.

The reviewed WakaTime terms grant revocable access to one's own data, require lawful use,
prohibit overloading the service, and reserve WakaTime's intellectual property. Reading
those terms, private single-operator archiving and analysis of one's own exported activity
appears supportable, and the discovery CLI stays far below the documented rate limits.
This summary is a reading of the published documents, not legal advice, and it claims no
legal certainty. Commercial use, multi-user deployment, ingesting another person's data,
or redistributing WakaTime-derived data would each require independent legal review.
Consult the official sources directly, since they may change:

- [WakaTime Developers API Documentation](https://wakatime.com/developers/)
- [WakaTime Pricing](https://wakatime.com/pricing)
- [WakaTime Terms of Service](https://wakatime.com/legal/terms-of-service)
- [WakaTime Privacy Policy](https://wakatime.com/legal/privacy-policy)
- [WakaTime FAQ](https://wakatime.com/faq)
