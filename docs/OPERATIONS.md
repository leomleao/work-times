# Work Times — Operations & Deployment Guide

This guide details the operational procedures, configuration options, deployment patterns, and maintenance workflows for the Work Times service.

---

## 1. Operational Overview & Security Model

Work Times is designed as a **single-node, local-first** service. It archives, classifies, and serves developer activity telemetry to authorized local or remote AI agents.

### Security & Storage Invariants
- **No Application-Level Database Encryption**: Work Times does not perform database-layer encryption (such as SQLCipher). Security at rest is enforced through:
  - Strict host-level directory and file permissions (`chmod 0700` directories, `chmod 0600` files).
  - Non-root container execution (`USER node`, UID 1000).
  - Host-level encrypted storage (e.g. LUKS on Linux, encrypted APFS on macOS, or encrypted ZFS pools).
  - Encrypted offsite backups.
- **Gitignored Telemetry & State**: Database files (`/data/`, `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`), WakaTime export dumps (`/dump/`, `/dumps/`), and environment files (`.env`, `.env.*`) are **strictly gitignored**. They contain single-user Personally Identifiable Information (PII) and credentials. Never commit or track these paths. All telemetry, imported dumps, database records, and classification rules are stored and processed locally under operator control.
- **Privacy Boundary**: The Model Context Protocol (MCP) endpoint at `/mcp` enforces strict work-only privacy. Telemetry classified as `personal` is completely quarantined and excluded. All personal and unclassified identities and details (projects, categories, languages, entities, and file paths) are excluded from responses. However, MCP responses intentionally return aggregate unclassified-seconds warnings (`unclassifiedSeconds`, `hasUnclassified`) so AI agents are informed of incomplete classification coverage without leaking non-work activities or identifying details.

---

## 2. Local Development Setup

### System Prerequisites
- **Node.js**: `>= 24.0.0`
- **pnpm**: `>= 11.0.0` (`corepack enable`)

### Development Workflow
```bash
# Install dependencies according to frozen lockfile
pnpm install

# Run static type analysis and Svelte component checks
pnpm check

# Run Vitest test suite
pnpm test

# Run Playwright end-to-end tests
pnpm test:e2e

# Start local development server (bound to 127.0.0.1:3002)
pnpm dev
```

### Available Scripts Reference
| Command | Description |
| :--- | :--- |
| `pnpm dev` | Starts Vite development server at `127.0.0.1:3002`. |
| `pnpm build` | Compiles SvelteKit application for production using `@sveltejs/adapter-node`. |
| `pnpm start` | Boots the compiled production server (`node server/index.mjs`). |
| `pnpm check` | Runs `svelte-kit sync` and `svelte-check` type analysis. |
| `pnpm test` | Runs the Vitest test suite. |
| `pnpm test:watch` | Runs Vitest in interactive watch mode. |
| `pnpm test:e2e` | Runs Playwright browser test suite. |
| `pnpm db:migrate` | Executes the database migration CLI (`scripts/migrate.ts`). |
| `pnpm import:dumps` | Executes the WakaTime dump ingestion CLI (`scripts/import-dumps.ts`). |
| `pnpm wakatime:discover` | Runs safe, read-only discovery of WakaTime credentials and API capabilities (`scripts/wakatime-discover.ts`). |
| `pnpm admin:hash-password` | Generates an `scrypt` password hash via hidden interactive stdin. |

---

## 3. Configuration & Secret Management

### Environment File Setup
Create a private `.env` file from the provided template and lock its permissions immediately:
```bash
cp .env.example .env
chmod 600 .env
```

### Secret Storage Best Practices
In production environments, prefer the `*_FILE` configuration variants over inline environment secrets. This prevents secrets from leaking via process tables, `/proc`, container environment dumps, or orchestration manifests.

```bash
# Create a dedicated, permissions-locked secrets directory
mkdir -p secrets
chmod 700 secrets

# Example: store session secret in a restricted file
openssl rand -hex 32 > secrets/session_secret
chmod 600 secrets/session_secret
```

