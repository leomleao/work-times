<script lang="ts">
  import { onDestroy } from 'svelte';
  import AppShell from '$lib/components/AppShell.svelte';
  import MetricCard from '$lib/components/MetricCard.svelte';
  import type { PageData } from './$types';
  import type { McpClientType, McpAuthMethod } from '$lib/server/mcp/config-recipes';
  import {
    AlertTriangle,
    Check,
    Copy,
    ExternalLink,
    Globe,
    Info,
    KeyRound,
    Lock,
    Terminal
  } from '@lucide/svelte';

  let { data }: { data: PageData } = $props();

  let selectedClient = $state<McpClientType>('codex');
  let selectedAuth = $state<McpAuthMethod>('bearer');

  // Active recipe derived from server-provided recipes
  let currentRecipe = $derived(data.recipes[selectedClient][selectedAuth]);

  // Copy status management
  let copyState = $state<'idle' | 'snippet-copied' | 'endpoint-copied' | 'command-copied'>('idle');
  let copyError = $state<string | null>(null);
  let liveAnnouncement = $state<string>('');
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  onDestroy(() => {
    if (copyTimer) {
      clearTimeout(copyTimer);
      copyTimer = null;
    }
  });

  async function handleCopy(text: string, type: 'snippet' | 'endpoint' | 'command') {
    copyError = null;
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.writeText) {
        throw new Error('Clipboard API unavailable in this browser context');
      }
      await navigator.clipboard.writeText(text);

      if (type === 'snippet') {
        copyState = 'snippet-copied';
        liveAnnouncement = `${currentRecipe.clientName} configuration snippet copied to clipboard`;
      } else if (type === 'endpoint') {
        copyState = 'endpoint-copied';
        liveAnnouncement = 'MCP endpoint URL copied to clipboard';
      } else {
        copyState = 'command-copied';
        liveAnnouncement = 'CLI command copied to clipboard';
      }

      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyState = 'idle';
      }, 2500);
    } catch (err) {
      copyState = 'idle';
      copyError = 'Unable to copy automatically. Please select and copy the text manually from the code block below.';
      liveAnnouncement = copyError;
    }
  }

  const clients: Array<{ id: McpClientType; name: string; desc: string }> = [
    { id: 'codex', name: 'Codex CLI', desc: 'OpenAI Codex CLI using TOML configuration' },
    { id: 'claude-code', name: 'Claude Code', desc: 'Claude Code CLI via .mcp.json HTTP configuration' },
    { id: 'claude-desktop', name: 'Claude Desktop', desc: 'Remote MCP Connector with OAuth 2.0' },
    { id: 'generic', name: 'Generic MCP Client', desc: 'Standard streamable HTTP JSON-RPC 2.0' }
  ];

  const authMethods: Array<{ id: McpAuthMethod; name: string; desc: string }> = [
    { id: 'bearer', name: 'API Key (Bearer Token)', desc: 'Static token via WORK_TIMES_API_KEY' },
    { id: 'oauth', name: 'OAuth 2.0', desc: 'RFC 9728 discovery on /mcp (Keys optional)' }
  ];

  function handleClientKeydown(e: KeyboardEvent, index: number) {
    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      nextIndex = (index + 1) % clients.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      nextIndex = (index - 1 + clients.length) % clients.length;
    }
    if (nextIndex !== null) {
      selectedClient = clients[nextIndex].id;
      if (typeof document !== 'undefined') {
        const radios = document.querySelectorAll<HTMLInputElement>('input[name="mcp-client"]');
        radios[nextIndex]?.focus();
      }
    }
  }

  function handleAuthKeydown(e: KeyboardEvent, index: number) {
    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      nextIndex = (index + 1) % authMethods.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      nextIndex = (index - 1 + authMethods.length) % authMethods.length;
    }
    if (nextIndex !== null) {
      selectedAuth = authMethods[nextIndex].id;
      if (typeof document !== 'undefined') {
        const radios = document.querySelectorAll<HTMLInputElement>('input[name="mcp-auth"]');
        radios[nextIndex]?.focus();
      }
    }
  }
</script>

<svelte:head>
  <title>MCP Configuration — Work Times</title>
</svelte:head>

