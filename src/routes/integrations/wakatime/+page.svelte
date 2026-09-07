<script lang="ts">
  import { ArrowRight, CheckCircle2, Database, KeyRound, LockKeyhole, ShieldCheck, Unplug } from '@lucide/svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form?: ActionData | null } = $props();
</script>

<svelte:head>
  <title>Connect WakaTime — Work Times</title>
  <meta name="description" content="Connect WakaTime to a private Work Times archive using read-only OAuth access." />
</svelte:head>

<main class="integration-shell">
  <section class="integration-card">
    <div class="brand-row">
      <div class="brand-mark" aria-hidden="true">W</div>
      <div>
        <p class="eyebrow">Private activity archive</p>
        <h1>Connect WakaTime</h1>
      </div>
    </div>

    <p class="intro">
      Work Times imports your coding activity into your own SQLite database, then lets you classify
      it as work, personal, or unclassified. The connection is read-only and can be revoked here.
    </p>

    {#if data.result}
      <div class="notice {data.result.tone}" role="status">{data.result.text}</div>
    {/if}
    {#if form?.error}
      <div class="notice danger" role="alert">{form.error}</div>
    {/if}

    <div class="trust-grid">
      <article>
        <ShieldCheck size={19} />
        <div><strong>Read-only access</strong><span>No heartbeat, rule, or account writes.</span></div>
      </article>
      <article>
        <LockKeyhole size={19} />
        <div><strong>Encrypted tokens</strong><span>OAuth tokens stay server-side in SQLite.</span></div>
      </article>
      <article>
        <Database size={19} />
        <div><strong>Locally owned data</strong><span>Your archive remains on your home server.</span></div>
      </article>
    </div>

    <div class="connection-panel">
      <div>
        <span class="status-line">
          <span class="status-dot" class:warning={!data.status.connected}></span>
          {data.status.connected ? 'Connected' : 'Not connected'}
        </span>
        <small>{data.status.connected ? 'Ready for authenticated API reads' : 'Authorization is still required'}</small>
      </div>

      {#if data.status.connected && data.isAdmin}
        <form method="POST" action="?/disconnect">
          <input type="hidden" name="csrfToken" value={data.csrfToken ?? ''} />
          <button class="button danger" type="submit"><Unplug size={15} /> Disconnect</button>
        </form>
      {:else if data.status.appConfigured && data.status.encryptionReady}
        <a class="button primary" href="/oauth/wakatime/authorize">
          {data.isAdmin ? 'Authorize with WakaTime' : 'Sign in to connect'} <ArrowRight size={15} />
        </a>
      {:else if data.isAdmin}
        <span class="badge accent"><KeyRound size={13} /> Configuration required</span>
      {:else}
        <a class="button primary" href="/login?redirectTo=%2Fintegrations%2Fwakatime">Administrator sign in</a>
      {/if}
    </div>

    {#if data.isAdmin && (!data.status.appConfigured || !data.status.encryptionReady)}
      <div class="setup-box">
        <strong>Server configuration needed</strong>
        <p>Add <code>WAKATIME_OAUTH_CLIENT_ID</code> and <code>WAKATIME_OAUTH_CLIENT_SECRET</code>. A persistent <code>SESSION_SECRET</code> is also required to encrypt stored tokens.</p>
        <p>Authorized callback: <code>{data.status.callbackUrl}</code></p>
      </div>
    {/if}

    <div class="scope-box">
      <div><CheckCircle2 size={16} /><strong>Permissions requested</strong></div>
      <p>Heartbeats and file activity, daily summaries, plus machine, editor, and project lookup metadata.</p>
      <code>{data.status.scopes.join(' ')}</code>
    </div>
  </section>
</main>

<style>
  .integration-shell { min-height: 100vh; display: grid; place-items: center; padding: 32px 20px; background: radial-gradient(circle at 50% 0%, #1d1913 0, var(--bg) 48%); }
  .integration-card { width: min(720px, 100%); padding: clamp(26px, 5vw, 46px); border: 1px solid var(--border-strong); border-radius: 24px; background: color-mix(in srgb, var(--panel) 94%, transparent); box-shadow: var(--shadow-lg); }
  .brand-row { display: flex; align-items: center; gap: 14px; }
  h1 { font-size: clamp(30px, 6vw, 48px); }
  .intro { margin: 22px 0; color: var(--muted); line-height: 1.65; }
  .trust-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 22px 0; }
  .trust-grid article { display: flex; gap: 10px; padding: 14px; border: 1px solid var(--border); border-radius: 13px; background: var(--panel-sunken); color: var(--work); }
  .trust-grid strong, .trust-grid span { display: block; }
  .trust-grid strong { color: var(--text); font-size: 12px; }
  .trust-grid span { margin-top: 4px; color: var(--faint); font-size: 11px; line-height: 1.4; }
  .connection-panel { display: flex; justify-content: space-between; gap: 18px; align-items: center; padding: 18px; border: 1px solid var(--border-strong); border-radius: 15px; background: var(--panel-raised); }
  .status-line { display: flex; align-items: center; gap: 9px; font-weight: 650; }
  .connection-panel small { display: block; margin-top: 5px; color: var(--muted); }
  .setup-box, .scope-box { margin-top: 14px; padding: 16px 18px; border: 1px solid var(--border); border-radius: 13px; background: var(--panel-sunken); }
  .setup-box p, .scope-box p { color: var(--muted); font-size: 12px; line-height: 1.55; }
  .scope-box > div { display: flex; align-items: center; gap: 8px; }
  .scope-box code, .setup-box code { color: var(--text); overflow-wrap: anywhere; font-size: 11px; }
  @media (max-width: 650px) { .trust-grid { grid-template-columns: 1fr; } .connection-panel { align-items: stretch; flex-direction: column; } .connection-panel .button { width: 100%; } }
</style>