#### Secret File Paths
The `*_FILE` variables are read as literal filesystem paths inside the process that
consumes them. Host-relative `./secrets/...` paths work for local `pnpm dev` and
`pnpm start` runs. The local Docker Compose definition intentionally has no secret bind
mount, so leave its `*_FILE` variables empty and provide the direct secret variables in
the ignored `.env`. A future production deployment definition can mount file-backed
secrets at `/run/secrets`.

### Configuration Reference
All runtime configuration is evaluated in `src/lib/server/config.ts` and `server/index.mjs`:

| Variable | File Variant | Default | Purpose / Constraints |
| :--- | :--- | :--- | :--- |
| `DATABASE_PATH` | — | `./data/work-times.sqlite` | SQLite database path (or `/data/work-times.sqlite` in container). |
| `ADMIN_USERNAME` | — | `admin` | Username for the web administration interface. |
| `ADMIN_PASSWORD_HASH` | `ADMIN_PASSWORD_HASH_FILE` | *None* | `scrypt` hash generated via `pnpm admin:hash-password`. |
| `SESSION_SECRET` | `SESSION_SECRET_FILE` | *Ephemeral* | Secret for generating and authenticating session-bound HMAC CSRF tokens (must be $\ge 32$ characters; admin sessions are opaque server-side records). |
| `PUBLIC_URL` | — | `http://localhost:3002` | Canonical origin for Host/Origin verification and metadata (no path allowed). |
| `PORT` | — | `3002` | HTTP listen port for the custom Polka server (`server/index.mjs`). |
| `HOST` | — | `127.0.0.1` | Network interface to bind (`0.0.0.0` in container). |
| `COOKIE_SECURE` | — | `false` (dev) / `true` (HTTPS) | Enforces `Secure` attribute on admin session cookies. |
| `MAX_DIRECT_IMPORT_BYTES` | — | `100663296` (96 MB) | Memory safety ceiling for parsing large JSON dump files. |
| `WAKATIME_OAUTH_CLIENT_ID` | — | *None* | App ID from the WakaTime OAuth application. Not a secret. |
| `WAKATIME_OAUTH_CLIENT_SECRET` | `WAKATIME_OAUTH_CLIENT_SECRET_FILE` | *None* | App Secret used only for server-side token exchange, refresh, and revocation. |
| `WORK_TIMES_PORT` | — | `3002` | Host port mapping in `docker-compose.yml`. |

> [!IMPORTANT]
> Real recurring WakaTime API synchronization is **deferred** in this release. The OAuth connection and read-only capability discovery are implemented; no background polling scheduler is running yet.

### WakaTime OAuth App Registration

For the planned production origin, enter the following at <https://wakatime.com/apps>:

```text
Install URL: https://time.byleo.uk/integrations/wakatime
Authorized Redirect URI: https://time.byleo.uk/oauth/wakatime/callback
Authorized Redirect URI: http://localhost:3002/oauth/wakatime/callback
```

Change both production URLs if a different hostname is chosen. `PUBLIC_URL`
must be the exact origin used by the active redirect URI. WakaTime's public
documentation requires an exact authorized redirect but does not document a
loopback HTTP exception; if its app form rejects the localhost URI, use a
stable HTTPS development tunnel origin and register its callback instead.

### Safe Read-Only WakaTime Capability Discovery (`pnpm wakatime:discover`)
The discovery CLI inspects WakaTime account credentials, endpoint availability, and plan-gated restrictions without writing to the database or modifying upstream account state:

```bash
# Run after authorizing at /integrations/wakatime
pnpm wakatime:discover

# Emit bounded JSON output on stdout
pnpm wakatime:discover --json

# Probe a specific UTC calendar date
pnpm wakatime:discover --probe-date 2026-09-05
```

#### Security & Discovery Invariants
- **Missing-Connection Behavior**: When OAuth has not been authorized, the CLI performs zero network calls, exits with code 1, and points to the install page.
- **No CLI Credentials**: Access tokens and API keys must never be passed via CLI arguments.
- **Strict UTC Calendar Date Validation**: The `--probe-date` option is strictly validated as a real UTC calendar date with month-boundary and leap-year enforcement (rejecting non-calendar dates like `2026-02-31`).
- **Bounded Non-PII Reporting**:
  - Dumps listing is capped to at most 10 items (`MAX_DUMP_ITEMS = 10`) with total aggregate count and a truncation indicator (`truncated: boolean`).
  - Dump types and statuses are strictly mapped to safe known values (`daily`, `heartbeats`, `pending`, `processing`, `completed`, `failed`) or `"unknown"`. Arbitrary upstream strings are never echoed.
  - Response field names are filtered against explicit schema allowlists (`RECOGNIZED_RESPONSE_FIELDS`), redacting unexpected passthrough keys.
  - Reports strictly omit user IDs, emails, usernames, entity paths, project names, machines, download URLs, raw response bodies, and authorization headers.
