<script lang="ts">
  import {
    Clock,
    Database,
    FileCode,
    RefreshCw,
    Shield
  } from '@lucide/svelte';
  import type { AdminSyncRegistryDto } from '$lib/server/admin/sync';

  let {
    registry = null,
    busy = false,
    onRefreshRegistry
  } = $props<{
    registry?: AdminSyncRegistryDto | null;
    busy?: boolean;
    onRefreshRegistry: () => Promise<void>;
  }>();

  function formatDateTime(isoStr?: string | null): string {
    if (!isoStr) return 'Never';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      return d.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
      });
    } catch {
      return isoStr;
    }
  }

  let refreshing = $derived(Boolean(registry?.isRefreshing));
  let refreshInFlight = $state(false);

  async function handleRefresh() {
    if (busy || refreshing || refreshInFlight) return;
    refreshInFlight = true;
    try {
      await onRefreshRegistry();
    } finally {
      refreshInFlight = false;
    }
  }
</script>

<div class="panel" style="padding: 20px 22px; margin-bottom: 24px;" data-testid="sync-registry-panel">
  <div class="panel-heading" style="padding: 0; margin-bottom: 14px; border: none;">
    <div>
      <p class="eyebrow">Identity Registry</p>
      <h2>User-Agent & Editor Registry</h2>
    </div>
    <span class="badge {refreshing ? 'work' : 'neutral'}">
      {refreshing ? 'Refreshing…' : 'Published'}
    </span>
  </div>

  <p style="margin: 0 0 16px; font-size: 13px; color: var(--muted); line-height: 1.5;">
    Authoritative editor display labels are resolved through the registry for user-facing presentation only.
    Refreshing labels does not alter raw selector UUIDs, matching logic, or historical classifications.
  </p>

  <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
    <div style="display: flex; gap: 24px; flex-wrap: wrap; font-size: 13px;">
      <div>
        <span style="color: var(--faint);">Last Refresh:</span>
        <strong style="margin-left: 6px;">{formatDateTime(registry?.lastRefreshedAt)}</strong>
      </div>
      <div>
        <span style="color: var(--faint);">Total Entries:</span>
        <strong style="margin-left: 6px;">{registry?.totalEntries ?? 0}</strong>
      </div>
      <div>
        <span style="color: var(--faint);">Distinct Editors:</span>
        <strong style="margin-left: 6px;">{registry?.distinctEditors ?? 0}</strong>
      </div>
    </div>

    <button
      type="button"
      class="button secondary"
      disabled={busy || refreshing || refreshInFlight}
      onclick={handleRefresh}
      data-testid="refresh-registry-btn"
    >
      <RefreshCw size={14} class={refreshing || refreshInFlight ? 'spin' : ''} />
      <span>{refreshing || refreshInFlight ? 'Refreshing Registry…' : 'Refresh Registry Now'}</span>
    </button>
  </div>
</div>

<style>
  :global(.spin) {
    animation: rotate 1s linear infinite;
  }
  @keyframes rotate {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
</style>
