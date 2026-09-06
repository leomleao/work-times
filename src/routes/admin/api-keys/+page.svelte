<script lang="ts">
  import { page } from '$app/state';
  import AppShell from '$lib/components/AppShell.svelte';
  import MetricCard from '$lib/components/MetricCard.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import {
    Check,
    Copy,
    KeyRound,
    Lock,
    Plus,
    ShieldAlert,
    Trash2
  } from '@lucide/svelte';

  interface ActionData {
    secret?: string;
    error?: string;
    [key: string]: unknown;
  }

  interface ApiKeyItem {
    id: string;
    name: string;
    prefix: string; // e.g. "wtk_"
    scopes: string[];
    createdAt: string;
    expiresAt?: string | null;
    lastUsedAt: string | null;
    status: 'active' | 'revoked';
  }

  let { data, form }: { data: { keys: ApiKeyItem[] }; form?: ActionData | null } = $props();

  let keys = $derived(data.keys);

  // Create Key Modal state
  let createModalOpen = $state(false);
  let newKeyName = $state('');
  let newKeyScopes = $state<string[]>(['activity:read']);
  const availableScopes = [
    { id: 'activity:read', label: 'activity:read', desc: 'Read activity timelines and daily summaries' },
    { id: 'activity:detail', label: 'activity:detail', desc: 'Read fine-grained heartbeats, lines, and AI telemetry' },
    { id: 'operations:read', label: 'operations:read', desc: 'Inspect sync status, capability probing, and run history' }
  ];

  let copied = $state(false);

  function toggleScope(scopeId: string) {
    if (newKeyScopes.includes(scopeId)) {
      newKeyScopes = newKeyScopes.filter((s) => s !== scopeId);
    } else {
      newKeyScopes = [...newKeyScopes, scopeId];
    }
  }
</script>

<svelte:head>
  <title>API Keys — Work Times</title>
</svelte:head>

