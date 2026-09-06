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
| `WAKATIME_API_KEY` | `WAKATIME_API_KEY_FILE` | *None* | *Deferred*: Reserved for future WakaTime API background sync. |
| `WORK_TIMES_PORT` | — | `3002` | Host port mapping in `docker-compose.yml`. |

> [!IMPORTANT]
> Real WakaTime API synchronization using `WAKATIME_API_KEY` is **deferred** in this release. The application currently operates as a dump-backed archive. Do not expect background API polling to pull live heartbeats automatically.

### Generating the Admin Password Hash
Work Times uses `scrypt` with parameters `N=32768, r=8, p=1, maxmem=64MB` and enforces a minimum password length of 12 characters. Use the interactive CLI to generate the hash without echoing your password:

```bash
pnpm admin:hash-password
# When prompted with "Admin password: ", enter your password (characters are hidden)
```

The CLI outputs a hash formatted as:
```text
scrypt$32768$8$1$<salt-base64url>$<digest-base64url>
```

Add this hash to `.env`:
```bash
ADMIN_PASSWORD_HASH="scrypt$32768$8$1$..."
```
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

---

## 6. Docker Compose Deployment

A production-ready `docker-compose.yml` and multi-stage `Dockerfile` are included in the repository.

### Container Architecture
- **Base Image**: `node:24-bookworm-slim`.
- **Runtime User**: Runs as non-root user `node` (`USER node`, UID 1000).
- **In-Process Migrations**: The container entry point (`node server/index.mjs`) executes pending database migrations on boot before listening on port `3002`.
- **Data Persistence**: Backed by a named Docker volume (`work-times-data`) mapped to `/data`.
- **Host Port Binding**: Bound strictly to loopback `127.0.0.1:3002` (configurable via `WORK_TIMES_PORT`).
- **Reverse Proxy**: Includes labels for integration with Traefik on the `traefik-net` network.

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
    networks:
      - default
      - traefik-net
    labels:
      traefik.enable: "true"
      traefik.http.routers.work-times.rule: "Host(`work-times.home`)"
      traefik.http.routers.work-times.entrypoints: "websecure"
      traefik.http.routers.work-times.tls: "true"
      traefik.http.services.work-times.loadbalancer.server.port: "3002"

volumes:
  work-times-data:

networks:
  traefik-net:
    external: true
```

### Launching the Service
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
If you ran historical dump ingestion locally on the host (`DATABASE_PATH=./data/work-times.sqlite pnpm import:dumps ...`) before deploying to Docker Compose, safely seed the resulting SQLite database into the named volume `work-times-data`:

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

### OAuth Client Registration (`/admin/oauth-clients`)
You can register public or confidential OAuth client applications in `/admin/oauth-clients`.
- Clients receive a client ID prefixed with `woc_`.
- Confidential clients receive a client secret prefixed with `wcs_` that is transiently rendered once upon registration and never persisted in plaintext. It disappears permanently upon navigation or reload.

> [!NOTE]
> **OAuth Implementation Status**: Discovery metadata endpoints exist at:
> - `GET /.well-known/oauth-authorization-server`
> - `GET /.well-known/oauth-protected-resource/mcp`
>
> However, interactive OAuth protocol endpoints (such as `/oauth/authorize`, `/oauth/token`, and `/oauth/register`) are **deferred and not yet mounted** as live HTTP routes. API keys (`<generated-api-key>`) are the active authentication mechanism for MCP clients.

---

## 10. Model Context Protocol (MCP) Configuration

Work Times implements a Streamable HTTP Model Context Protocol (MCP) server at `/mcp`.

### Endpoint Specification
- **URL**: `${PUBLIC_URL}/mcp` (e.g. `http://127.0.0.1:3002/mcp` or `https://work-times.yourdomain.com/mcp`)
- **HTTP Methods**: `GET`, `POST`, `DELETE`
- **Authentication**: `Authorization: Bearer <generated-api-key>`
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
   - Create a policy with action **`Bypass`** targeting these path prefixes:
     - `/.well-known/*`
     - `/oauth/*`
     - `/mcp`
   - Selector: `Everyone` (or restricted by Client Certificate / IP if desired).

> [!WARNING]
> **Why Bypass is Required**: Non-browser agent clients (such as Claude Desktop, Cursor, and automated scripts) do not execute browser JavaScript or follow Cloudflare Access interactive login redirects.
>
> If Cloudflare Access is not bypassed on `/mcp` and `/.well-known/*`, the agent receives an **HTML 302/200 login page** instead of JSON-RPC responses or HTTP 401 Bearer challenges. This immediately breaks MCP client initialization.
>
> **Security Impact**: Bypassing Cloudflare Access on `/mcp` **does not** expose your data to the public. The `/mcp` endpoint is protected by:
> - Application Bearer token verification (`Authorization: Bearer <generated-api-key>`).
> - Required OAuth scope validation (`activity:read`).
> - Host and Origin header validation.
> - SHA-256 token hash lookup against the SQLite store.

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

### 3. Agent Receives HTML Instead of JSON from `/mcp`
- **Symptom**: MCP client logs show `Unexpected token < in JSON at position 0` or redirects to `https://*.cloudflareaccess.com`.
- **Cause**: Cloudflare Access is intercepting `/mcp` requests.
- **Remedy**: Add an Access **Bypass** policy for path `/mcp` in your Cloudflare Zero Trust dashboard.

### 4. `403 Forbidden: Cross-origin request rejected`
- **Cause**: Browser mutation sent an `Origin` header that does not match `PUBLIC_URL`.
- **Remedy**: Ensure `PUBLIC_URL` in `.env` matches the exact scheme and hostname accessed in the browser (e.g. `PUBLIC_URL=https://work-times.yourdomain.com`).

### 5. `401 Unauthorized: Access token is invalid or expired` on `/mcp`
- **Cause**: Token omitted, invalid, or revoked.
- **Remedy**: Generate a new API key in `/admin/api-keys` (keys are prefixed with `wtk_`), and ensure the client sends `Authorization: Bearer <generated-api-key>`.

### 6. Importer Memory Ceiling Exceeded
- **Cause**: A massive dump exceeds `MAX_DIRECT_IMPORT_BYTES` (default 96 MB).
- **Remedy**: Increase the threshold for the import run:
  ```bash
  pnpm import:dumps --daily ... --heartbeats ... --max-bytes 209715200
  ```