- **Soft Degradation**: Probing optional endpoints (durations and heartbeats) that return HTTP 402 or 403 records `status: "restricted"` with `restrictionCode: "HTTP_402"` or `"HTTP_403"` without failing discovery if baseline summaries succeed.
- **Read-Only Invariant**: Probes existing data dumps via `GET /users/current/data_dumps` only; never triggers dump creation. Background incremental sync remains deferred.

### Generating the Admin Password Hash
Work Times uses `scrypt` with parameters `N=32768, r=8, p=1, maxmem=64MB` and enforces a minimum password length of 10 characters. Use the interactive CLI to generate the hash without echoing your password:

```bash
pnpm admin:hash-password
# When prompted with "Admin password: ", enter your password (characters are hidden)
```

The CLI outputs a hash formatted as:
```text
scrypt$32768$8$1$<salt-base64url>$<digest-base64url>
```

Add this hash to `.env`:
```dotenv
ADMIN_PASSWORD_HASH='scrypt$32768$8$1$...'
```

Use single quotes in `.env`; Docker Compose otherwise treats the hash's `$`
separators as environment-variable interpolation.
Or write it to a secret file:
```bash
pnpm admin:hash-password > secrets/admin_password_hash
chmod 600 secrets/admin_password_hash
# In .env: ADMIN_PASSWORD_HASH_FILE=./secrets/admin_password_hash
```

### Generating the Session Secret
The session secret authenticates session-bound HMAC CSRF tokens. Admin sessions themselves are opaque server-side database records stored in SQLite, not signed cookies. The secret must contain at least 32 characters.

Because `.env.example` already defines empty `SESSION_SECRET=` and `SESSION_SECRET_FILE=` placeholders, do not append a duplicate line with `>> .env`. Instead, replace the placeholder in `.env` or prefer `SESSION_SECRET_FILE`:

```bash
# Option A: Write directly to a protected secret file (Recommended)
mkdir -p secrets && chmod 700 secrets
openssl rand -hex 32 > secrets/session_secret
chmod 600 secrets/session_secret
# In .env: SESSION_SECRET_FILE=./secrets/session_secret

# Option B: Replace the empty SESSION_SECRET placeholder in .env
sed -i.bak "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" .env && rm -f .env.bak
```

---

## 4. Database Schema & Migrations

Database migrations reside in the `migrations/` directory:
- `migrations/001-import-schema.sql`: Tables for WakaTime daily dimensions, entities, heartbeats, and canonical dependencies.
- `migrations/002-application-state.sql`: Tables for admin sessions, API keys, OAuth clients/authorizations, classification rules, allocations, and revision audit logs.

### In-Process Automatic Migrations
When Work Times boots, `openDatabase()` in `src/lib/server/db/connection.ts` discovers all pending migrations in ascending numeric order and executes them inside an isolated transaction. Already-applied migrations recorded in `schema_migrations` are safely skipped.

### Manual Migration Management CLI
You can inspect or apply migrations manually using `scripts/migrate.ts`:

```bash
# Check current migration status without modifying the database
pnpm db:migrate --status

# Apply all pending migrations
pnpm db:migrate

# Target an explicit SQLite database file
pnpm db:migrate --database /data/work-times.sqlite
```

The migration CLI automatically sets `process.umask(0o077)` and creates parent directories with mode `0700`.

---

## 5. Historical Data Ingestion (WakaTime Dumps)

Work Times populates historical activity from official WakaTime account exports.

### Locating Export Files
When exporting data from WakaTime, you receive two JSON archives:
1. `wakatime-*-daily.json`: Daily summary grand totals, project breakdowns, categories, languages, and editors.
2. `wakatime-*-heatbeat .json`: Raw heartbeat activity events and machine telemetry (note the space before `.json` in the upstream export). Heartbeats represent activity events (encompassing both write and non-write interactions), not all write events.

