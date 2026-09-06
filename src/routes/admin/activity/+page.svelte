<script lang="ts">
  import AppShell from '$lib/components/AppShell.svelte';
  import MetricCard from '$lib/components/MetricCard.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import TimelineBar from '$lib/components/TimelineBar.svelte';
  import {
    Activity,
    Bot,
    Calendar,
    Check,
    Clock,
    Code,
    FileCode,
    Filter,
    FolderKanban,
    Globe,
    HardDrive,
    Info,
    Laptop,
    Layers,
    Search,
    SlidersHorizontal,
    Terminal
  } from '@lucide/svelte';

  // Sanitized synthetic telemetry activity events
  interface ActivityRecord {
    id: string;
    timestamp: string;
    duration: string;
    durationSec: number;
    entity: string;
    entityType: 'file' | 'app' | 'domain';
    project: string;
    language: string;
    machine: string;
    classification: 'work' | 'personal' | 'unclassified';
    aiSession?: {
      plan: string;
      tokens: number;
      aiLines: number;
    };
  }

  const activityEvents: ActivityRecord[] = [
    {
      id: 'hb_901a_4410',
      timestamp: '2026-09-05 16:42:10',
      duration: '18m 30s',
      durationSec: 1110,
      entity: 'src/lib/components/AppShell.svelte',
      entityType: 'file',
      project: 'work-times',
      language: 'Svelte',
      machine: 'workstation-mbp',
      classification: 'work',
      aiSession: { plan: 'pro', tokens: 1840, aiLines: 42 }
    },
    {
      id: 'hb_901a_4409',
      timestamp: '2026-09-05 16:15:00',
      duration: '27m 15s',
      durationSec: 1635,
      entity: 'src/styles/app.css',
      entityType: 'file',
      project: 'work-times',
      language: 'CSS',
      machine: 'workstation-mbp',
      classification: 'work'
    },
    {
      id: 'hb_890b_2104',
      timestamp: '2026-09-05 15:30:20',
      duration: '42m 00s',
      durationSec: 2520,
      entity: 'github.com/leomleao/work-times/pull/12',
      entityType: 'domain',
      project: 'work-times',
      language: 'Markdown',
      machine: 'workstation-mbp',
      classification: 'work'
    },
    {
      id: 'hb_765c_1190',
      timestamp: '2026-09-05 14:10:00',
      duration: '1h 05m',
      durationSec: 3900,
      entity: 'com.apple.dt.Xcode',
      entityType: 'app',
      project: 'client-portal',
      language: 'Swift',
      machine: 'workstation-mbp',
      classification: 'work',
      aiSession: { plan: 'standard', tokens: 3200, aiLines: 95 }
    },
    {
      id: 'hb_654d_0982',
      timestamp: '2026-09-05 12:45:10',
      duration: '35m 12s',
      durationSec: 2112,
      entity: '~/homelab/k8s/argocd/values.yaml',
      entityType: 'file',
      project: 'homelab-cluster',
      language: 'YAML',
      machine: 'linux-devbox',
      classification: 'personal'
    },
    {
      id: 'hb_543e_0811',
      timestamp: '2026-09-05 11:18:40',
      duration: '22m 45s',
      durationSec: 1365,
      entity: 'docker-compose.yml',
      entityType: 'file',
      project: 'experimental-ai-tool',
      language: 'YAML',
      machine: 'workstation-mbp',
      classification: 'unclassified'
    },
    {
      id: 'hb_432f_0720',
      timestamp: '2026-09-05 09:40:00',
      duration: '48m 10s',
      durationSec: 2890,
      entity: 'src/lib/server/db/schema.ts',
      entityType: 'file',
      project: 'work-times',
      language: 'TypeScript',
      machine: 'workstation-mbp',
      classification: 'work',
      aiSession: { plan: 'pro', tokens: 2100, aiLines: 64 }
    }
  ];

  // Filters state
  let timeRange = $state<'today' | '7d' | '30d' | 'all'>('7d');
  let typeFilter = $state<'all' | 'file' | 'app' | 'domain'>('all');
  let classificationFilter = $state<'all' | 'work' | 'personal' | 'unclassified'>('all');
  let filterText = $state('');

  // Row slice override modal state
  let overrideModalOpen = $state(false);
  let targetRow = $state<ActivityRecord | null>(null);
  let targetClassification = $state<'work' | 'personal'>('work');
  let toastMessage = $state('');

  let filteredActivity = $derived(
    activityEvents.filter((item) => {
      if (typeFilter !== 'all' && item.entityType !== typeFilter) return false;
      if (classificationFilter !== 'all' && item.classification !== classificationFilter) return false;
      if (filterText.trim()) {
        const query = filterText.toLowerCase();
        return (
          item.entity.toLowerCase().includes(query) ||
          item.project.toLowerCase().includes(query) ||
          item.language.toLowerCase().includes(query) ||
          item.machine.toLowerCase().includes(query)
        );
      }
      return true;
    })
  );

  function getEntityIcon(type: 'file' | 'app' | 'domain') {
    switch (type) {
      case 'file':
        return FileCode;
      case 'app':
        return Laptop;
      case 'domain':
        return Globe;
    }
  }

  function openSliceOverride(record: ActivityRecord) {
    targetRow = record;
    targetClassification = record.classification === 'personal' ? 'personal' : 'work';
    overrideModalOpen = true;
  }

  function saveRowOverride() {
    if (!targetRow) return;
    targetRow.classification = targetClassification;
    overrideModalOpen = false;
    toastMessage = `Whole-slice override saved for ${targetRow.id} (${targetClassification.toUpperCase()}).`;
    setTimeout(() => {
      toastMessage = '';
    }, 5000);
  }
