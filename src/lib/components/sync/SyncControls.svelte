<script lang="ts">
  import {
    Calendar,
    Check,
    ChevronDown,
    ChevronUp,
    Clock,
    Link,
    Play,
    RefreshCw,
    Sliders,
    Zap
  } from '@lucide/svelte';

  let {
    csrfToken,
    schedulingEnabled = false,
    sourceTimezone = null,
    busy = false,
    onSyncNow,
    onBackfill,
    onCompare,
    onToggleSchedule,
    onBindConnection
  } = $props<{
    csrfToken?: string | null;
    schedulingEnabled?: boolean;
    sourceTimezone?: string | null;
    busy?: boolean;
    onSyncNow: () => Promise<void>;
    onBackfill: (startDate: string, endDate: string) => Promise<void>;
    onCompare: (startDate: string, endDate: string) => Promise<void>;
    onToggleSchedule: (enabled: boolean) => Promise<void>;
    onBindConnection: () => Promise<void>;
  }>();

  // Local state for backfill & compare date inputs
  let backfillOpen = $state(false);
  let compareOpen = $state(false);

  let backfillStartDate = $state('');
  let backfillEndDate = $state('');
  let backfillError = $state<string | null>(null);

  let compareStartDate = $state('');
  let compareEndDate = $state('');
  let compareError = $state<string | null>(null);

  let bindConfirmOpen = $state(false);

  function todayInSourceTimezone(): string | null {
    if (!sourceTimezone) return null;
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: sourceTimezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(new Date());
      const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value;
      const year = value('year');
      const month = value('month');
      const day = value('day');
      return year && month && day ? `${year}-${month}-${day}` : null;
    } catch {
      return null;
    }
  }

  // Pure calendar validation helper
  function validateDateRange(startStr: string, endStr: string): string | null {
    if (!startStr || !endStr) {
      return 'Start date and end date are both required';
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startStr) || !dateRegex.test(endStr)) {
      return 'Dates must be in YYYY-MM-DD format';
    }

    const start = new Date(startStr + 'T00:00:00Z');
    const end = new Date(endStr + 'T00:00:00Z');

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return 'Invalid calendar date specified';
    }

    if (start.toISOString().slice(0, 10) !== startStr || end.toISOString().slice(0, 10) !== endStr) {
      return 'Specified calendar date does not exist';
    }

    if (startStr > endStr) {
      return 'Start date must be before or equal to end date';
    }

    const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    if (diffDays > 366) {
      return `Date range cannot exceed 366 days (requested ${diffDays} days)`;
    }

    // Check future date against source timezone / today
    const todayStr = todayInSourceTimezone();
    if (!todayStr) return 'Verified source timezone is unavailable';
    if (endStr > todayStr) {
      return 'Date range cannot include future dates';
    }

    return null;
  }

  async function handleSyncNowClick() {
    if (busy) return;
    await onSyncNow();
  }

  async function handleBackfillSubmit(e: Event) {
    e.preventDefault();
    if (busy) return;
    const err = validateDateRange(backfillStartDate, backfillEndDate);
    if (err) {
      backfillError = err;
      return;
    }
    backfillError = null;
    await onBackfill(backfillStartDate, backfillEndDate);
  }

  async function handleCompareSubmit(e: Event) {
    e.preventDefault();
    if (busy) return;
    const err = validateDateRange(compareStartDate, compareEndDate);
    if (err) {
      compareError = err;
      return;
    }
    compareError = null;
    await onCompare(compareStartDate, compareEndDate);
  }

  async function handleScheduleToggle() {
    if (busy) return;
    await onToggleSchedule(!schedulingEnabled);
  }

  async function handleBindConnectionConfirm() {
    if (busy) return;
    await onBindConnection();
    bindConfirmOpen = false;
  }
</script>