Store these files in a gitignored location (such as `dumps/` or an external drive) and restrict access:
```bash
chmod 600 /path/to/dumps/*
```

### Ingestion Workflow
Run the importer CLI via `scripts/import-dumps.ts`.

#### Step 1: Dry-Run Validation
Always run a dry run first to validate schema compliance, calculate statistics, and detect anomalies:
```bash
pnpm import:dumps \
  --daily /path/to/wakatime-*-daily.json \
  --heartbeats "/path/to/wakatime-*-heatbeat .json" \
  --dry-run
```

#### Step 2: Live Ingestion
Execute the import to write records to the SQLite database:
```bash
pnpm import:dumps \
  --daily /path/to/wakatime-*-daily.json \
  --heartbeats "/path/to/wakatime-*-heatbeat .json"
```

#### Importer CLI Flags Reference
| Flag | Description |
| :--- | :--- |
| `--daily <path>` | **Required**. Path to the daily summaries JSON file. |
| `--heartbeats <path>` | **Required**. Path to the raw heartbeats JSON file. |
| `--database <path>` | Target SQLite database file (defaults to `DATABASE_PATH`). |
| `--dry-run` | Validates data and outputs the summary report without writing to disk. |
| `--allow-conflicts` | Quarantines conflicting duplicate heartbeats instead of failing closed. |
| `--force` | Forces re-import of dumps whose exact file hashes have already been ingested. |
| `--max-bytes <n>` | Memory threshold in bytes for direct JSON parsing (default: `100663296`). |
| `--json` | Emits the final report as machine-readable JSON on stdout. |

#### Safe Ingestion Guarantees
- **Redacted Logging**: Paths, machine identifiers, and user accounts are reduced to short SHA-256 fingerprints before being written to stderr.
- **Idempotency**: Repeatedly importing identical dumps is a safe no-op. Heartbeats are deduplicated by UUID, and dependency arrays are sorted and hashed canonically into `deps_hash`.

### Verified Ingestion Metrics (Historical Archive)
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

---

## 6. Local Docker Compose

A local-development `docker-compose.yml` and production-ready multi-stage `Dockerfile` are included in the repository. Reverse-proxy and public deployment settings are intentionally deferred to a separate deployment definition.

### Container Architecture
- **Base Image**: `node:24-bookworm-slim`.
- **Native Build Stage**: Compiles native `better-sqlite3` bindings using `python3`, `make`, and `g++` in the build stage while maintaining a minimal production runtime image.
- **Runtime User**: Runs as non-root user `node` (`USER node`, UID 1000).
- **In-Process Migrations**: The container entry point (`node server/index.mjs`) executes pending database migrations on boot before listening on port `3002`.
- **Data Persistence**: Backed by a named Docker volume (`work-times-data`) mapped to `/data`.
- **Host Port Binding**: Bound strictly to loopback `127.0.0.1:3002` (configurable via `WORK_TIMES_PORT`).
- **Local Networking**: Has no Traefik labels or external Docker network dependency.
- **Local Credentials**: Loads direct secret values from the ignored `.env`; file-backed production secrets are deferred to the deployment definition.
- **No Background Sync**: Does not execute live recurring API sync or background polling workers.

### Docker Compose Service Definition
The service is configured in `docker-compose.yml`:
```yaml
services:
  work-times:
    build:
      context: .
      dockerfile: Dockerfile
    image: work-times:local
    restart: unless-stopped
    env_file:
      - .env
    environment:
      DATABASE_PATH: /data/work-times.sqlite
      HOST: 0.0.0.0
      PORT: 3002
    ports:
      - "127.0.0.1:${WORK_TIMES_PORT:-3002}:3002"
    volumes:
      - work-times-data:/data

volumes:
  work-times-data:
```

### Launching the Service
Configure direct local credentials in the ignored `.env`. Do not put production secrets
in the Compose file or an image layer.

```bash
# Build the Docker image and start in detached mode
docker compose up -d --build

# Monitor startup logs and in-process migrations
docker compose logs -f work-times

# Verify container health status
docker compose ps
```

