<script lang="ts">
  import AppShell from '$lib/components/AppShell.svelte';
  import MetricCard from '$lib/components/MetricCard.svelte';
  import type { PageData } from './$types';
  import {
    Activity,
    Bot,
    Calendar,
    ChevronLeft,
    ChevronRight,
    FileCode,
    Filter,
    FolderKanban,
    Globe,
    Info,
    Laptop,
    Layers,
    Search,
    SlidersHorizontal,
    X
  } from '@lucide/svelte';

  let { data } = $props<{ data: PageData }>();
  let activity = $derived(data.activity);

  function getEntityIcon(type: string) {
    switch (type) {
      case 'file':
        return FileCode;
      case 'app':
        return Laptop;
      case 'domain':
        return Globe;
      default:
        return FolderKanban;
    }
  }

  function buildFilterUrl(params: Record<string, string | number | null | undefined>): string {
    const current = new URLSearchParams();
    if (activity.filters.selectedDate) current.set('date', activity.filters.selectedDate);
    if (activity.filters.startDate) current.set('startDate', activity.filters.startDate);
    if (activity.filters.endDate) current.set('endDate', activity.filters.endDate);
    if (activity.filters.classification && activity.filters.classification !== 'all') {
      current.set('classification', activity.filters.classification);
    }
    if (activity.filters.q) current.set('q', activity.filters.q);
    if (activity.filters.selectorType) current.set('selectorType', activity.filters.selectorType);
    if (activity.filters.selectorValue) current.set('selectorValue', activity.filters.selectorValue);
    if (activity.filters.project) current.set('project', activity.filters.project);
    if (activity.filters.editor) current.set('editor', activity.filters.editor);
    if (activity.filters.machine) current.set('machine', activity.filters.machine);
    if (activity.filters.application) current.set('application', activity.filters.application);
    if (activity.filters.domain) current.set('domain', activity.filters.domain);
    if (activity.filters.folder) current.set('folder', activity.filters.folder);
    if (activity.filters.entity) current.set('entity', activity.filters.entity);
    if (activity.filters.entityType && activity.filters.entityType !== 'all') {
      current.set('entityType', activity.filters.entityType);
    }
    if (activity.pagination.pageSize !== 50) current.set('pageSize', String(activity.pagination.pageSize));

    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined || value === '' || (value === 'all' && key !== 'date')) {
        current.delete(key);
      } else {
        current.set(key, String(value));
      }
    }

    const query = current.toString();
    return `/admin/activity${query ? `?${query}` : ''}`;
  }

  function submitSelectedDate(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement;
    if (!select.value) return;
    const form = select.form;
    if (!form) return;
    const start = form.elements.namedItem('startDate') as HTMLInputElement | null;
    const end = form.elements.namedItem('endDate') as HTMLInputElement | null;
    if (start) start.value = '';
    if (end) end.value = '';
    form.requestSubmit();
  }

  function activateDateRange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const date = input.form?.elements.namedItem('date') as HTMLSelectElement | null;
    if (date) date.value = '';
  }

  let hasActiveFilters = $derived(
    Boolean(
      (activity.filters.selectorType && activity.filters.selectorValue) ||
      activity.filters.project ||
      activity.filters.editor ||
      activity.filters.machine ||
      activity.filters.application ||
      activity.filters.domain ||
      activity.filters.folder ||
      activity.filters.entity ||
      (activity.filters.entityType && activity.filters.entityType !== 'all') ||
      (activity.filters.classification && activity.filters.classification !== 'all') ||
      activity.filters.q ||
      (activity.filters.startDate && activity.filters.endDate) ||
      activity.filters.selectedDate === 'all'
    )
  );
</script>

<svelte:head>
  <title>Activity Explorer — Work Times</title>
</svelte:head>

