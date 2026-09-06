<script lang="ts">
  import { page } from '$app/state';
  import AppShell from '$lib/components/AppShell.svelte';
  import MetricCard from '$lib/components/MetricCard.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import {
    AlertTriangle,
    Check,
    Copy,
    Globe,
    Plus,
    ShieldCheck,
    Terminal,
    Trash2
  } from '@lucide/svelte';

  interface ActionData {
    clientSecret?: string;
    clientId?: string;
    error?: string;
    [key: string]: unknown;
  }

  interface OAuthClientItem {
    id: string;
    clientId: string; // e.g. "wt_client_cli_8f90"
    name: string;
    clientType: 'public' | 'confidential';
    redirectUris: string[];
    scopes: string[];
    createdAt: string;
    status: 'active' | 'revoked';
  }

  let { data, form }: { data: { clients: OAuthClientItem[] }; form?: ActionData | null } = $props();

  let clients = $derived(data.clients);

  // Create Client Modal State
  let createModalOpen = $state(false);
  let clientName = $state('');
  let clientType = $state<'public' | 'confidential'>('public');
  let redirectUrisText = $state('http://127.0.0.1:8085/callback');
  let selectedScopes = $state<string[]>(['activity:read']);

  const standardScopes = [
    { id: 'activity:read', label: 'activity:read', desc: 'Read timeline summaries and hours' },
    { id: 'activity:detail', label: 'activity:detail', desc: 'Access fine-grained heartbeats, lines, and AI telemetry' },
    { id: 'operations:read', label: 'operations:read', desc: 'Read sync engine state and telemetry status' }
  ];

  let copied = $state(false);

  function toggleScope(scopeId: string) {
    if (selectedScopes.includes(scopeId)) {
      selectedScopes = selectedScopes.filter((s) => s !== scopeId);
    } else {
      selectedScopes = [...selectedScopes, scopeId];
    }
  }
</script>

<svelte:head>
  <title>OAuth Clients — Work Times</title>
</svelte:head>

