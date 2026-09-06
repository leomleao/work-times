<script lang="ts">
  import AppShell from '$lib/components/AppShell.svelte';
  import MetricCard from '$lib/components/MetricCard.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import {
    AlertCircle,
    Archive,
    Check,
    CheckCircle2,
    Clock,
    Database,
    FileArchive,
    HardDriveDownload,
    HelpCircle,
    Info,
    Play,
    RefreshCw,
    ShieldAlert,
    UploadCloud,
    XCircle
  } from '@lucide/svelte';

  // Synthetic sync history and capability status data
  interface ImportRun {
    id: number;
    startedAt: string;
    source: 'api' | 'dump';
    duration: string;
    status: 'completed' | 'partial' | 'failed' | 'running';
    dayCount: number;
    heartbeatCount: number;
    warnings?: string[];
  }

  const importRuns: ImportRun[] = [
    {
      id: 42,
      startedAt: '2026-09-05 16:20:00',
      source: 'api',
      duration: '4.2s',
      status: 'partial',
      dayCount: 7,
      heartbeatCount: 1420,
      warnings: [
        'DURATIONS_PLAN_RESTRICTED (HTTP 402 Payment Required)',
        'HEARTBEATS_PLAN_RESTRICTED (Optional capability degraded gracefully; summaries saved)'
      ]
    },
    {
      id: 41,
      startedAt: '2026-09-04 02:00:15',
      source: 'api',
      duration: '3.8s',
      status: 'partial',
      dayCount: 7,
      heartbeatCount: 1390,
      warnings: ['HEARTBEATS_PLAN_RESTRICTED']
    },
    {
      id: 40,
      startedAt: '2026-09-01 19:44:10',
      source: 'dump',
      duration: '48.5s',
      status: 'completed',
      dayCount: 175,
      heartbeatCount: 141470,
      warnings: []
    }
  ];

  // Capability probes state
  let probing = $state(false);
  let syncing = $state(false);
  let probeSuccessNotice = $state('');

  // Warnings modal state
  let warningsModalOpen = $state(false);
  let selectedRunWarnings = $state<string[]>([]);
  let selectedRunId = $state<number>(0);

  function openWarnings(run: ImportRun) {
    selectedRunId = run.id;
    selectedRunWarnings = run.warnings || [];
    warningsModalOpen = true;
  }

  function handleProbe() {
    probing = true;
    setTimeout(() => {
      probing = false;
      probeSuccessNotice = 'Live API capabilities successfully probed. Summaries confirmed active; optional duration endpoints remain plan-restricted.';
      setTimeout(() => {
        probeSuccessNotice = '';
      }, 6000);
    }, 700);
  }

  function handleTriggerSync() {
    syncing = true;
    setTimeout(() => {
      syncing = false;
      probeSuccessNotice = 'Sync run #43 completed: 7 days within free tier policy window refreshed.';
      setTimeout(() => {
        probeSuccessNotice = '';
      }, 6000);
    }, 850);
  }
</script>

<svelte:head>
  <title>Imports & Sync — Work Times</title>
</svelte:head>

