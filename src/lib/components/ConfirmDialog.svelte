<script lang="ts">
  import Modal from './Modal.svelte';
  import { AlertTriangle } from '@lucide/svelte';

  let {
    open = false,
    title = 'Confirm action',
    message,
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    danger = false,
    onconfirm,
    oncancel
  } = $props<{
    open: boolean;
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    onconfirm: () => void;
    oncancel: () => void;
  }>();
</script>

<Modal
  {open}
  {title}
  onclose={oncancel}
  maxWidth="460px"
>
  <div style="display: flex; gap: 14px; align-items: flex-start;">
    {#if danger}
      <div style="color: var(--danger); background: var(--danger-soft); padding: 8px; border-radius: var(--radius-sm); flex-shrink: 0;">
        <AlertTriangle size={20} />
      </div>
    {/if}
    <p style="margin: 0; font-size: 13px; line-height: 1.6; color: var(--muted);">
      {message}
    </p>
  </div>

  {#snippet footer()}
    <button type="button" class="button ghost" onclick={oncancel}>
      {cancelText}
    </button>
    <button
      type="button"
      class="button {danger ? 'danger' : 'primary'}"
      onclick={onconfirm}
    >
      {confirmText}
    </button>
  {/snippet}
</Modal>