<AppShell>
  <header class="page-header">
    <div>
      <p class="eyebrow">Federated Authorization</p>
      <h1>OAuth 2.1 Clients & PKCE.</h1>
      <p class="lede">
        Manage authorized client applications with strict PKCE (S256) requirements and loopback redirect URI controls.
        Client secrets are shown once upon registration, are never persisted in plaintext, and disappear after navigating or reloading.
      </p>
    </div>
    <div class="header-actions">
      <button
        type="button"
        class="button primary"
        onclick={() => (createModalOpen = true)}
      >
        <Plus size={15} />
        <span>Register OAuth Client</span>
      </button>
    </div>
  </header>

  <!-- Metrics -->
  <section class="metrics" aria-label="OAuth client statistics">
    <MetricCard
      label="Registered Clients"
      value={clients.length}
      subtext="Public CLI & Confidential services"
      badge="OAuth 2.1"
      badgeVariant="neutral"
    />
    <MetricCard
      label="PKCE Enforcement"
      value="Strict S256"
      subtext="Plain code challenge method is rejected"
      badge="Mandatory"
      badgeVariant="safe"
    />
    <MetricCard
      label="Redirect URI Matching"
      value="Exact Match"
      subtext="Exact registered match required for all URIs"
      badge="Enforced"
      badgeVariant="work"
    />
  </section>

  <!-- PKCE and Security Requirement Banner -->
  <div style="max-width: 1180px; margin: 0 auto 20px;">
    <div class="notice info">
      <ShieldCheck size={18} />
      <div>
        <strong style="display: block; margin-bottom: 2px;">OAuth 2.1 Security & PKCE Expectations:</strong>
        All authorization code flows strictly require Proof Key for Code Exchange (RFC 7636) with SHA-256
        (<code>code_challenge_method=S256</code>). Public clients (desktop, CLI, SPA) do not have client secrets.
        Confidential client secrets are transiently displayed <strong>once</strong> at registration so the operator can copy them, are never persisted in plaintext, and disappear after navigating or reloading.
      </div>
    </div>
  </div>

  <!-- Clients List Table -->
  <div style="max-width: 1180px; margin: 0 auto;">
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Authorized Applications</p>
          <h2>Client Registrations</h2>
        </div>
        <span class="badge neutral">{clients.length} applications</span>
      </div>

      <div class="table-wrap">
        <table class="data-table" aria-label="OAuth 2.1 client applications table">
          <thead>
            <tr>
              <th scope="col">Client Name & Type</th>
              <th scope="col">Client ID</th>
              <th scope="col">Allowed Redirect URIs</th>
              <th scope="col">Scopes</th>
              <th scope="col">Status</th>
              <th scope="col" style="text-align: right;">Action</th>
            </tr>
          </thead>
          <tbody>
            {#each clients as client}
              <tr>
                <td>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    {#if client.clientType === 'public'}
                      <Terminal size={16} style="color: var(--personal); flex-shrink: 0;" />
                    {:else}
                      <Globe size={16} style="color: var(--accent); flex-shrink: 0;" />
                    {/if}
                    <div>
                      <strong style="display: block; color: var(--text);">{client.name}</strong>
                      <small style="color: var(--faint); font-size: 11px;">
                        {client.clientType === 'public' ? 'Public (PKCE required, no secret)' : 'Confidential (Server backend)'}
                      </small>
                    </div>
                  </div>
                </td>
                <td>
                  <code>{client.clientId}</code>
                </td>
                <td>
                  <div style="display: flex; flex-direction: column; gap: 3px; max-width: 280px;">
                    {#each client.redirectUris as uri}
                      <code style="font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        {uri}
                      </code>
                    {/each}
                  </div>
                </td>
                <td>
                  <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                    {#each client.scopes as scope}
                      <span class="badge neutral" style="font-size: 10px; height: 20px; padding: 0 6px;">
                        {scope}
                      </span>
                    {/each}
                  </div>
                </td>
                <td>
                  {#if client.status === 'active'}
                    <span class="badge safe">Active</span>
                  {:else}
                    <span class="badge danger">Revoked</span>
                  {/if}
                </td>
                <td style="text-align: right;">
                  {#if client.status === 'active'}
                    <form method="POST" action="?/revokeClient" style="display: inline;">
                      {#if page.data.csrfToken}
                        <input type="hidden" name="csrfToken" value={page.data.csrfToken} />
                      {/if}
                      <input type="hidden" name="clientId" value={client.id} />
                      <button
                        type="submit"
                        class="button danger sm"
                        aria-label="Revoke client {client.name}"
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

<!-- Register Client Modal -->
<Modal
  open={createModalOpen}
  title="Register OAuth 2.1 Client"
  description="Configure an application identifier, client type, and permitted redirect destinations."
  onclose={() => (createModalOpen = false)}
>
  <form method="POST" action="?/registerClient" id="create-oauth-client-form">
    {#if page.data.csrfToken}
      <input type="hidden" name="csrfToken" value={page.data.csrfToken} />
    {/if}
    <div class="form-group">
      <label for="client-name-input" class="form-label">
        <span>Application Name</span>
      </label>
      <input
        id="client-name-input"
        name="name"
        type="text"
        bind:value={clientName}
        placeholder="e.g. Local Desktop Widget"
        class="form-input"
        required
      />
    </div>

    <div class="form-group">
      <span class="form-label">Client Type</span>
      <input type="hidden" name="clientType" value={clientType} />
      <div style="display: flex; gap: 10px; margin-top: 4px;">
        <button
          type="button"
          class="button {clientType === 'public' ? 'primary' : 'secondary'}"
          style="flex: 1;"
          onclick={() => (clientType = 'public')}
        >
          Public (CLI / Native / SPA)
        </button>
        <button
          type="button"
          class="button {clientType === 'confidential' ? 'primary' : 'secondary'}"
          style="flex: 1;"
          onclick={() => (clientType = 'confidential')}
        >
          Confidential (Server)
        </button>
      </div>
      <span class="form-hint" style="margin-top: 6px;">
        {clientType === 'public'
          ? 'Public clients cannot keep secrets and rely exclusively on PKCE (S256).'
          : 'Confidential clients receive a one-time client secret and authenticate back-channel.'}
      </span>
    </div>

    <div class="form-group">
      <label for="redirect-uris-input" class="form-label">
        <span>Allowed Redirect URIs</span>
        <span class="form-hint">One per line</span>
      </label>
      <textarea
        id="redirect-uris-input"
        name="redirectUris"
        bind:value={redirectUrisText}
        rows={3}
        class="form-textarea"
        placeholder="http://127.0.0.1:8085/callback&#10;https://my-app.com/oauth/callback"
        required
      ></textarea>
      <span class="form-hint">
        Exact registered match required for all URIs.
      </span>
    </div>

    <div class="form-group">
      <span class="form-label">Permitted Scopes</span>
      <span class="form-hint" style="margin-bottom: 8px;">Follow principle of least privilege. Allowed scopes: activity:read, activity:detail, operations:read.</span>
      <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 4px;">
        {#each standardScopes as sc}
          <label class="form-checkbox-label">
            <input
              type="checkbox"
              name="scopes"
              value={sc.id}
              checked={selectedScopes.includes(sc.id)}
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
      form="create-oauth-client-form"
      class="button primary"
      disabled={!clientName.trim() || !redirectUrisText.trim() || selectedScopes.length === 0}
      title="Register OAuth client"
    >
      Register Client
    </button>
  {/snippet}
</Modal>

{#if form?.clientSecret}
  <Modal
    open={true}
    title="Save Confidential Client Secret"
    description="This client secret will NEVER be displayed again. Only its hashed representation is stored."
    onclose={() => {}}
  >
    <div class="notice warning" style="margin: 0 0 16px;">
      <AlertTriangle size={18} />
      <span>Copy your client secret now. Plaintext values are never persisted or retrievable and disappear after navigating or reloading.</span>
    </div>

    {#if form.clientId}
      <div class="form-group">
        <span class="form-label">Client ID</span>
        <code>{form.clientId}</code>
      </div>
    {/if}

    <div class="form-group" style="margin-top: 10px;">
      <span class="form-label">Client Secret (One-Time Display)</span>
      <div class="secret-key-display">
        <span>{form.clientSecret}</span>
        <button
          type="button"
          class="button secondary sm"
          onclick={() => {
            if (form?.clientSecret) {
              navigator.clipboard.writeText(form.clientSecret);
              copied = true;
              setTimeout(() => {
                copied = false;
              }, 3000);
            }
          }}
          aria-label="Copy client secret"
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
    </div>
  </Modal>
{/if}
