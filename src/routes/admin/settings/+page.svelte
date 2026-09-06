<script lang="ts">
  import AppShell from '$lib/components/AppShell.svelte';
  import MetricCard from '$lib/components/MetricCard.svelte';
  import type { PageData } from './$types';
  import {
    CheckCircle2,
    Cookie,
    Database,
    Globe,
    HardDrive,
    Info,
    Key,
    Lock,
    Server,
    Shield,
    SlidersHorizontal,
    TableProperties,
    User,
    XCircle
  } from '@lucide/svelte';

  let { data } = $props<{ data: PageData }>();
  let settings = $derived(data.settings);
</script>

<svelte:head>
  <title>Settings — Work Times</title>
</svelte:head>

<AppShell>
  <header class="page-header">
    <div>
      <p class="eyebrow">Instance Configuration</p>
      <h1>Archive Settings & Runtime Status.</h1>
      <p class="lede">
        Review runtime environment configuration, local SQLite storage health, and imported account
        preferences. Secrets and credential hashes are safely retained on the host and never transmitted to the browser.
      </p>
    </div>
  </header>

  <!-- Summary KPI Cards -->
  <section class="metrics" aria-label="Database health metrics">
    <MetricCard
      label="Database Storage"
      value={settings.sqliteStatus.formattedSize}
      subtext={`SQLite 3 · Journal: ${settings.sqliteStatus.journalMode}`}
      badge={settings.sqliteStatus.journalMode}
      badgeVariant="work"
    />
    <MetricCard
      label="Indexed Slices"
      value={settings.sqliteStatus.tableCounts.dayProjectEntitySlices.toLocaleString()}
      subtext={`${settings.sqliteStatus.tableCounts.heartbeats.toLocaleString()} heartbeats indexed`}
      badge="Storage"
      badgeVariant="neutral"
    />
    <MetricCard
      label="Admin Authentication"
      value={settings.adminPasswordConfigured ? 'Password Set' : 'Default Credentials'}
      subtext={`User: ${settings.adminUsername}`}
      badge={settings.adminPasswordConfigured ? 'Secure' : 'Warning'}
      badgeVariant={settings.adminPasswordConfigured ? 'safe' : 'accent'}
    />
    <MetricCard
      label="Cookie Security"
      value={settings.cookieSecure ? 'Secure' : 'Lax / HTTP'}
      subtext="Session cookie transmission policy"
      badge={settings.cookieSecure ? 'Encrypted' : 'Local Dev'}
      badgeVariant={settings.cookieSecure ? 'safe' : 'neutral'}
    />
  </section>

  <div class="content-grid">
    <!-- Left Column: Database Status & Table Counts -->
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <!-- SQLite Storage Operations & Metrics -->
      <section class="panel" aria-labelledby="storage-heading">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Database Health</p>
            <h2 id="storage-heading">SQLite Archive Status</h2>
          </div>
          <span class="badge safe">Read-Only View</span>
        </div>

        <div style="padding: 22px; font-size: 13px; line-height: 1.6; color: var(--muted); display: flex; flex-direction: column; gap: 14px;">
          <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
            <span>Database File Location</span>
            <code style="font-size: 12px; color: var(--text);">{settings.abbreviatedDbPath}</code>
          </div>

          <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
            <span>SQLite Journal Mode</span>
            <strong style="color: var(--text); font-family: ui-monospace, monospace;">{settings.sqliteStatus.journalMode}</strong>
          </div>

          <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
            <span>Page Size</span>
            <span>{settings.sqliteStatus.pageSize.toLocaleString()} bytes</span>
          </div>

          <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
            <span>Page Count</span>
            <span>{settings.sqliteStatus.pageCount.toLocaleString()} pages</span>
          </div>

          <div style="display: flex; justify-content: space-between;">
            <span>Estimated Archive Size</span>
            <strong style="color: var(--work);">{settings.sqliteStatus.formattedSize}</strong>
          </div>
        </div>
      </section>

      <!-- Table Ledger Record Counts -->
      <section class="panel" aria-labelledby="tables-heading">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Data Ledger</p>
            <h2 id="tables-heading">Table Record Counts</h2>
          </div>
          <span class="badge neutral">11 Tables</span>
        </div>

        <div style="padding: 18px 22px;">
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px;">
            <div style="padding: 10px 12px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 12px; font-family: ui-monospace, monospace; color: var(--muted);">day_project_entity_slices</span>
              <strong style="color: var(--text); font-size: 13px;">{settings.sqliteStatus.tableCounts.dayProjectEntitySlices.toLocaleString()}</strong>
            </div>

            <div style="padding: 10px 12px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 12px; font-family: ui-monospace, monospace; color: var(--muted);">heartbeats</span>
              <strong style="color: var(--text); font-size: 13px;">{settings.sqliteStatus.tableCounts.heartbeats.toLocaleString()}</strong>
            </div>

            <div style="padding: 10px 12px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 12px; font-family: ui-monospace, monospace; color: var(--muted);">daily_totals</span>
              <strong style="color: var(--text); font-size: 13px;">{settings.sqliteStatus.tableCounts.dailyTotals.toLocaleString()}</strong>
            </div>

            <div style="padding: 10px 12px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 12px; font-family: ui-monospace, monospace; color: var(--muted);">source_imports</span>
              <strong style="color: var(--text); font-size: 13px;">{settings.sqliteStatus.tableCounts.sourceImports.toLocaleString()}</strong>
            </div>

            <div style="padding: 10px 12px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 12px; font-family: ui-monospace, monospace; color: var(--muted);">classification_rules</span>
              <strong style="color: var(--text); font-size: 13px;">{settings.sqliteStatus.tableCounts.classificationRules.toLocaleString()}</strong>
            </div>

            <div style="padding: 10px 12px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 12px; font-family: ui-monospace, monospace; color: var(--muted);">daily_time_allocations</span>
              <strong style="color: var(--text); font-size: 13px;">{settings.sqliteStatus.tableCounts.dailyTimeAllocations.toLocaleString()}</strong>
            </div>

            <div style="padding: 10px 12px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 12px; font-family: ui-monospace, monospace; color: var(--muted);">classification_revisions</span>
              <strong style="color: var(--text); font-size: 13px;">{settings.sqliteStatus.tableCounts.classificationRevisions.toLocaleString()}</strong>
            </div>

            <div style="padding: 10px 12px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 12px; font-family: ui-monospace, monospace; color: var(--muted);">sync_runs</span>
              <strong style="color: var(--text); font-size: 13px;">{settings.sqliteStatus.tableCounts.syncRuns.toLocaleString()}</strong>
            </div>

            <div style="padding: 10px 12px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 12px; font-family: ui-monospace, monospace; color: var(--muted);">sync_days</span>
              <strong style="color: var(--text); font-size: 13px;">{settings.sqliteStatus.tableCounts.syncDays.toLocaleString()}</strong>
            </div>

            <div style="padding: 10px 12px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 12px; font-family: ui-monospace, monospace; color: var(--muted);">api_keys</span>
              <strong style="color: var(--text); font-size: 13px;">{settings.sqliteStatus.tableCounts.apiKeys.toLocaleString()}</strong>
            </div>

            <div style="padding: 10px 12px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 12px; font-family: ui-monospace, monospace; color: var(--muted);">oauth_clients</span>
              <strong style="color: var(--text); font-size: 13px;">{settings.sqliteStatus.tableCounts.oauthClients.toLocaleString()}</strong>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- Right Column: Runtime Environment & Account Preferences -->
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <!-- Runtime Environment Configuration -->
      <section class="panel" aria-labelledby="runtime-heading">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Local Environment</p>
            <h2 id="runtime-heading">Runtime Configuration</h2>
          </div>
          <span class="badge neutral">Non-Secret Status</span>
        </div>

        <div style="padding: 20px 22px; font-size: 13px; display: flex; flex-direction: column; gap: 12px;">
          <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
            <span style="color: var(--muted);">Public Origin</span>
            <code style="font-size: 12px; color: var(--text);">{settings.publicOrigin}</code>
          </div>

          <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
            <span style="color: var(--muted);">Admin User</span>
            <strong style="color: var(--text);">{settings.adminUsername}</strong>
          </div>

          <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
            <span style="color: var(--muted);">Admin Password Hash</span>
            <span class="badge {settings.adminPasswordConfigured ? 'safe' : 'accent'}">
              {settings.adminPasswordConfigured ? 'Configured in Environment' : 'Unconfigured'}
            </span>
          </div>

          <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
            <span style="color: var(--muted);">Session Secret</span>
            <span class="badge {settings.sessionSecretConfigured ? 'safe' : 'neutral'}">
              {settings.sessionSecretConfigured ? 'Configured in Environment' : 'Ephemeral Fallback'}
            </span>
          </div>

          <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
            <span style="color: var(--muted);">WakaTime API Key</span>
            <span class="badge {settings.wakatimeApiKeyConfigured ? 'safe' : 'neutral'}">
              {settings.wakatimeApiKeyConfigured ? 'Configured' : 'Unconfigured'}
            </span>
          </div>

          <div style="display: flex; justify-content: space-between;">
            <span style="color: var(--muted);">Cookie Secure Flag</span>
            <span class="badge {settings.cookieSecure ? 'safe' : 'neutral'}">
              {settings.cookieSecure ? 'Secure (HTTPS)' : 'Standard (HTTP)'}
            </span>
          </div>

          <div class="notice info" style="margin-top: 6px;">
            <Shield size={16} style="flex-shrink: 0;" />
            <span style="font-size: 12px;">
              Credential values and password hashes are never exposed to the web client.
              Manage administrative credentials via host environment files.
            </span>
          </div>
        </div>
      </section>

      <!-- Imported Account Preferences -->
      <section class="panel" aria-labelledby="pref-heading">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Telemetry Calculations</p>
            <h2 id="pref-heading">Imported Account Preferences</h2>
          </div>
          <span class="badge {settings.accountPreferences ? 'safe' : 'neutral'}">
            {settings.accountPreferences ? 'Loaded' : 'No Account Dump'}
          </span>
        </div>

        <div style="padding: 20px 22px; font-size: 13px; display: flex; flex-direction: column; gap: 12px;">
          {#if settings.accountPreferences}
            <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
              <span style="color: var(--muted);">Timezone</span>
              <strong style="color: var(--text);">{settings.accountPreferences.timezone}</strong>
            </div>

            <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
              <span style="color: var(--muted);">Weekday Start</span>
              <span>{settings.accountPreferences.weekdayStartLabel}</span>
            </div>

            <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
              <span style="color: var(--muted);">Keystroke Timeout</span>
              <span>{settings.accountPreferences.keystrokeTimeoutSeconds} seconds</span>
            </div>

            <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
              <span style="color: var(--muted);">Writes Only Tracking</span>
              <span>{settings.accountPreferences.writesOnly ? 'Yes' : 'No'}</span>
            </div>

            <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
              <span style="color: var(--muted);">Account Plan</span>
              <span class="badge neutral">{settings.accountPreferences.plan}</span>
            </div>

            <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
              <span style="color: var(--muted);">Premium Features</span>
              <span>{settings.accountPreferences.hasPremiumFeatures ? 'Enabled' : 'Disabled'}</span>
            </div>

            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--muted);">Last Updated</span>
              <span style="font-size: 12px;">{new Date(settings.accountPreferences.updatedAt).toLocaleString()}</span>
            </div>
          {:else}
            <div style="text-align: center; padding: 24px 12px; color: var(--muted);">
              <SlidersHorizontal size={24} style="margin-bottom: 8px; color: var(--accent);" />
              <p style="font-weight: 500; margin: 0 0 6px; color: var(--text);">No account settings imported</p>
              <p style="font-size: 12px; margin: 0; color: var(--faint);">
                Account calculation preferences are imported from the <code>user</code> payload inside WakaTime daily dump archives.
              </p>
            </div>
          {/if}
        </div>
      </section>
    </div>
  </div>
</AppShell>
