<script lang="ts">
  import { Eye, EyeOff, Lock, ShieldCheck, User } from '@lucide/svelte';

  interface ActionData {
    error?: string;
    message?: string;
    [key: string]: unknown;
  }

  let { form }: { form?: ActionData | null } = $props();

  let username = $state('admin');
  let password = $state('');
  let showPassword = $state(false);
</script>

<svelte:head>
  <title>Sign in — Work Times</title>
</svelte:head>

<a href="#login-content" class="skip-link">Skip to login</a>

<main id="login-content" class="login-wrapper">
  <div class="login-card">
    <div class="login-header">
      <div class="brand-mark" aria-hidden="true">W</div>
      <div>
        <p class="eyebrow">Single-Operator Security</p>
        <h1>Work Times Archive</h1>
      </div>
    </div>

    <p class="login-desc">
      Authenticate to inspect activity telemetry, manage classification rules, and control
      confidential API keys.
    </p>

    {#if form?.error || form?.message}
      <div class="notice danger" role="alert">
        <Lock size={16} />
        <span>{form.error || form.message}</span>
      </div>
    {/if}

    <form method="POST" class="login-form">
      <div class="form-group">
        <label for="username" class="form-label">
          <span>Username</span>
        </label>
        <div class="input-with-icon">
          <User size={16} class="input-icon" />
          <input
            id="username"
            name="username"
            type="text"
            required
            autocomplete="username"
            bind:value={username}
            placeholder="admin"
            class="form-input"
            style="padding-left: 36px;"
          />
        </div>
      </div>

      <div class="form-group">
        <label for="password" class="form-label">
          <span>Master Password</span>
          <span class="form-hint">scrypt verified</span>
        </label>
        <div class="input-with-icon">
          <Lock size={16} class="input-icon" />
          <input
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            required
            autocomplete="current-password"
            bind:value={password}
            placeholder="••••••••••••"
            class="form-input"
            style="padding-left: 36px; padding-right: 40px;"
          />
          <button
            type="button"
            class="password-toggle"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            onclick={() => (showPassword = !showPassword)}
          >
            {#if showPassword}
              <EyeOff size={16} />
            {:else}
              <Eye size={16} />
            {/if}
          </button>
        </div>
      </div>

      <button
        type="submit"
        class="button primary login-button"
      >
        <ShieldCheck size={16} />
        <span>Sign In to Archive</span>
      </button>
    </form>

    <div class="login-footer">
      <div class="security-badge">
        <span class="status-dot"></span>
        <span>Local single-tenant storage · Scoped access via authenticated MCP</span>
      </div>
    </div>
  </div>
</main>

<style>
  .login-wrapper {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: radial-gradient(circle at top, #181814 0%, #0c0c0b 60%);
  }

  .login-card {
    width: 100%;
    max-width: 420px;
    padding: 34px 32px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--panel);
    box-shadow: var(--shadow-lg);
  }

  .login-header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 12px;
  }

  .login-header h1 {
    font-size: 22px;
    font-weight: 600;
  }

  .login-desc {
    margin: 0 0 24px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
  }

  .login-form {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .input-with-icon {
    position: relative;
    display: flex;
    align-items: center;
  }

  :global(.input-icon) {
    position: absolute;
    left: 12px;
    color: var(--faint);
    pointer-events: none;
  }

  .password-toggle {
    position: absolute;
    right: 8px;
    border: 0;
    background: transparent;
    color: var(--faint);
    padding: 6px;
    cursor: pointer;
    border-radius: var(--radius-xs);
    display: grid;
    place-items: center;
  }

  .password-toggle:hover {
    color: var(--text);
  }

  .login-button {
    width: 100%;
    padding: 11px;
    font-size: 14px;
    margin-top: 10px;
  }

  .login-footer {
    margin-top: 26px;
    padding-top: 18px;
    border-top: 1px solid var(--border);
  }

  .security-badge {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--faint);
    line-height: 1.4;
  }
</style>
