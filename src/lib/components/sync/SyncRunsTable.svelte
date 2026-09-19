<script lang="ts">
  import {
    ChevronRight,
    Clock,
    FileText,
    RefreshCw,
    RotateCcw
  } from '@lucide/svelte';
  import QualityBadge from './QualityBadge.svelte';
  import type { AdminSyncRunSummaryDto } from '$lib/server/admin/sync';

  let {
    runs = [],
    selectedRunId = null,
    busy = false,
    onSelectRun,
    onRetryRun
  } = $props<{
    runs?: AdminSyncRunSummaryDto[];
    selectedRunId?: number | null;
    busy?: boolean;
    onSelectRun: (runId: number) => void;
    onRetryRun: (runId: number) => Promise<void>;
  }>();

  function formatDateTime(isoStr?: string | null): string {
    if (!isoStr) return '—';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      return d.toLocaleString(undefined, {
        dateStyle: 'short',
        timeStyle: 'short'
      });
    } catch {
      return isoStr;
    }
  }

  function isRetryable(status: string): boolean {
    const s = status.toLowerCase();
    return s === 'failed' || s === 'partial' || s === 'interrupted';
  }

  let retryingRunId = $state<number | null>(null);

  async function handleRetry(runId: number) {
    if (busy || retryingRunId !== null) return;
    retryingRunId = runId;
    try {
      await onRetryRun(runId);
    } finally {
      retryingRunId = null;
    }
  }
</script>

<div class="panel" style="margin-bottom: 24px;" data-testid="sync-runs-panel">
  <div class="panel-heading">
    <div>
      <p class="eyebrow">Durable History</p>
      <h2>Recorded Sync Runs ({runs.length})</h2>
    </div>
  </div>

  <div class="table-wrap">
    <table class="data-table" aria-label="Sync runs history">
      <thead>
        <tr>
          <th scope="col">Run</th>
          <th scope="col">Mode & Trigger</th>
          <th scope="col">Status</th>
          <th scope="col">Date Range</th>
          <th scope="col">Completed Dates</th>
          <th scope="col">Started</th>
          <th scope="col">Finished</th>
          <th scope="col" style="text-align: right;">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#if runs.length === 0}
          <tr>
            <td colspan="8" style="text-align: center; padding: 36px 16px; color: var(--muted);">
              No sync runs recorded. Use "Sync Now" to perform the first synchronization.
            </td>
          </tr>
        {:else}
          {#each runs as run (run.id)}
            {@const isSelected = selectedRunId === run.id}
            <tr
              style={isSelected ? 'background: var(--panel-raised);' : undefined}
              data-testid="run-row-{run.id}"
            >
              <td style="font-family: ui-monospace, monospace; font-size: 12px; font-weight: 600;">
                #{run.id}
                {#if run.resumedFromRunId}
                  <span style="display: block; font-size: 10px; color: var(--faint);">
                    from #{run.resumedFromRunId}
                  </span>
                {/if}
              </td>
              <td>
                <span style="font-weight: 500; text-transform: capitalize;">{run.mode}</span>
                <small style="display: block; color: var(--faint); font-size: 11px;">
                  {run.trigger}
                </small>
              </td>
              <td>
                <QualityBadge status={run.status} />
              </td>
              <td style="font-family: ui-monospace, monospace; font-size: 12px; white-space: nowrap;">
                {#if run.rangeStartDate && run.rangeEndDate}
                  {run.rangeStartDate} → {run.rangeEndDate}
                {:else}
                  <span style="color: var(--faint);">—</span>
                {/if}
              </td>
              <td style="font-size: 12px;">
                <strong>{run.daysSynced}</strong> / {run.dayCount}
                {#if run.daysFailed > 0}
                  <span style="color: var(--danger); margin-left: 4px;">({run.daysFailed} failed)</span>
                {/if}
              </td>
              <td style="font-size: 12px; white-space: nowrap; color: var(--muted);">
                {formatDateTime(run.startedAt)}
              </td>
              <td style="font-size: 12px; white-space: nowrap; color: var(--muted);">
                {formatDateTime(run.finishedAt)}
              </td>
              <td style="text-align: right; white-space: nowrap;">
                <div style="display: inline-flex; align-items: center; gap: 6px;">
                  {#if isRetryable(run.status)}
                    <button
                      type="button"
                      class="button ghost sm"
                      disabled={busy || retryingRunId === run.id}
                      onclick={() => handleRetry(run.id)}
                      title="Retry failed/interrupted dates"
                      data-testid="retry-run-btn-{run.id}"
                    >
                      <RotateCcw size={13} />
                      <span>{retryingRunId === run.id ? 'Retrying…' : 'Retry'}</span>
                    </button>
                  {/if}

                  <button
                    type="button"
                    class="button secondary sm"
                    onclick={() => onSelectRun(run.id)}
                    data-testid="view-run-details-btn-{run.id}"
                  >
                    <FileText size={13} />
                    <span>{isSelected ? 'Viewing' : 'Details'}</span>
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
</div>
