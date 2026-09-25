<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import AppShell from '$lib/components/AppShell.svelte';
  import MetricCard from '$lib/components/MetricCard.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import {
    cancelUpload,
    uploadFileChunks,
    uploadRequest,
    type UploadSummary
  } from '$lib/client/import-upload';
  import type { PageData } from './$types';
  import {
    AlertCircle,
    AlertTriangle,
    CheckCircle2,
    Clock,
    Database,
    FileArchive,
    HardDrive,
    Info,
    Shield,
    Terminal,
    XCircle
  } from '@lucide/svelte';

  let { data } = $props<{ data: PageData }>();
  let imports = $derived(data.imports);
  let uploading = $state(false);
  let uploadPhase = $state<'idle' | 'preparing' | 'daily' | 'heartbeats' | 'processing'>('idle');
  let dailyProgress = $state(0);
  let heartbeatProgress = $state(0);
  let uploadError = $state<string | null>(null);
  let uploadResult = $state<UploadSummary | null>(null);
  let validatedId = $state<string | null>(null);
  let validatedDaily: File | null = null;
  let validatedHeartbeats: File | null = null;
  let dailyInput: HTMLInputElement;
  let heartbeatInput: HTMLInputElement;

  function clearValidated() {
    if (validatedId && data.csrfToken) void cancelUpload(data.csrfToken, validatedId).catch(() => {});
    validatedId = null;
    validatedDaily = null;
    validatedHeartbeats = null;
    dailyProgress = 0;
    heartbeatProgress = 0;
    uploadError = null;
    uploadResult = null;
  }

  async function submitUpload(mode: 'validate' | 'import') {
    if (uploading) return;

    const daily = dailyInput.files?.[0];
    const heartbeats = heartbeatInput.files?.[0];
    if (!daily || !heartbeats) {
      uploadError = 'Select both the daily and heartbeat JSON files.';
      return;
    }
    if (!data.csrfToken) {
      uploadError = 'Your session expired. Sign in again and retry.';
      return;
    }
    if (daily.size > data.maxImportBytes || heartbeats.size > data.maxImportBytes) {
      uploadError = `Each JSON file must be no larger than ${data.maxImportMiB} MiB.`;
      return;
    }

    uploading = true;
    uploadError = null;
    uploadResult = null;
    let id: string | null = null;

    try {
      if (validatedId && validatedDaily === daily && validatedHeartbeats === heartbeats) {
        id = validatedId;
        dailyProgress = 100;
        heartbeatProgress = 100;
      } else {
        uploadPhase = 'preparing';
        dailyProgress = 0;
        heartbeatProgress = 0;
        const started = await uploadRequest<{ id: string; chunkBytes: number }>(data.csrfToken, {
          action: 'start',
          dailySize: daily.size,
          heartbeatSize: heartbeats.size
        });
        id = started.id;
        uploadPhase = 'daily';
        await uploadFileChunks(daily, 'daily', id, started.chunkBytes, data.csrfToken, (percent) => {
          dailyProgress = percent;
        });
        uploadPhase = 'heartbeats';
        await uploadFileChunks(heartbeats, 'heartbeats', id, started.chunkBytes, data.csrfToken, (percent) => {
          heartbeatProgress = percent;
        });
      }

      uploadPhase = 'processing';
      const response = await uploadRequest<{ upload: UploadSummary }>(data.csrfToken, {
        action: 'finish',
        id,
        mode
      });
      uploadResult = response.upload;
      if (mode === 'validate' && !response.upload.alreadyImported) {
        validatedId = id;
        validatedDaily = daily;
        validatedHeartbeats = heartbeats;
      } else {
        validatedId = null;
        validatedDaily = null;
        validatedHeartbeats = null;
        if (mode === 'validate') void cancelUpload(data.csrfToken, id).catch(() => {});
        if (mode === 'import') void invalidateAll().catch(() => {});
      }
    } catch (error) {
      uploadError = error instanceof Error ? error.message : 'The upload failed. Please retry.';
      if (id) void cancelUpload(data.csrfToken, id).catch(() => {});
      validatedId = null;
      validatedDaily = null;
      validatedHeartbeats = null;
    } finally {
      uploading = false;
      uploadPhase = 'idle';
    }
  }

  // Warnings modal state for real import warnings
  let warningsModalOpen = $state(false);
  let selectedImportWarnings = $state<string[]>([]);
  let selectedImportId = $state<number>(0);
  let selectedOmittedWarnings = $state<number>(0);

  function openWarnings(id: number, warnings: string[], omitted: number) {
    selectedImportId = id;
    selectedImportWarnings = warnings;
    selectedOmittedWarnings = omitted;
    warningsModalOpen = true;
  }
