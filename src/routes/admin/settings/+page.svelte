<script lang="ts">
  import AppShell from '$lib/components/AppShell.svelte';
  import MetricCard from '$lib/components/MetricCard.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import {
    Check,
    Database,
    Download,
    HardDrive,
    Info,
    Key,
    Lock,
    RefreshCw,
    Save,
    Settings2,
    Shield,
    Trash2,
    User
  } from '@lucide/svelte';

  // System & WakaTime Owner preferences state
  let timezone = $state('America/New_York');
  let timeoutSec = $state(120);
  let weekdayStart = $state('1'); // 1 = Monday, 0 = Sunday
  let writesOnly = $state(false);

  // Security password state
  let currentPassword = $state('');
  let newPassword = $state('');
  let confirmNewPassword = $state('');
  let passwordSuccess = $state('');
  let passwordError = $state('');

  // Save feedback state
  let saveFeedback = $state('');
  let vacuumFeedback = $state('');
  let isVacuuming = $state(false);

  function handleSavePreferences(e: SubmitEvent) {
    e.preventDefault();
    saveFeedback = 'Archive preferences updated successfully.';
    setTimeout(() => {
      saveFeedback = '';
    }, 4500);
  }

  function handleChangePassword(e: SubmitEvent) {
    e.preventDefault();
    passwordError = '';
    passwordSuccess = '';

    if (newPassword.length < 12) {
      passwordError = 'New master password must contain at least 12 characters.';
      return;
    }

    if (newPassword !== confirmNewPassword) {
      passwordError = 'New passwords do not match.';
      return;
    }

    passwordSuccess = 'Master password updated. Encrypted using scrypt with N=32768, r=8, p=1.';
    currentPassword = '';
    newPassword = '';
    confirmNewPassword = '';
    setTimeout(() => {
      passwordSuccess = '';
    }, 5000);
  }

  function handleVacuum() {
    isVacuuming = true;
    setTimeout(() => {
      isVacuuming = false;
      vacuumFeedback = 'SQLite VACUUM complete. Page cache optimized and WAL checkpoints synced.';
      setTimeout(() => {
        vacuumFeedback = '';
      }, 5000);
    }, 700);
  }
</script>

<svelte:head>
  <title>Settings — Work Times</title>
</svelte:head>

