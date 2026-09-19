<script lang="ts">
  import {
    Activity,
    AlertCircle,
    CheckCircle2,
    Clock,
    Pause,
    Play,
    StopCircle,
    XCircle
  } from '@lucide/svelte';
  import QualityBadge from './QualityBadge.svelte';
  import type { AdminSyncActiveProgressDto } from '$lib/server/admin/sync';

  let {
    activeProgress,
    rateLimitedUntil,
    busy = false,
    onCancel
  } = $props<{
    activeProgress?: AdminSyncActiveProgressDto | null;
    rateLimitedUntil?: string | null;
    busy?: boolean;
    onCancel: (runId: number) => Promise<void>;
  }>();

  let activeRun = $derived(activeProgress?.activeRun ?? null);
  let queueDepth = $derived(activeProgress?.queueDepth ?? 0);
  let currentDate = $derived(activeProgress?.currentDate ?? null);
  let lastProgressAt = $derived(activeProgress?.lastProgressAt ?? null);
  let isPaused = $derived(activeProgress?.isPaused ?? false);

  let progressPercent = $derived(
    activeRun && activeRun.dayCount > 0
      ? Math.min(100, Math.round((activeRun.daysSynced / activeRun.dayCount) * 100))
      : 0
  );

  function formatTime(isoStr?: string | null): string {
    if (!isoStr) return '—';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      return d.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch {
      return isoStr;
    }
  }

  let cancelInFlight = $state(false);

  async function handleCancel() {
    if (!activeRun || cancelInFlight || busy) return;
    cancelInFlight = true;
    try {
      await onCancel(activeRun.id);
    } finally {
      cancelInFlight = false;
    }
  }
</script>

{#if activeRun || queueDepth > 0}
  <div class="panel" style="margin-bottom: 24px; padding: 20px 22px; border-color: var(--border-strong);" data-testid="active-progress-panel">
    <div class="panel-heading" style="padding: 0; margin-bottom: 14px; border: none;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <span class="status-dot" style="background: var(--work); animation: pulse 2s infinite;"></span>
        <div>
          <p class="eyebrow" style="margin: 0;">Execution Progress</p>
          <h2 style="margin: 2px 0 0; font-size: 16px;">
            {#if activeRun}
              Active Run #{activeRun.id} ({activeRun.mode.toUpperCase()})
            {:else}
              Queued Sync ({queueDepth} run{queueDepth === 1 ? '' : 's'} waiting)
            {/if}
          </h2>
        </div>
      </div>

      {#if activeRun}
        <div style="display: flex; align-items: center; gap: 8px;">
          <QualityBadge status={activeRun.status} />
          <button
            type="button"
            class="button secondary sm"
            disabled={busy || cancelInFlight}
            onclick={handleCancel}
            data-testid="cancel-active-run-btn"
          >
            <StopCircle size={14} style="color: var(--danger);" />
            <span>{cancelInFlight ? 'Cancelling…' : 'Cancel Run'}</span>
          </button>
        </div>
      {/if}
    </div>

    {#if activeRun}
      <!-- Rate limit indicator if active -->
      {#if rateLimitedUntil || isPaused}
        <div
          class="notice accent"
          style="padding: 8px 12px; margin-bottom: 14px; font-size: 12px; display: flex; align-items: center; gap: 8px;"
          data-testid="progress-rate-limit-notice"
        >
          <Clock size={15} style="flex-shrink: 0;" />
          <span>
            Truthful upstream rate limit active. Waiting until <strong>{formatTime(rateLimitedUntil)}</strong> before continuing.
          </span>
        </div>
      {/if}

      <!-- Progress Meter -->
      <div style="margin-bottom: 14px;">
        <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 6px;">
          <span>
            Dates Completed: <strong>{activeRun.daysSynced}</strong> of <strong>{activeRun.dayCount}</strong>
            {#if activeRun.daysFailed > 0}
              <span style="color: var(--danger); margin-left: 6px;">({activeRun.daysFailed} failed)</span>
            {/if}
          </span>
          <span style="font-family: ui-monospace, monospace;">{progressPercent}%</span>
        </div>

        <div
          style="width: 100%; height: 8px; background: var(--panel-sunken); border-radius: var(--radius-xs); overflow: hidden; border: 1px solid var(--border);"
          role="progressbar"
          aria-valuenow={progressPercent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            style="width: {progressPercent}%; height: 100%; background: var(--work); transition: width 300ms ease;"
          ></div>
        </div>
      </div>

      <!-- Detail chips -->
      <div style="display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--muted);">
        {#if currentDate}
          <div>
            <span style="color: var(--faint);">Current Date:</span>
            <strong style="margin-left: 4px; font-family: ui-monospace, monospace; color: var(--text);">
              {currentDate}
            </strong>
          </div>
        {/if}
        {#if lastProgressAt}
          <div>
            <span style="color: var(--faint);">Last Progress:</span>
            <span style="margin-left: 4px; color: var(--text);">{formatTime(lastProgressAt)}</span>
          </div>
        {/if}
        {#if queueDepth > 0}
          <div>
            <span style="color: var(--faint);">Queue Depth:</span>
            <strong style="margin-left: 4px; color: var(--text);">{queueDepth}</strong>
          </div>
        {/if}
      </div>
    {:else if queueDepth > 0}
      <p style="margin: 0; font-size: 13px; color: var(--muted);">
        {queueDepth} sync run{queueDepth === 1 ? ' is' : 's are'} enqueued and waiting for coordinator execution.
      </p>
    {/if}
  </div>
{/if}

<style>
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