<AppShell>
  <header class="page-header">
    <div>
      <p class="eyebrow">Telemetry Explorer</p>
      <h1>Activity Slices & Dimensions.</h1>
      <p class="lede">
        Inspect authoritative day-project-entity time slices, observed environment selectors,
        and effective classification decisions. To adjust classifications, use the canonical classification rules inbox.
      </p>
    </div>
    <div class="header-actions">
      <a href="/admin/classify" class="button primary">
        <SlidersHorizontal size={15} />
        <span>Manage Classification Rules</span>
      </a>
    </div>
  </header>

  {#if activity.isTruncated}
    <div class="notice warning" role="status">
      <strong>Partial view.</strong>
      This selection holds more than {activity.maxSlices.toLocaleString()} slices, so only the
      first {activity.maxSlices.toLocaleString()} were loaded. The totals and counts below
      describe that capped set, not the full range — narrow the date filter for exact figures.
    </div>
  {/if}

  <!-- Summary KPI Cards for active view -->
  <section class="metrics" aria-label="Activity volume metrics">
    <MetricCard
      label="Total Filtered Duration"
      value={activity.metrics.formattedTotalDuration}
      subtext={`${activity.metrics.totalSlices.toLocaleString()} slices in selection`}
      badge={activity.filters.selectedDate ? (activity.filters.selectedDate === 'all' ? 'All Dates' : activity.filters.selectedDate) : 'Active View'}
      badgeVariant="neutral"
    />
    <MetricCard
      label="Classified as Work"
      value={activity.metrics.workSeconds > 0 ? (activity.metrics.workSeconds >= 3600 ? `${Math.round(activity.metrics.workSeconds / 3600)}h` : `${Math.round(activity.metrics.workSeconds / 60)}m`) : '0m'}
      subtext={activity.metrics.totalDurationSeconds > 0
        ? `${Math.round((activity.metrics.workSeconds / activity.metrics.totalDurationSeconds) * 100)}% of filtered duration`
        : '0% of duration'}
      badge="Work"
      badgeVariant="work"
    />
    <MetricCard
      label="Classified as Personal"
      value={activity.metrics.personalSeconds > 0 ? (activity.metrics.personalSeconds >= 3600 ? `${Math.round(activity.metrics.personalSeconds / 3600)}h` : `${Math.round(activity.metrics.personalSeconds / 60)}m`) : '0m'}
      subtext={activity.metrics.totalDurationSeconds > 0
        ? `${Math.round((activity.metrics.personalSeconds / activity.metrics.totalDurationSeconds) * 100)}% of filtered duration`
        : '0% of duration'}
      badge="Personal"
      badgeVariant="personal"
    />
    <MetricCard
      label="Unclassified Slices"
      value={activity.metrics.unclassifiedSeconds > 0 ? (activity.metrics.unclassifiedSeconds >= 3600 ? `${Math.round(activity.metrics.unclassifiedSeconds / 3600)}h` : `${Math.round(activity.metrics.unclassifiedSeconds / 60)}m`) : '0m'}
      subtext={`${activity.metrics.aiSessions} AI sessions on active slices`}
      badge={activity.metrics.unclassifiedSeconds > 0 ? 'Pending' : 'Resolved'}
      badgeVariant={activity.metrics.unclassifiedSeconds > 0 ? 'accent' : 'safe'}
    />
  </section>

  <!-- Filter & Search Controls (Preserving URL state) -->
  <div style="max-width: 1180px; margin: 0 auto 16px;">
    <form method="GET" action="/admin/activity" class="panel" style="padding: 14px 18px; display: flex; flex-direction: column; gap: 12px;">
      <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: space-between;">
        <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
          <!-- Date Selector -->
          <div style="display: flex; align-items: center; gap: 6px;">
            <Calendar size={15} style="color: var(--muted);" />
            <label for="filter-date" class="sr-only">Date</label>
            <select
              id="filter-date"
              name="date"
              class="form-select"
              style="font-size: 12px; padding: 6px 10px; min-width: 140px;"
              onchange={submitSelectedDate}
            >
              {#if activity.distinctDates.length === 0}
                <option value="">No dates recorded</option>
              {:else}
                <option
                  value=""
                  selected={Boolean(activity.filters.startDate && activity.filters.endDate)}
                >
                  Custom range
                </option>
                <option value="all" selected={activity.filters.selectedDate === 'all'}>All Dates</option>
                {#each activity.distinctDates as d}
                  <option value={d} selected={d === activity.filters.selectedDate}>
                    {d} {d === activity.latestDate ? '(Latest)' : ''}
                  </option>
                {/each}
              {/if}
            </select>
          </div>

          <!-- Explicit date range; changing either bound clears the single-date selector. -->
          <div style="display: flex; align-items: center; gap: 6px;">
            <label for="filter-start-date" style="font-size: 11px; color: var(--faint);">From</label>
            <input
              id="filter-start-date"
              name="startDate"
              type="date"
              value={activity.filters.startDate ?? ''}
              max={activity.latestDate ?? undefined}
              class="form-input"
              style="width: 132px; font-size: 12px; padding: 6px 8px;"
              onchange={activateDateRange}
            />
            <label for="filter-end-date" style="font-size: 11px; color: var(--faint);">To</label>
            <input
              id="filter-end-date"
              name="endDate"
              type="date"
              value={activity.filters.endDate ?? ''}
              max={activity.latestDate ?? undefined}
              class="form-input"
              style="width: 132px; font-size: 12px; padding: 6px 8px;"
              onchange={activateDateRange}
            />
          </div>

          <!-- Project Selector -->
          {#if activity.distinctProjects && activity.distinctProjects.length > 0}
            <div style="display: flex; align-items: center; gap: 6px;">
              <FolderKanban size={15} style="color: var(--muted);" />
              <label for="filter-project" class="sr-only">Project</label>
              <select
                id="filter-project"
                name="project"
                class="form-select"
                style="font-size: 12px; padding: 6px 10px; max-width: 150px;"
                onchange={(e) => {
                  (e.currentTarget.form as HTMLFormElement).submit();
                }}
              >
                <option value="">All Projects</option>
                {#each activity.distinctProjects as p}
                  <option value={p} selected={p === activity.filters.project}>{p}</option>
                {/each}
              </select>
            </div>
          {/if}

          <!-- Editor Selector -->
          {#if activity.distinctEditors && activity.distinctEditors.length > 0}
            <div style="display: flex; align-items: center; gap: 6px;">
              <FileCode size={15} style="color: var(--muted);" />
              <label for="filter-editor" class="sr-only">Editor</label>
              <select
                id="filter-editor"
                name="editor"
                class="form-select"
                style="font-size: 12px; padding: 6px 10px; max-width: 130px;"
                onchange={(e) => {
                  (e.currentTarget.form as HTMLFormElement).submit();
                }}
              >
                <option value="">All Editors</option>
                {#each activity.distinctEditors as ed}
                  <option value={ed} selected={ed === activity.filters.editor}>{ed}</option>
                {/each}
              </select>
            </div>
          {/if}

          <!-- Entity Type Selector -->
          <div style="display: flex; align-items: center; gap: 6px;">
            <Layers size={15} style="color: var(--muted);" />
            <label for="filter-entity-type" class="sr-only">Entity Type</label>
            <select
              id="filter-entity-type"
              name="entityType"
              class="form-select"
              style="font-size: 12px; padding: 6px 10px; min-width: 100px;"
              onchange={(e) => {
                (e.currentTarget.form as HTMLFormElement).submit();
              }}
            >
              <option value="all" selected={activity.filters.entityType === 'all'}>All Types</option>
              <option value="file" selected={activity.filters.entityType === 'file'}>Files</option>
              <option value="app" selected={activity.filters.entityType === 'app'}>Apps</option>
              <option value="domain" selected={activity.filters.entityType === 'domain'}>Domains</option>
              <option value="unattributed" selected={activity.filters.entityType === 'unattributed'}>Unattributed</option>
            </select>
          </div>

          <!-- Text search query -->
          <div style="position: relative;">
            <input
              type="text"
              name="q"
              placeholder="Search entity, project…"
              value={activity.filters.q}
              class="form-input"
              style="width: 200px; font-size: 12px; padding: 6px 10px;"
              aria-label="Filter activity slices"
            />
          </div>

          <!-- Hidden inputs to preserve drilldown selector and classification filters -->
          {#if activity.filters.selectorType}
            <input type="hidden" name="selectorType" value={activity.filters.selectorType} />
          {/if}
          {#if activity.filters.selectorValue}
            <input type="hidden" name="selectorValue" value={activity.filters.selectorValue} />
          {/if}
          {#if activity.filters.machine}
            <input type="hidden" name="machine" value={activity.filters.machine} />
          {/if}
          {#if activity.filters.application}
            <input type="hidden" name="application" value={activity.filters.application} />
          {/if}
          {#if activity.filters.domain}
            <input type="hidden" name="domain" value={activity.filters.domain} />
          {/if}
          {#if activity.filters.folder}
            <input type="hidden" name="folder" value={activity.filters.folder} />
          {/if}
          {#if activity.filters.entity}
            <input type="hidden" name="entity" value={activity.filters.entity} />
          {/if}
          {#if activity.filters.classification !== 'all'}
            <input type="hidden" name="classification" value={activity.filters.classification} />
          {/if}

          <button type="submit" class="button secondary sm">
            <Search size={13} />
            <span>Filter</span>
          </button>
        </div>

        <!-- Classification category pill buttons -->
        <div style="display: flex; gap: 6px; align-items: center;">
          <span style="font-size: 11px; color: var(--faint);">Status:</span>
          <a
            href={buildFilterUrl({ classification: 'all', page: 1 })}
            class="button sm {activity.filters.classification === 'all' ? 'primary' : 'ghost'}"
          >
            All
          </a>
          <a
            href={buildFilterUrl({ classification: 'work', page: 1 })}
            class="button sm {activity.filters.classification === 'work' ? 'primary' : 'ghost'}"
          >
            Work
          </a>
          <a
            href={buildFilterUrl({ classification: 'personal', page: 1 })}
            class="button sm {activity.filters.classification === 'personal' ? 'primary' : 'ghost'}"
          >
            Personal
          </a>
          <a
            href={buildFilterUrl({ classification: 'unclassified', page: 1 })}
            class="button sm {activity.filters.classification === 'unclassified' ? 'primary' : 'ghost'}"
          >
            Unclassified
          </a>
        </div>
      </div>

      <!-- Active Filters Row (Pills with dismiss buttons) -->
      {#if hasActiveFilters}
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 8px; border-top: 1px solid var(--border);">
          <span style="font-size: 11px; color: var(--faint); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
            Active:
          </span>

          {#if activity.filters.selectorType && activity.filters.selectorValue}
            <span class="badge accent" style="gap: 6px; font-size: 11px; padding: 2px 8px; height: 26px;">
              <span>
                <strong style="text-transform: capitalize;">{activity.filters.selectorType.replace('_', ' ')}:</strong>
                {activity.filters.selectorValue}
              </span>
              <a
                href={buildFilterUrl({ selectorType: null, selectorValue: null, page: 1 })}
                style="display: inline-flex; align-items: center; color: inherit; opacity: 0.7; margin-left: 2px;"
                title="Clear selector filter"
                aria-label="Clear selector filter"
              >
                <X size={12} />
              </a>
            </span>
          {/if}

          {#if activity.filters.selectedDate === 'all'}
            <span class="badge neutral" style="gap: 6px; font-size: 11px; padding: 2px 8px; height: 26px;">
              <span><strong>Date:</strong> All Dates</span>
              <a
                href={buildFilterUrl({ date: activity.latestDate ?? '', page: 1 })}
                style="display: inline-flex; align-items: center; color: inherit; opacity: 0.7; margin-left: 2px;"
                title="Reset to latest date"
                aria-label="Reset to latest date"
              >
                <X size={12} />
              </a>
            </span>
          {/if}

          {#if activity.filters.startDate && activity.filters.endDate}
            <span class="badge neutral" style="gap: 6px; font-size: 11px; padding: 2px 8px; height: 26px;">
              <span>
                <strong>Range:</strong> {activity.filters.startDate} → {activity.filters.endDate}
              </span>
              <a
                href={buildFilterUrl({
                  startDate: null,
                  endDate: null,
                  date: activity.latestDate ?? '',
                  page: 1
                })}
                style="display: inline-flex; align-items: center; color: inherit; opacity: 0.7; margin-left: 2px;"
                title="Reset to latest date"
                aria-label="Clear date range"
              >
                <X size={12} />
              </a>
            </span>
          {/if}

          {#if activity.filters.classification !== 'all'}
            <span class="badge {activity.filters.classification}" style="gap: 6px; font-size: 11px; padding: 2px 8px; height: 26px;">
              <span><strong>Status:</strong> {activity.filters.classification.toUpperCase()}</span>
              <a
                href={buildFilterUrl({ classification: 'all', page: 1 })}
                style="display: inline-flex; align-items: center; color: inherit; opacity: 0.7; margin-left: 2px;"
                title="Clear classification filter"
                aria-label="Clear classification filter"
              >
                <X size={12} />
              </a>
            </span>
          {/if}

          {#if activity.filters.project}
            <span class="badge neutral" style="gap: 6px; font-size: 11px; padding: 2px 8px; height: 26px;">
              <span><strong>Project:</strong> {activity.filters.project}</span>
              <a
                href={buildFilterUrl({ project: null, page: 1 })}
                style="display: inline-flex; align-items: center; color: inherit; opacity: 0.7; margin-left: 2px;"
                title="Clear project filter"
                aria-label="Clear project filter"
              >
                <X size={12} />
              </a>
            </span>
          {/if}

          {#if activity.filters.editor}
            <span class="badge neutral" style="gap: 6px; font-size: 11px; padding: 2px 8px; height: 26px;">
              <span><strong>Editor:</strong> {activity.filters.editor}</span>
              <a
                href={buildFilterUrl({ editor: null, page: 1 })}
                style="display: inline-flex; align-items: center; color: inherit; opacity: 0.7; margin-left: 2px;"
                title="Clear editor filter"
                aria-label="Clear editor filter"
              >
                <X size={12} />
              </a>
            </span>
          {/if}

          {#if activity.filters.machine}
            <span class="badge neutral" style="gap: 6px; font-size: 11px; padding: 2px 8px; height: 26px;">
              <span><strong>Machine:</strong> {activity.filters.machine}</span>
              <a
                href={buildFilterUrl({ machine: null, page: 1 })}
                style="display: inline-flex; align-items: center; color: inherit; opacity: 0.7; margin-left: 2px;"
                title="Clear machine filter"
                aria-label="Clear machine filter"
              >
                <X size={12} />
              </a>
            </span>
          {/if}

          {#if activity.filters.application}
            <span class="badge neutral" style="gap: 6px; font-size: 11px; padding: 2px 8px; height: 26px;">
              <span><strong>App:</strong> {activity.filters.application}</span>
              <a
                href={buildFilterUrl({ application: null, page: 1 })}
                style="display: inline-flex; align-items: center; color: inherit; opacity: 0.7; margin-left: 2px;"
                title="Clear app filter"
                aria-label="Clear app filter"
              >
                <X size={12} />
              </a>
            </span>
          {/if}

          {#if activity.filters.domain}
            <span class="badge neutral" style="gap: 6px; font-size: 11px; padding: 2px 8px; height: 26px;">
              <span><strong>Domain:</strong> {activity.filters.domain}</span>
              <a
                href={buildFilterUrl({ domain: null, page: 1 })}
                style="display: inline-flex; align-items: center; color: inherit; opacity: 0.7; margin-left: 2px;"
                title="Clear domain filter"
                aria-label="Clear domain filter"
              >
                <X size={12} />
              </a>
            </span>
          {/if}

          {#if activity.filters.folder}
            <span class="badge neutral" style="gap: 6px; font-size: 11px; padding: 2px 8px; height: 26px;">
              <span><strong>Folder:</strong> {activity.filters.folder}</span>
              <a
                href={buildFilterUrl({ folder: null, page: 1 })}
                style="display: inline-flex; align-items: center; color: inherit; opacity: 0.7; margin-left: 2px;"
                title="Clear folder filter"
                aria-label="Clear folder filter"
              >
                <X size={12} />
              </a>
            </span>
          {/if}

          {#if activity.filters.entity}
            <span class="badge neutral" style="gap: 6px; font-size: 11px; padding: 2px 8px; height: 26px;">
              <span><strong>Entity:</strong> {activity.filters.entity}</span>
              <a
                href={buildFilterUrl({ entity: null, page: 1 })}
                style="display: inline-flex; align-items: center; color: inherit; opacity: 0.7; margin-left: 2px;"
                title="Clear entity filter"
                aria-label="Clear entity filter"
              >
                <X size={12} />
              </a>
            </span>
          {/if}

          {#if activity.filters.entityType && activity.filters.entityType !== 'all'}
            <span class="badge neutral" style="gap: 6px; font-size: 11px; padding: 2px 8px; height: 26px;">
              <span><strong>Type:</strong> {activity.filters.entityType}</span>
              <a
                href={buildFilterUrl({ entityType: null, page: 1 })}
                style="display: inline-flex; align-items: center; color: inherit; opacity: 0.7; margin-left: 2px;"
                title="Clear entity type filter"
                aria-label="Clear entity type filter"
              >
                <X size={12} />
              </a>
            </span>
          {/if}

          {#if activity.filters.q}
            <span class="badge neutral" style="gap: 6px; font-size: 11px; padding: 2px 8px; height: 26px;">
              <span><strong>Search:</strong> "{activity.filters.q}"</span>
              <a
                href={buildFilterUrl({ q: null, page: 1 })}
                style="display: inline-flex; align-items: center; color: inherit; opacity: 0.7; margin-left: 2px;"
                title="Clear search query"
                aria-label="Clear search query"
              >
                <X size={12} />
              </a>
            </span>
          {/if}

          <a
            href="/admin/activity"
            class="button ghost sm"
            style="font-size: 11px; padding: 2px 8px; height: 24px; color: var(--faint);"
          >
            Reset all
          </a>
        </div>
      {/if}
    </form>
  </div>

  <!-- Slices Table -->
  <div style="max-width: 1180px; margin: 0 auto 20px;">
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Canonical Slices</p>
          <h2>Authoritative Day-Project-Entity Records</h2>
        </div>
        <span class="badge neutral">
          {activity.pagination.totalItems.toLocaleString()} slices
        </span>
      </div>

      <div class="table-wrap">
        <table class="data-table" aria-label="Activity slices table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Duration</th>
              <th scope="col">Entity</th>
              <th scope="col">Project</th>
              <th scope="col">Selectors / Identifiers</th>
              <th scope="col">Decision Source</th>
              <th scope="col">Classification</th>
              <th scope="col" style="text-align: right;">Action</th>
            </tr>
          </thead>
          <tbody>
            {#if activity.isEmpty}
              <tr>
                <td colspan="8" style="text-align: center; padding: 48px 16px; color: var(--muted);">
                  <div style="max-width: 420px; margin: 0 auto;">
                    <Info size={24} style="margin-bottom: 8px; color: var(--accent);" />
                    <p style="font-weight: 500; font-size: 14px; margin: 0 0 6px; color: var(--text);">No activity slices recorded</p>
                    <p style="font-size: 12px; margin: 0; color: var(--faint);">
                      Ingest a historical export via <code>pnpm import:dumps</code> to populate slices and entities.
                    </p>
                  </div>
                </td>
              </tr>
            {:else if activity.items.length === 0}
              <tr>
                <td colspan="8" style="text-align: center; padding: 36px 16px; color: var(--faint);">
                  No activity slices match the selected date and filter criteria.
                </td>
              </tr>
            {:else}
              {#each activity.items as row}
                {@const Icon = getEntityIcon(row.entityType)}
                <tr>
                  <td style="white-space: nowrap; font-family: ui-monospace, monospace; font-size: 12px;">
                    {row.date}
                  </td>
                  <td style="white-space: nowrap;">
                    <strong style="color: var(--text); font-size: 13px;">{row.formattedDuration}</strong>
                    {#if row.aiSessions > 0}
                      <small style="display: block; color: var(--personal); font-size: 10px;">
                        {row.aiSessions} AI sess
                      </small>
                    {/if}
                  </td>
                  <td>
                    <div style="display: flex; align-items: center; gap: 8px; max-width: 340px;">
                      <Icon size={15} style="color: var(--accent); flex-shrink: 0;" />
                      <span
                        style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, monospace; font-size: 12px;"
                        title={row.entity}
                      >
                        {row.entity}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span style="font-weight: 500; font-size: 12px;">{row.projectName}</span>
                  </td>
                  <td>
                    <div style="display: flex; flex-direction: column; gap: 2px; font-size: 11px;">
                      {#if row.editors.length > 0}
                        <span style="color: var(--text);">{row.editors.join(', ')}</span>
                      {/if}
                      {#if row.machineIds.length > 0}
                        <small style="color: var(--faint); font-family: ui-monospace, monospace;">
                          {row.machineIds.join(', ')}
                        </small>
                      {/if}
                      {#if row.editors.length === 0 && row.machineIds.length === 0}
                        <span style="color: var(--faint);">—</span>
                      {/if}
                    </div>
                  </td>
                  <td>
                    <div style="display: flex; flex-direction: column; gap: 2px;">
                      {#if row.decisionSource === 'override'}
                        <span class="badge accent" style="align-self: flex-start; font-size: 10px;">
                          Override
                        </span>
                      {:else if row.decisionSource === 'rule'}
                        <span class="badge safe" style="align-self: flex-start; font-size: 10px;" title={row.winningRuleId ?? undefined}>
                          Rule
                        </span>
                      {:else}
                        <span class="badge neutral" style="align-self: flex-start; font-size: 10px;">
                          Default
                        </span>
                      {/if}
                    </div>
                  </td>
                  <td>
                    <span class="badge {row.classification}">
                      {row.classification.toUpperCase()}
                    </span>
                  </td>
                  <td style="text-align: right; white-space: nowrap;">
                    <!-- Whole-slice changes link to /admin/classify rather than implementing a second mutation path -->
                    <a
                      href="/admin/classify?date={encodeURIComponent(row.date)}&projectId={row.projectId}&entity={encodeURIComponent(row.entity)}"
                      class="button ghost sm"
                      aria-label="Classify slice {row.entity}"
                    >
                      <SlidersHorizontal size={13} />
                      <span>Classify</span>
                    </a>
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>

      <!-- Pagination bar -->
      {#if activity.pagination.totalPages > 1}
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 20px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted);">
          <span>
            Showing page {activity.pagination.page} of {activity.pagination.totalPages}
            ({activity.pagination.totalItems.toLocaleString()} total slices)
          </span>

          <div style="display: flex; gap: 8px;">
            {#if activity.pagination.hasPrevPage}
              <a
                href={buildFilterUrl({ page: activity.pagination.page - 1 })}
                class="button secondary sm"
                aria-label="Previous page"
              >
                <ChevronLeft size={14} />
                <span>Previous</span>
              </a>
            {:else}
              <button type="button" class="button ghost sm" disabled aria-label="Previous page">
                <ChevronLeft size={14} />
                <span>Previous</span>
              </button>
            {/if}

            {#if activity.pagination.hasNextPage}
              <a
                href={buildFilterUrl({ page: activity.pagination.page + 1 })}
                class="button secondary sm"
                aria-label="Next page"
              >
                <span>Next</span>
                <ChevronRight size={14} />
              </a>
            {:else}
              <button type="button" class="button ghost sm" disabled aria-label="Next page">
                <span>Next</span>
                <ChevronRight size={14} />
              </button>
            {/if}
          </div>
        </div>
      {/if}
    </section>
  </div>
</AppShell>