<AppShell>
  <!-- Accessible Live Announcement for Screen Readers -->
  <div class="sr-only" role="status" aria-live="polite">
    {liveAnnouncement}
  </div>

  <header class="page-header">
    <div>
      <p class="eyebrow">Agent Integrations</p>
      <h1>Model Context Protocol (MCP) Setup.</h1>
      <p class="lede">
        Connect AI coding assistants and automation agents to your private activity archive via the streamable
        HTTP <code>/mcp</code> endpoint. Choose your client and authentication method to generate exact, copyable
        configuration snippets.
      </p>
    </div>
    <div class="header-actions">
      <a href="/admin/api-keys" class="button secondary">
        <KeyRound size={15} />
        <span>Manage API Keys</span>
      </a>
      <a href="/admin/oauth-clients" class="button secondary">
        <Globe size={15} />
        <span>OAuth Clients</span>
      </a>
    </div>
  </header>

  <!-- Metrics / Quick Status -->
  <section class="metrics" aria-label="MCP endpoint and credential status summary">
    <MetricCard
      label="MCP Endpoint"
      value="/mcp"
      subtext={data.endpoint}
      badge="Streamable HTTP"
      badgeVariant="safe"
    />
    <MetricCard
      label="Active API Keys"
      value={data.activeKeysCount}
      subtext="Keys with activity:read scope"
      badge={data.hasActiveKey ? 'Ready' : 'Keys Optional for OAuth'}
      badgeVariant={data.hasActiveKey ? 'work' : 'neutral'}
    />
    <MetricCard
      label="Authentication Modes"
      value="Dual Auth"
      subtext="Bearer token or RFC 9728 OAuth"
      badge="Work-Only Filtered"
      badgeVariant="safe"
    />
  </section>

  <!-- Upstream vs Local OAuth Separation Notice -->
  <div class="notice-container">
    <div class="notice info" role="region" aria-label="OAuth architecture information">
      <Info size={17} />
      <div>
        <strong class="notice-title">OAuth Architecture & Credential Scopes:</strong>
        Work Times MCP OAuth provides local authorization for AI agent clients connecting to this archive's
        <code>/mcp</code> endpoint. It is strictly separate from the upstream WakaTime OAuth connection used
        for telemetry synchronization. <strong>API keys are optional for OAuth:</strong> you do not need to generate
        an API key to use OAuth-enabled clients.
      </div>
    </div>
  </div>

  <!-- Main Configuration Grid -->
  <div class="content-grid">
    <!-- Left Panel: Client & Recipe Generator -->
    <div class="panel">
      <div class="panel-heading">
        <div>
          <h2>Client Configuration Generator</h2>
          <p class="panel-subtitle">Select your client and preferred authentication protocol.</p>
        </div>
        <span class="badge accent">{currentRecipe.clientName}</span>
      </div>

      <div class="panel-body">
        <!-- Client Selector with Complete Keyboard Radio Behavior -->
        <fieldset class="form-group selector-group">
          <legend class="form-label">Select Client</legend>
          <div class="client-grid" role="radiogroup" aria-label="Select AI client">
            {#each clients as client, index}
              {@const isSelected = selectedClient === client.id}
              <label
                class="client-card"
                class:active={isSelected}
              >
                <input
                  type="radio"
                  name="mcp-client"
                  value={client.id}
                  checked={isSelected}
                  onchange={() => (selectedClient = client.id)}
                  onkeydown={(e) => handleClientKeydown(e, index)}
                  class="sr-only"
                />
                <div class="client-card-header">
                  <strong>{client.name}</strong>
                  {#if isSelected}
                    <span class="client-dot" aria-hidden="true"></span>
                  {/if}
                </div>
                <small>{client.desc}</small>
              </label>
            {/each}
          </div>
        </fieldset>

        <!-- Authentication Method Selector with Complete Keyboard Radio Behavior -->
        <fieldset class="form-group selector-group">
          <legend class="form-label">Authentication Method</legend>
          <div class="choice-group auth-choice" role="radiogroup" aria-label="Select authentication method">
            {#each authMethods as method, index}
              {@const isSelected = selectedAuth === method.id}
              <label
                class="choice-label"
                class:chosen-work={isSelected}
                class:chosen-none={!isSelected}
              >
                <input
                  type="radio"
                  name="mcp-auth"
                  value={method.id}
                  checked={isSelected}
                  onchange={() => (selectedAuth = method.id)}
                  onkeydown={(e) => handleAuthKeydown(e, index)}
                  class="sr-only"
                />
                <span>{method.name}</span>
              </label>
            {/each}
          </div>
          <p class="form-hint">
            {#if selectedAuth === 'bearer'}
              Requires an active API key with <code>activity:read</code> scope set in your environment as <code>WORK_TIMES_API_KEY</code>.
            {:else}
              Interactive OAuth 2.0 flow discovered automatically via RFC 9728. API keys are not required.
            {/if}
          </p>
        </fieldset>

        <!-- Endpoint URL Display Box with Copy Button -->
        <div class="endpoint-box">
          <div class="endpoint-info">
            <span class="endpoint-label">Server Endpoint URL</span>
            <code class="endpoint-url">{data.endpoint}</code>
          </div>
          <button
            type="button"
            class="button secondary sm copy-btn"
            aria-label="Copy MCP endpoint URL"
            onclick={() => handleCopy(data.endpoint, 'endpoint')}
          >
            {#if copyState === 'endpoint-copied'}
              <Check size={14} />
              <span>Copied URL</span>
            {:else}
              <Copy size={14} />
              <span>Copy URL</span>
            {/if}
          </button>
        </div>

        <!-- Recipe Warning (e.g. Claude Desktop Public Reachability) -->
        {#if currentRecipe.warning}
          <div class="notice warning" role="alert">
            <AlertTriangle size={17} />
            <div>
              <strong>Connector Notice:</strong>
              <span>{currentRecipe.warning}</span>
            </div>
          </div>
        {/if}

        <!-- Clipboard Failure Alert -->
        {#if copyError}
          <div class="notice danger" role="alert">
            <AlertTriangle size={17} />
            <div>
              <strong>Clipboard Error:</strong>
              <span>{copyError}</span>
            </div>
          </div>
        {/if}

        <!-- Copyable Configuration Snippet -->
        <div class="code-card">
          <div class="code-header">
            <div class="code-title">
              <Terminal size={14} />
              <span>{currentRecipe.filename ? currentRecipe.filename : `${currentRecipe.clientName} Configuration`}</span>
            </div>
            <button
              type="button"
              class="button primary sm copy-btn"
              aria-label={`Copy ${currentRecipe.clientName} configuration snippet`}
              onclick={() => handleCopy(currentRecipe.snippet, 'snippet')}
            >
              {#if copyState === 'snippet-copied'}
                <Check size={14} />
                <span>Copied Snippet!</span>
              {:else}
                <Copy size={14} />
                <span>Copy Snippet</span>
              {/if}
            </button>
          </div>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <pre
            class="code-block"
            role="region"
            tabindex="0"
            aria-label={`${currentRecipe.clientName} configuration snippet`}
          ><code>{currentRecipe.snippet}</code></pre>
        </div>

        <!-- Secondary Command (e.g. codex mcp login work-times) -->
        {#if currentRecipe.command}
          <div class="command-box">
            <div class="command-info">
              <span class="command-label">OAuth Login Command</span>
              <code class="command-snippet">{currentRecipe.command}</code>
            </div>
            <button
              type="button"
              class="button secondary sm copy-btn"
              aria-label="Copy OAuth login command"
              onclick={() => handleCopy(currentRecipe.command!, 'command')}
            >
              {#if copyState === 'command-copied'}
                <Check size={14} />
                <span>Copied</span>
              {:else}
                <Copy size={14} />
                <span>Copy Command</span>
              {/if}
            </button>
          </div>
        {/if}

        <!-- Setup Instructions -->
        <div class="instructions-section">
          <h3>Setup Instructions</h3>
          <ol class="instructions-list">
            {#each currentRecipe.instructions as instruction}
              <li>{instruction}</li>
            {/each}
          </ol>
        </div>

        <!-- Protocol Notes -->
        {#if currentRecipe.notes.length > 0}
          <div class="notes-section">
            <span class="notes-heading">Protocol Notes</span>
            <ul class="notes-list">
              {#each currentRecipe.notes as note}
                <li>{note}</li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
    </div>

    <!-- Right Column: Key Status & Operations Guidance -->
    <div class="sidebar-panels">
      <!-- Compact Key Status Card -->
      <div class="panel">
        <div class="panel-heading">
          <div>
            <h2>API Key Status</h2>
            <p class="panel-subtitle">Credentials with required <code>activity:read</code> scope.</p>
          </div>
          {#if data.hasActiveKey}
            <span class="badge safe">Active Key Ready</span>
          {:else}
            <span class="badge warning">No Active Key</span>
          {/if}
        </div>

        <div class="panel-body">
          {#if data.hasActiveKey}
            <p class="key-summary-text">
              Found <strong>{data.activeKeysCount}</strong> active key(s) possessing the required <code>activity:read</code> scope:
            </p>
            <div class="key-compact-list">
              {#each data.keys.filter((k) => k.isActive) as key}
                <div class="key-compact-item">
                  <div class="key-compact-main">
                    <strong>{key.name}</strong>
                    <code class="key-prefix-badge" title="Prefix is an identifier only">{key.prefix}…</code>
                  </div>
                  <small class="key-compact-expiry">
                    {#if key.expiresAt}
                      Expires {key.expiresAt.split('T')[0]}
                    {:else}
                      Does not expire
                    {/if}
                  </small>
                </div>
              {/each}
            </div>
          {:else}
            <div class="notice warning" style="margin: 0 0 16px;">
              <AlertTriangle size={16} />
              <div>
                <strong>No Active API Keys Found:</strong>
                Bearer token authentication requires an active key with <code>activity:read</code>.
                OAuth connections do not require an API key.
              </div>
            </div>
          {/if}

          <!-- Crucial Security Notice: Prefix Cannot Restore Key -->
          <div class="notice info" style="margin: 14px 0 16px;">
            <Lock size={15} />
            <div>
              <strong>Prefix Identity Standard:</strong>
              API key prefixes (e.g. <code>wtk_...</code>) are identifiers only. A prefix cannot be expanded, reversed, or restored
              into a full secret key.
            </div>
          </div>

          <!-- Replacement Key Guidance -->
          <div class="replacement-guidance">
            <span class="guidance-title">Lost Your API Key Secret?</span>
            <p class="guidance-text">
              Plaintext tokens are only displayed once upon creation. If you lost your secret, you cannot restore it
              from the prefix or hash. Generate a replacement key on the API Keys page:
            </p>
            <a href="/admin/api-keys" class="button secondary sm guidance-link">
              <KeyRound size={13} />
              <span>Go to API Keys & Issue Replacement</span>
            </a>
          </div>
        </div>
      </div>

      <!-- Operations & Deployment Guidance Panel -->
      <div class="panel" style="margin-top: 18px;">
        <div class="panel-heading">
          <div>
            <h2>Operations & Network Reachability</h2>
            <p class="panel-subtitle">Reverse-proxy protocol and origin configuration.</p>
          </div>
          <Globe size={16} />
        </div>

        <div class="panel-body">
          <p class="ops-text">
            The Work Times MCP boundary validates exact Host and Origin headers according to your configured <code>PUBLIC_URL</code>.
          </p>

          <ul class="ops-checklist">
            <li>
              <strong>Reverse-proxy origin:</strong> Ensure <code>PUBLIC_URL</code> matches your proxy's external scheme and domain without trailing paths or queries.
            </li>
            <li>
              <strong>Remote client access:</strong> Hosted clients (such as Claude Desktop Remote Connectors) originate from Anthropic cloud infrastructure and require public HTTPS reachability.
            </li>
            <li>
              <strong>Protocol streams:</strong> Streamable HTTP uses <code>POST /mcp</code> for JSON-RPC 2.0 messages and <code>GET /mcp</code> for SSE notification streams.
            </li>
          </ul>

          <div class="ops-footer">
            <a
              href="https://github.com/leomleao/work-times/blob/main/docs/OPERATIONS.md"
              class="button ghost sm ops-link"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Read Operations & Deployment Guide (OPERATIONS.md)"
            >
              <ExternalLink size={13} />
              <span>Read Operations & Deployment Guide (OPERATIONS.md)</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</AppShell>

<style>
  /* Page Layout & Container */
  .notice-container {
    max-width: 1180px;
    margin: 0 auto 20px;
  }
  .notice-container .notice {
    margin: 0;
  }
  .notice-title {
    display: block;
    margin-bottom: 3px;
  }

  .panel-subtitle {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 12px;
  }
  .panel-body {
    padding: 22px;
  }

  /* Client Selection Cards */
  .selector-group {
    border: none;
    padding: 0;
    margin-bottom: 20px;
  }
  .selector-group legend {
    padding: 0;
    margin-bottom: 10px;
  }
  .client-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
  }
  .client-card {
    text-align: left;
    padding: 12px 14px;
    background: var(--panel-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    cursor: pointer;
    transition: all 160ms ease;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 6px;
    position: relative;
    user-select: none;
  }
  .client-card:hover {
    border-color: var(--border-strong);
    background: var(--panel);
  }
  .client-card.active {
    border-color: var(--accent);
    background: var(--accent-soft);
    box-shadow: inset 2px 0 var(--accent);
  }
  .client-card:focus-within {
    border-color: var(--accent);
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .client-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .client-card-header strong {
    font-size: 13px;
    font-weight: 600;
  }
  .client-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }
  .client-card small {
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }

  /* Auth Choice Group */
  .auth-choice {
    display: flex;
    width: 100%;
    max-width: 420px;
    margin-top: 4px;
  }
  .choice-label {
    flex: 1;
    text-align: center;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    user-select: none;
    transition: all 140ms ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .choice-label:hover {
    color: var(--text);
    background: #1d1d19;
  }
  .choice-label.chosen-work {
    color: var(--work);
    background: var(--work-soft);
    box-shadow: 0 1px 4px rgb(0 0 0 / .3);
  }
  .choice-label.chosen-none {
    color: var(--text);
    background: var(--panel-raised);
  }
  .choice-label:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* Endpoint URL Box */
  .endpoint-box {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    background: var(--panel-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: 20px;
  }
  .endpoint-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .endpoint-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--faint);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .endpoint-url {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 13px;
    color: var(--work);
    word-break: break-all;
  }

  /* Code Snippet Card */
  .code-card {
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: #090908;
    overflow: hidden;
    margin-bottom: 20px;
  }
  .code-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: #11110f;
    border-bottom: 1px solid var(--border);
  }
  .code-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
  }
  .code-block {
    margin: 0;
    padding: 16px 18px;
    overflow-x: auto;
    white-space: pre;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 13px;
    line-height: 1.5;
    color: #f5f4ef;
    user-select: all;
    -webkit-user-select: all;
  }
  .code-block:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  /* Secondary Command Box */
  .command-box {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    background: #0d120f;
    border: 1px solid rgb(119 217 161 / 0.3);
    border-radius: var(--radius-sm);
    margin-bottom: 20px;
  }
  .command-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .command-label {
    font-size: 10px;
    font-weight: 700;
    color: var(--work);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .command-snippet {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 13px;
    color: #fff;
  }

  /* Instructions Section */
  .instructions-section {
    margin-top: 24px;
    border-top: 1px solid var(--border);
    padding-top: 18px;
  }
  .instructions-section h3 {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 12px;
  }
  .instructions-list {
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }
  .instructions-list li::marker {
    color: var(--accent);
    font-weight: 600;
  }

  /* Protocol Notes Section */
  .notes-section {
    margin-top: 18px;
    padding: 12px 14px;
    background: var(--panel-sunken);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
  .notes-heading {
    display: block;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--faint);
    margin-bottom: 8px;
  }
  .notes-list {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.4;
  }

  /* Right Sidebar Panels */
  .sidebar-panels {
    display: flex;
    flex-direction: column;
  }
  .key-summary-text {
    margin: 0 0 12px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }
  .key-compact-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 14px;
  }
  .key-compact-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 12px;
    background: var(--panel-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
  }
  .key-compact-main {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .key-compact-main strong {
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .key-prefix-badge {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11px;
    padding: 1px 5px;
    border-radius: 4px;
    background: #11110f;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .key-compact-expiry {
    font-size: 11px;
    color: var(--faint);
    white-space: nowrap;
  }

  /* Replacement Guidance Box */
  .replacement-guidance {
    padding: 14px;
    background: var(--panel-sunken);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-sm);
  }
  .guidance-title {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 4px;
  }
  .guidance-text {
    margin: 0 0 10px;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
  }
  .guidance-link {
    width: 100%;
    justify-content: center;
  }

  /* Operations Panel Styling */
  .ops-text {
    margin: 0 0 14px;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
  }
  .ops-checklist {
    margin: 0 0 18px;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
  }
  .ops-checklist strong {
    color: var(--text);
  }
  .ops-footer {
    border-top: 1px solid var(--border);
    padding-top: 14px;
  }
  .ops-link {
    width: 100%;
    justify-content: center;
    border: 1px solid var(--border-strong);
    color: var(--text);
  }

  /* Screen Reader Only Utility */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }

  /* Mobile and Responsive Media Queries */
  @media (max-width: 768px) {
    .client-grid {
      grid-template-columns: 1fr;
    }
    .endpoint-box, .command-box {
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
    }
    .copy-btn {
      width: 100%;
      justify-content: center;
    }
    .auth-choice {
      max-width: 100%;
    }
  }
</style>