### Stopping the Service
```bash
# Stop the container (persistent /data volume is retained)
docker compose down
```

### Seeding a Locally Imported Database into the Named Volume
If you ran historical dump ingestion locally on the host (`DATABASE_PATH=./data/work-times.sqlite pnpm import:dumps ...`) before starting Docker Compose, safely seed the resulting SQLite database into the named volume `work-times-data`:

1. Ensure the application container is stopped:
   ```bash
   docker compose stop work-times
   ```
2. Create the service container if not yet created:
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

---

## 7. Persistent Data Permissions & Backup Strategies

### Permissions on `/data`
The SQLite database and WAL artifacts require restrictive permissions:
- Directory `/data`: `chmod 0700 /data`, owned by `node:node` (UID 1000).
- Database files: `/data/work-times.sqlite`, `work-times.sqlite-wal`, `work-times.sqlite-shm` are maintained at `chmod 0600`.

### Online Backup Procedures
Because Work Times operates SQLite in WAL mode (`journal_mode=WAL`), **never copy `work-times.sqlite` alone while the server is active**. Doing so produces a corrupt or incomplete backup because active transactions reside in `work-times.sqlite-wal`.

#### Option 1: SQLite Online Backup (Zero Downtime)
Use the SQLite online backup API inside the running container to create a consistent snapshot, then copy it outside the named volume to host storage:
```bash
# 1. Execute online backup to a temporary file inside the container volume:
docker compose exec work-times node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/data/work-times.sqlite');
  db.backup('/data/work-times-backup.sqlite')
    .then(() => process.stdout.write('Backup successful\n'))
    .catch((err) => { process.stderr.write(err.message + '\n'); process.exit(1); });
"

# 2. Copy the backup file outside the named volume to host storage:
mkdir -p ./backups
docker compose cp work-times:/data/work-times-backup.sqlite ./backups/work-times-$(date +%Y%m%d_%H%M%S).sqlite

# 3. Clean up the temporary snapshot file inside the container volume:
docker compose exec work-times rm /data/work-times-backup.sqlite
```

#### Option 2: Offline Snapshot (Cold Backup)
Stop the container briefly to checkpoint the WAL file and copy the persistent data outside the volume:
```bash
# 1. Stop the container to ensure WAL is cleanly flushed:
docker compose stop work-times

# 2. Copy the database directory outside the container to host backups:
mkdir -p ./backups
docker compose cp work-times:/data ./backups/work-times-data-$(date +%Y%m%d_%H%M%S)

# 3. Restart the container:
docker compose start work-times
```

### Encrypting Backups
Store backup archives using encrypted backup utilities (such as Restic, Borg, or age-encrypted tarballs):
```bash
# Example using age encryption:
tar -czf - /path/to/backup.sqlite | age -r "age1..." > /backups/work-times-backup.tar.gz.age
```
Back up your `.env` and `secrets/` directory separately using the same encryption tooling.

---

## 8. Health Checks & Observability

### Endpoint Contract
Work Times exposes an unauthenticated health probe at `GET /api/health`.

- **Success Response** (`HTTP 200 OK`):
  ```json
  {
    "status": "ok",
    "service": "work-times",
    "database": "ready"
  }
  ```
- **Degraded Response** (`HTTP 503 Service Unavailable`):
  ```json
  {
    "status": "degraded",
    "service": "work-times",
    "database": "unavailable"
  }
  ```
- **Headers**: Emits `Cache-Control: no-store` and does not disclose version strings, database paths, or PII.

### Docker Healthcheck Integration
The `Dockerfile` includes a built-in health check:
```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3002/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
```

---

## 9. Administrator Workflows, API Keys & OAuth

### Web Administration Console
1. Navigate to `/login` (e.g. `http://localhost:3002/login` or your public domain).
2. Enter `ADMIN_USERNAME` and password.
3. Login attempts are rate-limited to 5 consecutive failures per 15-minute window per IP.
4. Successful login establishes an `HttpOnly; SameSite=Lax` session cookie (`work_times_session`).
5. All administrative mutations require a matching HMAC session-bound CSRF token.

