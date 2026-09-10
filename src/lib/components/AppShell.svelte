<script lang="ts">
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';
  import {
    Activity,
    Braces,
    Clock3,
    Database,
    KeyRound,
    LogOut,
    Settings2,
    SlidersHorizontal,
    Terminal,
    Menu,
    X
  } from '@lucide/svelte';

  let { children, active } = $props<{
    children: Snippet;
    active?: string;
  }>();

  const navigation = [
    { label: 'Overview', href: '/admin', match: (p: string) => p === '/admin', icon: Activity },
    {
      label: 'Classify',
      href: '/admin/classify',
      match: (p: string) => p.startsWith('/admin/classify') || p.startsWith('/admin/classification'),
      icon: SlidersHorizontal
    },
    { label: 'Activity', href: '/admin/activity', match: (p: string) => p.startsWith('/admin/activity'), icon: Clock3 },
    {
      label: 'Imports & sync',
      href: '/admin/sync',
      match: (p: string) => p.startsWith('/admin/sync') || p.startsWith('/admin/imports'),
      icon: Database
    },
    { label: 'API keys', href: '/admin/api-keys', match: (p: string) => p.startsWith('/admin/api-keys'), icon: KeyRound },
    {
      label: 'OAuth clients',
      href: '/admin/oauth-clients',
      match: (p: string) => p.startsWith('/admin/oauth-clients'),
      icon: Braces
    },
    {
      label: 'MCP config',
      href: '/admin/mcp-config',
      match: (p: string) => p.startsWith('/admin/mcp-config'),
      icon: Terminal
    },
    { label: 'Settings', href: '/admin/settings', match: (p: string) => p.startsWith('/admin/settings'), icon: Settings2 }
  ];

  let currentPath = $derived(page.url.pathname);
  let mobileMenuOpen = $state(false);

  function isRouteActive(item: typeof navigation[number]): boolean {
    if (active) return active === item.label;
    return item.match(currentPath);
  }
</script>

<a href="#main-content" class="skip-link">Skip to main content</a>

<div class="app-shell">
  <!-- Mobile top header bar for small viewports -->
  <header class="mobile-bar" aria-label="Mobile site header">
    <a class="brand" href="/admin" aria-label="Work Times home">
      <span class="brand-mark">W</span>
      <span>
        <strong>Work Times</strong>
        <small>Private activity archive</small>
      </span>
    </a>
    <button
      type="button"
      class="icon-button mobile-menu-btn"
      aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
      aria-expanded={mobileMenuOpen}
      onclick={() => (mobileMenuOpen = !mobileMenuOpen)}
    >
      {#if mobileMenuOpen}
        <X size={20} />
      {:else}
        <Menu size={20} />
      {/if}
    </button>
  </header>

  <!-- Sidebar / Desktop Navigation -->
  <aside class="sidebar" class:mobile-open={mobileMenuOpen} aria-label="Main navigation sidebar">
    <a class="brand" href="/admin" aria-label="Work Times home">
      <span class="brand-mark">W</span>
      <span>
        <strong>Work Times</strong>
        <small>Private activity archive</small>
      </span>
    </a>

    <nav aria-label="Admin workspace navigation">
      <p class="nav-label">Workspace</p>
      {#each navigation as item}
        {@const isActive = isRouteActive(item)}
        <a
          class:active={isActive}
          href={item.href}
          aria-current={isActive ? 'page' : undefined}
          onclick={() => (mobileMenuOpen = false)}
        >
          <item.icon size={17} strokeWidth={1.8} />
          <span>{item.label}</span>
        </a>
      {/each}
    </nav>

    <div class="sidebar-footer">
      <div class="archive-state">
        <span class="status-dot" title="Archive operational"></span>
        <span>
          <strong>Local archive</strong>
          <small>Ready</small>
        </span>
      </div>
      <form method="POST" action="/login?/logout" class="signout-form">
        {#if page.data.csrfToken}
          <input type="hidden" name="csrfToken" value={page.data.csrfToken} />
        {/if}
        <button type="submit" class="icon-button" aria-label="Sign out" title="Sign out">
          <LogOut size={16} />
        </button>
      </form>
    </div>
  </aside>

  <main id="main-content" class="main-panel">
    {@render children()}
  </main>
</div>

<style>
  .signout-form {
    display: inline-flex;
    margin: 0;
  }

  .mobile-bar {
    display: none;
    align-items: center;
    justify-content: space-between;
    padding: 12px 18px;
    background: var(--panel-sunken);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 200;
  }

  @media (max-width: 700px) {
    .mobile-bar {
      display: flex;
    }

    .sidebar {
      display: none;
      position: fixed;
      top: 61px;
      left: 0;
      right: 0;
      bottom: 0;
      height: calc(100vh - 61px);
      z-index: 190;
      background: var(--panel-sunken);
      flex-direction: column;
      padding: 20px 18px;
    }

    .sidebar.mobile-open {
      display: flex;
    }

    .sidebar .brand {
      display: none;
    }

    .sidebar nav {
      display: grid;
      gap: 6px;
    }

    .sidebar nav a {
      justify-content: flex-start;
      padding: 12px 14px;
      font-size: 14px;
    }

    .sidebar nav a span {
      display: inline;
    }

    .sidebar-footer {
      display: flex;
      margin-top: auto;
      padding-top: 18px;
    }

    .sidebar-footer .archive-state {
      display: flex;
    }

    .sidebar-footer .archive-state span:last-child {
      display: block;
    }
  }
</style>
