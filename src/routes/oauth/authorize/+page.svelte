<script lang="ts">
  import { Check, Globe, Lock, ShieldCheck, Terminal, User, X } from '@lucide/svelte';

  interface PageData {
    client: {
      clientId: string;
      name: string;
      publicClient: boolean;
    };
    redirectUri: string;
    resource: string;
    scopes: string[];
    codeChallenge: string;
    codeChallengeMethod: string;
    state: string | null;
    csrfToken: string;
    adminUsername: string;
  }

  interface ActionData {
    error?: string;
    [key: string]: unknown;
  }

  let { data, form }: { data: PageData; form?: ActionData | null } = $props();

  const scopeDescriptions: Record<string, { label: string; desc: string }> = {
    'activity:read': {
      label: 'Read Work Activity Summaries',
      desc: 'View aggregated timelines, category distributions, languages, and project hours.'
    },
    'activity:detail': {
      label: 'Access Detailed Heartbeats & Telemetry',
      desc: 'Read fine-grained file paths, branch telemetry, commit hashes, and machine metrics.'
    },
    'operations:read': {
      label: 'Read System & Sync Engine Operations',
      desc: 'Monitor background sync jobs, importer health, and operational diagnostics.'
    }
  };
</script>

<svelte:head>
  <title>Authorize {data.client.name} — Work Times</title>
</svelte:head>

<div class="consent-wrapper">
  <div class="consent-card">
    <div class="consent-header">
      <div class="brand-mark" aria-hidden="true">W</div>
      <div>
        <p class="eyebrow">Federated Authorization</p>
        <h1>Authorize Application</h1>
      </div>
    </div>

    <div class="client-banner">
      <div class="client-avatar">
        <Terminal size={22} />
      </div>
      <div class="client-details">
        <h2 class="client-name">{data.client.name}</h2>
        <div class="client-meta">
          <span class="badge {data.client.publicClient ? 'neutral' : 'accent'}">
            {data.client.publicClient ? 'Public Client' : 'Confidential Service'}
          </span>
          <span class="client-id" title={data.client.clientId}>{data.client.clientId}</span>
        </div>
      </div>
    </div>

    <p class="consent-notice">
      The application above is requesting scoped access to your private Work Times archive.
    </p>

    {#if form?.error}
      <div class="notice danger" role="alert">
        <Lock size={16} />
        <span>{form.error}</span>
      </div>
    {/if}

    <section class="permissions-section" aria-label="Requested permissions">
      <h3 class="section-title">Requested Permissions</h3>
      <ul class="scope-list">
        {#each data.scopes as scope}
          <li class="scope-item">
            <div class="scope-icon">
              <Check size={16} />
            </div>
            <div class="scope-text">
              <span class="scope-title">{scopeDescriptions[scope]?.label ?? scope}</span>
              <p class="scope-desc">{scopeDescriptions[scope]?.desc ?? 'Custom application scope permission.'}</p>
              <code class="scope-code">{scope}</code>
            </div>
          </li>
        {/each}
      </ul>
    </section>

    <div class="meta-details">
      <div class="meta-row">
        <span class="meta-label">Protected Resource</span>
        <code class="meta-value">{data.resource}</code>
      </div>
      <div class="meta-row">
        <span class="meta-label">Redirect Destination</span>
        <code class="meta-value">{data.redirectUri}</code>
      </div>
      <div class="meta-row">
        <span class="meta-label">Authenticated Operator</span>
        <span class="meta-value operator-badge">
          <User size={13} />
          {data.adminUsername}
        </span>
      </div>
    </div>

    <!-- Approval & Denial Forms -->
    <div class="actions-wrapper">
      <form method="POST" action="?/approve" class="action-form">
        <input type="hidden" name="csrfToken" value={data.csrfToken} />
        <input type="hidden" name="client_id" value={data.client.clientId} />
        <input type="hidden" name="redirect_uri" value={data.redirectUri} />
        <input type="hidden" name="response_type" value="code" />
        <input type="hidden" name="resource" value={data.resource} />
        <input type="hidden" name="scope" value={data.scopes.join(' ')} />
        <input type="hidden" name="code_challenge" value={data.codeChallenge} />
        <input type="hidden" name="code_challenge_method" value={data.codeChallengeMethod} />
        {#if data.state}
          <input type="hidden" name="state" value={data.state} />
        {/if}
        <button type="submit" name="action" value="approve" class="button primary approve-button">
          <ShieldCheck size={16} />
          <span>Approve & Authorize</span>
        </button>
      </form>

      <form method="POST" action="?/deny" class="action-form">
        <input type="hidden" name="csrfToken" value={data.csrfToken} />
        <input type="hidden" name="client_id" value={data.client.clientId} />
        <input type="hidden" name="redirect_uri" value={data.redirectUri} />
        {#if data.state}
          <input type="hidden" name="state" value={data.state} />
        {/if}
        <button type="submit" name="action" value="deny" class="button secondary deny-button">
          <X size={16} />
          <span>Deny Access</span>
        </button>
      </form>
    </div>

    <div class="consent-footer">
      <p>
        OAuth 2.1 authorization with strict PKCE (S256). You can revoke access at any time from the administrator console.
      </p>
    </div>
  </div>
</div>

<style>
  .consent-wrapper {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 32px 20px;
    background: radial-gradient(circle at top, #181814 0%, #0c0c0b 60%);
  }

  .consent-card {
    width: 100%;
    max-width: 520px;
    padding: 32px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--panel);
    box-shadow: var(--shadow-lg);
  }

  .consent-header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 20px;
  }

  .consent-header h1 {
    font-size: 22px;
    font-weight: 600;
  }

  .client-banner {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px;
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    margin-bottom: 20px;
  }

  .client-avatar {
    width: 44px;
    height: 44px;
    border-radius: var(--radius-sm);
    background: var(--bg-card);
    border: 1px solid var(--border);
    display: grid;
    place-items: center;
    color: var(--accent);
    flex-shrink: 0;
  }

  .client-details {
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow: hidden;
  }

  .client-name {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
  }

  .client-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .client-id {
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .consent-notice {
    font-size: 13px;
    color: var(--muted);
    line-height: 1.5;
    margin: 0 0 20px;
  }

  .section-title {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--faint);
    font-weight: 600;
    margin-bottom: 12px;
  }

  .scope-list {
    list-style: none;
    padding: 0;
    margin: 0 0 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .scope-item {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .scope-icon {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: rgba(34, 197, 94, 0.15);
    color: #4ade80;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .scope-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .scope-title {
    font-size: 13px;
    font-weight: 600;
  }

  .scope-desc {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.4;
    margin: 0 0 4px;
  }

  .scope-code {
    font-size: 11px;
    color: var(--faint);
  }

  .meta-details {
    padding: 14px 16px;
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 24px;
  }

  .meta-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    gap: 12px;
  }

  .meta-label {
    color: var(--faint);
    flex-shrink: 0;
  }

  .meta-value {
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .operator-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--text);
  }

  .actions-wrapper {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 20px;
  }

  .action-form {
    margin: 0;
  }

  .approve-button,
  .deny-button {
    width: 100%;
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 600;
  }

  .deny-button:hover {
    color: #f87171;
    border-color: rgba(239, 68, 68, 0.4);
  }

  .consent-footer {
    padding-top: 16px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--faint);
    line-height: 1.5;
    text-align: center;
  }
</style>