### API Key Management (`/admin/api-keys`)
API keys authenticate AI agents and MCP clients.
1. In the admin console, navigate to **API Keys** (`/admin/api-keys`).
2. Enter a descriptive key name (2–80 characters) and select scopes (defaults to `activity:read`).
3. Click **Create Key**.
4. The plaintext token (prefixed with `wtk_`) is transiently rendered once in the browser response upon creation and is never persisted in plaintext (only its SHA-256 hash is saved in SQLite). It disappears permanently upon navigation or page reload; copy and store it immediately in your agent configuration.
5. The database stores only the token hash. Keys can be revoked at any time from the UI table.

### OAuth 2.0 Authorization Server Implementation
Work Times provides an RFC-compliant OAuth 2.0 authorization server powering URL-only agent onboarding.

#### Protocol Endpoints Reference
| Endpoint | Method | RFC / Spec | Purpose |
| :--- | :--- | :--- | :--- |
| `/.well-known/oauth-authorization-server` | `GET` | RFC 8414 | OAuth 2.0 authorization server metadata. |
| `/.well-known/oauth-protected-resource/mcp` | `GET` | RFC 9728 | Protected resource metadata linking `/mcp` to the authorization server. |
| `/oauth/register` | `POST` | RFC 7591 | Constrained dynamic client registration for public agents. |
| `/oauth/authorize` | `GET`, `POST` | RFC 6749, RFC 7636 | Interactive admin consent flow requiring SvelteKit admin session. |
| `/oauth/token` | `POST` | RFC 6749, RFC 7636 | Authorization code redemption and refresh token rotation. |
| `/oauth/revoke` | `POST` | RFC 7009 | Revocation endpoint for access and refresh tokens. |

#### OAuth Security Details
- **Interactive Admin Consent**: `/oauth/authorize` checks for an active administrative session. If unauthenticated, it redirects safely to `/login` preserving validated redirect parameters. Authenticated administrators review the requesting client name, exact redirect URI, and requested scopes before granting consent with session-bound CSRF verification.
- **Mandatory PKCE**: Proof Key for Code Exchange with code challenge method `S256` is strictly enforced for public clients. Plaintext code challenges (`method=plain`) are rejected.
- **Exact Redirect & Resource Binding**: Redirect URIs must match the client's registered redirect URIs byte-for-byte; partial, prefix, or wildcard matches are rejected. Tokens are bound to the MCP resource indicator (`resource=${PUBLIC_URL}/mcp`).
- **Public & Confidential Client Authentication**:
  - Public clients authenticate using `client_id` paired with PKCE `code_verifier`.
  - Confidential clients authenticate using `client_id` and `client_secret` via either HTTP Basic (`Authorization: Basic base64(id:secret)`) or `client_secret_post` in the request body.
- **Refresh Token Rotation & Reuse Revocation**: Every refresh token exchange issues a newly rotated refresh token and invalidates the prior token. If an already-used refresh token is presented again (indicating potential token leakage or replay), the system immediately revokes all access and refresh tokens associated with that grant.
- **Constrained Dynamic Client Registration (`/oauth/register`)**: Supports automated agent registration for public clients. Constrained to prevent abuse: IP-based rate limiting (10 registrations per 15-minute window), strict redirect URI validation (must use `http://127.0.0.1`, `http://localhost`, or `https://`), and restricted client names.
- **OAuth Client Management (`/admin/oauth-clients`)**: Administrators can review registered public and confidential clients, create confidential clients with one-time rendered secrets (`wcs_...`), and revoke clients along with all issued authorizations.

---

## 10. Model Context Protocol (MCP) Configuration

Work Times implements a Streamable HTTP Model Context Protocol (MCP) server at `/mcp`.

### Endpoint Specification
- **URL**: `${PUBLIC_URL}/mcp` (e.g. `http://127.0.0.1:3002/mcp` or `https://work-times.yourdomain.com/mcp`)
- **HTTP Methods**: `GET`, `POST`, `DELETE`
- **Authentication**: `Authorization: Bearer <token>` (accepts API keys `wtk_...` or OAuth access tokens `wto_...`)
- **Required Scope**: `activity:read`

