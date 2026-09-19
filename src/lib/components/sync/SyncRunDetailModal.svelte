<script lang="ts">
  import Modal from '$lib/components/Modal.svelte';
  import QualityBadge from './QualityBadge.svelte';
  import {
    ChevronLeft,
    ChevronRight,
    Copy,
    Info,
    RotateCcw
  } from '@lucide/svelte';
  import type { AdminSyncRunDetailDto, AdminSyncDateDetailDto } from '$lib/server/admin/sync';

  let {
    runDetail = null,
    loading = false,
    error = null,
    busy = false,
    onClose,
    onPageChange,
    onRetryDate,
    onAnnounce
  } = $props<{
    runDetail?: AdminSyncRunDetailDto | null;
    loading?: boolean;
    error?: string | null;
    busy?: boolean;
    onClose: () => void;
    onPageChange: (newPage: number) => void;
    onRetryDate: (runId: number, date: string) => Promise<void>;
    onAnnounce?: (msg: string) => void;
  }>();

  async function copyDiagnostic(text: string) {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      onAnnounce?.(`Diagnostic: ${text}`);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      onAnnounce?.(`Diagnostic code "${text}" copied to clipboard.`);
    } catch {
      onAnnounce?.(`Clipboard access denied for diagnostic code "${text}".`);
    }
  }

  let retryingDate = $state<string | null>(null);

  async function handleRetry(date: string) {
    if (!runDetail?.run?.id || busy || retryingDate !== null) return;
    retryingDate = date;
    try {
      await onRetryDate(runDetail.run.id, date);
    } finally {
      retryingDate = null;
    }
  }

  function isDateRetryable(day: AdminSyncDateDetailDto): boolean {
    const s = day.status.toLowerCase();
    const q = day.qualityStatus.toLowerCase();
    return s === 'failed' || s === 'interrupted' || s === 'restricted' || q === 'restricted' || q === 'reconnect_required';
  }
</script>

<Modal
  open={Boolean(runDetail || loading || error)}
  title={runDetail ? `Run #${runDetail.run.id} Details (${runDetail.run.mode.toUpperCase()})` : 'Sync Run Details'}
  description="Inspect per-date layer status, quality projections, and safe diagnostics."
  maxWidth="960px"
  onclose={onClose}