<div class="panel" style="margin-bottom: 24px; padding: 20px 22px;">
  <div class="panel-heading" style="padding: 0; margin-bottom: 16px; border: none;">
    <div>
      <p class="eyebrow">Ingestion Controls</p>
      <h2>Operational Sync Actions</h2>
    </div>
    <div style="display: flex; align-items: center; gap: 12px;">
      <!-- Schedule Toggle -->
      <label
        class="form-check-label"
        style="display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; font-weight: 500;"
      >
        <input
          type="checkbox"
          checked={schedulingEnabled}
          disabled={busy}
          onchange={handleScheduleToggle}
          style="accent-color: var(--work); width: 16px; height: 16px; cursor: pointer;"
          data-testid="schedule-toggle-input"
        />
        <span>Automated Scheduling</span>
      </label>

      <!-- Bind Connection button -->
      <button
        type="button"
        class="button ghost sm"
        disabled={busy}
        onclick={() => (bindConfirmOpen = !bindConfirmOpen)}
        title="Bind current WakaTime connection to archive"
        data-testid="bind-connection-btn"
      >
        <Link size={14} />
        <span>Bind Archive</span>
      </button>
    </div>
  </div>

  {#if bindConfirmOpen}
    <div
      class="notice info"
      style="margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px;"
    >
      <div>
        <strong>Acknowledge Account Binding</strong>
        <p style="margin: 2px 0 0; font-size: 12px; color: var(--muted);">
          Confirm that the active OAuth connection belongs to the same WakaTime account as this archive.
        </p>
      </div>
      <div style="display: flex; gap: 8px; flex-shrink: 0;">
        <button
          type="button"
          class="button primary sm"
          disabled={busy}
          onclick={handleBindConnectionConfirm}
          data-testid="confirm-bind-btn"
        >
          Confirm Binding
        </button>
        <button
          type="button"
          class="button secondary sm"
          onclick={() => (bindConfirmOpen = false)}
        >
          Cancel
        </button>
      </div>
    </div>
  {/if}

  <!-- Action Buttons Row -->
  <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
    <!-- Primary Sync Now -->
    <button
      type="button"
      class="button primary"
      disabled={busy}
      onclick={handleSyncNowClick}
      data-testid="sync-now-button"
    >
      <Play size={15} />
      <span>Sync Now (Recent)</span>
    </button>

    <!-- Secondary Backfill Toggle -->
    <button
      type="button"
      class="button secondary"
      disabled={busy}
      onclick={() => {
        backfillOpen = !backfillOpen;
        if (backfillOpen) compareOpen = false;
      }}
      data-testid="toggle-backfill-form"
    >
      <Calendar size={15} />
      <span>Bounded Backfill</span>
      {#if backfillOpen}<ChevronUp size={14} />{:else}<ChevronDown size={14} />{/if}
    </button>

    <!-- Secondary Compare Toggle -->
    <button
      type="button"
      class="button secondary"
      disabled={busy}
      onclick={() => {
        compareOpen = !compareOpen;
        if (compareOpen) backfillOpen = false;
      }}
      data-testid="toggle-compare-form"
    >
      <RefreshCw size={15} />
      <span>Summary Compare</span>
      {#if compareOpen}<ChevronUp size={14} />{:else}<ChevronDown size={14} />{/if}
    </button>
  </div>

  <!-- Backfill Expandable Form -->
  {#if backfillOpen}
    <form
      onsubmit={handleBackfillSubmit}
      style="margin-top: 18px; padding: 16px; background: var(--panel-sunken); border: 1px solid var(--border); border-radius: var(--radius-sm);"
      data-testid="backfill-form"
    >
      <div style="margin-bottom: 12px;">
        <strong style="font-size: 13px; display: block;">Bounded Backfill Request</strong>
        <p style="margin: 2px 0 0; font-size: 12px; color: var(--muted);">
          Enqueue historical synchronization for an inclusive date range (max 366 days, past dates only).
        </p>
      </div>

      {#if backfillError}
        <div class="notice danger" style="padding: 8px 12px; margin-bottom: 12px; font-size: 12px;" data-testid="backfill-error">
          {backfillError}
        </div>
      {/if}

      <div style="display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap;">
        <div>
          <label for="backfill-start" style="display: block; font-size: 11px; color: var(--faint); margin-bottom: 4px;">
            Start Date (YYYY-MM-DD)
          </label>
          <input
            id="backfill-start"
            name="backfillStartDate"
            type="date"
            class="form-input"
            bind:value={backfillStartDate}
            disabled={busy}
            style="font-size: 12px; padding: 6px 10px; width: 140px;"
            data-testid="backfill-start-input"
          />
        </div>

        <div>
          <label for="backfill-end" style="display: block; font-size: 11px; color: var(--faint); margin-bottom: 4px;">
            End Date (YYYY-MM-DD)
          </label>
          <input
            id="backfill-end"
            name="backfillEndDate"
            type="date"
            class="form-input"
            bind:value={backfillEndDate}
            disabled={busy}
            style="font-size: 12px; padding: 6px 10px; width: 140px;"
            data-testid="backfill-end-input"
          />
        </div>

        <button
          type="submit"
          class="button primary sm"
          disabled={busy || !backfillStartDate || !backfillEndDate}
          data-testid="submit-backfill-btn"
        >
          Enqueue Backfill
        </button>
      </div>
    </form>
  {/if}

  <!-- Compare Expandable Form -->
  {#if compareOpen}
    <form
      onsubmit={handleCompareSubmit}
      style="margin-top: 18px; padding: 16px; background: var(--panel-sunken); border: 1px solid var(--border); border-radius: var(--radius-sm);"
      data-testid="compare-form"
    >
      <div style="margin-bottom: 12px;">
        <strong style="font-size: 13px; display: block;">Summary Comparison Request</strong>
        <p style="margin: 2px 0 0; font-size: 12px; color: var(--muted);">
          Compare upstream summaries against archive totals without overwriting granular entity detail (max 366 days).
        </p>
      </div>

      {#if compareError}
        <div class="notice danger" style="padding: 8px 12px; margin-bottom: 12px; font-size: 12px;" data-testid="compare-error">
          {compareError}
        </div>
      {/if}

      <div style="display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap;">
        <div>
          <label for="compare-start" style="display: block; font-size: 11px; color: var(--faint); margin-bottom: 4px;">
            Start Date (YYYY-MM-DD)
          </label>
          <input
            id="compare-start"
            name="compareStartDate"
            type="date"
            class="form-input"
            bind:value={compareStartDate}
            disabled={busy}
            style="font-size: 12px; padding: 6px 10px; width: 140px;"
            data-testid="compare-start-input"
          />
        </div>

        <div>
          <label for="compare-end" style="display: block; font-size: 11px; color: var(--faint); margin-bottom: 4px;">
            End Date (YYYY-MM-DD)
          </label>
          <input
            id="compare-end"
            name="compareEndDate"
            type="date"
            class="form-input"
            bind:value={compareEndDate}
            disabled={busy}
            style="font-size: 12px; padding: 6px 10px; width: 140px;"
            data-testid="compare-end-input"
          />
        </div>

        <button
          type="submit"
          class="button primary sm"
          disabled={busy || !compareStartDate || !compareEndDate}
          data-testid="submit-compare-btn"
        >
          Enqueue Compare
        </button>
      </div>
    </form>
  {/if}
</div>