### Privacy Enforcement
- MCP tools execute against `SqliteWorkOnlyAnalytics`.
- Only records resolved as `work` by the classification engine are aggregated into project and duration totals.
- `personal` activity and all personal and unclassified identifying details (projects, categories, languages, entities, and file paths) are strictly excluded from tool results.
- Responses intentionally return aggregate unclassified-seconds warnings (`unclassifiedSeconds`, `hasUnclassified`) across the requested day or range to indicate incomplete classification coverage without leaking non-work activities or identities.
- Exact file paths are excluded from evidence payloads to prevent accidental code location disclosure.

### Client Configuration Example (Claude Desktop / Cursor / Orca)
Add the following to your agent or desktop client's MCP configuration JSON:
```json
{
  "mcpServers": {
    "work-times": {
      "url": "https://work-times.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer <generated-api-key>"
      }
    }
  }
}
```

---

## 11. Cloudflare Tunnel & Cloudflare Access Requirements

When publishing Work Times through Cloudflare Tunnel and protecting it with Cloudflare Access, follow this exact configuration.

### Network Ingress Topology
```text
[ Browser Operator ]  ──> Cloudflare Access ──┐
                                               ├──> Cloudflare Tunnel ──> 127.0.0.1:3002 ──> Work Times
[ MCP / AI Client  ]  ──> [ Access Bypass ] ──┘
```

### Cloudflare Tunnel Ingress
In your `cloudflared` configuration (`config.yml` or Zero Trust dashboard):
```yaml
ingress:
  - hostname: work-times.yourdomain.com
    service: http://127.0.0.1:3002
```

### Cloudflare Access Configuration (CRITICAL)
Create an Access Application covering `work-times.yourdomain.com`.

1. **Operator Access Policy**:
   - Protect browser admin routes (`/admin/*`, `/login`).
   - Action: `Allow`
   - Include: Your administrative email or identity provider group.

2. **Machine Protocol Bypass Policy (MANDATORY)**:
   - Create an Access policy with action **`Bypass`** targeting these path prefixes:
     - `/.well-known/*`
     - `/oauth/*`
     - `/mcp`
     - `/integrations/wakatime`
   - Selector: `Everyone` (or restricted by Client Certificate / IP if desired).

> [!WARNING]
> **Why Bypass is Required**: Non-browser agent clients (such as Claude Desktop, Cursor, and automated scripts) do not execute browser JavaScript or follow Cloudflare Access interactive login redirects.
>
> If Cloudflare Access is not bypassed on `/mcp`, `/oauth/*`, and `/.well-known/*`, the agent receives an **HTML 302/200 login page** instead of JSON-RPC responses, token exchanges, or HTTP 401 challenges. This immediately breaks MCP and OAuth client operation.
>
> **Security Rationale**: Bypassing Cloudflare Access on `/mcp` and `/oauth/*` does not expose private activity data to the public because:
> - The `/mcp` endpoint enforces cryptographic Bearer token authentication (`Authorization: Bearer ...`) and requires the `activity:read` scope.
> - The `/oauth/authorize` endpoint requires an authenticated administrator session cookie (`work_times_session`) and session-bound CSRF token to issue authorization codes.
> - Dynamic client registration (`/oauth/register`) is rate-limited and constrained to public client parameters.
> - Host and Origin header validation protects against cross-site request forgery.
> - All telemetry classified as `personal` is completely quarantined from MCP responses.
>
> Note: While application-layer authentication protects these endpoints, administrators should still consider IP restrictions or mTLS if public machine exposure is a concern.

---

## 12. Maintenance: Upgrades & Rollbacks

### Upgrading Work Times
1. Take a snapshot backup of the SQLite database outside the volume:
   ```bash
   docker compose exec work-times node -e "
     const Database = require('better-sqlite3');
     const db = new Database('/data/work-times.sqlite');
     db.backup('/data/work-times-pre-upgrade.sqlite')
       .then(() => process.stdout.write('Pre-upgrade backup successful\n'))
       .catch((err) => { process.stderr.write(err.message + '\n'); process.exit(1); });
   "
   mkdir -p ./backups
   docker compose cp work-times:/data/work-times-pre-upgrade.sqlite ./backups/work-times-pre-upgrade.sqlite
   docker compose exec work-times rm /data/work-times-pre-upgrade.sqlite
   ```
2. Pull the latest repository code:
   ```bash
   git pull origin main
   ```
3. Rebuild and restart the container:
   ```bash
   docker compose up -d --build
   ```