>
  {#if loading}
    <div style="padding: 40px; text-align: center; color: var(--muted);" data-testid="run-detail-loading">
      Loading date details…
    </div>
  {:else if error}
    <div class="notice danger" style="margin-bottom: 16px;" data-testid="run-detail-error">
      {error}
    </div>
  {:else if runDetail}
    <!-- Run Summary Header -->
    <div
      style="padding: 12px 16px; background: var(--panel-sunken); border: 1px solid var(--border); border-radius: var(--radius-sm); margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;"
    >
      <div style="display: flex; align-items: center; gap: 12px; font-size: 13px;">
        <div>
          <span style="color: var(--faint);">Status:</span>
          <QualityBadge status={runDetail.run.status} />
        </div>
        <div>
          <span style="color: var(--faint);">Dates:</span>
          <strong>{runDetail.run.daysSynced}</strong> / {runDetail.run.dayCount}
          {#if runDetail.run.daysFailed > 0}
            <span style="color: var(--danger); margin-left: 4px;">({runDetail.run.daysFailed} failed)</span>
          {/if}
        </div>
        {#if runDetail.run.rangeStartDate && runDetail.run.rangeEndDate}
          <div>
            <span style="color: var(--faint);">Range:</span>
            <span style="font-family: ui-monospace, monospace;">
              {runDetail.run.rangeStartDate} → {runDetail.run.rangeEndDate}
            </span>
          </div>
        {/if}
      </div>

      {#if runDetail.run.advisoryCodes && runDetail.run.advisoryCodes.length > 0}
        <div style="font-size: 11px;">
          <span style="color: var(--faint);">Advisories:</span>
          <code>{runDetail.run.advisoryCodes.join(', ')}</code>
        </div>
      {/if}
    </div>

    <!-- Paginated Dates Table -->
    <div class="table-wrap" style="max-height: 480px; overflow-y: auto;">
      <table class="data-table" aria-label="Run dates table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Status</th>
            <th scope="col">Disposition</th>
            <th scope="col">Quality Projection</th>
            <th scope="col">Layers (Sum / Dur / HB)</th>
            <th scope="col">Safe Diagnostic</th>
            <th scope="col" style="text-align: right;">Action</th>
          </tr>
        </thead>
        <tbody>
          {#if runDetail.days.length === 0}
            <tr>
              <td colspan="7" style="text-align: center; padding: 24px; color: var(--muted);">
                No date records for this run.
              </td>
            </tr>
          {:else}
            {#each runDetail.days as day (day.id || day.date)}
              <tr data-testid="date-row-{day.date}">
                <td style="font-family: ui-monospace, monospace; font-size: 12px; font-weight: 600; white-space: nowrap;">
                  {day.date}
                </td>
                <td>
                  <QualityBadge status={day.status} />
                </td>
                <td>
                  <QualityBadge disposition={day.disposition} />
                </td>
                <td>
                  <QualityBadge
                    status={day.qualityStatus}
                    isStale={day.isStale}
                    isProvisional={day.isProvisional}
                  />
                </td>
                <td style="font-size: 11px; white-space: nowrap;">
                  <span title="Summaries layer" style="color: {day.summariesStatus === 'succeeded' ? 'var(--work)' : day.summariesStatus === 'restricted' ? 'var(--accent)' : 'var(--muted)'};">
                    Sum: {day.summariesStatus || '—'}
                  </span>
                  <span style="color: var(--faint); margin: 0 4px;">/</span>
                  <span title="Durations layer" style="color: {day.durationsStatus === 'succeeded' ? 'var(--work)' : day.durationsStatus === 'restricted' ? 'var(--accent)' : 'var(--muted)'};">
                    Dur: {day.durationsStatus || '—'}
                  </span>
                  <span style="color: var(--faint); margin: 0 4px;">/</span>
                  <span title="Heartbeats layer" style="color: {day.heartbeatsStatus === 'succeeded' ? 'var(--work)' : day.heartbeatsStatus === 'restricted' ? 'var(--accent)' : 'var(--muted)'};">
                    HB: {day.heartbeatsStatus || '—'}
                  </span>
                </td>
                <td style="font-size: 11px; max-width: 180px;">
                  {#if day.errorMessage}
                    <div style="display: flex; align-items: center; gap: 4px;">
                      <code style="color: var(--accent); word-break: break-all;" data-testid="diag-code-{day.date}">
                        {day.errorMessage}
                      </code>
                      <button
                        type="button"
                        class="icon-button"
                        style="padding: 2px;"
                        title="Copy diagnostic code"
                        aria-label="Copy diagnostic code for {day.date}"
                        onclick={() => copyDiagnostic(day.errorMessage!)}
                        data-testid="copy-diag-btn-{day.date}"
                      >
                        <Copy size={11} />
                      </button>
                    </div>
                  {:else}
                    <span style="color: var(--faint);">—</span>
                  {/if}
                </td>
                <td style="text-align: right; white-space: nowrap;">
                  {#if isDateRetryable(day)}
                    <button
                      type="button"
                      class="button ghost sm"
                      disabled={busy || retryingDate === day.date}
                      onclick={() => handleRetry(day.date)}
                      title="Retry this date"
                      data-testid="retry-date-btn-{day.date}"
                    >
                      <RotateCcw size={12} />
                      <span>{retryingDate === day.date ? 'Retrying…' : 'Retry'}</span>
                    </button>
                  {:else}
                    <span style="color: var(--faint); font-size: 11px;">—</span>
                  {/if}
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>

    <!-- Pagination Footer -->
    {#if runDetail.pagination && runDetail.pagination.totalPages > 1}
      <div
        style="margin-top: 16px; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--muted);"
      >
        <span>
          Page <strong>{runDetail.pagination.page}</strong> of <strong>{runDetail.pagination.totalPages}</strong>
          ({runDetail.pagination.totalDays} total dates)
        </span>

        <div style="display: flex; gap: 8px;">
          <button
            type="button"
            class="button secondary sm"
            disabled={busy || runDetail.pagination.page <= 1}
            onclick={() => onPageChange(runDetail!.pagination.page - 1)}
            data-testid="prev-page-btn"
          >
            <ChevronLeft size={14} />
            <span>Previous</span>
          </button>

          <button
            type="button"
            class="button secondary sm"
            disabled={busy || runDetail.pagination.page >= runDetail.pagination.totalPages}
            onclick={() => onPageChange(runDetail!.pagination.page + 1)}
            data-testid="next-page-btn"
          >
            <span>Next</span>
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    {/if}
  {/if}
</Modal>
