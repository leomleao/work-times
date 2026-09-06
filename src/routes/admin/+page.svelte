<script lang="ts">
  import AppShell from '$lib/components/AppShell.svelte';
  import MetricCard from '$lib/components/MetricCard.svelte';
  import TimelineBar from '$lib/components/TimelineBar.svelte';
  import type { PageData } from './$types';
  import {
    Activity,
    ArrowUpRight,
    Bot,
    Clock,
    Database,
    FolderKanban,
    HardDrive,
    Info,
    Laptop,
    SlidersHorizontal,
    Sparkles
  } from '@lucide/svelte';

  let { data } = $props<{ data: PageData }>();
  let overview = $derived(data.overview);
</script>

<svelte:head>
  <title>Overview — Work Times</title>
</svelte:head>

<AppShell>
  <header class="page-header">
    <div>
      <p class="eyebrow">Local Activity Archive</p>
      <h1>Activity archive overview.</h1>
      <p class="lede">
        Private activity telemetry ingested from local dumps and WakaTime API sync.
        Rules and overrides classify historical activity without mutating raw events.
      </p>
    </div>
    <div class="header-actions">
      <a href="/admin/sync" class="button secondary">
        <Database size={15} />
        <span>Sync Archive</span>
      </a>
      <a href="/admin/classify" class="button primary">
        <SlidersHorizontal size={15} />
        <span>Classify Inbox</span>
      </a>
    </div>
  </header>

  <!-- Empty state banner if database has no records -->
  {#if overview.isEmpty}
    <div class="notice info" role="status" style="max-width: 1180px; margin: 0 auto 24px;">
      <Info size={18} style="flex-shrink: 0;" />
      <div>
        <strong>Database is ready and awaiting activity ingestion.</strong>
        <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted);">
          No activity records, daily totals, or source imports were found in the SQLite database.
          Ingest historical activity dumps using <code>pnpm import:dumps</code> or configure WakaTime API credentials.
        </p>
      </div>
    </div>
  {/if}

  <!-- High-level KPI metrics from real SQLite aggregates -->
  <section class="metrics" aria-label="Archive summary statistics">
    <MetricCard
      label="Total Recorded Time"
      value={overview.dateSpan.totalSeconds > 0 ? overview.dateSpan.totalSeconds >= 3600 ? `${Math.round(overview.dateSpan.totalSeconds / 3600)}h` : `${Math.round(overview.dateSpan.totalSeconds / 60)}m` : '0h'}
      subtext={overview.dateSpan.activeDays > 0
        ? `Across ${overview.dateSpan.activeDays} active calendar days · ${overview.heartbeatCount.toLocaleString()} heartbeats`
        : 'No recorded days in archive'}
      badge={overview.isEmpty ? 'Empty' : 'Active Archive'}
      badgeVariant={overview.isEmpty ? 'neutral' : 'work'}
    />
    <MetricCard
      label="Classified Coverage"
      value={`${overview.coverage.coveragePercentage}%`}
      subtext={`${Math.round(overview.coverage.workSeconds / 3600)}h Work · ${Math.round(overview.coverage.personalSeconds / 3600)}h Personal`}
      badge="Deterministic"
      badgeVariant="work"
    />
    <MetricCard
      label="Unclassified Time"
      value={overview.coverage.unclassifiedSeconds >= 3600 ? `${Math.round(overview.coverage.unclassifiedSeconds / 3600)}h` : `${Math.round(overview.coverage.unclassifiedSeconds / 60)}m`}
      subtext={`${overview.coverage.unclassifiedSlices} slices awaiting decision`}
      badge={overview.coverage.unclassifiedSeconds > 0 ? 'Action needed' : 'Up to date'}
      badgeVariant={overview.coverage.unclassifiedSeconds > 0 ? 'accent' : 'safe'}
    />
    <MetricCard
      label="AI Sessions Tracked"
      value={overview.dateSpan.totalAiSessions.toLocaleString()}
      subtext={overview.dateSpan.totalAiTokens > 0
        ? `${Math.round(overview.dateSpan.totalAiTokens / 1000)}k tokens · +${overview.dateSpan.totalAiAdditions.toLocaleString()} lines`
        : 'Telemetry from local slices'}
      badge="AI Telemetry"
      badgeVariant="personal"
    />
  </section>

  <!-- Ratio strip using real immutable overlay coverage -->
  <div style="max-width: 1180px; margin: 0 auto 28px;">
    <div class="panel" style="padding: 18px 22px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <span style="font-size: 12px; font-weight: 600; color: var(--text);">Overall Classification Ratio</span>
        <span class="badge neutral">Source of truth: local rules & overrides</span>
      </div>
      <TimelineBar
        workPercent={overview.coverage.workPercent}
        personalPercent={overview.coverage.personalPercent}
        unclassifiedPercent={overview.coverage.unclassifiedPercent}
        height="12px"
      />
    </div>
  </div>

  <!-- Content Grid -->
  <div class="content-grid">
    <!-- Left Column: Activity trend and Top Projects -->
    <div style="display: flex; flex-direction: column; gap: 18px;">
      <!-- Hourly Activity Distribution if heartbeats exist -->
      <section class="panel" aria-labelledby="heading-trend">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Hourly Intensity</p>
            <h2 id="heading-trend">Activity Distribution</h2>
          </div>
          <span class="badge {overview.hourlyActivity ? 'safe' : 'neutral'}">
            {overview.hourlyActivity ? `${overview.heartbeatCount.toLocaleString()} Heartbeats` : 'Summaries Only'}
          </span>
        </div>
        <div style="padding: 20px 22px;">
          {#if overview.hourlyActivity}
            <p style="margin: 0 0 14px; font-size: 12px; color: var(--muted);">
              Aggregate coding volume distribution across 24 hours of the day derived from canonical heartbeat timestamps.
            </p>
            <TimelineBar hourlyData={overview.hourlyActivity} />
          {:else}
            <div style="padding: 24px 16px; text-align: center; color: var(--muted); font-size: 13px;">
              <p style="margin: 0 0 6px; font-weight: 500; color: var(--text);">No granular hourly heartbeats</p>
              <p style="margin: 0; font-size: 12px; color: var(--faint);">
                Hourly distribution curves are populated when importing full heartbeat dumps via <code>pnpm import:dumps</code>.
              </p>
            </div>
          {/if}
        </div>
      </section>

      <!-- Projects breakdown from real immutable overlay -->
      <section class="panel" aria-labelledby="heading-projects">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Project breakdown</p>
            <h2 id="heading-projects">Largest Active Projects</h2>
          </div>
          <a href="/admin/activity" class="button ghost sm">
            <span>View all in Activity</span>
            <ArrowUpRight size={13} />
          </a>
        </div>

        <div class="table-wrap">
          <table class="data-table" aria-label="Top active projects table">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Time Tracked</th>
                <th scope="col">Classification</th>
                <th scope="col">AI Sessions</th>
                <th scope="col" style="text-align: right;">Action</th>
              </tr>
            </thead>
            <tbody>
              {#if overview.topProjects.length === 0}
                <tr>
                  <td colspan="5" style="text-align: center; padding: 32px 16px; color: var(--faint);">
                    No projects found in database.
                  </td>
                </tr>
              {:else}
                {#each overview.topProjects as proj}
                  <tr>
                    <td>
                      <div style="display: flex; align-items: center; gap: 8px;">
                        <FolderKanban size={15} style="color: var(--accent); flex-shrink: 0;" />
                        <strong>{proj.name}</strong>
                      </div>
                    </td>
                    <td>
                      <span>{proj.formattedTime}</span>
                      <small style="display: block; color: var(--faint); font-size: 11px;">
                        {proj.sliceCount} {proj.sliceCount === 1 ? 'slice' : 'slices'}
                      </small>
                    </td>
                    <td>
                      <span class="badge {proj.classification}">
                        {proj.classification.charAt(0).toUpperCase() + proj.classification.slice(1)}
                      </span>
                    </td>
                    <td>
                      {#if proj.aiSessions > 0}
                        <span style="display: inline-flex; align-items: center; gap: 4px; font-size: 12px;">
                          <Bot size={13} style="color: var(--personal);" />
                          {proj.aiSessions}
                        </span>
                      {:else}
                        <span style="color: var(--faint); font-size: 11px;">—</span>
                      {/if}
                    </td>
                    <td style="text-align: right;">
                      <a href="/admin/classify" class="button ghost sm" aria-label="Manage rules for {proj.name}">
                        <span>Rules</span>
                      </a>
                    </td>
                  </tr>
                {/each}
              {/if}
            </tbody>
          </table>
        </div>
      </section>

      <!-- Recent Activity breakdown -->
      {#if overview.recentActivity.length > 0}
        <section class="panel" aria-labelledby="heading-recent">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Timeline History</p>
              <h2 id="heading-recent">Recent Daily Activity</h2>
            </div>
            <span class="badge neutral">{overview.recentActivity.length} Days</span>
          </div>

          <div class="table-wrap">
            <table class="data-table" aria-label="Recent daily totals table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Total Time</th>
                  <th scope="col">AI Sessions</th>
                  <th scope="col">Code Additions / Deletions</th>
                  <th scope="col" style="text-align: right;">Explorer</th>
                </tr>
              </thead>
              <tbody>
                {#each overview.recentActivity as day}
                  <tr>
                    <td style="font-family: ui-monospace, monospace; font-size: 12px;">
                      <strong>{day.date}</strong>
                    </td>
                    <td>
                      <span style="font-weight: 500;">{day.formattedTime}</span>
                    </td>
                    <td>
                      {#if day.aiSessions > 0}
                        <span style="display: inline-flex; align-items: center; gap: 4px; font-size: 12px;">
                          <Bot size={13} style="color: var(--personal);" />
                          {day.aiSessions}
                        </span>
                      {:else}
                        <span style="color: var(--faint); font-size: 11px;">—</span>
                      {/if}
                    </td>
                    <td style="font-size: 12px;">
                      {#if day.humanAdditions > 0 || day.aiAdditions > 0 || day.humanDeletions > 0 || day.aiDeletions > 0}
                        <span style="color: var(--work);">+{day.humanAdditions + day.aiAdditions}</span>
                        <span style="color: var(--faint);">/</span>
                        <span style="color: var(--personal);">&minus;{day.humanDeletions + day.aiDeletions}</span>
                      {:else}
                        <span style="color: var(--faint); font-size: 11px;">—</span>
                      {/if}
                    </td>
                    <td style="text-align: right;">
                      <a href="/admin/activity?date={day.date}" class="button ghost sm" aria-label="View activity on {day.date}">
                        <span>View Slices</span>
                        <ArrowUpRight size={13} />
                      </a>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </section>
      {/if}
    </div>

    <!-- Right Column: Classification Inbox, Editors, and Sync Health -->
    <div style="display: flex; flex-direction: column; gap: 18px;">
      <!-- Classification Inbox CTA -->
      <div class="panel" style="border-color: {overview.coverage.unclassifiedSlices > 0 ? 'rgb(217 134 74 / 0.4)' : 'var(--border)'}; background: #131210;">
        <div class="panel-heading" style="border-bottom-color: {overview.coverage.unclassifiedSlices > 0 ? 'rgb(217 134 74 / 0.2)' : 'var(--border)'};">
          <div>
            <p class="eyebrow">Classification Overlay</p>
            <h2>Classification Inbox</h2>
          </div>
          <span class="badge {overview.coverage.unclassifiedSlices > 0 ? 'accent' : 'safe'}">
            {overview.coverage.unclassifiedSlices > 0 ? `${overview.coverage.unclassifiedSlices} Pending` : 'All Classified'}
          </span>
        </div>
        <div style="padding: 18px 22px;">
          <p style="margin: 0 0 16px; font-size: 13px; line-height: 1.6; color: var(--muted);">
            {overview.coverage.unclassifiedSlices > 0
              ? 'Unclassified activity slices were observed in the archive. Establish rules or whole-slice overrides to assign work or personal classification.'
              : 'All observed slices across the archive have been classified deterministically by your rule hierarchy and immutable overrides.'}
          </p>

          <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 18px;">
            <div style="display: flex; justify-content: space-between; font-size: 12px; padding: 8px 12px; background: #0c0c0b; border-radius: 7px; border: 1px solid var(--border);">
              <span>Unclassified Duration</span>
              <strong style="color: {overview.coverage.unclassifiedSeconds > 0 ? 'var(--accent)' : 'var(--text)'};">
                {overview.coverage.unclassifiedSeconds >= 3600
                  ? `${Math.round(overview.coverage.unclassifiedSeconds / 3600)}h`
                  : `${Math.round(overview.coverage.unclassifiedSeconds / 60)}m`}
              </strong>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 12px; padding: 8px 12px; background: #0c0c0b; border-radius: 7px; border: 1px solid var(--border);">
              <span>Coverage Ratio</span>
              <strong style="color: var(--work);">{overview.coverage.coveragePercentage}%</strong>
            </div>
          </div>

          <a href="/admin/classify" class="button primary" style="width: 100%;">
            <SlidersHorizontal size={15} />
            <span>Open Classification Inbox</span>
          </a>
        </div>
      </div>

      <!-- Active Editors with real scope='account' queries -->
      <div class="panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Environment</p>
            <h2>Active Editors</h2>
          </div>
          <span class="badge neutral">{overview.topEditors.length} Observed</span>
        </div>
        <div style="padding: 18px 22px; display: flex; flex-direction: column; gap: 12px;">
          {#if overview.topEditors.length === 0}
            <p style="margin: 0; font-size: 12px; color: var(--faint);">
              No editor telemetry recorded in the database.
            </p>
          {:else}
            {#each overview.topEditors as ed}
              <div>
                <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 5px;">
                  <span style="font-weight: 500; color: var(--text);">{ed.name}</span>
                  <span style="color: var(--muted);">{ed.formattedTime} ({ed.sharePercent}%)</span>
                </div>
                <div style="height: 6px; background: #1b1b18; border-radius: 999px; overflow: hidden;">
                  <div style="height: 100%; width: {ed.sharePercent}%; background: var(--accent); border-radius: 999px;"></div>
                </div>
              </div>
            {/each}
          {/if}
        </div>
      </div>

      <!-- Sync engine status from real source_imports and sync_runs -->
      <div class="panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Archive Health</p>
            <h2>Sync & Ingestion</h2>
          </div>
          <span class="badge {overview.sourceImportState.latestImport?.status === 'completed' ? 'safe' : 'neutral'}">
            {overview.sourceImportState.latestImport ? overview.sourceImportState.latestImport.status.toUpperCase() : 'Idle'}
          </span>
        </div>
        <div style="padding: 18px 22px; font-size: 12px; color: var(--muted); line-height: 1.6;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span>Total Imports</span>
            <strong style="color: var(--text);">{overview.sourceImportState.totalImports}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span>Latest Source</span>
            <strong style="color: var(--text);">
              {overview.sourceImportState.latestImport?.sourceType ?? 'None'}
            </strong>
          </div>
          <div style="display: flex; justify-content: space-between; margin-bottom: 16px;">
            <span>Import Status</span>
            <strong style="color: {overview.sourceImportState.latestImport?.status === 'completed' ? 'var(--work)' : 'var(--text)'};">
              {overview.sourceImportState.latestImport ? `${overview.sourceImportState.latestImport.status} (${overview.sourceImportState.latestImport.dayCount} days)` : 'No imports recorded'}
            </strong>
          </div>
          <div style="display: flex; gap: 8px;">
            <a href="/admin/sync" class="button secondary sm" style="flex: 1;">
              <Database size={14} />
              <span>Sync Page</span>
            </a>
            <a href="/admin/imports" class="button secondary sm" style="flex: 1;">
              <HardDrive size={14} />
              <span>Imports</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</AppShell>

<style>
  :global(.badge.mixed) {
    color: var(--accent);
    border-color: rgb(217 134 74 / 0.35);
    background: var(--accent-soft);
  }
  :global(.badge.unclassified) {
    color: var(--muted);
    border-color: var(--border-strong);
    background: var(--panel-raised);
  }
</style>
