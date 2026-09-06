<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from '@lucide/svelte';

  let {
    open = false,
    title,
    description,
    maxWidth = '540px',
    onclose,
    children,
    footer
  } = $props<{
    open: boolean;
    title: string;
    description?: string;
    maxWidth?: string;
    onclose: () => void;
    children: Snippet;
    footer?: Snippet;
  }>();

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      onclose();
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      onclose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div
    class="modal-backdrop"
    role="presentation"
    onclick={handleBackdropClick}
  >
    <div
      class="modal-window"
      style="max-width: {maxWidth};"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      aria-describedby={description ? 'modal-description' : undefined}
    >
      <div class="modal-header">
        <div>
          <h3 id="modal-title">{title}</h3>
          {#if description}
            <p id="modal-description" class="form-hint" style="margin: 4px 0 0;">
              {description}
            </p>
          {/if}
        </div>
        <button
          type="button"
          class="icon-button"
          aria-label="Close modal"
          onclick={onclose}
        >
          <X size={18} />
        </button>
      </div>

      <div class="modal-body">
        {@render children()}
      </div>

      {#if footer}
        <div class="modal-footer">
          {@render footer()}
        </div>
      {/if}
    </div>
  </div>
{/if}
