<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import AppShell from '$lib/components/AppShell.svelte';
  import MetricCard from '$lib/components/MetricCard.svelte';
  import QualityBadge from '$lib/components/sync/QualityBadge.svelte';
  import SyncReadinessBanner from '$lib/components/sync/SyncReadinessBanner.svelte';
  import SyncControls from '$lib/components/sync/SyncControls.svelte';
  import SyncActiveProgress from '$lib/components/sync/SyncActiveProgress.svelte';
  import SyncRunsTable from '$lib/components/sync/SyncRunsTable.svelte';
  import SyncRunDetailModal from '$lib/components/sync/SyncRunDetailModal.svelte';
  import SyncRegistryCard from '$lib/components/sync/SyncRegistryCard.svelte';
  import type { PageData } from './$types';
  import type {
    SyncAdminData,
    AdminSyncRunSummaryDto,
    AdminSyncRunDetailDto
  } from '$lib/server/admin/sync';
  import {
    Activity,
    AlertCircle,
    CheckCircle2,
    Clock,
    Database,
    HardDrive,
    Key,
    Shield,
    XCircle
  } from '@lucide/svelte';

  let { data } = $props<{ data: PageData }>();

  // State initialized from SSR data
  let sync = $state<SyncAdminData | null>(null);
  $effect.pre(() => {
    if (!sync && data.sync) {
      sync = data.sync;
    }
  });
  let csrfToken = $derived(data.csrfToken);
  let isUnavailable = $derived(data.unavailable || !sync);

  // Accessible live announcement
  let announcement = $state('');
  function announce(message: string) {
    announcement = message;
  }

  // Mutation and polling state
  let busy = $state(false);
  let pageError = $state<string | null>(null);

  // Selected run details modal state
  let selectedRunId = $state<number | null>(null);
  let selectedRunDetail = $state<AdminSyncRunDetailDto | null>(null);
  let runDetailLoading = $state(false);
  let runDetailError = $state<string | null>(null);
  let runDetailPage = $state(1);

  // Derived state
  let readiness = $derived(sync?.readiness ?? null);
  let schedule = $derived(sync?.schedule ?? null);
  let degradation = $derived(sync?.degradation ?? null);
  let activeProgress = $derived(sync?.activeProgress ?? null);
  let registry = $derived(sync?.registry ?? null);
  let runs = $derived(sync?.runs ?? []);
  let sourceTimezone = $derived(sync?.sourceTimezone ?? 'UTC');
  let lastAcceptedSuccessAt = $derived(sync?.lastAcceptedSuccessAt ?? null);

  let nextDueTime = $derived.by(() => {
    if (!schedule?.nextDue) return null;
    const dues = [schedule.nextDue.recent, schedule.nextDue.reconcile, schedule.nextDue.compare]
      .filter((d): d is string => Boolean(d))
      .sort();
    return dues[0] ?? null;
  });

  // Polling logic: poll every 2000ms ONLY while active, slower bounded backoff while idle/hidden
  let isPolling = false;
  let pollTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let isUnmounted = false;

  let isWorkActive = $derived(
    Boolean(
      activeProgress?.activeRun ||
      (activeProgress && activeProgress.queueDepth > 0) ||
      registry?.isRefreshing ||
      runs.some((r) => r.status === 'running' || r.status === 'queued') ||
      busy
    )
  );

  function getPollInterval(): number {
    if (typeof document !== 'undefined' && document.hidden) {
      return 10000;
    }
    return isWorkActive ? 2000 : 10000;
  }

  async function pollSyncState() {
    if (isUnmounted || isPolling) return;
    if (pollTimeoutId) {
      clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    }

    isPolling = true;
    try {
      const res = await fetch('/api/admin/sync-runs?limit=50', {
        headers: { Accept: 'application/json' }
      });

      if (res.ok) {
        const collection = await res.json();
        if (sync) {
          sync = {
            ...sync,
            runs: collection.runs,
            schedule: collection.schedule,
            readiness: collection.readiness,
            activeProgress: {
              ...sync.activeProgress,
              activeRun: collection.activeRun,
              queueDepth: collection.runs.filter((r: AdminSyncRunSummaryDto) => r.status === 'queued').length
            }
          };
        }

        // If a run modal is currently open, refresh its date details too
        if (selectedRunId !== null && !runDetailLoading) {
          await loadRunDetail(selectedRunId, runDetailPage, false);
        }
      }
    } catch {
      // Ignore transient network errors during background polling
    } finally {
      isPolling = false;
      if (!isUnmounted) {
        scheduleNextPoll(getPollInterval());
      }
    }
  }

  function scheduleNextPoll(delayMs?: number) {
    if (pollTimeoutId) {
      clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    }
    if (isUnmounted) return;
    const delay = delayMs ?? getPollInterval();
    pollTimeoutId = setTimeout(() => {
      pollTimeoutId = null;
      void pollSyncState();
    }, delay);
  }

  // Speed up polling to 2s when work transitions from idle to active
  let prevWorkActive = false;
  $effect(() => {
    const active = isWorkActive;
    if (active && !prevWorkActive) {
      prevWorkActive = true;
      if (!isPolling) {
        scheduleNextPoll(document.hidden ? 10000 : 2000);
      }
    } else if (!active && prevWorkActive) {
      prevWorkActive = false;
    }
  });

  function handleVisibilityChange() {
    if (!document.hidden) {
      // Visibility resume should not create duplicate polls
      if (pollTimeoutId) {
        clearTimeout(pollTimeoutId);
        pollTimeoutId = null;
      }
      if (!isPolling) {
        void pollSyncState();
      }
    }
  }

  onMount(() => {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    // Start initial background poll with appropriate interval
    scheduleNextPoll(getPollInterval());
  });

  onDestroy(() => {
    isUnmounted = true;
    if (pollTimeoutId) {
      clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  });

  // Map API errors to human-readable safe descriptions:
  // Must NEVER return arbitrary server/network error text for unknown codes!
  function mapSafeError(err: unknown, fallback: string): string {
    if (!err) return fallback;
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as any).code) : '';

    if (code === 'SYNC_QUEUE_FULL') {
      return 'The sync queue is currently full (maximum 10 queued runs). Please wait for active runs to complete.';
    }
    if (code === 'IDEMPOTENCY_CONFLICT') {
      return 'An identical mutation with a conflicting payload was previously submitted.';
    }
    if (code === 'UNAUTHORIZED') {
      return 'Session expired. Please log in again.';
    }
    if (code === 'FORBIDDEN') {
      return 'Request rejected: missing or invalid CSRF token or origin.';
    }
    if (code === 'TIMEZONE_MISMATCH') {
      return 'Upstream timezone conflicts with the pinned archive timezone.';
    }
    if (code === 'RECONNECT_REQUIRED') {
      return 'WakaTime re-authorization required before retrying restricted dates.';
    }
    if (code === 'RATE_LIMITED') {
      return 'Upstream rate limit in effect. Requests are backed off.';
    }
    if (code === 'SYNC_STATE_UNAVAILABLE') {
      return 'Sync engine state is currently unavailable.';
    }

    // Return the operation-specific safe fallback for unknown or unallowlisted codes
    return fallback;
  }

  // Stable idempotency keys across ambiguous failed retries for the same payload
  let recentIdempotencyKey: string | null = null;
  let backfillIdempotency: { payloadKey: string; idempotencyKey: string } | null = null;
  let compareIdempotency: { payloadKey: string; idempotencyKey: string } | null = null;

  // Action: Sync Now
  async function handleSyncNow() {
    if (busy || !csrfToken) return;
    busy = true;
    pageError = null;

    if (!recentIdempotencyKey) {
      recentIdempotencyKey = `manual-recent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    const idempotencyKey = recentIdempotencyKey;

    try {
      const res = await fetch('/api/admin/sync-runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({
          mode: 'recent',
          idempotencyKey,
          csrfToken
        })
      });

      const body = await res.json();
      if (!res.ok) {
        throw body;
      }

      // Accepted success: clear the stable key
      recentIdempotencyKey = null;
      announce(`Sync run #${body.runId} successfully enqueued.`);
      await pollSyncState();
    } catch (err) {
      pageError = mapSafeError(err, 'Failed to enqueue recent sync');
      announce(`Error: ${pageError}`);
    } finally {
      busy = false;
    }
  }

  // Action: Bounded Backfill
  async function handleBackfill(startDate: string, endDate: string) {
    if (busy || !csrfToken) return;
    busy = true;
    pageError = null;

    const payloadKey = `${startDate}_${endDate}`;
    if (!backfillIdempotency || backfillIdempotency.payloadKey !== payloadKey) {
      backfillIdempotency = {
        payloadKey,
        idempotencyKey: `manual-backfill-${startDate}-${endDate}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      };
    }
    const idempotencyKey = backfillIdempotency.idempotencyKey;

    try {
      const res = await fetch('/api/admin/sync-runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({
          mode: 'backfill',
          rangeStartDate: startDate,
          rangeEndDate: endDate,
          idempotencyKey,
          csrfToken
        })
      });

      const body = await res.json();
      if (!res.ok) {
        throw body;
      }

      // Accepted success: clear the stable key
      backfillIdempotency = null;
      announce(`Backfill run #${body.runId} (${startDate} to ${endDate}) enqueued.`);
      await pollSyncState();
    } catch (err) {
      pageError = mapSafeError(err, 'Failed to enqueue backfill run');
      announce(`Error: ${pageError}`);
    } finally {
      busy = false;
    }
  }

  // Action: Compare
  async function handleCompare(startDate: string, endDate: string) {
    if (busy || !csrfToken) return;
    busy = true;
    pageError = null;

    const payloadKey = `${startDate}_${endDate}`;
    if (!compareIdempotency || compareIdempotency.payloadKey !== payloadKey) {
      compareIdempotency = {
        payloadKey,
        idempotencyKey: `manual-compare-${startDate}-${endDate}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      };
    }
    const idempotencyKey = compareIdempotency.idempotencyKey;

    try {
      const res = await fetch('/api/admin/sync-runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({
          mode: 'compare',
          rangeStartDate: startDate,
          rangeEndDate: endDate,
          idempotencyKey,
          csrfToken
        })
      });

      const body = await res.json();
      if (!res.ok) {
        throw body;
      }

      // Accepted success: clear the stable key
      compareIdempotency = null;
      announce(`Comparison run #${body.runId} (${startDate} to ${endDate}) enqueued.`);
      await pollSyncState();
    } catch (err) {
      pageError = mapSafeError(err, 'Failed to enqueue comparison run');
      announce(`Error: ${pageError}`);
    } finally {
      busy = false;
    }
  }

  // Action: Toggle Schedule
  async function handleToggleSchedule(enabled: boolean) {
    if (busy || !csrfToken) return;
    busy = true;
    pageError = null;

    try {
      const res = await fetch('/api/admin/sync-settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({
          schedulingEnabled: enabled,
          csrfToken
        })
      });

      const body = await res.json();
      if (!res.ok) throw body;

      if (sync && sync.schedule) {
        sync.schedule = {
          ...sync.schedule,
          schedulingEnabled: body.schedulingEnabled
        };
      }

      announce(`Automated scheduling ${body.schedulingEnabled ? 'enabled' : 'disabled'}.`);
    } catch (err) {
      pageError = mapSafeError(err, 'Failed to update schedule settings');
      announce(`Error: ${pageError}`);
    } finally {
      busy = false;
    }
  }

  // Action: Bind Connection
  async function handleBindConnection() {
    if (busy || !csrfToken) return;
    busy = true;
    pageError = null;

    try {
      const res = await fetch('/api/admin/sync-settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({
          bindCurrentConnection: true,
          csrfToken
        })
      });

      const body = await res.json();
      if (!res.ok) throw body;

      announce('WakaTime connection generation bound to archive identity.');
      await pollSyncState();
    } catch (err) {
      pageError = mapSafeError(err, 'Failed to bind connection');
      announce(`Error: ${pageError}`);
    } finally {
      busy = false;
    }
  }

  // Action: Cancel Run
  async function handleCancelRun(runId: number) {
    if (busy || !csrfToken) return;
    busy = true;
    pageError = null;

    try {
      const res = await fetch(`/api/admin/sync-runs/${runId}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({ csrfToken })
      });

      const body = await res.json();
      if (!res.ok) throw body;

      announce(`Run #${runId} cancelled successfully.`);
      await pollSyncState();
    } catch (err) {
      pageError = mapSafeError(err, `Failed to cancel run #${runId}`);
      announce(`Error: ${pageError}`);
    } finally {
      busy = false;
    }
  }

  // Action: Retry Run
  async function handleRetryRun(runId: number) {
    if (busy || !csrfToken) return;
    busy = true;
    pageError = null;

    try {
      const res = await fetch(`/api/admin/sync-runs/${runId}/retry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({ csrfToken })
      });

      const body = await res.json();
      if (!res.ok) throw body;

      announce(`Retry run #${body.runId} enqueued for parent run #${runId}.`);
      await pollSyncState();
    } catch (err) {
      pageError = mapSafeError(err, `Failed to retry run #${runId}`);
      announce(`Error: ${pageError}`);
    } finally {
      busy = false;
    }
  }

  // Action: Retry Single Date
  async function handleRetryDate(runId: number, date: string) {
    if (busy || !csrfToken) return;
    busy = true;
    pageError = null;

    try {
      const res = await fetch(`/api/admin/sync-runs/${runId}/retry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({
          targetDate: date,
          csrfToken
        })
      });

      const body = await res.json();
      if (!res.ok) throw body;

      announce(`Retry enqueued for date ${date} (Run #${body.runId}).`);
      await pollSyncState();
      await loadRunDetail(selectedRunId!, runDetailPage, false);
    } catch (err) {
      runDetailError = mapSafeError(err, `Failed to retry date ${date}`);
      announce(`Error: ${runDetailError}`);
    } finally {
      busy = false;
    }
  }

  // Action: Refresh Registry
  async function handleRefreshRegistry() {
    if (busy || !csrfToken) return;
    busy = true;
    pageError = null;

    try {
      const res = await fetch('/api/admin/sync-registry/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({ csrfToken })
      });

      const body = await res.json();
      if (!res.ok) throw body;

      if (sync && sync.registry) {
        sync.registry = {
          ...sync.registry,
          isRefreshing: true
        };
      }

      announce('User-agent registry refresh enqueued.');
      scheduleNextPoll(1000);
    } catch (err) {
      pageError = mapSafeError(err, 'Failed to initiate registry refresh');
      announce(`Error: ${pageError}`);
    } finally {
      busy = false;
    }
  }

  // Load Run Details
  async function loadRunDetail(runId: number, page = 1, showSpinner = true) {
    if (showSpinner) runDetailLoading = true;
    runDetailError = null;

    try {
      const res = await fetch(`/api/admin/sync-runs/${runId}?page=${page}&pageSize=50`, {
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) {
        const err = await res.json();
        throw err;
      }
      selectedRunDetail = await res.json();
      runDetailPage = page;
    } catch (err) {
      runDetailError = mapSafeError(err, `Failed to load details for run #${runId}`);
    } finally {
      if (showSpinner) runDetailLoading = false;
    }
  }

  function handleSelectRun(runId: number) {
    selectedRunId = runId;
    void loadRunDetail(runId, 1, true);
  }

  function handleCloseRunModal() {
    selectedRunId = null;
    selectedRunDetail = null;
    runDetailError = null;
  }
</script>

<svelte:head>
  <title>API Sync Engine & Operations — Work Times</title>
</svelte:head>

<!-- Live accessibility announcement region -->
<div class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="live-announcement">
  {announcement}
</div>

<AppShell>
  <header class="page-header">
    <div>
      <p class="eyebrow">Data Ingestion Engine</p>
      <h1>Operational Sync & Capabilities.</h1>
      <p class="lede">
        Execute verified WakaTime synchronizations, inspect execution progress and layer outcomes,
        and manage schedule and user-agent registry settings.
      </p>
    </div>
    <div class="header-actions">
      <a href="/admin/imports" class="button secondary">
        <HardDrive size={15} />
        <span>View Archive Imports</span>
      </a>
    </div>
  </header>

  {#if isUnavailable}
    <div class="notice danger" role="alert" style="max-width: 1180px; margin: 0 auto 24px;" data-testid="sync-unavailable-banner">
      <AlertCircle size={18} style="flex-shrink: 0;" />
      <div>
        <strong>Sync State Unavailable.</strong>
        <p style="margin: 4px 0 0; font-size: 13px;">
          The sync service could not be initialized or database tables are unavailable.
        </p>
      </div>
    </div>
  {:else}
    <!-- Top-level error notification banner if present -->
    {#if pageError}
      <div class="notice danger" role="alert" style="max-width: 1180px; margin: 0 auto 16px;" data-testid="page-error-banner">
        <AlertCircle size={18} style="flex-shrink: 0;" />
        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
          <span>{pageError}</span>
          <button
            type="button"
            class="button ghost sm"
            style="color: var(--danger); padding: 2px 6px;"
            onclick={() => (pageError = null)}
          >
            Dismiss
          </button>
        </div>
      </div>
    {/if}

    <!-- KPI Summary Metrics -->
    <section class="metrics" aria-label="Sync engine status overview">
      <MetricCard
        label="WakaTime Connection"
        value={readiness?.oauthConnected ? 'Connected' : 'Disconnected'}
        subtext={readiness?.reconnectRequired ? 'Reconnect required' : readiness?.oauthConnected ? 'Tokens ready' : 'Auth required'}
        badge={readiness?.reconnectRequired ? 'Reconnect' : readiness?.oauthConnected ? 'Active' : 'Setup'}
        badgeVariant={readiness?.reconnectRequired ? 'accent' : readiness?.oauthConnected ? 'work' : 'neutral'}
      />
      <MetricCard
        label="Active Execution"
        value={activeProgress?.activeRun ? `#${activeProgress.activeRun.id}` : 'Idle'}
        subtext={activeProgress?.activeRun ? `${activeProgress.activeRun.daysSynced} / ${activeProgress.activeRun.dayCount} dates` : `${runs.length} runs recorded`}
        badge={activeProgress?.activeRun ? 'Running' : 'Ready'}
        badgeVariant={activeProgress?.activeRun ? 'work' : 'neutral'}
      />
      <MetricCard
        label="Automated Schedule"
        value={schedule?.schedulingEnabled ? 'Enabled' : 'Disabled'}
        subtext={schedule?.schedulingEnabled ? (nextDueTime ? 'Cadence active' : 'Waiting') : 'Manual only'}
        badge={schedule?.schedulingEnabled ? 'Active' : 'Off'}
        badgeVariant={schedule?.schedulingEnabled ? 'safe' : 'neutral'}
      />
      <MetricCard
        label="Identity Registry"
        value={registry?.distinctEditors ? `${registry.distinctEditors} Editors` : 'Published'}
        subtext={registry?.lastRefreshedAt ? 'Labels up to date' : 'Initial state'}
        badge={registry?.isRefreshing ? 'Refreshing' : 'Current'}
        badgeVariant={registry?.isRefreshing ? 'work' : 'neutral'}
      />
    </section>

    <div style="max-width: 1180px; margin: 0 auto;">
      <!-- Readiness, Timezone, Schedule & Degradation Banners -->
      <SyncReadinessBanner
        {readiness}
        {schedule}
        {degradation}
        {sourceTimezone}
        {lastAcceptedSuccessAt}
      />

      <!-- Active / Queued Progress -->
      <SyncActiveProgress
        {activeProgress}
        rateLimitedUntil={degradation?.rateLimitedUntil}
        {busy}
        onCancel={handleCancelRun}
      />

      <!-- Operational Actions: Sync Now, Backfill, Compare, Schedule Toggle -->
      <SyncControls
        {csrfToken}
        schedulingEnabled={schedule?.schedulingEnabled ?? false}
        {sourceTimezone}
        {busy}
        onSyncNow={handleSyncNow}
        onBackfill={handleBackfill}
        onCompare={handleCompare}
        onToggleSchedule={handleToggleSchedule}
        onBindConnection={handleBindConnection}
      />

      <!-- Bounded Run History Table -->
      <SyncRunsTable
        {runs}
        {selectedRunId}
        {busy}
        onSelectRun={handleSelectRun}
        onRetryRun={handleRetryRun}
      />

      <!-- User-Agent Registry Card -->
      <SyncRegistryCard
        {registry}
        {busy}
        onRefreshRegistry={handleRefreshRegistry}
      />
    </div>

    <!-- Selected Run Details Modal -->
    <SyncRunDetailModal
      runDetail={selectedRunDetail}
      loading={runDetailLoading}
      error={runDetailError}
      {busy}
      onClose={handleCloseRunModal}
      onPageChange={(p) => loadRunDetail(selectedRunId!, p, true)}
      onRetryDate={handleRetryDate}
      onAnnounce={announce}
    />
  {/if}
</AppShell>
