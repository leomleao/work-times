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
    HardDrive,
    Info,
    Key,
    Shield,
    Terminal,
    XCircle
  } from '@lucide/svelte';

  let { data } = $props<{ data: PageData }>();
  let sync = $derived(data.sync);
  let sumCap = $derived(sync.capabilityState?.capabilities?.summaries);
  let durCap = $derived(sync.capabilityState?.capabilities?.durations);
  let hbCap = $derived(sync.capabilityState?.capabilities?.heartbeats);

  // Advisories modal state for real runs
  let advisoriesModalOpen = $state(false);
  let selectedRunAdvisories = $state<string[]>([]);
  let selectedRunId = $state<number>(0);

  function openAdvisories(runId: number, codes: string[]) {
    selectedRunId = runId;
    selectedRunAdvisories = codes;
    advisoriesModalOpen = true;
  }
</script>

<svelte:head>
  <title>API Sync & Capabilities — Work Times</title>
</svelte:head>

<AppShell>
  <header class="page-header">
    <div>
      <p class="eyebrow">Data Ingestion Engine</p>
      <h1>API Sync & Capability State.</h1>
      <p class="lede">
        Inspect upstream WakaTime API sync runs, recorded daily sync states, and discovered
        account plan capability boundaries. Background incremental sync is deferred.
      </p>
    </div>
    <div class="header-actions">
      <a href="/admin/imports" class="button secondary">
        <HardDrive size={15} />
        <span>View Archive Imports</span>
      </a>
    </div>
  </header>

  <!-- Truthful status banners -->
  <div style="max-width: 1180px; margin: 0 auto 20px; display: flex; flex-direction: column; gap: 12px;">
    {#if !sync.oauthAppConfigured}
      <div class="notice info" role="status">
        <Key size={18} style="flex-shrink: 0; color: var(--accent);" />
        <div>
          <strong>The WakaTime OAuth app is unconfigured.</strong>
          <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted);">
            Add <code>WAKATIME_OAUTH_CLIENT_ID</code>, the App Secret, and a persistent <code>SESSION_SECRET</code> to the server environment.
          </p>
        </div>
      </div>
    {:else if !sync.oauthConnected}
      <div class="notice info" role="status">
        <Key size={18} style="flex-shrink: 0; color: var(--accent);" />
        <div>
          <strong>WakaTime authorization is required.</strong>
          <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted);">
            <a href="/integrations/wakatime" style="color: var(--text); text-decoration: underline;">Open the secure connection page</a> to authorize read-only access.
          </p>
        </div>
      </div>
    {:else}
      <div class="notice safe" role="status">
        <CheckCircle2 size={18} style="flex-shrink: 0; color: var(--work);" />
        <div>
          <strong>WakaTime OAuth is connected. Safe capability discovery is ready.</strong>
          <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted);">
            Run safe discovery for this Docker database: <code>docker compose run --rm --build work-times-tools wakatime:discover</code>.
            This probes the upstream API without modifying telemetry and stores discovered account limits.
          </p>
        </div>
      </div>
    {/if}

    <div class="notice neutral" role="status">
      <Clock size={18} style="flex-shrink: 0; color: var(--muted);" />
      <div>
        <strong>Background and live incremental sync execution is deferred.</strong>
        <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted);">
          Automated background synchronization is intentionally deferred in this architecture. All data synchronization
          is initiated through explicit operator CLI commands to guarantee predictable execution, safe idempotency, and auditability.
        </p>
      </div>
    </div>
  </div>

  <!-- KPI Metrics -->
  <section class="metrics" aria-label="Sync engine status overview">
    <MetricCard
      label="WakaTime OAuth"
      value={sync.oauthConnected ? 'Connected' : 'Disconnected'}
      subtext={sync.oauthConnected ? 'Encrypted server-side tokens' : 'Authorization required'}
      badge={sync.discoveryReady ? 'Ready' : 'Setup'}
      badgeVariant={sync.discoveryReady ? 'work' : 'neutral'}
    />
    <MetricCard
      label="Recorded Sync Runs"
      value={sync.syncRuns.length.toLocaleString()}
      subtext="Historical sync run executions"
      badge={sync.syncRuns.length > 0 ? 'Recorded' : 'Empty'}
      badgeVariant="neutral"
    />
    <MetricCard
      label="Tracked Sync Days"
      value={sync.syncDays.length.toLocaleString()}
      subtext="Day-level sync records in SQLite"
      badge={sync.syncDays.length > 0 ? 'Indexed' : 'Empty'}
      badgeVariant={sync.syncDays.length > 0 ? 'safe' : 'neutral'}
    />
    <MetricCard
      label="Background Engine"
      value="Deferred"
      subtext="Live background polling disabled"
      badge="Architectural"
      badgeVariant="neutral"
    />
  </section>

  <!-- Capability Boundaries Panel -->
  <div style="max-width: 1180px; margin: 0 auto 24px;">
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Policy & Plan Boundaries</p>
          <h2>WakaTime API Capabilities</h2>
        </div>
        <span class="badge {sync.capabilityState ? 'safe' : 'neutral'}">
          {sync.capabilityState ? 'Probed' : 'Not Probed Yet'}
        </span>
      </div>

      <div style="padding: 20px 22px;">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px;">
          <!-- Summaries capability -->
          <div style="padding: 16px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm);">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
              <div>
                <strong style="display: block; font-size: 14px;">Summaries (Required Baseline)</strong>
                <small style="color: var(--faint);">Daily totals, projects, languages, editors</small>
              </div>
              <span class="badge {sumCap?.status === 'available' ? 'work' : sumCap?.status === 'restricted' ? 'accent' : 'neutral'}">
                {sumCap ? sumCap.status.toUpperCase() : 'UNTESTED'}
              </span>
            </div>
            <p style="margin: 0; font-size: 12px; color: var(--muted); line-height: 1.5;">
              Primary source of truth for daily grand totals.
              {#if sumCap?.lastSuccessAt}
                Last confirmed at {new Date(sumCap.lastSuccessAt).toLocaleString()}.
              {:else}
                Run the safe discovery command to probe this capability.
              {/if}
            </p>
          </div>

          <!-- Durations capability -->
          <div style="padding: 16px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm);">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
              <div>
                <strong style="display: block; font-size: 14px;">Durations (Optional)</strong>
                <small style="color: var(--faint);">Granular entity start and end intervals</small>
              </div>
              <span class="badge {durCap?.status === 'available' ? 'work' : durCap?.status === 'restricted' ? 'accent' : 'neutral'}">
                {durCap ? durCap.status.toUpperCase() : 'UNTESTED'}
              </span>
            </div>
            <p style="margin: 0; font-size: 12px; color: var(--muted); line-height: 1.5;">
              {#if durCap?.status === 'restricted'}
                Restricted on upstream plan ({durCap.restrictionCode ?? 'HTTP 402/403'}). Engine degrades to partial sync gracefully.
              {:else if durCap?.status === 'available'}
                Available and active for granular duration calculation.
              {:else}
                Subject to account plan tier. Evaluated during safe discovery.
              {/if}
            </p>
          </div>

          <!-- Heartbeats capability -->
          <div style="padding: 16px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm);">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
              <div>
                <strong style="display: block; font-size: 14px;">Heartbeats (Optional)</strong>
                <small style="color: var(--faint);">Raw write events, AI sessions, and tokens</small>
              </div>
              <span class="badge {hbCap?.status === 'available' ? 'work' : hbCap?.status === 'restricted' ? 'accent' : 'neutral'}">
                {hbCap ? hbCap.status.toUpperCase() : 'UNTESTED'}
              </span>
            </div>
            <p style="margin: 0; font-size: 12px; color: var(--muted); line-height: 1.5;">
              {#if hbCap?.status === 'restricted'}
                Restricted on upstream plan ({hbCap.restrictionCode ?? 'HTTP 402/403'}). Full heartbeats can be imported via dump archives.
              {:else if hbCap?.status === 'available'}
                Available for fine-grained heartbeat ingestion.
              {:else}
                Subject to account plan tier. Evaluated during safe discovery.
              {/if}
            </p>
          </div>
        </div>
      </div>
    </section>
  </div>

  <!-- Real Sync Runs History -->
  <div style="max-width: 1180px; margin: 0 auto 24px;">
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Execution Log</p>
          <h2>Recorded Sync Runs</h2>
        </div>
        <span class="badge neutral">{sync.syncRuns.length} runs</span>
      </div>

      <div class="table-wrap">
        <table class="data-table" aria-label="Sync runs table">
          <thead>
            <tr>
              <th scope="col">Run ID</th>
              <th scope="col">Started At</th>
              <th scope="col">Trigger</th>
              <th scope="col">Date Range</th>
              <th scope="col">Days Synced / Failed</th>
              <th scope="col">Status</th>
              <th scope="col" style="text-align: right;">Advisories</th>
            </tr>
          </thead>
          <tbody>
            {#if sync.syncRuns.length === 0}
              <tr>
                <td colspan="7" style="text-align: center; padding: 36px 16px; color: var(--faint);">
                  No sync runs recorded in database. Run discovery or sync commands via the CLI.
                </td>
              </tr>
            {:else}
              {#each sync.syncRuns as run}
                <tr>
                  <td><code>#{run.id}</code></td>
                  <td style="font-size: 12px; white-space: nowrap;">
                    {new Date(run.startedAt).toLocaleString()}
                  </td>
                  <td>
                    <span class="badge neutral">{run.trigger}</span>
                  </td>
                  <td style="font-size: 12px; font-family: ui-monospace, monospace;">
                    {run.rangeStartDate ?? '—'} to {run.rangeEndDate ?? '—'}
                  </td>
                  <td style="font-size: 12px;">
                    <strong>{run.daysSynced} synced</strong>
                    {#if run.daysFailed > 0}
                      <span style="color: var(--danger);">({run.daysFailed} failed)</span>
                    {/if}
                  </td>
                  <td>
                    <span class="badge {run.status === 'succeeded' ? 'safe' : run.status === 'partial' ? 'accent' : 'danger'}">
                      {run.status.toUpperCase()}
                    </span>
                  </td>
                  <td style="text-align: right;">
                    {#if run.advisoryCodes.length > 0}
                      <button
                        type="button"
                        class="button ghost sm"
                        onclick={() => openAdvisories(run.id, run.advisoryCodes)}
                        aria-label="View advisories for run {run.id}"
                      >
                        <AlertCircle size={13} style="color: var(--warning);" />
                        <span>{run.advisoryCodes.length} advisory</span>
                      </button>
                    {:else}
                      <span style="color: var(--faint); font-size: 11px;">None</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
    </section>
  </div>

  <!-- Real Sync Days History -->
  {#if sync.syncDays.length > 0}
    <div style="max-width: 1180px; margin: 0 auto 24px;">
      <section class="panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Day-Level State</p>
            <h2>Recorded Sync Days</h2>
          </div>
          <span class="badge neutral">{sync.syncDays.length} days</span>
        </div>

        <div class="table-wrap">
          <table class="data-table" aria-label="Sync days table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Status</th>
                <th scope="col">Summaries</th>
                <th scope="col">Durations</th>
                <th scope="col">Heartbeats</th>
                <th scope="col">Total Recorded Time</th>
                <th scope="col" style="text-align: right;">Heartbeats Count</th>
              </tr>
            </thead>
            <tbody>
              {#each sync.syncDays as day}
                <tr>
                  <td style="font-family: ui-monospace, monospace; font-size: 12px;">
                    <strong>{day.date}</strong>
                  </td>
                  <td>
                    <span class="badge {day.status === 'succeeded' ? 'safe' : day.status === 'partial' ? 'accent' : 'danger'}">
                      {day.status.toUpperCase()}
                    </span>
                  </td>
                  <td>
                    <span style="font-size: 11px; color: {day.summariesStatus === 'succeeded' ? 'var(--work)' : 'var(--faint)'};">
                      {day.summariesStatus ?? '—'}
                    </span>
                  </td>
                  <td>
                    <span style="font-size: 11px; color: {day.durationsStatus === 'succeeded' ? 'var(--work)' : 'var(--faint)'};">
                      {day.durationsStatus ?? '—'}
                    </span>
                  </td>
                  <td>
                    <span style="font-size: 11px; color: {day.heartbeatsStatus === 'succeeded' ? 'var(--work)' : 'var(--faint)'};">
                      {day.heartbeatsStatus ?? '—'}
                    </span>
                  </td>
                  <td>
                    <span style="font-weight: 500;">{day.formattedDuration}</span>
                  </td>
                  <td style="text-align: right; font-family: ui-monospace, monospace; font-size: 12px;">
                    {day.heartbeatCount.toLocaleString()}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  {/if}
</AppShell>

<!-- Advisories Modal for real runs -->
<Modal
  open={advisoriesModalOpen}
  title="Sync Run #{selectedRunId} Advisories"
  description="Diagnostic codes recorded by the capability policy engine."
  onclose={() => (advisoriesModalOpen = false)}
>
  <div style="display: flex; flex-direction: column; gap: 10px;">
    {#each selectedRunAdvisories as code}
      <div style="padding: 10px 14px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; display: flex; align-items: flex-start; gap: 8px;">
        <AlertCircle size={16} style="color: var(--warning); flex-shrink: 0; margin-top: 2px;" />
        <span style="font-family: ui-monospace, monospace; color: var(--text);">{code}</span>
      </div>
    {/each}
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="button primary"
      onclick={() => (advisoriesModalOpen = false)}
    >
      Close
    </button>
  {/snippet}
</Modal>