</script>

<svelte:head>
  <title>Source Imports — Work Times</title>
</svelte:head>

<AppShell>
  <header class="page-header">
    <div>
      <p class="eyebrow">Data Ingestion Engine</p>
      <h1>Historical Source Imports.</h1>
      <p class="lede">
        Review ingested WakaTime dump archives and API summary payloads. Imports are
        deduplicated canonically using content hashes to maintain immutable historical records.
      </p>
    </div>
    <div class="header-actions">
      <a href="/admin/sync" class="button secondary">
        <Database size={15} />
        <span>Sync Status</span>
      </a>
    </div>
  </header>

  <!-- Summary KPI Cards -->
  <section class="metrics" aria-label="Import statistics overview">
    <MetricCard
      label="Total Recorded Imports"
      value={imports.totalImports.toLocaleString()}
      subtext="Historical source import runs"
      badge={imports.totalImports > 0 ? 'Recorded' : 'Empty'}
      badgeVariant={imports.totalImports > 0 ? 'work' : 'neutral'}
    />
    <MetricCard
      label="CLI Ingestion Tool"
      value="pnpm import:dumps"
      subtext="Offline alternative to browser upload"
      badge="Canonical"
      badgeVariant="neutral"
    />
    <MetricCard
      label="Direct Ingestion Limit"
      value={`${data.maxImportMiB} MiB`}
      subtext="Configured via MAX_DIRECT_IMPORT_BYTES"
      badge="Configured"
      badgeVariant="safe"
    />
    <MetricCard
      label="Deduplication Engine"
      value="Content Hash"
      subtext="Canonical SHA-256 payload indexing"
      badge="Deterministic"
      badgeVariant="work"
    />
  </section>

  <section class="panel upload-panel" aria-labelledby="upload-heading">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">Browser upload</p>
        <h2 id="upload-heading">Import WakaTime JSON exports</h2>
      </div>
      <span class="badge safe">Administrator only</span>
    </div>

    <div class="upload-body">
      <p>
        Select the daily and heartbeat JSON files from the same WakaTime export. They are sent over
        this site's HTTPS connection in small requests, avoiding the proxy's combined-upload limit.
        Each file may be up to {data.maxImportMiB} MiB. Validated files stay temporarily on the server
        so you can import them without uploading again; they are removed after import or expiry.
      </p>

      {#if uploadError}
        <div class="notice danger" role="alert">{uploadError}</div>
      {/if}
      {#if uploadResult}
        <div class="notice safe" role="status">
          {#if uploadResult.alreadyImported}
            These exact exports were already imported; no changes were made.
          {:else if uploadResult.dryRun}
            Validation passed. No data was written. You can import these files without uploading again.
          {:else}
            Import complete.
          {/if}
          {uploadResult.dayCount.toLocaleString()} days and {uploadResult.heartbeatCount.toLocaleString()}
          heartbeats from {uploadResult.rangeStartDate} to {uploadResult.rangeEndDate}.
          {#if uploadResult.warningCount > 0}
            {uploadResult.warningCount.toLocaleString()}
            {uploadResult.warningCount === 1 ? 'warning was' : 'warnings were'} found.
          {/if}
        </div>
      {/if}

      <div class="upload-form">
        <div class="upload-fields">
          <label>
            <span>Daily JSON export</span>
            <input bind:this={dailyInput} type="file" accept=".json,application/json" disabled={uploading} onchange={clearValidated} />
          </label>
          <label>
            <span>Heartbeat JSON export</span>
            <input bind:this={heartbeatInput} type="file" accept=".json,application/json" disabled={uploading} onchange={clearValidated} />
          </label>
        </div>
        {#if uploading || dailyProgress > 0 || heartbeatProgress > 0}
          <div class="upload-progress" role="group" aria-label="File upload progress">
            <div class="progress-row">
              <div class="progress-label"><strong>Daily JSON</strong><span>{dailyProgress}%</span></div>
              <progress aria-label="Daily JSON upload" value={dailyProgress} max="100"></progress>
            </div>
            <div class="progress-row">
              <div class="progress-label"><strong>Heartbeat JSON</strong><span>{heartbeatProgress}%</span></div>
              <progress aria-label="Heartbeat JSON upload" value={heartbeatProgress} max="100"></progress>
            </div>
          </div>
        {/if}
        <div class="upload-actions">
          <button class="button secondary" type="button" disabled={uploading} onclick={() => submitUpload('validate')}>Validate only</button>
          <button class="button primary" type="button" disabled={uploading} onclick={() => submitUpload('import')}>
            {validatedId ? 'Import validated files' : 'Import files'}
          </button>
          {#if uploading}
            <span role="status">
              {#if uploadPhase === 'preparing'}Preparing upload…
              {:else if uploadPhase === 'daily'}Uploading daily JSON…
              {:else if uploadPhase === 'heartbeats'}Uploading heartbeat JSON…
              {:else}Transfer complete. Processing archive…{/if}
              Keep this page open.
            </span>
          {/if}
        </div>
        <noscript>Browser upload requires JavaScript. Use the CLI importer described below instead.</noscript>
      </div>
    </div>
  </section>

  <!-- Content Grid: Left Imports List, Right CLI Explanation -->
  <div class="content-grid">
    <!-- Left: Real Source Imports Table -->
    <section class="panel" aria-labelledby="imports-heading">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Database Ledger</p>
          <h2 id="imports-heading">Ingested Source Archives</h2>
        </div>
        <span class="badge neutral">
          {#if imports.omittedImports > 0}
            {imports.sourceImports.length} of {imports.totalImports} imports
          {:else}
            {imports.sourceImports.length} imports
          {/if}
        </span>
      </div>

      <div class="table-wrap">
        <table class="data-table" aria-label="Source imports table">
          <thead>
            <tr>
              <th scope="col">ID</th>
              <th scope="col">Source Type</th>
              <th scope="col">Covered Range</th>
              <th scope="col">Days / Records</th>
              <th scope="col">Duplicates / Conflicts</th>
              <th scope="col">Status</th>
              <th scope="col" style="text-align: right;">Warnings</th>
            </tr>
          </thead>
          <tbody>
            {#if imports.isEmpty}
              <tr>
                <td colspan="7" style="text-align: center; padding: 48px 16px; color: var(--muted);">
                  <div style="max-width: 440px; margin: 0 auto;">
                    <FileArchive size={28} style="margin-bottom: 10px; color: var(--accent);" />
                    <p style="font-weight: 500; font-size: 14px; margin: 0 0 6px; color: var(--text);">
                      No source imports recorded yet
                    </p>
                    <p style="font-size: 12px; margin: 0; color: var(--faint); line-height: 1.5;">
                      Upload both WakaTime JSON exports above, or use the CLI importer described on the right.
                    </p>
                  </div>
                </td>
              </tr>
            {:else}
              {#each imports.sourceImports as imp}
                <tr>
                  <td><code>#{imp.id}</code></td>
                  <td>
                    <div style="display: flex; flex-direction: column; gap: 2px;">
                      <span class="badge neutral" style="align-self: flex-start;">
                        {imp.sourceType}
                      </span>
                      <small style="color: var(--faint); font-size: 10px;">
                        {imp.formattedByteSize} {imp.dryRun ? '· dry run' : ''}
                      </small>
                    </div>
                  </td>
                  <td style="font-size: 12px; font-family: ui-monospace, monospace;">
                    {imp.rangeStartDate ?? '—'} to {imp.rangeEndDate ?? '—'}
                  </td>
                  <td style="font-size: 12px;">
                    <strong>{imp.dayCount} days</strong>
                    <small style="display: block; color: var(--faint);">
                      {imp.recordCount.toLocaleString()} records
                    </small>
                  </td>
                  <td style="font-size: 12px;">
                    <span>{imp.duplicateCount.toLocaleString()} dupes</span>
                    {#if imp.conflictCount > 0}
                      <small style="display: block; color: var(--danger);">
                        {imp.conflictCount} conflicts
                      </small>
                    {/if}
                  </td>
                  <td>
                    <span class="badge {imp.status === 'completed' ? 'safe' : imp.status === 'running' ? 'accent' : 'danger'}">
                      {imp.status.toUpperCase()}
                    </span>
                    {#if imp.errorSummary}
                      <small style="display: block; color: var(--danger); font-size: 10px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title={imp.errorSummary}>
                        {imp.errorSummary}
                      </small>
                    {/if}
                  </td>
                  <td style="text-align: right;">
                    {#if imp.warnings.length > 0}
                      <button
                        type="button"
                        class="button ghost sm"
                        onclick={() => openWarnings(imp.id, imp.warnings, imp.omittedWarnings)}
                        aria-label="View warnings for import {imp.id}"
                      >
                        <AlertCircle size={13} style="color: var(--warning);" />
                        <span>
                          {#if imp.omittedWarnings > 0}
                            {imp.warnings.length}+
                          {:else}
                            {imp.warnings.length}
                          {/if}
                        </span>
                      </button>
                    {:else}
                      <span style="color: var(--faint); font-size: 11px;">Clean</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
    </section>

    <!-- Right: Explaining CLI Dump Ingestion -->
    <aside class="panel" aria-labelledby="cli-heading">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Local CLI Ingestion</p>
          <h2 id="cli-heading">Importing Dump Archives</h2>
        </div>
        <span class="badge safe">Secure Process</span>
      </div>

      <div style="padding: 22px; font-size: 13px; line-height: 1.6; color: var(--muted); display: flex; flex-direction: column; gap: 16px;">
        <p style="margin: 0;">
          WakaTime dump archives contain personal historical telemetry and single-user activity.
          The CLI is an offline alternative to browser upload. It reads dumps directly on the
          machine holding the database, without sending them through the web application.
        </p>

        <div style="background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px 16px;">
          <strong style="display: block; font-size: 12px; color: var(--text); margin-bottom: 6px;">
            Command Usage
          </strong>
          <pre style="margin: 0; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; color: var(--accent); overflow-x: auto; white-space: pre-wrap;">pnpm import:dumps --daily &lt;daily-dump.json&gt; --heartbeats &lt;heartbeats.json&gt;</pre>
        </div>

        <div>
          <strong style="display: block; font-size: 12px; color: var(--text); margin-bottom: 8px;">
            CLI Flags & Options
          </strong>
          <ul style="margin: 0; padding-left: 18px; font-size: 12px; display: flex; flex-direction: column; gap: 6px;">
            <li><code>--dry-run</code>: Validate and report totals without writing to the database.</li>
            <li><code>--allow-conflicts</code>: Quarantine conflicting duplicate payloads instead of failing closed.</li>
            <li><code>--force</code>: Re-import dumps whose exact bytes were already processed.</li>
            <li><code>--database &lt;path&gt;</code>: Target SQLite database (defaults to DATABASE_PATH).</li>
            <li><code>--json</code>: Output the full ingestion report as JSON on stdout.</li>
          </ul>
        </div>

        <div class="notice info" style="margin: 0;">
          <Shield size={16} style="flex-shrink: 0;" />
          <span style="font-size: 12px;">
            <strong>PII Protection Guarantee:</strong>
            Dump paths, entity file names, and machine IDs are fingerprinted before hitting logs.
            Exact duplicates are deduplicated canonically by payload SHA-256 hash.
          </span>
        </div>
      </div>
    </aside>
  </div>
</AppShell>

<!-- Warnings Modal for real imports -->
<Modal
  open={warningsModalOpen}
  title="Import #{selectedImportId} Warnings"
  description="Warnings emitted during canonical parsing and deduplication."
  onclose={() => (warningsModalOpen = false)}
>
  <div style="display: flex; flex-direction: column; gap: 10px; max-height: 400px; overflow-y: auto;">
    {#each selectedImportWarnings as warn}
      <div style="padding: 10px 14px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; display: flex; align-items: flex-start; gap: 8px;">
        <AlertTriangle size={15} style="color: var(--warning); flex-shrink: 0; margin-top: 2px;" />
        <span style="font-family: ui-monospace, monospace; color: var(--text);">{warn}</span>
      </div>
    {/each}
    {#if selectedOmittedWarnings > 0}
      <p style="font-size: 11px; color: var(--muted); margin: 0;">
        {selectedOmittedWarnings.toLocaleString()} further warning{selectedOmittedWarnings === 1
          ? ''
          : 's'} on this import were not loaded.
      </p>
    {/if}
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="button primary"
      onclick={() => (warningsModalOpen = false)}
    >
      Close
    </button>
  {/snippet}
</Modal>

<style>
  .upload-panel { margin-bottom: 24px; }
  .upload-body { padding: 22px; }
  .upload-body > p { margin: 0 0 18px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .upload-body .notice { margin-bottom: 18px; }
  .upload-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  .upload-fields label { display: grid; gap: 9px; color: var(--text); font-size: 12px; font-weight: 650; }
  .upload-fields input { width: 100%; padding: 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--panel-sunken); color: var(--muted); }
  .upload-fields input:disabled { opacity: 0.6; }
  .upload-progress { display: grid; gap: 13px; margin-top: 18px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel-sunken); }
  .progress-row { display: grid; gap: 7px; }
  .progress-label { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 12px; }
  .progress-label strong { color: var(--text); font-weight: 650; }
  .progress-row progress { width: 100%; height: 9px; accent-color: var(--accent); }
  .upload-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
  .upload-actions span { color: var(--muted); font-size: 12px; }
  @media (max-width: 650px) { .upload-fields { grid-template-columns: 1fr; } }
</style>