</script>

<svelte:head>
  <title>Activity Explorer — Work Times</title>
</svelte:head>

<AppShell>
  <header class="page-header">
    <div>
      <p class="eyebrow">Telemetry Explorer</p>
      <h1>Recorded Activity & Timeline.</h1>
      <p class="lede">
        Inspect normalized heartbeat intervals, source dimensions, and AI session metadata.
        Attach one-off whole-slice overrides directly to specific intervals.
      </p>
    </div>
    <div class="header-actions">
      <a href="/admin/classify" class="button secondary">
        <SlidersHorizontal size={15} />
        <span>Manage Rules</span>
      </a>
    </div>
  </header>

  <!-- Summary Metrics -->
  <section class="metrics" aria-label="Activity volume metrics">
    <MetricCard
      label="Total Active Interval"
      value="4h 28m"
      subtext="7 heartbeats recorded today"
      badge="Today"
      badgeVariant="neutral"
    />
    <MetricCard
      label="Work Classified"
      value="3h 30m"
      subtext="78.3% of observed duration"
      badge="Work"
      badgeVariant="work"
    />
    <MetricCard
      label="Personal Classified"
      value="35m"
      subtext="13.1% (homelab-cluster)"
      badge="Personal"
      badgeVariant="personal"
    />
    <MetricCard
      label="AI Code Generation"
      value="7,140"
      subtext="Tokens consumed · 201 lines generated"
      badge="3 AI Sessions"
      badgeVariant="accent"
    />
  </section>

  {#if toastMessage}
    <div class="notice safe" role="status" style="max-width: 1180px; margin: 0 auto 20px;">
      <Check size={16} />
      <span>{toastMessage}</span>
    </div>
  {/if}

  <!-- Hourly activity distribution -->
  <div style="max-width: 1180px; margin: 0 auto 20px;">
    <div class="panel" style="padding: 18px 22px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <span style="font-size: 12px; font-weight: 600; color: var(--text);">Hourly Activity Intensity (00:00 - 23:00)</span>
        <div style="display: flex; gap: 4px;">
          <button
            type="button"
            class="button sm {timeRange === 'today' ? 'primary' : 'ghost'}"
            onclick={() => (timeRange = 'today')}
          >
            Today
          </button>
          <button
            type="button"
            class="button sm {timeRange === '7d' ? 'primary' : 'ghost'}"
            onclick={() => (timeRange = '7d')}
          >
            Last 7d
          </button>
          <button
            type="button"
            class="button sm {timeRange === '30d' ? 'primary' : 'ghost'}"
            onclick={() => (timeRange = '30d')}
          >
            Last 30d
          </button>
        </div>
      </div>
      <TimelineBar
        hourlyData={[
          { hour: 0, minutes: 0 },
          { hour: 1, minutes: 0 },
          { hour: 2, minutes: 0 },
          { hour: 3, minutes: 0 },
          { hour: 4, minutes: 0 },
          { hour: 5, minutes: 0 },
          { hour: 6, minutes: 0 },
          { hour: 7, minutes: 0 },
          { hour: 8, minutes: 10 },
          { hour: 9, minutes: 48 },
          { hour: 10, minutes: 0 },
          { hour: 11, minutes: 22 },
          { hour: 12, minutes: 35 },
          { hour: 13, minutes: 0 },
          { hour: 14, minutes: 60 },
          { hour: 15, minutes: 42 },
          { hour: 16, minutes: 45 },
          { hour: 17, minutes: 0 },
          { hour: 18, minutes: 0 },
          { hour: 19, minutes: 0 },
          { hour: 20, minutes: 0 },
          { hour: 21, minutes: 0 },
          { hour: 22, minutes: 0 },
          { hour: 23, minutes: 0 }
        ]}
      />
    </div>
  </div>

  <!-- Filter Controls -->
  <div style="max-width: 1180px; margin: 0 auto 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
    <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
      <div style="position: relative;">
        <input
          type="text"
          placeholder="Filter by entity, project, language…"
          bind:value={filterText}
          class="form-input"
          style="width: 260px; font-size: 12px; padding: 7px 10px;"
          aria-label="Filter activity records"
        />
      </div>

      <div style="display: flex; gap: 4px;">
        <button
          type="button"
          class="button sm {typeFilter === 'all' ? 'primary' : 'ghost'}"
          onclick={() => (typeFilter = 'all')}
        >
          All Entities
        </button>
        <button
          type="button"
          class="button sm {typeFilter === 'file' ? 'primary' : 'ghost'}"
          onclick={() => (typeFilter = 'file')}
        >
          Files
        </button>
        <button
          type="button"
          class="button sm {typeFilter === 'app' ? 'primary' : 'ghost'}"
          onclick={() => (typeFilter = 'app')}
        >
          Apps
        </button>
        <button
          type="button"
          class="button sm {typeFilter === 'domain' ? 'primary' : 'ghost'}"
          onclick={() => (typeFilter = 'domain')}
        >
          Web
        </button>
      </div>
    </div>

    <div style="display: flex; gap: 6px; align-items: center;">
      <span style="font-size: 11px; color: var(--faint);">Status:</span>
      <button
        type="button"
        class="button sm {classificationFilter === 'all' ? 'primary' : 'ghost'}"
        onclick={() => (classificationFilter = 'all')}
      >
        All
      </button>
      <button
        type="button"
        class="button sm {classificationFilter === 'work' ? 'primary' : 'ghost'}"
        onclick={() => (classificationFilter = 'work')}
      >
        Work
      </button>
      <button
        type="button"
        class="button sm {classificationFilter === 'personal' ? 'primary' : 'ghost'}"
        onclick={() => (classificationFilter = 'personal')}
      >
        Personal
      </button>
      <button
        type="button"
        class="button sm {classificationFilter === 'unclassified' ? 'primary' : 'ghost'}"
        onclick={() => (classificationFilter = 'unclassified')}
      >
        Unclassified
      </button>
    </div>
  </div>

  <!-- Activity Explorer Table -->
  <div style="max-width: 1180px; margin: 0 auto;">
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Telemetry Records</p>
          <h2>Activity Heartbeat Slices</h2>
        </div>
        <span class="badge neutral">{filteredActivity.length} intervals</span>
      </div>

      <div class="table-wrap">
        <table class="data-table" aria-label="Activity records table">
          <thead>
            <tr>
              <th scope="col">Timestamp</th>
              <th scope="col">Duration</th>
              <th scope="col">Entity</th>
              <th scope="col">Project</th>
              <th scope="col">Language / Machine</th>
              <th scope="col">AI Telemetry</th>
              <th scope="col">Classification</th>
              <th scope="col" style="text-align: right;">Action</th>
            </tr>
          </thead>
          <tbody>
            {#if filteredActivity.length === 0}
              <tr>
                <td colspan="8" style="text-align: center; padding: 36px 20px;">
                  <span style="color: var(--faint);">No activity matches the selected filter criteria.</span>
                </td>
              </tr>
            {/if}
            {#each filteredActivity as row}
              {@const Icon = getEntityIcon(row.entityType)}
              <tr>
                <td style="white-space: nowrap; font-size: 12px;">
                  <span>{row.timestamp}</span>
                </td>
                <td style="white-space: nowrap;">
                  <strong style="color: var(--text);">{row.duration}</strong>
                </td>
                <td>
                  <div style="display: flex; align-items: center; gap: 8px; max-width: 320px;">
                    <Icon size={16} style="color: var(--accent); flex-shrink: 0;" />
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, monospace; font-size: 12px;">
                      {row.entity}
                    </span>
                  </div>
                </td>
                <td>
                  <span style="font-weight: 500;">{row.project}</span>
                </td>
                <td>
                  <div style="display: flex; flex-direction: column; gap: 2px;">
                    <span style="font-size: 12px; color: var(--text);">{row.language}</span>
                    <small style="color: var(--faint); font-size: 10px;">{row.machine}</small>
                  </div>
                </td>
                <td>
                  {#if row.aiSession}
                    <div style="display: inline-flex; align-items: center; gap: 5px; font-size: 11px; background: var(--personal-soft); color: var(--personal); padding: 2px 7px; border-radius: 6px; border: 1px solid rgb(215 169 255 / 0.3);">
                      <Bot size={13} />
                      <span>{row.aiSession.tokens} tokens (+{row.aiSession.aiLines}L)</span>
                    </div>
                  {:else}
                    <span style="color: var(--faint); font-size: 11px;">—</span>
                  {/if}
                </td>
                <td>
                  <span class="badge {row.classification}">
                    {row.classification.toUpperCase()}
                  </span>
                </td>
                <td style="text-align: right;">
                  <button
                    type="button"
                    class="button ghost sm"
                    onclick={() => openSliceOverride(row)}
                    aria-label="Override classification for {row.entity}"
                  >
                    <Layers size={13} />
                    <span>Override</span>
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  </div>
</AppShell>

<!-- Slice Override Modal for Individual Row -->
<Modal
  open={overrideModalOpen}
  title="Apply Whole-Slice Override"
  description="Pin this single interval without altering the project's reusable rule."
  onclose={() => (overrideModalOpen = false)}
>
  {#if targetRow}
    <div style="display: flex; flex-direction: column; gap: 14px;">
      <div style="padding: 12px 14px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; line-height: 1.6;">
        <div style="display: flex; justify-content: space-between;">
          <span style="color: var(--faint);">Interval ID</span>
          <code>{targetRow.id}</code>
        </div>
        <div style="display: flex; justify-content: space-between; margin-top: 4px;">
          <span style="color: var(--faint);">Entity</span>
          <strong style="color: var(--text);">{targetRow.entity}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; margin-top: 4px;">
          <span style="color: var(--faint);">Duration</span>
          <span>{targetRow.duration}</span>
        </div>
      </div>

      <div class="form-group">
        <span class="form-label">Classification Assignment</span>
        <div style="display: flex; gap: 10px; margin-top: 6px;">
          <button
            type="button"
            class="button {targetClassification === 'work' ? 'primary' : 'secondary'}"
            style="flex: 1;"
            onclick={() => (targetClassification = 'work')}
          >
            Work
          </button>
          <button
            type="button"
            class="button {targetClassification === 'personal' ? 'primary' : 'secondary'}"
            style="flex: 1;"
            onclick={() => (targetClassification = 'personal')}
          >
            Personal
          </button>
        </div>
      </div>

      <div class="notice info" style="margin: 0;">
        <Info size={16} />
        <span>Whole-slice overrides take absolute precedence over all existing and future rules for this slice.</span>
      </div>
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="button ghost"
      onclick={() => (overrideModalOpen = false)}
    >
      Cancel
    </button>
    <button
      type="button"
      class="button primary"
      onclick={saveRowOverride}
    >
      Save Override
    </button>
  {/snippet}
</Modal>