4. Check startup logs to confirm in-process migrations completed:
   ```bash
   docker compose logs --tail=50 work-times
   ```
5. Verify health:
   ```bash
   curl -s http://127.0.0.1:3002/api/health
   ```

### Rolling Back
1. Stop the application container:
   ```bash
   docker compose stop work-times
   ```
2. Restore the pre-upgrade SQLite database backup into the named volume:
   ```bash
   docker compose cp ./backups/work-times-pre-upgrade.sqlite work-times:/data/work-times.sqlite
   ```
3. Restore ownership to UID 1000 (`node`) and restrict permissions:
   ```bash
   docker compose run --rm --entrypoint sh -u root work-times -c "
     chown -R 1000:1000 /data &&
     chmod 700 /data &&
     chmod 600 /data/work-times.sqlite*
   "
   ```
4. Check out the previous stable git commit or image tag:
   ```bash
   git checkout <previous-commit-hash>
   ```
5. Restart the service:
   ```bash
   docker compose up -d --build
   ```

---

## 13. Troubleshooting Guide

### 1. `SQLITE_BUSY: database is locked`
- **Cause**: Concurrent writers or long-running transactions exceeding `busy_timeout` (default 5000 ms).
- **Remedy**:
  - Verify that only one container or process is accessing the SQLite file.
  - Do not run manual CLI imports while the production container is performing heavy writes.
  - Check that WAL mode is active (`journal_mode=WAL`).

### 2. `EACCES: permission denied` on `/data` or `.sqlite`
- **Cause**: The container runs as non-root UID 1000 (`node`), but the named volume directory has incorrect ownership or permissions.
- **Remedy**:
  ```bash
  docker compose run --rm --entrypoint sh -u root work-times -c "
    chown -R 1000:1000 /data &&
    chmod 700 /data &&
    chmod 600 /data/work-times.sqlite*
  "
  ```

### 3. Agent Receives HTML Instead of JSON from `/mcp` or `/oauth/*`
- **Symptom**: MCP client logs show `Unexpected token < in JSON at position 0` or redirects to `https://*.cloudflareaccess.com`.
- **Cause**: Cloudflare Access is intercepting `/mcp` or `/oauth/*` requests.
- **Remedy**: Add an Access **Bypass** policy for paths `/mcp`, `/oauth/*`, and `/.well-known/*` in your Cloudflare Zero Trust dashboard.

### 4. `403 Forbidden: Cross-origin request rejected`
- **Cause**: Browser mutation sent an `Origin` header that does not match `PUBLIC_URL`.
- **Remedy**: Ensure `PUBLIC_URL` in `.env` matches the exact scheme and hostname accessed in the browser (e.g. `PUBLIC_URL=https://work-times.yourdomain.com`).

### 5. `401 Unauthorized: Access token is invalid or expired` on `/mcp`
- **Cause**: Token omitted, invalid, or revoked.
- **Remedy**: Generate a new API key in `/admin/api-keys` (keys are prefixed with `wtk_`) or re-authenticate via OAuth, ensuring the client sends `Authorization: Bearer <token>`.

### 6. Importer Memory Ceiling Exceeded
- **Cause**: A massive dump exceeds `MAX_DIRECT_IMPORT_BYTES` (default 96 MB).
- **Remedy**: Increase the threshold for the import run:
  ```bash
  pnpm import:dumps --daily ... --heartbeats ... --max-bytes 209715200
  ```

---

## 14. Research, Licensing & References

WakaTime terms grant revocable access to one's own data, require lawful use, prohibit service overloading, and reserve intellectual property rights. Work Times operates as a personal, private archive consuming user-owned exported activity files. This analysis is not legal advice and does not claim legal certainty; any commercialization, multi-user deployment, or third-party redistribution would require independent legal review.

Primary references:
- [WakaTime Developers API Documentation](https://wakatime.com/developers/)
- [WakaTime Frequently Asked Questions](https://wakatime.com/faq)
- [WakaTime Pricing Information](https://wakatime.com/pricing)
- [WakaTime Terms of Service](https://wakatime.com/legal/terms-of-service)
- [WakaTime Privacy Policy](https://wakatime.com/legal/privacy-policy)