<AppShell>
  <header class="page-header">
    <div>
      <p class="eyebrow">Data Ingestion Engine</p>
      <h1>Imports & WakaTime Sync.</h1>
      <p class="lede">
        Manage automated WakaTime API polling, inspect capability boundaries, and ingest full
        historical data dumps. Telemetry is deduplicated canonically via content hashing.
      </p>
    </div>
    <div class="header-actions">
      <button
        type="button"
        class="button secondary"
        disabled={probing}
        onclick={handleProbe}
      >
        <RefreshCw size={15} class={probing ? 'spin' : ''} />
        <span>{probing ? 'Probing…' : 'Probe Capabilities'}</span>
      </button>
      <button
        type="button"
        class="button primary"
        disabled={syncing}
        onclick={handleTriggerSync}
      >
        <Play size={15} />
        <span>{syncing ? 'Syncing…' : 'Run Sync Now'}</span>
      </button>
    </div>
  </header>

  <!-- Summary KPI cards -->
  <section class="metrics" aria-label="Sync status overview">
    <MetricCard
      label="Free Tier Policy Window"
      value="7 Days"
      subtext="Rolling window policy heuristic relative to now"
      badge="Active Policy"
      badgeVariant="neutral"
    />
    <MetricCard
      label="Baseline Summaries"
      value="Available"
      subtext="Required endpoint · 200 OK verified"
      badge="Healthy"
      badgeVariant="work"
    />
    <MetricCard
      label="Optional Durations / HB"
      value="Degraded"
      subtext="HTTP 402/403 · Next reprobe in 21h 45m"
      badge="Graceful Fallback"
      badgeVariant="accent"
    />
    <MetricCard
      label="Total Ingested Events"
      value="142,890"
      subtext="182 calendar days across 3 import runs"
      badge="WAL Mode"
      badgeVariant="safe"
    />
  </section>

  {#if probeSuccessNotice}
    <div class="notice safe" role="status" style="max-width: 1180px; margin: 0 auto 20px;">
      <Check size={16} />
      <span>{probeSuccessNotice}</span>
    </div>
  {/if}

  <!-- Policy and Capability Matrix Card -->
  <div style="max-width: 1180px; margin: 0 auto 24px;">
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Policy & Plan Boundaries</p>
          <h2>WakaTime API Capabilities & Fallbacks</h2>
        </div>
        <span class="badge neutral">Automatic Probing</span>
      </div>

      <div style="padding: 20px 22px;">
        <div class="notice info" style="margin: 0 0 18px;">
          <Info size={16} />
          <div>
            <strong>7-Day Free Tier Window Heuristic:</strong>
            Free WakaTime accounts provide accessible summaries for the last 7 calendar days.
            Work Times prioritizes syncing within this window before days roll out of view. For
            older historical data, export and upload a WakaTime data dump.
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px;">
          <!-- Summaries capability -->
          <div style="padding: 16px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm);">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
              <div>
                <strong style="display: block; font-size: 14px;">Summaries (Required Baseline)</strong>
                <small style="color: var(--faint);">Daily totals, projects, languages, editors</small>
              </div>
              <span class="badge work">Available</span>
            </div>
            <p style="margin: 0; font-size: 12px; color: var(--muted); line-height: 1.5;">
              Primary source of truth for daily grand totals. If this endpoint fails, the sync
              run is marked failed.
            </p>
          </div>

          <!-- Durations capability -->
          <div style="padding: 16px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm);">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
              <div>
                <strong style="display: block; font-size: 14px;">Durations (Optional)</strong>
                <small style="color: var(--faint);">Granular entity start and end intervals</small>
              </div>
              <span class="badge accent">Restricted (402)</span>
            </div>
            <p style="margin: 0; font-size: 12px; color: var(--muted); line-height: 1.5;">
              Account plan does not include durations. Policy degrades to 'partial' sync and avoids
              hammering endpoint (24h reprobe interval).
            </p>
          </div>

          <!-- Heartbeats capability -->
          <div style="padding: 16px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm);">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
              <div>
                <strong style="display: block; font-size: 14px;">Raw Heartbeats (Optional)</strong>
                <small style="color: var(--faint);">Fine-grained write events and AI prompts</small>
              </div>
              <span class="badge accent">Restricted (403)</span>
            </div>
            <p style="margin: 0; font-size: 12px; color: var(--muted); line-height: 1.5;">
              Optional capability degraded gracefully. Full historical heartbeats can be imported
              anytime via compressed dump archives.
            </p>
          </div>
        </div>
      </div>
    </section>
  </div>

  <!-- Ingestion Panels: Upload Dump and Run History -->
  <div class="content-grid">
    <!-- Left: Import Runs History -->
    <section class="panel" aria-labelledby="history-heading">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Ingestion History</p>
          <h2 id="history-heading">Recent Import & Sync Runs</h2>
        </div>
        <span class="badge neutral">{importRuns.length} runs</span>
      </div>

      <div class="table-wrap">
        <table class="data-table" aria-label="Sync and import run history">
          <thead>
            <tr>
              <th scope="col">Run ID</th>
              <th scope="col">Started At</th>
              <th scope="col">Source</th>
              <th scope="col">Duration</th>
              <th scope="col">Days / Heartbeats</th>
              <th scope="col">Status</th>
              <th scope="col" style="text-align: right;">Advisories</th>
            </tr>
          </thead>
          <tbody>
            {#each importRuns as run}
              <tr>
                <td><code>#{run.id}</code></td>
                <td style="font-size: 12px; white-space: nowrap;">{run.startedAt}</td>
                <td>
                  <span class="badge {run.source === 'dump' ? 'personal' : 'neutral'}">
                    {run.source.toUpperCase()}
                  </span>
                </td>
                <td style="font-size: 12px;">{run.duration}</td>
                <td style="font-size: 12px;">
                  <strong>{run.dayCount} days</strong>
                  <small style="display: block; color: var(--faint);">{run.heartbeatCount.toLocaleString()} events</small>
                </td>
                <td>
                  {#if run.status === 'completed'}
                    <span class="badge safe">Completed</span>
                  {:else if run.status === 'partial'}
                    <span class="badge accent">Partial</span>
                  {:else}
                    <span class="badge danger">Failed</span>
                  {/if}
                </td>
                <td style="text-align: right;">
                  {#if run.warnings && run.warnings.length > 0}
                    <button
                      type="button"
                      class="button ghost sm"
                      onclick={() => openWarnings(run)}
                      aria-label="View warnings for run {run.id}"
                    >
                      <AlertCircle size={13} style="color: var(--warning);" />
                      <span>{run.warnings.length} advisory</span>
                    </button>
                  {:else}
                    <span style="color: var(--faint); font-size: 11px;">Clean</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <!-- Right: Dump File Importer -->
    <aside class="panel" aria-labelledby="dump-heading">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Manual Dump Ingestion</p>
          <h2 id="dump-heading">Import Archive Dump</h2>
        </div>
        <span class="badge neutral">Max: 96 MB</span>
      </div>

      <div style="padding: 22px;">
        <p style="margin: 0 0 16px; font-size: 13px; line-height: 1.6; color: var(--muted);">
          Ingest a full historical export from WakaTime. Supports compressed <code>.json.gz</code>
          or <code>.zip</code> dumps containing heartbeats and daily summaries.
        </p>

        <!-- Drag & Drop Zone -->
        <div style="border: 2px dashed var(--border-strong); border-radius: var(--radius); padding: 32px 20px; text-align: center; background: #10100e; cursor: pointer; transition: border-color 150ms ease;">
          <div style="width: 44px; height: 44px; margin: 0 auto 12px; display: grid; place-items: center; border-radius: 50%; background: var(--panel-raised); color: var(--accent);">
            <UploadCloud size={22} />
          </div>
          <strong style="display: block; font-size: 14px; margin-bottom: 4px;">
            Choose dump file or drag & drop
          </strong>
          <span style="font-size: 11px; color: var(--faint); display: block; margin-bottom: 16px;">
            wakatime-*.json.gz or wakatime-*.zip (up to 96 MB direct)
          </span>
          <button type="button" class="button secondary sm">
            <span>Select Local Archive</span>
          </button>
        </div>

        <div style="margin-top: 18px; font-size: 11px; color: var(--faint); line-height: 1.5;">
          <strong style="color: var(--muted); display: block; margin-bottom: 3px;">Safe Ingestion Guarantee:</strong>
          The importer computes canonical dependency hashes (`deps_hash`) and deduplicates
          heartbeats by UUID to guarantee idempotent re-imports without duplicating hours.
        </div>
      </div>
    </aside>
  </div>
</AppShell>

<!-- Advisories & Warnings Modal -->
<Modal
  open={warningsModalOpen}
  title="Import Run #{selectedRunId} Advisories"
  description="Diagnostic advisory codes recorded by the capability policy engine."
  onclose={() => (warningsModalOpen = false)}
>
  <div style="display: flex; flex-direction: column; gap: 10px;">
    {#each selectedRunWarnings as warn}
      <div style="padding: 10px 14px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; display: flex; align-items: flex-start; gap: 8px;">
        <AlertCircle size={16} style="color: var(--warning); flex-shrink: 0; margin-top: 2px;" />
        <span style="font-family: ui-monospace, monospace; color: var(--text);">{warn}</span>
      </div>
    {/each}
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
