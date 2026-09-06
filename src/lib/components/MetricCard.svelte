<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    label,
    value,
    subtext,
    badge,
    badgeVariant = 'neutral',
    children
  } = $props<{
    label: string;
    value: string | number;
    subtext?: string;
    badge?: string;
    badgeVariant?: 'work' | 'personal' | 'safe' | 'neutral' | 'accent' | 'warning' | 'danger';
    children?: Snippet;
  }>();
</script>

<article class="metric-card">
  <div class="metric-header">
    <span class="metric-label">{label}</span>
    {#if badge}
      <span class="badge {badgeVariant}">{badge}</span>
    {/if}
  </div>
  <strong class="metric-value">{value}</strong>
  {#if subtext}
    <small class="metric-subtext">{subtext}</small>
  {/if}
  {#if children}
    {@render children()}
  {/if}
</article>
