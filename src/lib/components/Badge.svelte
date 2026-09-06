<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    variant = 'neutral',
    children,
    size = 'md'
  } = $props<{
    variant?: 'work' | 'personal' | 'safe' | 'neutral' | 'accent' | 'warning' | 'danger';
    children?: Snippet;
    size?: 'sm' | 'md';
  }>();
</script>

<span class="badge {variant} {size}">
  {#if children}
    {@render children()}
  {/if}
</span>