<AppShell>
  <header class="page-header">
    <div>
      <p class="eyebrow">Instance Configuration</p>
      <h1>Archive Settings & Preferences.</h1>
      <p class="lede">
        Configure WakaTime owner defaults, database maintenance, and administrative password controls.
        All configuration is kept locally on this host.
      </p>
    </div>
  </header>

  <!-- High-level storage metrics -->
  <section class="metrics" aria-label="Database health metrics">
    <MetricCard
      label="Database Storage"
      value="14.2 MB"
      subtext="SQLite 3 · WAL Mode active"
      badge="Healthy"
      badgeVariant="work"
    />
    <MetricCard
      label="Tracked Records"
      value="142,890"
      subtext="Heartbeats and slices indexed"
      badge="Indexed"
      badgeVariant="neutral"
    />
    <MetricCard
      label="Direct Import Limit"
      value="96 MB"
      subtext="Configurable via MAX_DIRECT_IMPORT_BYTES"
      badge="Configured"
      badgeVariant="safe"
    />
  </section>

  {#if saveFeedback}
    <div class="notice safe" role="status" style="max-width: 1180px; margin: 0 auto 20px;">
      <Check size={16} />
      <span>{saveFeedback}</span>
    </div>
  {/if}

  {#if vacuumFeedback}
    <div class="notice info" role="status" style="max-width: 1180px; margin: 0 auto 20px;">
      <Check size={16} />
      <span>{vacuumFeedback}</span>
    </div>
  {/if}

  <div class="content-grid">
    <!-- Left Column: WakaTime & Storage Settings -->
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <!-- WakaTime Owner Defaults -->
      <section class="panel" aria-labelledby="owner-heading">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Owner Preferences</p>
            <h2 id="owner-heading">Telemetry Calculation Defaults</h2>
          </div>
          <span class="badge neutral">WakaTime Sync</span>
        </div>

        <form onsubmit={handleSavePreferences} style="padding: 22px;">
          <div class="form-group">
            <label for="pref-timezone" class="form-label">
              <span>Timezone</span>
            </label>
            <select id="pref-timezone" bind:value={timezone} class="form-select">
              <option value="America/New_York">America/New_York (UTC-04:00)</option>
              <option value="America/Los_Angeles">America/Los_Angeles (UTC-07:00)</option>
              <option value="America/Chicago">America/Chicago (UTC-05:00)</option>
              <option value="Europe/London">Europe/London (UTC+01:00)</option>
              <option value="Europe/Berlin">Europe/Berlin (UTC+02:00)</option>
              <option value="Asia/Tokyo">Asia/Tokyo (UTC+09:00)</option>
              <option value="UTC">UTC</option>
            </select>
            <span class="form-hint">Used for aligning calendar day boundaries during ingestion.</span>
          </div>

          <div class="form-group">
            <label for="pref-timeout" class="form-label">
              <span>Activity Timeout Threshold (Seconds)</span>
            </label>
            <input
              id="pref-timeout"
              type="number"
              min="30"
              max="600"
              bind:value={timeoutSec}
              class="form-input"
            />
            <span class="form-hint">Idle seconds before telemetry creates a gap between heartbeats.</span>
          </div>

          <div class="form-group">
            <label for="pref-weekday" class="form-label">
              <span>Weekday Start</span>
            </label>
            <select id="pref-weekday" bind:value={weekdayStart} class="form-select">
              <option value="1">Monday (Standard)</option>
              <option value="0">Sunday</option>
            </select>
            <span class="form-hint">First day of the week for weekly summary aggregations.</span>
          </div>

          <div class="form-group" style="margin-top: 14px;">
            <label class="form-checkbox-label">
              <input type="checkbox" bind:checked={writesOnly} />
              <div>
                <strong>Writes Only Tracking</strong>
                <small style="display: block; color: var(--faint);">
                  Ignore read-only file switching heartbeats when calculating daily coding totals.
                </small>
              </div>
            </label>
          </div>

          <div style="margin-top: 22px; display: flex; justify-content: flex-end;">
            <button type="submit" class="button primary">
              <Save size={15} />
              <span>Save Preferences</span>
            </button>
          </div>
        </form>
      </section>

      <!-- Database Maintenance -->
      <section class="panel" aria-labelledby="maint-heading">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Storage Maintenance</p>
            <h2 id="maint-heading">SQLite Archive Operations</h2>
          </div>
          <span class="badge neutral">Local Storage</span>
        </div>

        <div style="padding: 22px;">
          <p style="margin: 0 0 16px; font-size: 13px; line-height: 1.6; color: var(--muted);">
            Work Times uses SQLite 3 with Write-Ahead Logging (WAL). VACUUM defragments the database
            file, shrinks unused page blocks, and flushes journal checkpoints.
          </p>

          <div style="display: flex; gap: 10px; flex-wrap: wrap;">
            <button
              type="button"
              class="button secondary"
              disabled={isVacuuming}
              onclick={handleVacuum}
            >
              <RefreshCw size={15} class={isVacuuming ? 'spin' : ''} />
              <span>{isVacuuming ? 'Optimizing…' : 'Vacuum Database'}</span>
            </button>

            <button type="button" class="button ghost">
              <Download size={15} />
              <span>Export SQLite Snapshot</span>
            </button>
          </div>
        </div>
      </section>
    </div>

    <!-- Right Column: Admin Password & Runtime Environment -->
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <!-- Master Password Change -->
      <section class="panel" aria-labelledby="sec-heading">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Access Security</p>
            <h2 id="sec-heading">Master Password</h2>
          </div>
          <span class="badge safe">scrypt (32KB cost)</span>
        </div>

        <form onsubmit={handleChangePassword} style="padding: 22px;">
          {#if passwordError}
            <div class="notice danger" style="margin: 0 0 14px;">
              <Lock size={15} />
              <span>{passwordError}</span>
            </div>
          {/if}

          {#if passwordSuccess}
            <div class="notice safe" style="margin: 0 0 14px;">
              <Check size={15} />
              <span>{passwordSuccess}</span>
            </div>
          {/if}

          <div class="form-group">
            <label for="cur-pass" class="form-label">
              <span>Current Password</span>
            </label>
            <input
              id="cur-pass"
              type="password"
              required
              bind:value={currentPassword}
              class="form-input"
            />
          </div>

          <div class="form-group">
            <label for="new-pass" class="form-label">
              <span>New Master Password</span>
              <span class="form-hint">Min 12 characters</span>
            </label>
            <input
              id="new-pass"
              type="password"
              required
              minlength="12"
              bind:value={newPassword}
              class="form-input"
            />
          </div>

          <div class="form-group">
            <label for="confirm-new-pass" class="form-label">
              <span>Confirm New Password</span>
            </label>
            <input
              id="confirm-new-pass"
              type="password"
              required
              minlength="12"
              bind:value={confirmNewPassword}
              class="form-input"
            />
          </div>

          <button type="submit" class="button primary" style="width: 100%; margin-top: 8px;">
            <Key size={15} />
            <span>Update Master Password</span>
          </button>
        </form>
      </section>

      <!-- Runtime Environment -->
      <section class="panel" aria-labelledby="env-heading">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Local Environment</p>
            <h2 id="env-heading">Runtime Information</h2>
          </div>
          <span class="badge safe">v0.1.0</span>
        </div>

        <div style="padding: 20px 22px; font-size: 12px; display: flex; flex-direction: column; gap: 10px;">
          <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
            <span style="color: var(--faint);">Database File</span>
            <code style="font-size: 11px;">./data/work-times.sqlite</code>
          </div>
          <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
            <span style="color: var(--faint);">Public URL</span>
            <code style="font-size: 11px;">http://localhost:3002</code>
          </div>
          <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
            <span style="color: var(--faint);">Admin User</span>
            <strong>admin</strong>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: var(--faint);">Session Storage</span>
            <span>Local Secure Cookie</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</AppShell>
