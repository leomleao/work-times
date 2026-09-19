<script lang="ts">
  import {
    AlertCircle,
    AlertTriangle,
    CheckCircle2,
    Clock,
    Globe,
    Key,
    Shield,
    ShieldAlert
  } from '@lucide/svelte';
  import type {
    AdminSyncReadinessDto,
    AdminSyncScheduleDto,
    AdminSyncDegradationDto
  } from '$lib/server/admin/sync';

  let {
    readiness,
    schedule,
    degradation,
    sourceTimezone,
    lastAcceptedSuccessAt
  } = $props<{
    readiness?: AdminSyncReadinessDto | null;
    schedule?: AdminSyncScheduleDto | null;
    degradation?: AdminSyncDegradationDto | null;
    sourceTimezone?: string | null;
    lastAcceptedSuccessAt?: string | null;
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

  let isRateLimited = $derived(Boolean(degradation?.rateLimitedUntil));
  let hasDegradation = $derived(
    Boolean(
      degradation?.summariesDegraded ||
      degradation?.durationsDegraded ||
      degradation?.heartbeatsDegraded ||
      (degradation?.activeAdvisoryCodes && degradation.activeAdvisoryCodes.length > 0)
    )
  );

  let nextDueTime = $derived.by(() => {
    if (!schedule?.nextDue) return null;
    const dues = [schedule.nextDue.recent, schedule.nextDue.reconcile, schedule.nextDue.compare]
      .filter((d): d is string => Boolean(d))
      .sort();
    return dues[0] ?? null;
  });
</script>

<div class="readiness-banner-stack" style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px;">
  <!-- Auth & Connection status -->
  {#if !readiness?.oauthAppConfigured}
    <div class="notice warning" role="status" data-testid="banner-oauth-unconfigured">
      <Key size={18} style="flex-shrink: 0; color: var(--accent);" />
      <div>
        <strong>WakaTime OAuth application is unconfigured.</strong>
        <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted);">
          Configure <code>WAKATIME_OAUTH_CLIENT_ID</code> and secret in server environment.
        </p>
      </div>
    </div>
  {:else if readiness?.reconnectRequired || !readiness?.oauthConnected}
    <div class="notice warning" role="status" data-testid="banner-reconnect-required">
      <AlertTriangle size={18} style="flex-shrink: 0; color: var(--warning);" />
      <div>
        <strong>WakaTime reconnect required.</strong>
        <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted);">
          Upstream token expired, revoked, or requires re-authorization.
          <a href="/integrations/wakatime" style="color: var(--text); text-decoration: underline; margin-left: 6px;">
            Re-authorize connection
          </a>
        </p>
      </div>
    </div>
  {:else if readiness?.isBlocked || degradation?.has401Blocked}
    <div class="notice danger" role="status" data-testid="banner-oauth-blocked">
      <ShieldAlert size={18} style="flex-shrink: 0; color: var(--danger);" />
      <div>
        <strong>Upstream authorization blocked (401).</strong>
        <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted);">
          Sync requests are suspended until authentication is refreshed.
          <a href="/integrations/wakatime" style="color: var(--text); text-decoration: underline; margin-left: 6px;">
            Reconnect WakaTime
          </a>
        </p>
      </div>
    </div>
  {:else}
    <div class="notice safe" role="status" data-testid="banner-connected-ready">
      <CheckCircle2 size={18} style="flex-shrink: 0; color: var(--work);" />
      <div>
        <strong>WakaTime connection is active & ready.</strong>
        <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted);">
          Verified source timezone: <strong>{sourceTimezone || 'Unknown'}</strong>.
          {#if readiness?.lastProbedAt}
            Capabilities confirmed at {formatDateTime(readiness.lastProbedAt)}.
          {/if}
        </p>
      </div>
    </div>
  {/if}

  <!-- Rate limiting truthfully reported -->
  {#if isRateLimited}
    <div class="notice accent" role="status" data-testid="banner-rate-limited">
      <Clock size={18} style="flex-shrink: 0; color: var(--accent);" />
      <div>
        <strong>Truthful rate limit wait active.</strong>
        <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted);">
          Upstream Retry-After active until <strong>{formatDateTime(degradation?.rateLimitedUntil)}</strong>. Worker is paused and pacing requests.
        </p>
      </div>
    </div>
  {/if}

  <!-- Concise degradation notice -->
  {#if hasDegradation && !isRateLimited}
    <div class="notice info" role="status" data-testid="banner-degradation">
      <AlertCircle size={18} style="flex-shrink: 0; color: var(--accent);" />
      <div>
        <strong>Degraded API capability notice.</strong>
        <div style="margin: 4px 0 0; font-size: 13px; color: var(--muted); display: flex; flex-direction: column; gap: 4px;">
          {#if degradation?.durationsDegraded}
            <p style="margin: 0;">
              Durations endpoint is restricted on this plan. Granular entity intervals degraded gracefully.
            </p>
          {/if}
          {#if degradation?.heartbeatsDegraded}
            <p style="margin: 0;">
              Heartbeats endpoint is restricted or unavailable. Ingesting summary slices only.
            </p>
          {/if}
          {#if degradation?.activeAdvisoryCodes && degradation.activeAdvisoryCodes.length > 0}
            <p style="margin: 0;">
              Active advisories: <code>{degradation.activeAdvisoryCodes.join(', ')}</code>
            </p>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <!-- Operational Status Bar -->
  <div
    class="panel"
    style="padding: 12px 18px; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 16px; background: var(--panel-raised);"
  >
    <div style="display: flex; align-items: center; gap: 20px; flex-wrap: wrap; font-size: 13px;">
      <div>
        <span style="color: var(--faint);">Timezone:</span>
        <strong style="margin-left: 6px; font-family: ui-monospace, monospace;">{sourceTimezone || '—'}</strong>
      </div>
      <div>
        <span style="color: var(--faint);">Schedule:</span>
        <span class="badge {schedule?.schedulingEnabled ? 'work' : 'neutral'}" style="margin-left: 6px;">
          {schedule?.schedulingEnabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      <div>
        <span style="color: var(--faint);">Next Due:</span>
        <strong style="margin-left: 6px;">
          {schedule?.schedulingEnabled ? formatDateTime(nextDueTime) : 'Manual only'}
        </strong>
      </div>
      <div>
        <span style="color: var(--faint);">Last Accepted Success:</span>
        <strong style="margin-left: 6px;">{formatDateTime(lastAcceptedSuccessAt)}</strong>
      </div>
    </div>
  </div>
</div>
