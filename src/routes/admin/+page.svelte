<script lang="ts">
  import AppShell from '$lib/components/AppShell.svelte';
  import MetricCard from '$lib/components/MetricCard.svelte';
  import TimelineBar from '$lib/components/TimelineBar.svelte';
  import {
    Activity,
    ArrowUpRight,
    Bot,
    Clock,
    Database,
    FolderKanban,
    Laptop,
    Play,
    SlidersHorizontal,
    Sparkles
  } from '@lucide/svelte';

  // Synthetic sanitized overview data suitable for server props replacement
  const weeklyActivity = [
    { hour: 9, minutes: 45, label: 'Mon' },
    { hour: 10, minutes: 52, label: 'Tue' },
    { hour: 11, minutes: 60, label: 'Wed' },
    { hour: 14, minutes: 48, label: 'Thu' },
    { hour: 15, minutes: 55, label: 'Fri' },
    { hour: 16, minutes: 20, label: 'Sat' },
    { hour: 17, minutes: 12, label: 'Sun' }
  ];

  const topProjects = [
    { name: 'work-times', time: '142h 20m', events: '18,420', classification: 'work', aiSessions: 42 },
    { name: 'client-portal', time: '98h 45m', events: '12,980', classification: 'work', aiSessions: 28 },
    { name: 'core-infra', time: '76h 10m', events: '9,110', classification: 'work', aiSessions: 14 },
    { name: 'homelab-cluster', time: '34h 50m', events: '4,620', classification: 'personal', aiSessions: 6 },
    { name: 'experimental-ai-tool', time: '22h 15m', events: '2,940', classification: 'unclassified', aiSessions: 18 }
  ];

  const topEditors = [
    { name: 'VS Code', share: '68%', time: '848h' },
    { name: 'Neovim', share: '24%', time: '299h' },
    { name: 'Xcode', share: '8%', time: '101h' }
  ];
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

  <!-- High-level KPI metrics -->
  <section class="metrics" aria-label="Archive summary statistics">
    <MetricCard
      label="Total Recorded Time"
      value="1,248h"
      subtext="Across 182 calendar days · 142,890 events"
      badge="Active Archive"
      badgeVariant="neutral"
    />
    <MetricCard
      label="Classified Coverage"
      value="74.2%"
      subtext="926h Work · 184h Personal"
      badge="Deterministic"
      badgeVariant="work"
    />
    <MetricCard
      label="Unclassified Backlog"
      value="138h 15m"
      subtext="5 identities awaiting initial decision"
      badge="Action needed"
      badgeVariant="accent"
    />
    <MetricCard
      label="AI Sessions Tracked"
      value="842"
      subtext="4.2M tokens · +38.4k code lines generated"
      badge="AI Telemetry"
      badgeVariant="personal"
    />
  </section>

  <!-- Ratio strip -->
  <div style="max-width: 1180px; margin: 0 auto 28px;">
    <div class="panel" style="padding: 18px 22px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <span style="font-size: 12px; font-weight: 600; color: var(--text);">Overall Classification Ratio</span>
        <span class="badge neutral">Source of truth: local rules</span>
      </div>
      <TimelineBar
        workPercent={74}
        personalPercent={15}
        unclassifiedPercent={11}
        height="12px"
      />
    </div>
  </div>

  <!-- Content Grid -->
  <div class="content-grid">
    <!-- Left Column: Activity trend and Top Projects -->
    <div style="display: flex; flex-direction: column; gap: 18px;">
      <!-- Weekly distribution -->
      <section class="panel" aria-labelledby="heading-trend">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Hourly Intensity</p>
            <h2 id="heading-trend">Recent Activity Distribution</h2>
          </div>
          <span class="badge safe">Peak: 14:00 - 17:00</span>
        </div>
        <div style="padding: 20px 22px;">
          <p style="margin: 0 0 14px; font-size: 12px; color: var(--muted);">
            Active coding volume across working hours. Green indicates classified work; purple represents personal projects.
          </p>
          <TimelineBar
            hourlyData={[
              { hour: 0, minutes: 0 },
              { hour: 1, minutes: 0 },
              { hour: 2, minutes: 0 },
              { hour: 3, minutes: 0 },
              { hour: 4, minutes: 0 },
              { hour: 5, minutes: 0 },
              { hour: 6, minutes: 5 },
              { hour: 7, minutes: 12 },
              { hour: 8, minutes: 35 },
              { hour: 9, minutes: 54 },
              { hour: 10, minutes: 58 },
              { hour: 11, minutes: 55 },
              { hour: 12, minutes: 40 },
              { hour: 13, minutes: 45 },
              { hour: 14, minutes: 60 },
              { hour: 15, minutes: 58 },
              { hour: 16, minutes: 52 },
              { hour: 17, minutes: 44 },
              { hour: 18, minutes: 30 },
              { hour: 19, minutes: 18 },
              { hour: 20, minutes: 22 },
              { hour: 21, minutes: 15 },
              { hour: 22, minutes: 8 },
              { hour: 23, minutes: 2 }
            ]}
          />
        </div>
      </section>

      <!-- Projects breakdown -->
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
              {#each topProjects as proj}
                <tr>
                  <td>
                    <div style="display: flex; align-items: center; gap: 8px;">
                      <FolderKanban size={15} style="color: var(--accent); flex-shrink: 0;" />
                      <strong>{proj.name}</strong>
                    </div>
                  </td>
                  <td>
                    <span>{proj.time}</span>
                    <small style="display: block; color: var(--faint); font-size: 11px;">{proj.events} events</small>
                  </td>
                  <td>
                    <span class="badge {proj.classification}">
                      {proj.classification.charAt(0).toUpperCase() + proj.classification.slice(1)}
                    </span>
                  </td>
                  <td>
                    <span style="display: inline-flex; align-items: center; gap: 4px; font-size: 12px;">
                      <Bot size={13} style="color: var(--personal);" />
                      {proj.aiSessions}
                    </span>
                  </td>
                  <td style="text-align: right;">
                    <a href="/admin/classify" class="button ghost sm" aria-label="Classify {proj.name}">
                      <span>Rules</span>
                    </a>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <!-- Right Column: Quick Inbox, Editors, and Sync Health -->
    <div style="display: flex; flex-direction: column; gap: 18px;">
      <!-- Classification CTA -->
      <div class="panel" style="border-color: rgb(217 134 74 / 0.4); background: #131210;">
        <div class="panel-heading" style="border-bottom-color: rgb(217 134 74 / 0.2);">
          <div>
            <p class="eyebrow">Action Required</p>
            <h2>Classification Inbox</h2>
          </div>
          <span class="badge accent">5 Pending</span>
        </div>
        <div style="padding: 18px 22px;">
          <p style="margin: 0 0 16px; font-size: 13px; line-height: 1.6; color: var(--muted);">
            Unclassified identities were observed across recent sync runs. Confirming decisions will
            preview historical impact and establish rules for future telemetry.
          </p>
          <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 18px;">
            <div style="display: flex; justify-content: space-between; font-size: 12px; padding: 6px 10px; background: #0c0c0b; border-radius: 7px; border: 1px solid var(--border);">
              <span>experimental-ai-tool</span>
              <strong style="color: var(--accent);">22h 15m</strong>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 12px; padding: 6px 10px; background: #0c0c0b; border-radius: 7px; border: 1px solid var(--border);">
              <span>docker-compose.yml</span>
              <strong style="color: var(--accent);">11h 30m</strong>
            </div>
          </div>
          <a href="/admin/classify" class="button primary" style="width: 100%;">
            <SlidersHorizontal size={15} />
            <span>Open Classification Inbox</span>
          </a>
        </div>
      </div>

      <!-- Editors share -->
      <div class="panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Environment</p>
            <h2>Active Editors</h2>
          </div>
          <span class="badge neutral">3 Observed</span>
        </div>
        <div style="padding: 18px 22px; display: flex; flex-direction: column; gap: 12px;">
          {#each topEditors as ed}
            <div>
              <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 5px;">
                <span style="font-weight: 500; color: var(--text);">{ed.name}</span>
                <span style="color: var(--muted);">{ed.time} ({ed.share})</span>
              </div>
              <div style="height: 6px; background: #1b1b18; border-radius: 999px; overflow: hidden;">
                <div style="height: 100%; width: {ed.share}; background: var(--accent); border-radius: 999px;"></div>
              </div>
            </div>
          {/each}
        </div>
      </div>

      <!-- Sync engine status -->
      <div class="panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Engine Status</p>
            <h2>Sync & Ingestion</h2>
          </div>
          <span class="badge safe">Operational</span>
        </div>
        <div style="padding: 18px 22px; font-size: 12px; color: var(--muted); line-height: 1.6;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span>Engine mode</span>
            <strong style="color: var(--text);">WakaTime API + Dump</strong>
          </div>
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span>Free Tier window</span>
            <strong style="color: var(--text);">7-day rolling window</strong>
          </div>
          <div style="display: flex; justify-content: space-between; margin-bottom: 16px;">
            <span>Last sync run</span>
            <strong style="color: var(--work);">18m ago (Completed)</strong>
          </div>
          <a href="/admin/sync" class="button secondary" style="width: 100%;">
            <Database size={14} />
            <span>Manage Sync & Imports</span>
          </a>
        </div>
      </div>
    </div>
  </div>
</AppShell>