<AppShell>
  <header class="page-header">
    <div>
      <p class="eyebrow">Programmatic Access</p>
      <h1>API Keys & Secret Management.</h1>
      <p class="lede">
        Issue cryptographically secure tokens for automation agents and MCP clients.
        Raw secret values are transiently displayed once upon generation for copying, are never persisted, and disappear after navigating or reloading.
      </p>
    </div>
    <div class="header-actions">
      <button
        type="button"
        class="button primary"
        onclick={() => (createModalOpen = true)}
      >
        <Plus size={15} />
        <span>Generate New API Key</span>
      </button>
    </div>
  </header>

  <!-- Metrics -->
  <section class="metrics" aria-label="API key summary statistics">
    <MetricCard
      label="Active Tokens"
      value={keys.filter((k) => k.status === 'active').length}
      subtext="Bound to least-privilege scopes"
      badge="SHA-256 Hashed"
      badgeVariant="work"
    />
    <MetricCard
      label="Revoked Keys"
      value={keys.filter((k) => k.status === 'revoked').length}
      subtext="Permanently invalidated tokens"
      badge="Revoked"
      badgeVariant="neutral"
    />
    <MetricCard
      label="Key Storage Standard"
      value="One-Time"
      subtext="Zero plaintext secret persistence in database"
      badge="Secure"
      badgeVariant="safe"
    />
  </section>

  <!-- Mandatory Security Notice -->
  <div style="max-width: 1180px; margin: 0 auto 20px;">
    <div class="notice info">
      <Lock size={17} />
      <div>
        <strong style="display: block; margin-bottom: 2px;">One-Time Secret Display Standard:</strong>
        API key secrets are transiently displayed <strong>only once</strong> at the moment of creation so the operator can copy them. Work Times stores
        only SHA-256 hashes. Once closed, lost keys cannot be recovered—they must be revoked and re-issued.
        Plaintext token secrets are never persisted and disappear after navigating or reloading.
      </div>
    </div>
  </div>

  <!-- API Keys Table -->
  <div style="max-width: 1180px; margin: 0 auto;">
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Access Credentials</p>
          <h2>Configured API Tokens</h2>
        </div>
        <span class="badge neutral">{keys.length} keys total</span>
      </div>

      <div class="table-wrap">
        <table class="data-table" aria-label="Configured API keys table">
          <thead>
            <tr>
              <th scope="col">Key Name</th>
              <th scope="col">Prefix</th>
              <th scope="col">Scopes</th>
              <th scope="col">Created</th>
              <th scope="col">Last Used</th>
              <th scope="col">Status</th>
              <th scope="col" style="text-align: right;">Action</th>
            </tr>
          </thead>
          <tbody>
            {#each keys as key}
              <tr>
                <td>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <KeyRound size={15} style="color: var(--accent); flex-shrink: 0;" />
                    <strong style="color: var(--text);">{key.name}</strong>
                  </div>
                </td>
                <td>
                  <code title="Only token prefix and SHA-256 hash digest are retained">{key.prefix}••••</code>
                </td>
                <td>
                  <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                    {#each key.scopes as scope}
                      <span class="badge neutral" style="font-size: 10px; height: 20px; padding: 0 6px;">
                        {scope}
                      </span>
                    {/each}
                  </div>
                </td>
                <td style="font-size: 12px; white-space: nowrap;">{key.createdAt}</td>
                <td style="font-size: 12px; color: var(--muted); white-space: nowrap;">{key.lastUsedAt || 'Never'}</td>
                <td>
                  {#if key.status === 'active'}
                    <span class="badge safe">Active</span>
                  {:else}
                    <span class="badge danger">Revoked</span>
                  {/if}
                </td>
                <td style="text-align: right;">
                  {#if key.status === 'active'}
                    <form method="POST" action="?/revokeKey" style="display: inline;">
                      {#if page.data.csrfToken}
                        <input type="hidden" name="csrfToken" value={page.data.csrfToken} />
                      {/if}
                      <input type="hidden" name="keyId" value={key.id} />
                      <button
                        type="submit"
                        class="button danger sm"
                        aria-label="Revoke key {key.name}"
                      >
                        <Trash2 size={13} />
                        <span>Revoke</span>
                      </button>
                    </form>
                  {:else}
                    <span style="color: var(--faint); font-size: 11px;">Disabled</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  </div>
</AppShell>

<!-- Create API Key Modal -->
<Modal
  open={createModalOpen}
  title="Generate New API Key"
  description="Create a scoped access token for background automation or MCP clients."
  onclose={() => (createModalOpen = false)}
>
  <form method="POST" action="?/createKey" id="create-api-key-form">
    {#if page.data.csrfToken}
      <input type="hidden" name="csrfToken" value={page.data.csrfToken} />
    {/if}
    <div class="form-group">
      <label for="new-key-name" class="form-label">
        <span>Key Label / Description</span>
      </label>
      <input
        id="new-key-name"
        name="name"
        type="text"
        bind:value={newKeyName}
        placeholder="e.g. Local MCP Agent"
        class="form-input"
        required
      />
      <span class="form-hint">A recognizable name identifying the machine or application.</span>
    </div>

    <div class="form-group">
      <span class="form-label">Granted Scopes</span>
      <span class="form-hint" style="margin-bottom: 8px;">Follow principle of least privilege. Allowed scopes: activity:read, activity:detail, operations:read.</span>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        {#each availableScopes as sc}
          <label class="form-checkbox-label">
            <input
              type="checkbox"
              name="scopes"
              value={sc.id}
              checked={newKeyScopes.includes(sc.id)}
              onchange={() => toggleScope(sc.id)}
            />
            <div>
              <strong style="display: block; font-size: 12px; font-family: ui-monospace, monospace;">{sc.label}</strong>
              <small style="color: var(--faint); font-size: 11px;">{sc.desc}</small>
            </div>
          </label>
        {/each}
      </div>
    </div>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="button ghost"
      onclick={() => (createModalOpen = false)}
    >
      Cancel
    </button>
    <button
      type="submit"
      form="create-api-key-form"
      class="button primary"
      disabled={!newKeyName.trim() || newKeyScopes.length === 0}
      title="Generate API key"
    >
      Generate Key
    </button>
  {/snippet}
</Modal>

{#if form?.secret}
  <Modal
    open={true}
    title="Save Your API Key"
    description="This token will NEVER be shown again. Store it securely in your secrets manager."
    onclose={() => {}}
  >
    <div class="notice warning" style="margin: 0 0 16px;">
      <ShieldAlert size={18} />
      <span>Copy this secret now. Work Times stores only a SHA-256 hash and cannot retrieve this value later.</span>
    </div>

    <div class="form-group">
      <span class="form-label">Generated Secret Token</span>
      <div class="secret-key-display">
        <span>{form.secret}</span>
        <button
          type="button"
          class="button secondary sm"
          onclick={() => {
            if (form?.secret) {
              navigator.clipboard.writeText(form.secret);
              copied = true;
              setTimeout(() => { copied = false; }, 3000);
            }
          }}
          aria-label="Copy secret token to clipboard"
        >
          {#if copied}
            <Check size={13} style="color: var(--work);" />
            <span style="color: var(--work);">Copied</span>
          {:else}
            <Copy size={13} />
            <span>Copy</span>
          {/if}
        </button>
      </div>
      <span class="form-hint" style="margin-top: 6px;">Format: wtk_&lt;base64url random bytes&gt;</span>
    </div>
  </Modal>
{/if}
