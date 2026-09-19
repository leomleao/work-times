<script lang="ts">
  let {
    status,
    label,
    title,
    isStale = false,
    isProvisional = false,
    disposition
  } = $props<{
    status?: string | null;
    label?: string;
    title?: string;
    isStale?: boolean;
    isProvisional?: boolean;
    disposition?: string | null;
  }>();

  interface BadgeInfo {
    variant: string;
    text: string;
  }

  function getBadgeInfo(st?: string | null, disp?: string | null): BadgeInfo {
    const s = (st ?? '').toLowerCase();
    const d = (disp ?? '').toLowerCase();

    if (d === 'preserved' || s === 'archived_detail_preserved') {
      return { variant: 'warning', text: 'Archived Detail Preserved' };
    }
    if (s === 'reconnect_required') {
      return { variant: 'danger', text: 'Reconnect Required' };
    }
    if (s === 'restricted') {
      return { variant: 'accent', text: 'Restricted' };
    }
    if (s === 'verified_zero') {
      return { variant: 'neutral', text: 'Verified Zero' };
    }
    if (s === 'missing') {
      return { variant: 'neutral', text: 'Missing' };
    }
    if (s === 'current_day_provisional' || (s === 'provisional' && isProvisional)) {
      return { variant: 'personal', text: 'Current-Day Provisional' };
    }
    if (s === 'limited_detail') {
      return { variant: 'accent', text: 'Limited Detail' };
    }
    if (s === 'checked_unchanged' || d === 'unchanged') {
      return { variant: 'neutral', text: 'Checked Unchanged' };
    }
    if (s === 'updated' || d === 'updated') {
      return { variant: 'work', text: 'Updated' };
    }
    if (s === 'stale' || isStale) {
      return { variant: 'accent', text: 'Stale' };
    }
    if (s === 'succeeded') {
      return { variant: 'work', text: 'Succeeded' };
    }
    if (s === 'partial') {
      return { variant: 'accent', text: 'Partial' };
    }
    if (s === 'failed' || d === 'rejected') {
      return { variant: 'danger', text: 'Failed' };
    }
    if (s === 'cancelled') {
      return { variant: 'neutral', text: 'Cancelled' };
    }
    if (s === 'interrupted') {
      return { variant: 'danger', text: 'Interrupted' };
    }
    if (s === 'running') {
      return { variant: 'work', text: 'Running' };
    }
    if (s === 'queued') {
      return { variant: 'neutral', text: 'Queued' };
    }
    if (s === 'pending') {
      return { variant: 'neutral', text: 'Pending' };
    }
    if (s === 'skipped') {
      return { variant: 'neutral', text: 'Skipped' };
    }
    if (s === 'degraded') {
      return { variant: 'accent', text: 'Degraded' };
    }
    if (s === 'comparison_only') {
      return { variant: 'neutral', text: 'Comparison Only' };
    }

    return {
      variant: 'neutral',
      text: s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : 'Unknown'
    };
  }

  let info = $derived(getBadgeInfo(status, disposition));
  let badgeText = $derived(label ?? info.text);
  let badgeVariant = $derived(info.variant);
</script>

<span
  class="badge {badgeVariant}"
  data-testid="quality-badge"
  {title}
  data-quality-status={status}
  data-disposition={disposition}
  data-stale={isStale ? 'true' : undefined}
  data-provisional={isProvisional ? 'true' : undefined}
>
  {badgeText}
</span>
