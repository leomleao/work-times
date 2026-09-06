<script lang="ts">
  import AppShell from '$lib/components/AppShell.svelte';
  import MetricCard from '$lib/components/MetricCard.svelte';
  import Modal from '$lib/components/Modal.svelte';
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
      subtext="Offline CLI parsing with PII redaction"
      badge="Canonical"
      badgeVariant="neutral"
    />
    <MetricCard
      label="Direct Ingestion Limit"
      value="96 MB"
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
                      Run the CLI dump importer to ingest your historical WakaTime JSON exports.
                      See the instructions on the right for command details.
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
          Work Times processes dumps locally on your machine via the CLI script to ensure zero sensitive
          payload data or file paths are exposed over web endpoints.
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
