<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import type { SubmitFunction } from '@sveltejs/kit';
  import AppShell from '$lib/components/AppShell.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import type { PageData, ActionData } from './$types';
  import type { SelectorType, MatchMode } from '$lib/server/classification/model';
  import type {
    ClassificationCoverage,
    ClassificationRevisionRecord,
    ClassificationRuleRecord,
    DailyTimeAllocationRecord,
    EvaluatedSlice,
    UnclassifiedSuggestion
  } from '$lib/server/classification/sqlite';
  import {
    Activity,
    AlertTriangle,
    ArrowDown,
    Calendar,
    Check,
    CircleAlert,
    ExternalLink,
    FileCode,
    FolderKanban,
    Globe,
    HardDrive,
    History,
    Info,
    Laptop,
    Layers,
    Pencil,
    SlidersHorizontal,
    Terminal,
    Trash2,
    WandSparkles
  } from '@lucide/svelte';

  let { data, form } = $props<{
    data?: PageData;
    form?: ActionData;
  }>();

  const defaultCoverage: ClassificationCoverage = {
    totalSeconds: 0,
    classifiedSeconds: 0,
    workSeconds: 0,
    personalSeconds: 0,
    unclassifiedSeconds: 0,
    coverageRatio: 1,
    coveragePercentage: 100,
    totalSlices: 0,
    workSlices: 0,
    personalSlices: 0,
    unclassifiedSlices: 0,
    daysCovered: 0
  };

  let coverage = $derived(data?.coverage ?? defaultCoverage);
  let rules = $derived<ClassificationRuleRecord[]>(data?.rules ?? []);
  let allocations = $derived<DailyTimeAllocationRecord[]>(data?.allocations ?? []);
  let revisions = $derived<ClassificationRevisionRecord[]>(data?.revisions ?? []);
  let suggestions = $derived<UnclassifiedSuggestion[]>(data?.suggestions ?? []);
  let recentSlices = $derived<EvaluatedSlice[]>(data?.recentSlices ?? []);
  let csrfToken = $derived<string | null>(data?.csrfToken ?? null);
  let machineNames = $derived<Record<string, string>>(data?.machineNames ?? {});
  let editorNames = $derived<Record<string, string>>(data?.editorNames ?? {});

  function formatSelectorDisplay(type: SelectorType | string, value: string): string {
    if (type === 'machine' && machineNames[value]) return machineNames[value];
    if (type === 'editor' && editorNames[value]) return editorNames[value];
    return value;
  }

  // Navigation tab state
  const ALL_SELECTOR_TYPES: readonly SelectorType[] = [
    'machine',
    'editor',
    'application',
    'domain',
    'project',
    'folder_prefix',
    'entity'
  ] as const;

  function isValidSelectorType(val: unknown): val is SelectorType {
    return typeof val === 'string' && ALL_SELECTOR_TYPES.includes(val as SelectorType);
  }

  function getInitialTab(): 'suggestions' | 'rules' | 'overrides' | 'revisions' {
    const fromUrl = page?.url?.searchParams?.get('tab');
    if (fromUrl === 'suggestions' || fromUrl === 'rules' || fromUrl === 'overrides' || fromUrl === 'revisions') {
      return fromUrl;
    }
    const fromForm = form?.returnTab;
    if (fromForm === 'suggestions' || fromForm === 'rules' || fromForm === 'overrides' || fromForm === 'revisions') {
      return fromForm;
    }
    if (typeof window !== 'undefined') {
      try {
        const stored = sessionStorage.getItem('wt_classify_tab');
        if (stored === 'suggestions' || stored === 'rules' || stored === 'overrides' || stored === 'revisions') {
          return stored;
        }
      } catch {}
    }
    return 'suggestions';
  }

  function getInitialSelector(): 'all' | SelectorType {
    const fromUrl = page?.url?.searchParams?.get('selector');
    if (fromUrl === 'all' || isValidSelectorType(fromUrl)) {
      return fromUrl as 'all' | SelectorType;
    }
    const fromForm = form?.returnSelector;
    if (fromForm === 'all' || isValidSelectorType(fromForm)) {
      return fromForm as 'all' | SelectorType;
    }
    if (typeof window !== 'undefined') {
      try {
        const stored = sessionStorage.getItem('wt_classify_selector');
        if (stored === 'all' || isValidSelectorType(stored)) {
          return stored as 'all' | SelectorType;
        }
      } catch {}
    }
    return 'all';
  }

  let currentTab = $state<'suggestions' | 'rules' | 'overrides' | 'revisions'>(getInitialTab());
  let selectedSelectorFilter = $state<'all' | SelectorType>(getInitialSelector());
  let searchQuery = $state('');

  // Re-sync tab or selector if server action returned returnTab or returnSelector
  $effect(() => {
    if (form?.returnTab && (form.returnTab === 'suggestions' || form.returnTab === 'rules' || form.returnTab === 'overrides' || form.returnTab === 'revisions')) {
      currentTab = form.returnTab;
    }
    if (form?.returnSelector && (form.returnSelector === 'all' || isValidSelectorType(form.returnSelector))) {
      selectedSelectorFilter = form.returnSelector;
    }
  });

  // Persist current tab and selector filter in URL and sessionStorage
  $effect(() => {
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.setItem('wt_classify_tab', currentTab);
        sessionStorage.setItem('wt_classify_selector', selectedSelectorFilter);
      } catch {}

      const url = new URL(window.location.href);
      let changed = false;

      if (currentTab !== 'suggestions') {
        if (url.searchParams.get('tab') !== currentTab) {
          url.searchParams.set('tab', currentTab);
          changed = true;
        }
      } else if (url.searchParams.has('tab')) {
        url.searchParams.delete('tab');
        changed = true;
      }

      if (selectedSelectorFilter !== 'all') {
        if (url.searchParams.get('selector') !== selectedSelectorFilter) {
          url.searchParams.set('selector', selectedSelectorFilter);
          changed = true;
        }
      } else if (url.searchParams.has('selector')) {
        url.searchParams.delete('selector');
        changed = true;
      }

      if (changed) {
        window.history.replaceState(null, '', url.toString());
      }
    }
  });

  const preserveStateEnhance: SubmitFunction = () => {
    return async ({ update }) => {
      await update({ reset: false });
    };
  };

  // Suggestion selection and rule proposal state
  let selectedSuggestionKey = $state<string | null>(null);
  let proposalChoice = $state<'work' | 'personal'>('work');
  let proposalName = $state('');
  let proposalMatchMode = $state<MatchMode>('exact');
  let proposalPriority = $state(0);
  let proposalTimesheetCode = $state('');

  // Whole-slice override state
  let overrideModalOpen = $state(false);
  let selectedSliceForOverride = $state<EvaluatedSlice | null>(null);
  let overrideDate = $state('');
  let overrideProjectId = $state<number>(0);
  let overrideEntity = $state('');
  let overrideChoice = $state<'work' | 'personal'>('work');
  let overrideTimesheetCode = $state('');
  let overrideNote = $state('');

  // Rule editing state
  let editRuleModalOpen = $state(false);
  let editRuleId = $state('');
  let editRuleName = $state('');
  let editRuleClassification = $state<'work' | 'personal'>('work');
  let editRuleSelectorType = $state<SelectorType>('project');
  let editRuleSelectorValue = $state('');
  let editRuleMatchMode = $state<MatchMode>('exact');
  let editRulePriority = $state(0);
  let editRuleEnabled = $state(true);
  let editRuleTimesheetCode = $state('');

  function openEditRule(rule: ClassificationRuleRecord) {
    editRuleId = rule.id;
    editRuleName = rule.name;
    editRuleClassification = rule.classification;
    editRuleSelectorType = rule.selector_type;
    // Friendly labels are presentation-only. Preserve the canonical selector
    // value so editing an unrelated field cannot silently change rule scope.
    editRuleSelectorValue = rule.selector_value;
    editRuleMatchMode = rule.match_mode ?? 'exact';
    editRulePriority = rule.priority;
    editRuleEnabled = rule.enabled;
    editRuleTimesheetCode = rule.timesheet_code ?? '';
    editRuleModalOpen = true;
  }

  // Two-step rule confirmation modal state
  let showConfirmModal = $state(false);

  // Sync confirm modal with server action result
  $effect(() => {
    if (form?.success && form?.preview && form?.proposal) {
      showConfirmModal = true;
      editRuleModalOpen = false;
    }
    if (form?.confirmed) {
      showConfirmModal = false;
      selectedSuggestionKey = null;
      proposalName = '';
      proposalMatchMode = 'exact';
      proposalTimesheetCode = '';
      proposalPriority = 0;
    }
    if (form?.success && !form?.preview) {
      overrideModalOpen = false;
    }
  });

  // When user selects a slice in the override modal
  function selectSlice(slice: EvaluatedSlice) {
    selectedSliceForOverride = slice;
    overrideDate = slice.date;
    overrideProjectId = slice.projectId;
    overrideEntity = slice.entity;
    overrideChoice = slice.decision.classification === 'personal' ? 'work' : 'personal';
  }

  function formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0) return '0m';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.round(seconds % 60);
    if (hours > 0) {
      return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    if (minutes > 0) {
      return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
    }
    return `${secs}s`;
  }

  function formatDisplayDate(iso: string): string {
    if (!iso) return '—';
    const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return iso;
    const [, year, month, day] = match;
    return `${day}/${month}/${year}`;
  }

  function formatTimeframe(earliest?: string | null, latest?: string | null): string {
    if (!earliest && !latest) return '—';
    const start = earliest ? formatDisplayDate(earliest) : null;
    const end = latest ? formatDisplayDate(latest) : null;
    if (start && end) {
      return start === end ? start : `${start} -> ${end}`;
    }
    return start ?? end ?? '—';
  }

  function activityDrilldownUrl(suggestion: UnclassifiedSuggestion): string {
    const params = new URLSearchParams({
      selectorType: suggestion.selectorType,
      selectorValue: suggestion.selectorValue,
      classification: 'unclassified'
    });
    if (suggestion.earliestDate && suggestion.latestDate) {
      params.set('startDate', suggestion.earliestDate);
      params.set('endDate', suggestion.latestDate);
    }
    return `/admin/activity?${params.toString()}`;
  }

  function getSelectorIcon(type: SelectorType) {
    switch (type) {
      case 'machine':
        return HardDrive;
      case 'editor':
        return Terminal;
      case 'application':
        return Laptop;
      case 'domain':
        return Globe;
      case 'project':
        return FolderKanban;
      case 'folder_prefix':
        return ArrowDown;
      case 'entity':
        return FileCode;
    }
  }

  function getSelectorSpecificity(type: SelectorType): number {
    switch (type) {
      case 'machine':
      case 'editor':
      case 'application':
      case 'domain':
        return 10;
      case 'project':
        return 40;
      case 'folder_prefix':
        return 50;
      case 'entity':
        return 60;
      default:
        return 10;
    }
  }

  let candidateCounts = $derived.by(() => {
    const counts: Record<SelectorType, number> = {
      machine: 0,
      editor: 0,
      application: 0,
      domain: 0,
      project: 0,
      folder_prefix: 0,
      entity: 0
    };
    for (const s of suggestions) {
      if (s.selectorType in counts) {
        counts[s.selectorType]++;
      }
    }
    return counts;
  });

  let filteredSuggestions = $derived(
    suggestions.filter((s: UnclassifiedSuggestion) => {
      if (selectedSelectorFilter !== 'all' && s.selectorType !== selectedSelectorFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          s.selectorValue.toLowerCase().includes(q) ||
          s.displayValue.toLowerCase().includes(q) ||
          s.selectorType.toLowerCase().includes(q) ||
          s.sampleEntities.some((e: string) => e.toLowerCase().includes(q)) ||
          s.sampleProjects.some((p: string) => p.toLowerCase().includes(q))
        );
      }
      return true;
    })
  );

  let activeSuggestion = $derived<UnclassifiedSuggestion | null>(
    suggestions.find((s: UnclassifiedSuggestion) => `${s.selectorType}:${s.selectorValue}` === selectedSuggestionKey) ??
      filteredSuggestions[0] ??
      null
  );

  // Auto-generate proposal name when active suggestion changes
  $effect(() => {
    if (activeSuggestion) {
      proposalName = `${proposalChoice === 'work' ? 'Work' : 'Personal'} ${activeSuggestion.selectorType}: ${activeSuggestion.displayValue}`;
      proposalMatchMode = activeSuggestion.matchMode ?? 'exact';
    }
  });

  let activeRulesCount = $derived(rules.filter((r: ClassificationRuleRecord) => r.enabled).length);
</script>

<svelte:head>
  <title>Classification Admin — Work Times</title>
</svelte:head>

<AppShell>
  <header class="page-header">
    <div>
      <p class="eyebrow">Classification inbox</p>
      <h1>Teach the archive what counts as work.</h1>
      <p class="lede">
        Start broad, then establish narrower exceptions. Every confirmed decision previews its
        historical impact, highlights work↔personal conflicts, and becomes a deterministic rule.
      </p>
    </div>
    <div class="header-actions">
      <button
        type="button"
        class="button secondary"
        onclick={() => {
          overrideModalOpen = true;
          if (recentSlices.length > 0 && !selectedSliceForOverride) {
            selectSlice(recentSlices[0]);
          }
        }}
      >
        <Layers size={15} />
        <span>One-off Slice Override</span>
      </button>
    </div>
  </header>

  <!-- Real All-History Metrics Coverage summary -->
  <section class="metrics" aria-label="Classification coverage statistics">
    <article>
      <span>Classified coverage</span>
      <strong>{coverage.coveragePercentage.toFixed(1)}%</strong>
      <small>{formatDuration(coverage.workSeconds)} Work · {formatDuration(coverage.personalSeconds)} Personal</small>
    </article>
    <article>
      <span>Unclassified backlog</span>
      <strong>{formatDuration(coverage.unclassifiedSeconds)}</strong>
      <small>{suggestions.length} suggestions · {coverage.unclassifiedSlices} slices</small>
    </article>
    <article>
      <span>Active rules</span>
      <strong>{activeRulesCount} active</strong>
      <small>{rules.length} total rules · {allocations.length} slice overrides</small>
    </article>
  </section>

  <!-- Server Feedback Notices -->
  {#if form?.confirmed}
    <div class="notice info" role="status" style="max-width: 1180px; margin: 0 auto 20px;">
      <Check size={16} />
      <span>Rule change successfully confirmed and applied. Raw telemetry remains immutable.</span>
    </div>
  {:else if form?.success && form?.allocation}
    <div class="notice info" role="status" style="max-width: 1180px; margin: 0 auto 20px;">
      <Check size={16} />
      <span>
        Whole-slice override applied: official day/project/entity slice pinned as {form.allocation.classification.toUpperCase()} without modifying reusable rules.
      </span>
    </div>
  {:else if form?.conflict}
    <div class="notice warning" role="alert" style="max-width: 1180px; margin: 0 auto 20px; flex-direction: column; gap: 8px;">
      <div style="display: flex; gap: 10px; align-items: center;">
        <AlertTriangle size={18} />
        <div>
          <strong>Allocation Conflict Detected</strong>
          <p style="margin: 2px 0 0; font-size: 12px;">
            Slice on {form.targetSlice?.date} (project {form.targetSlice?.projectId}, entity '{form.targetSlice?.entity}') is already classified as <b>{form.existingClassification?.toUpperCase()}</b>. Proposed: <b>{form.proposedClassification?.toUpperCase()}</b>. Overwrites are not automatic.
          </p>
        </div>
      </div>
      <form method="POST" action="?/replaceAllocation" style="margin-top: 6px;" use:enhance={preserveStateEnhance}>
        <input type="hidden" name="csrfToken" value={csrfToken ?? ''} />
        <input type="hidden" name="returnTab" value={currentTab} />
        <input type="hidden" name="returnSelector" value={selectedSelectorFilter} />
        <input type="hidden" name="date" value={form.targetSlice?.date ?? ''} />
        <input type="hidden" name="projectId" value={form.targetSlice?.projectId ?? 0} />
        <input type="hidden" name="entity" value={form.targetSlice?.entity ?? ''} />
        <input type="hidden" name="classification" value={form.targetSlice?.classification ?? 'work'} />
        <input type="hidden" name="timesheetCode" value={form.targetSlice?.timesheetCode ?? ''} />
        <input type="hidden" name="note" value={form.targetSlice?.note ?? ''} />
        <button type="submit" class="button primary sm">
          Confirm Replacement (Replace Existing Allocation)
        </button>
      </form>
    </div>
  {:else if form?.stale}
    <div class="notice danger" role="alert" style="max-width: 1180px; margin: 0 auto 20px;">
      <AlertTriangle size={16} />
      <span>{form.error || 'Stale preview: The classification database revision has changed or the proposal was altered. Please review a fresh preview.'}</span>
    </div>
  {:else if form?.error}
    <div class="notice danger" role="alert" style="max-width: 1180px; margin: 0 auto 20px;">
      <AlertTriangle size={16} />
      <span>{form.error}</span>
    </div>
  {/if}

  <!-- Main View Navigation Tabs -->
  <div style="max-width: 1180px; margin: 0 auto 18px; border-bottom: 1px solid var(--border); display: flex; gap: 12px; overflow-x: auto; padding-bottom: 4px;">
    <button
      type="button"
      class="button sm {currentTab === 'suggestions' ? 'primary' : 'ghost'}"
      onclick={() => (currentTab = 'suggestions')}
    >
      <WandSparkles size={14} />
      <span>Suggestions Queue ({suggestions.length})</span>
    </button>
    <button
      type="button"
      class="button sm {currentTab === 'rules' ? 'primary' : 'ghost'}"
      onclick={() => (currentTab = 'rules')}
    >
      <SlidersHorizontal size={14} />
      <span>Active Rules ({rules.length})</span>
    </button>
    <button
      type="button"
      class="button sm {currentTab === 'overrides' ? 'primary' : 'ghost'}"
      onclick={() => (currentTab = 'overrides')}
    >
      <Layers size={14} />
      <span>Slice Overrides ({allocations.length})</span>
    </button>
    <button
      type="button"
      class="button sm {currentTab === 'revisions' ? 'primary' : 'ghost'}"
      onclick={() => (currentTab = 'revisions')}
    >
      <History size={14} />
      <span>Audit Log ({revisions.length})</span>
    </button>
  </div>

  <!-- TAB: SUGGESTIONS QUEUE -->
  {#if currentTab === 'suggestions'}
    <!-- Selector Filter Bar for all 7 selectors -->
    <div style="max-width: 1180px; margin: 0 auto 16px; overflow-x: auto;">
      <div style="display: flex; gap: 6px; padding-bottom: 4px;">
        <button
          type="button"
          class="button sm {selectedSelectorFilter === 'all' ? 'secondary' : 'ghost'}"
          onclick={() => (selectedSelectorFilter = 'all')}
        >
          All Selectors ({suggestions.length})
        </button>
        <button
          type="button"
          class="button sm {selectedSelectorFilter === 'machine' ? 'secondary' : 'ghost'}"
          onclick={() => (selectedSelectorFilter = 'machine')}
        >
          Machine ({candidateCounts.machine})
        </button>
        <button
          type="button"
          class="button sm {selectedSelectorFilter === 'editor' ? 'secondary' : 'ghost'}"
          onclick={() => (selectedSelectorFilter = 'editor')}
        >
          Editor ({candidateCounts.editor})
        </button>
        <button
          type="button"
          class="button sm {selectedSelectorFilter === 'application' ? 'secondary' : 'ghost'}"
          onclick={() => (selectedSelectorFilter = 'application')}
        >
          App ({candidateCounts.application})
        </button>
        <button
          type="button"
          class="button sm {selectedSelectorFilter === 'domain' ? 'secondary' : 'ghost'}"
          onclick={() => (selectedSelectorFilter = 'domain')}
        >
          Domain ({candidateCounts.domain})
        </button>
        <button
          type="button"
          class="button sm {selectedSelectorFilter === 'project' ? 'secondary' : 'ghost'}"
          onclick={() => (selectedSelectorFilter = 'project')}
        >
          Project ({candidateCounts.project})
        </button>
        <button
          type="button"
          class="button sm {selectedSelectorFilter === 'folder_prefix' ? 'secondary' : 'ghost'}"
          onclick={() => (selectedSelectorFilter = 'folder_prefix')}
        >
          Folder ({candidateCounts.folder_prefix})
        </button>
        <button
          type="button"
          class="button sm {selectedSelectorFilter === 'entity' ? 'secondary' : 'ghost'}"
          onclick={() => (selectedSelectorFilter = 'entity')}
        >
          Entity ({candidateCounts.entity})
        </button>
      </div>
    </div>

    <div class="content-grid">
      <!-- Left Column: Decision Queue -->
      <section class="panel queue-panel" aria-labelledby="inbox-heading">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Decision Queue</p>
            <h2 id="inbox-heading">Unclassified Candidates</h2>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <input
              type="text"
              placeholder="Filter candidates…"
              bind:value={searchQuery}
              class="form-input"
              style="padding: 5px 10px; font-size: 12px; width: 160px;"
              aria-label="Filter candidates by keyword"
            />
            <span class="badge neutral">{filteredSuggestions.length} candidates</span>
          </div>
        </div>

        <div class="notice">
          <CircleAlert size={17} />
          <span>
            Suggestions never auto-apply. Telemetry that cannot be attributed with full
            certainty stays unclassified. Select an identity to preview impact.
          </span>
        </div>

        {#if filteredSuggestions.length === 0}
          <div class="preview-empty">
            <div class="preview-orbit"><Check size={22} /></div>
            <strong>No Unclassified Candidates</strong>
            <p>
              {#if suggestions.length === 0}
                The unclassified backlog is empty! All observed telemetry is classified.
              {:else}
                No candidates match the current filter criteria.
              {/if}
            </p>
          </div>
        {:else}
          <div class="candidate-list">
            {#each filteredSuggestions as suggestion}
              {@const IconComponent = getSelectorIcon(suggestion.selectorType)}
              {@const isSelected = activeSuggestion && activeSuggestion.selectorType === suggestion.selectorType && activeSuggestion.selectorValue === suggestion.selectorValue}
              <div
                class="candidate"
                class:selected={isSelected}
                onclick={() => (selectedSuggestionKey = `${suggestion.selectorType}:${suggestion.selectorValue}`)}
                onkeydown={(e) => {
                  if (e.key === 'Enter') selectedSuggestionKey = `${suggestion.selectorType}:${suggestion.selectorValue}`;
                }}
                tabindex="0"
                role="button"
                aria-label="Inspect candidate {suggestion.displayValue}"
              >
                <div class="candidate-icon" aria-hidden="true">
                  <IconComponent size={18} />
                </div>
                <div class="candidate-copy">
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span class="candidate-kind">{suggestion.selectorType}</span>
                    <span class="badge neutral" style="font-size: 9px; height: 18px; padding: 0 5px;">
                      Rank {suggestion.specificity}
                    </span>
                  </div>
                  <strong>{suggestion.displayValue}</strong>
                  <small>
                    {#if suggestion.sampleProjects.length > 0}
                      Projects: {suggestion.sampleProjects.join(', ')}
                    {:else if suggestion.sampleEntities.length > 0}
                      Files: {suggestion.sampleEntities.join(', ')}
                    {:else}
                      Unclassified activity
                    {/if}
                  </small>
                </div>
                <div class="candidate-volume">
                  <strong>{formatDuration(suggestion.unclassifiedSeconds)}</strong>
                  <small>{suggestion.sliceCount} slices</small>
                </div>
                <div class="choice-group" aria-label="Classify {suggestion.displayValue}">
                  <button
                    type="button"
                    class:chosen-work={isSelected && proposalChoice === 'work'}
                    onclick={(e) => {
                      e.stopPropagation();
                      selectedSuggestionKey = `${suggestion.selectorType}:${suggestion.selectorValue}`;
                      proposalChoice = 'work';
                    }}
                    aria-pressed={isSelected && proposalChoice === 'work'}
                  >
                    Work
                  </button>
                  <button
                    type="button"
                    class:chosen-personal={isSelected && proposalChoice === 'personal'}
                    onclick={(e) => {
                      e.stopPropagation();
                      selectedSuggestionKey = `${suggestion.selectorType}:${suggestion.selectorValue}`;
                      proposalChoice = 'personal';
                    }}
                    aria-pressed={isSelected && proposalChoice === 'personal'}
                  >
                    Personal
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <!-- Right Column: Proposal Staging & Precedence Reference -->
      <aside class="panel preview-panel" aria-labelledby="preview-heading">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Real-Time Impact Preview</p>
            <h2 id="preview-heading">Deterministic Impact</h2>
          </div>
          <span class="badge safe">
            <Check size={12} /> Two-Step Flow
          </span>
        </div>

        {#if activeSuggestion}
          <div style="padding: 20px 22px; border-bottom: 1px solid var(--border);">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
              <span style="font-size: 11px; color: var(--faint); text-transform: uppercase; font-weight: 700; letter-spacing: 0.1em;">
                Target Identity
              </span>
              <span class="badge accent">{activeSuggestion.selectorType} (Rank {activeSuggestion.specificity})</span>
            </div>
            <strong style="font-size: 15px; color: var(--text); display: block; word-break: break-all;">
              {activeSuggestion.displayValue}
            </strong>
            <p style="margin: 6px 0 16px; font-size: 12px; color: var(--muted);">
              {#if activeSuggestion.sampleProjects.length > 0}
                Associated with: {activeSuggestion.sampleProjects.join(', ')}
              {:else if activeSuggestion.sampleEntities.length > 0}
                Sample path: {activeSuggestion.sampleEntities.join(', ')}
              {:else}
                Broad unclassified telemetry identifier
              {/if}
            </p>

            <div style="background: #10100e; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px;">
              <div>
                <span style="font-size: 11px; color: var(--faint);">Unclassified Time</span>
                <strong style="display: block; font-size: 16px; color: var(--text); margin-top: 2px;">
                  {formatDuration(activeSuggestion.unclassifiedSeconds)}
                </strong>
              </div>
              <div>
                <span style="font-size: 11px; color: var(--faint);">Target Slices</span>
                <strong style="display: block; font-size: 16px; color: var(--text); margin-top: 2px;">
                  {activeSuggestion.sliceCount} slices
                </strong>
              </div>
              <div style="grid-column: 1 / -1; border-top: 1px solid var(--border); padding-top: 8px; margin-top: 2px;">
                <span style="font-size: 11px; color: var(--faint); display: flex; align-items: center; gap: 4px;">
                  <Calendar size={12} style="color: var(--muted);" />
                  <span>Timeframe</span>
                </span>
                <strong style="display: block; font-size: 13px; color: var(--text); margin-top: 3px; font-family: ui-monospace, monospace; letter-spacing: -0.01em;">
                  {formatTimeframe(activeSuggestion.earliestDate, activeSuggestion.latestDate)}
                </strong>
              </div>
            </div>

            <!-- Activity Explorer Drilldown Link -->
            <div style="margin-bottom: 16px;">
              <a
                href={activityDrilldownUrl(activeSuggestion)}
                target="_blank"
                rel="noreferrer"
                class="button secondary sm"
                style="width: 100%; justify-content: center; gap: 6px; font-size: 12px;"
              >
                <Activity size={13} />
                <span>Inspect {activeSuggestion.sliceCount} slices in Activity</span>
                <ExternalLink size={12} style="color: var(--faint);" />
              </a>
            </div>

            <!-- Staging Proposal Form -->
            <form
              method="POST"
              action="?/previewRule"
              style="display: flex; flex-direction: column; gap: 12px;"
              use:enhance={preserveStateEnhance}
            >
              <input type="hidden" name="csrfToken" value={csrfToken ?? ''} />
              <input type="hidden" name="returnTab" value={currentTab} />
              <input type="hidden" name="returnSelector" value={selectedSelectorFilter} />
              <input type="hidden" name="type" value="create" />
              <input type="hidden" name="selectorType" value={activeSuggestion.selectorType} />
              <input type="hidden" name="selectorValue" value={activeSuggestion.selectorValue} />
              <input type="hidden" name="classification" value={proposalChoice} />
              <input type="hidden" name="matchMode" value={proposalMatchMode} />

              <div class="form-group">
                <span class="form-label">Match Mode</span>
                <div style="display: flex; gap: 8px; margin-top: 4px;">
                  <button
                    type="button"
                    class="button {proposalMatchMode === 'exact' ? 'primary' : 'secondary'}"
                    style="flex: 1;"
                    onclick={() => (proposalMatchMode = 'exact')}
                  >
                    Exact
                  </button>
                  <button
                    type="button"
                    class="button {proposalMatchMode === 'glob' ? 'primary' : 'secondary'}"
                    style="flex: 1;"
                    onclick={() => (proposalMatchMode = 'glob')}
                  >
                    Glob Pattern
                  </button>
                </div>
                <span class="form-hint">
                  {#if proposalMatchMode === 'glob'}
                    Wildcards: <code>*</code> matches zero or more characters; <code>?</code> matches one character. Use <code>[*]</code> or <code>[?]</code> for literal characters.
                  {:else}
                    Matches exact string without interpreting wildcards.
                  {/if}
                </span>
              </div>

              <div class="form-group">
                <label for="rule-name" class="form-label">
                  <span>Rule Name</span>
                </label>
                <input
                  id="rule-name"
                  name="name"
                  type="text"
                  bind:value={proposalName}
                  class="form-input"
                  required
                />
              </div>

              <div style="display: flex; gap: 10px;">
                <div class="form-group" style="flex: 1;">
                  <label for="rule-priority" class="form-label">
                    <span>Operator Priority</span>
                  </label>
                  <input
                    id="rule-priority"
                    name="priority"
                    type="number"
                    bind:value={proposalPriority}
                    class="form-input"
                    min="0"
                  />
                  <span class="form-hint">Evaluated before specificity rank.</span>
                </div>
                <div class="form-group" style="flex: 1;">
                  <label for="rule-timesheet" class="form-label">
                    <span>Timesheet Code (Optional)</span>
                  </label>
                  <input
                    id="rule-timesheet"
                    name="timesheetCode"
                    type="text"
                    bind:value={proposalTimesheetCode}
                    class="form-input"
                    placeholder="e.g. CLIENT-01"
                  />
                </div>
              </div>

              <div class="form-group">
                <span class="form-label">Classification Assignment</span>
                <div style="display: flex; gap: 8px; margin-top: 4px;">
                  <button
                    type="button"
                    class="button {proposalChoice === 'work' ? 'primary' : 'secondary'}"
                    style="flex: 1;"
                    onclick={() => (proposalChoice = 'work')}
                  >
                    Work
                  </button>
                  <button
                    type="button"
                    class="button {proposalChoice === 'personal' ? 'primary' : 'secondary'}"
                    style="flex: 1;"
                    onclick={() => (proposalChoice = 'personal')}
                  >
                    Personal
                  </button>
                </div>
              </div>

              <button type="submit" class="button primary" style="width: 100%; margin-top: 6px;">
                <WandSparkles size={15} />
                <span>Preview Impact & Verify</span>
              </button>
            </form>
          </div>
        {:else}
          <div class="preview-empty">
            <div class="preview-orbit"><WandSparkles size={22} /></div>
            <strong>Select an Identity to Preview</strong>
            <p>
              Choose an identity from the queue to see affected telemetry, specificity ranking,
              and historical shift breakdown.
            </p>
          </div>
        {/if}

        <!-- Precedence Hierarchy Display -->
        <div class="precedence">
          <span>Precedence & Ambiguity Hierarchy</span>
          <ol>
            <li>
              <b>0</b>
              <span>Whole-Slice Override (Official day/project/entity slice bypasses all rules)</span>
            </li>
            <li>
              <b>1</b>
              <span>Manual Priority (Operator-defined integer priority evaluated first)</span>
            </li>
            <li>
              <b>2</b>
              <span>Entity [60] (File, application, or domain exact match)</span>
            </li>
            <li>
              <b>3</b>
              <span>Folder Prefix [50] (Longer normalized prefix wins over shorter prefix)</span>
            </li>
            <li>
              <b>4</b>
              <span>Project [40] (WakaTime canonical project identity)</span>
            </li>
            <li>
              <b>5</b>
              <span>Machine / Editor / App / Domain [10] (Equal broad tier)</span>
            </li>
          </ol>

          <div style="margin-top: 14px; padding: 10px 12px; background: #121210; border-radius: var(--radius-sm); font-size: 11px; line-height: 1.5; color: var(--muted); border: 1px solid var(--border);">
            <strong style="color: var(--text); display: block; margin-bottom: 2px;">Ambiguity Rule:</strong>
            Opposing equal-precedence matches (e.g. Work vs Personal on equal-tier rules) resolve to
            <em>Unclassified</em>. Never decided arbitrarily by timestamps.
          </div>
        </div>
      </aside>
    </div>
  {/if}

  <!-- TAB: ACTIVE RULES LIST -->
  {#if currentTab === 'rules'}
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Reusable Rules</p>
          <h2>All Classification Rules ({rules.length})</h2>
        </div>
      </div>

      {#if rules.length === 0}
        <div class="preview-empty">
          <div class="preview-orbit"><SlidersHorizontal size={22} /></div>
          <strong>No Rules Configured</strong>
          <p>Create your first classification rule from the Suggestions Queue above.</p>
        </div>
      {:else}
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Rule Name</th>
                <th>Classification</th>
                <th>Selector Type</th>
                <th>Selector Value</th>
                <th>Mode</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {#each rules as rule}
                <tr>
                  <td>
                    <strong>{rule.name}</strong>
                    {#if rule.timesheet_code}
                      <small style="display: block; color: var(--faint);">Code: {rule.timesheet_code}</small>
                    {/if}
                  </td>
                  <td>
                    <span class="badge {rule.classification}">{rule.classification.toUpperCase()}</span>
                  </td>
                  <td>
                    <span class="badge neutral">{rule.selector_type}</span>
                  </td>
                  <td>
                    <code style="font-size: 12px; color: var(--text);">{rule.display_value || formatSelectorDisplay(rule.selector_type, rule.selector_value)}</code>
                  </td>
                  <td>
                    {#if rule.match_mode === 'glob'}
                      <span class="badge accent">Glob</span>
                    {:else}
                      <span class="badge neutral">Exact</span>
                    {/if}
                  </td>
                  <td>
                    <span>{rule.priority}</span>
                  </td>
                  <td>
                    <span class="badge {rule.enabled ? 'safe' : 'neutral'}">
                      {rule.enabled ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td>
                    <small>{rule.created_at.slice(0, 10)}</small>
                  </td>
                  <td style="white-space: nowrap;">
                    <button
                      type="button"
                      class="button ghost sm"
                      onclick={() => openEditRule(rule)}
                      aria-label="Edit rule {rule.name}"
                    >
                      <Pencil size={13} />
                      <span>Edit</span>
                    </button>
                    <form method="POST" action="?/previewRule" style="display: inline;" use:enhance={preserveStateEnhance}>
                      <input type="hidden" name="csrfToken" value={csrfToken ?? ''} />
                      <input type="hidden" name="returnTab" value={currentTab} />
                      <input type="hidden" name="returnSelector" value={selectedSelectorFilter} />
                      <input type="hidden" name="type" value="delete" />
                      <input type="hidden" name="id" value={rule.id} />
                      <button type="submit" class="button ghost sm" style="color: var(--danger);" aria-label="Delete rule {rule.name}">
                        <Trash2 size={13} />
                        <span>Delete</span>
                      </button>
                    </form>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}

  <!-- TAB: WHOLE-SLICE OVERRIDES -->
  {#if currentTab === 'overrides'}
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Whole-slice override system</p>
          <h2>Single-Slice Overrides (Immutable Raw Telemetry)</h2>
        </div>
        <button
          type="button"
          class="button primary sm"
          onclick={() => {
            overrideModalOpen = true;
            if (recentSlices.length > 0 && !selectedSliceForOverride) {
              selectSlice(recentSlices[0]);
            }
          }}
        >
          <Layers size={14} />
          <span>New Slice Override</span>
        </button>
      </div>

      <div style="padding: 20px 22px;">
        <div class="notice info" style="margin: 0 0 20px;">
          <Info size={16} />
          <div>
            <strong>Whole-slice override definition:</strong>
            A whole-slice override applies directly to one official day/project/entity slice as Work or Personal.
            It completely bypasses all reusable classification rules for that specific slice without modifying
            raw telemetry.
          </div>
        </div>

        {#if allocations.length === 0}
          <div class="preview-empty">
            <div class="preview-orbit"><Layers size={22} /></div>
            <strong>No Whole-Slice Overrides</strong>
            <p>
              Single-slice overrides bypass all rules for a specific official day/project/entity slice.
            </p>
          </div>
        {:else}
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Project ID</th>
                  <th>Entity</th>
                  <th>Classification</th>
                  <th>Allocated Time</th>
                  <th>Note</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {#each allocations as alloc}
                  <tr>
                    <td><strong>{alloc.date}</strong></td>
                    <td><span>Project #{alloc.project_id}</span></td>
                    <td><code style="font-size: 12px;">{alloc.entity}</code></td>
                    <td>
                      <span class="badge {alloc.classification}">{alloc.classification.toUpperCase()}</span>
                    </td>
                    <td><span>{formatDuration(alloc.allocated_seconds)}</span></td>
                    <td><small>{alloc.note || '—'}</small></td>
                    <td>
                      <form method="POST" action="?/deleteAllocation" style="display: inline;" use:enhance={preserveStateEnhance}>
                        <input type="hidden" name="csrfToken" value={csrfToken ?? ''} />
                        <input type="hidden" name="returnTab" value={currentTab} />
                        <input type="hidden" name="returnSelector" value={selectedSelectorFilter} />
                        <input type="hidden" name="id" value={alloc.id} />
                        <button type="submit" class="button ghost sm" style="color: var(--danger);">
                          <Trash2 size={13} />
                          <span>Remove</span>
                        </button>
                      </form>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    </section>
  {/if}

  <!-- TAB: AUDIT LOG (REVISIONS) -->
  {#if currentTab === 'revisions'}
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Audit Trail</p>
          <h2>Classification Revisions ({revisions.length})</h2>
        </div>
      </div>

      {#if revisions.length === 0}
        <div class="preview-empty">
          <div class="preview-orbit"><History size={22} /></div>
          <strong>No Revisions Recorded</strong>
          <p>Any mutations to classification rules or whole-slice overrides will be logged here.</p>
        </div>
      {:else}
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Mutation</th>
                <th>Target</th>
                <th>Target ID</th>
                <th>Actor</th>
                <th>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {#each revisions as rev}
                <tr>
                  <td><code>#{rev.id}</code></td>
                  <td><span class="badge neutral">{rev.mutation_type}</span></td>
                  <td><span>{rev.target_type}</span></td>
                  <td><code style="font-size: 11px;">{rev.target_id}</code></td>
                  <td><span>{rev.actor}</span></td>
                  <td><small>{rev.created_at}</small></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}
</AppShell>

<!-- TWO-STEP RULE CONFIRMATION MODAL -->
{#if form?.success && form?.preview && form?.proposal && showConfirmModal}
  {@const preview = form.preview}
  {@const proposal = form.proposal}
  <Modal
    open={showConfirmModal}
    title="Confirm Rule Application"
    description="Review deterministic historical telemetry impact before committing this rule to the database."
    onclose={() => (showConfirmModal = false)}
    maxWidth="580px"
  >
    <div style="display: flex; flex-direction: column; gap: 16px;">
      <div style="padding: 12px 14px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span style="font-size: 11px; text-transform: uppercase; color: var(--faint); font-weight: 700;">Proposed Rule Action</span>
          <span class="badge neutral">{proposal.type.toUpperCase()}</span>
        </div>
        {#if proposal.type === 'create'}
          <strong style="color: var(--text); display: block;">{proposal.rule.name}</strong>
          <div style="margin-top: 4px; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <span>Matches <code>{proposal.rule.selectorType}: {formatSelectorDisplay(proposal.rule.selectorType, proposal.rule.selectorValue)}</code></span>
            <span class="badge {proposal.rule.matchMode === 'glob' ? 'warning' : 'neutral'}">
              {(proposal.rule.matchMode ?? 'exact').toUpperCase()}
            </span>
            <span>→</span>
            <span class="badge {proposal.rule.classification}">
              {proposal.rule.classification.toUpperCase()}
            </span>
          </div>
        {:else if proposal.type === 'update'}
          <strong style="color: var(--text); display: block;">Update Rule #{proposal.id}</strong>
          <div style="margin-top: 6px; font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 3px;">
            {#if proposal.rule.name}
              <div>Name: <b style="color: var(--text);">{proposal.rule.name}</b></div>
            {/if}
            {#if proposal.rule.matchMode !== undefined}
              <div>Mode: <span class="badge {proposal.rule.matchMode === 'glob' ? 'warning' : 'neutral'}">{proposal.rule.matchMode.toUpperCase()}</span></div>
            {/if}
            {#if proposal.rule.classification}
              <div>
                Classification:
                <span class="badge {proposal.rule.classification}">
                  {proposal.rule.classification.toUpperCase()}
                </span>
              </div>
            {/if}
            {#if proposal.rule.selectorType || proposal.rule.selectorValue}
              <div>Selector: <code>{proposal.rule.selectorType ?? '—'}: {formatSelectorDisplay(proposal.rule.selectorType ?? '', proposal.rule.selectorValue ?? '—')}</code></div>
            {/if}
            {#if proposal.rule.priority !== undefined}
              <div>Priority: <b style="color: var(--text);">{proposal.rule.priority}</b></div>
            {/if}
            {#if proposal.rule.enabled !== undefined}
              <div>Status: <span class="badge {proposal.rule.enabled ? 'safe' : 'neutral'}">{proposal.rule.enabled ? 'Active' : 'Disabled'}</span></div>
            {/if}
            {#if proposal.rule.timesheetCode !== undefined}
              <div>Timesheet: <code>{proposal.rule.timesheetCode || '—'}</code></div>
            {/if}
          </div>
        {:else if proposal.type === 'delete'}
          <strong style="color: var(--text); display: block; color: var(--danger);">Delete Rule #{proposal.id}</strong>
        {/if}
      </div>

      <!-- Historical Impact Surface -->
      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
        <div style="padding: 10px; background: #10100e; border: 1px solid var(--border); border-radius: var(--radius-sm);">
          <span style="font-size: 11px; color: var(--faint);">Matched Slices</span>
          <strong style="display: block; font-size: 16px; color: var(--text); margin-top: 2px;">
            {preview.matchedBeforeCount ?? 0} → {preview.matchedAfterCount ?? 0}
          </strong>
        </div>
        <div style="padding: 10px; background: #10100e; border: 1px solid var(--border); border-radius: var(--radius-sm);">
          <span style="font-size: 11px; color: var(--faint);">Classified Shifted</span>
          <strong style="display: block; font-size: 16px; color: var(--text); margin-top: 2px;">
            {preview.classificationChangedCount ?? preview.affectedSliceCount} slices
          </strong>
        </div>
        <div style="padding: 10px; background: #10100e; border: 1px solid var(--border); border-radius: var(--radius-sm);">
          <span style="font-size: 11px; color: var(--faint);">Affected Dates</span>
          <strong style="display: block; font-size: 16px; color: var(--text); margin-top: 2px;">
            {preview.affectedDates.length} dates
          </strong>
        </div>
      </div>

      {#if (preview.ambiguityTransitions?.toAmbiguous ?? 0) > 0 || (preview.ambiguityTransitions?.fromAmbiguous ?? 0) > 0}
        <div class="notice warning" style="margin: 0;">
          <AlertTriangle size={16} />
          <div>
            <strong>Ambiguity Transitions</strong>
            <div style="font-size: 12px; margin-top: 2px;">
              {#if (preview.ambiguityTransitions?.toAmbiguous ?? 0) > 0}
                <div>Transitioned to Ambiguous (Unclassified): <b>{preview.ambiguityTransitions.toAmbiguous} slices</b></div>
              {/if}
              {#if (preview.ambiguityTransitions?.fromAmbiguous ?? 0) > 0}
                <div>Resolved from Ambiguous: <b>{preview.ambiguityTransitions.fromAmbiguous} slices</b></div>
              {/if}
            </div>
          </div>
        </div>
      {/if}

      {#if preview.sampleSlices && preview.sampleSlices.length > 0}
        <div style="padding: 12px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm);">
          <strong style="font-size: 11px; text-transform: uppercase; color: var(--faint); display: block; margin-bottom: 8px;">
            Sample Affected Slices (up to 5)
          </strong>
          <div style="display: flex; flex-direction: column; gap: 6px; font-size: 12px;">
            {#each preview.sampleSlices.slice(0, 5) as sample}
              <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; border-bottom: 1px solid #1a1a18; padding-bottom: 4px;">
                <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">
                  <span style="color: var(--faint); font-family: monospace; font-size: 11px; margin-right: 6px;">{sample.date}</span>
                  <span title={sample.entity} style="color: var(--text); font-family: monospace;">{sample.entity}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
                  <span class="badge {sample.beforeClassification}" style="font-size: 10px; padding: 2px 4px;">{sample.beforeClassification}</span>
                  <span style="color: var(--faint); font-size: 10px;">→</span>
                  <span class="badge {sample.afterClassification}" style="font-size: 10px; padding: 2px 4px;">{sample.afterClassification}</span>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Shifted Seconds Breakdown -->
      <div style="padding: 14px; background: #11110f; border: 1px solid var(--border); border-radius: var(--radius-sm);">
        <strong style="font-size: 12px; text-transform: uppercase; color: var(--faint); display: block; margin-bottom: 10px;">
          Telemetry Category Shifts
        </strong>

        <!-- Highlight direct work <-> personal shifts -->
        {#if preview.shiftedSeconds.workToPersonal > 0 || preview.shiftedSeconds.personalToWork > 0}
          <div class="notice warning" style="margin: 0 0 12px;">
            <AlertTriangle size={16} />
            <div>
              <strong>Work ↔ Personal Reclassification</strong>
              <div style="font-size: 12px; margin-top: 2px;">
                {#if preview.shiftedSeconds.workToPersonal > 0}
                  <div>Work → Personal: <b>{formatDuration(preview.shiftedSeconds.workToPersonal)}</b></div>
                {/if}
                {#if preview.shiftedSeconds.personalToWork > 0}
                  <div>Personal → Work: <b>{formatDuration(preview.shiftedSeconds.personalToWork)}</b></div>
                {/if}
              </div>
            </div>
          </div>
        {/if}

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12px;">
          <div>
            <span style="color: var(--muted);">Unclassified → Work:</span>
            <strong style="color: var(--work); margin-left: 4px;">{formatDuration(preview.shiftedSeconds.unclassifiedToWork)}</strong>
          </div>
          <div>
            <span style="color: var(--muted);">Unclassified → Personal:</span>
            <strong style="color: var(--personal); margin-left: 4px;">{formatDuration(preview.shiftedSeconds.unclassifiedToPersonal)}</strong>
          </div>
          <div>
            <span style="color: var(--muted);">Work → Unclassified:</span>
            <strong style="color: var(--warning); margin-left: 4px;">{formatDuration(preview.shiftedSeconds.workToUnclassified)}</strong>
          </div>
          <div>
            <span style="color: var(--muted);">Personal → Unclassified:</span>
            <strong style="color: var(--warning); margin-left: 4px;">{formatDuration(preview.shiftedSeconds.personalToUnclassified)}</strong>
          </div>
          <div style="grid-column: span 2; padding-top: 8px; border-top: 1px solid var(--border); display: flex; justify-content: space-between;">
            <span style="color: var(--faint);">Total Reclassified Seconds:</span>
            <strong>{formatDuration(preview.shiftedSeconds.totalShifted)}</strong>
          </div>
        </div>
      </div>

      <div class="notice info" style="margin: 0;">
        <Info size={16} />
        <span>
          Confirmation sends the exact proposal and preview digest (<code>{preview.previewDigest.slice(0, 16)}…</code>). If the underlying telemetry changes, confirmation safely rejects.
        </span>
      </div>
    </div>

    {#snippet footer()}
      <button type="button" class="button ghost" onclick={() => (showConfirmModal = false)}>
        Cancel
      </button>
      <form method="POST" action="?/confirmRule" style="display: inline;" use:enhance={preserveStateEnhance}>
        <input type="hidden" name="csrfToken" value={csrfToken ?? ''} />
        <input type="hidden" name="returnTab" value={currentTab} />
        <input type="hidden" name="returnSelector" value={selectedSelectorFilter} />
        <input type="hidden" name="previewDigest" value={preview.previewDigest} />
        <input type="hidden" name="previewRevision" value={preview.previewRevision} />
        <input type="hidden" name="proposal" value={JSON.stringify(proposal)} />
        <button type="submit" class="button primary">
          Confirm & Apply Rule
        </button>
      </form>
    {/snippet}
  </Modal>
{/if}

<!-- WHOLE-SLICE OVERRIDE CREATION MODAL -->
<Modal
  open={overrideModalOpen}
  title="Create Whole-Slice Override"
  description="Apply an override to exactly one official day/project/entity slice without modifying raw telemetry or creating reusable rules."
  onclose={() => (overrideModalOpen = false)}
  maxWidth="600px"
>
  <form method="POST" action="?/createAllocation" id="slice-override-form" use:enhance={preserveStateEnhance}>
    <input type="hidden" name="csrfToken" value={csrfToken ?? ''} />
    <input type="hidden" name="returnTab" value={currentTab} />
    <input type="hidden" name="returnSelector" value={selectedSelectorFilter} />
    <input type="hidden" name="classification" value={overrideChoice} />

    {#if recentSlices.length > 0}
      <div class="form-group">
        <label for="select-recent-slice" class="form-label">
          <span>Choose from Recent Evaluated Slices ({recentSlices.length})</span>
        </label>
        <select
          id="select-recent-slice"
          class="form-input"
          onchange={(e) => {
            const idx = Number(e.currentTarget.value);
            const slice = recentSlices[idx];
            if (slice) selectSlice(slice);
          }}
        >
          {#each recentSlices as slice, i}
            <option value={i} selected={selectedSliceForOverride?.id === slice.id}>
              {slice.date} · {slice.projectName || `Project ${slice.projectId}`} · {slice.entity} ({formatDuration(slice.totalSeconds)} - {slice.decision.classification})
            </option>
          {/each}
        </select>
        <span class="form-hint">Selecting a slice auto-populates the target fields below.</span>
      </div>
    {/if}

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
      <div class="form-group">
        <label for="slice-date" class="form-label">
          <span>Date (YYYY-MM-DD)</span>
        </label>
        <input
          id="slice-date"
          name="date"
          type="text"
          bind:value={overrideDate}
          class="form-input"
          placeholder="2026-09-06"
          required
        />
      </div>

      <div class="form-group">
        <label for="slice-project-id" class="form-label">
          <span>Project ID</span>
        </label>
        <input
          id="slice-project-id"
          name="projectId"
          type="number"
          bind:value={overrideProjectId}
          class="form-input"
          required
        />
      </div>
    </div>

    <div class="form-group">
      <label for="slice-entity" class="form-label">
        <span>Target Entity (File Path, App, or Domain)</span>
      </label>
      <input
        id="slice-entity"
        name="entity"
        type="text"
        bind:value={overrideEntity}
        class="form-input"
        placeholder="e.g. src/routes/admin/classify/+page.svelte"
        required
      />
      <span class="form-hint">Target must match an official day/project/entity slice.</span>
    </div>

    <div class="form-group">
      <span class="form-label">Classification Assignment</span>
      <div style="display: flex; gap: 10px; margin-top: 4px;">
        <button
          type="button"
          class="button {overrideChoice === 'work' ? 'primary' : 'secondary'}"
          style="flex: 1;"
          onclick={() => (overrideChoice = 'work')}
        >
          Work
        </button>
        <button
          type="button"
          class="button {overrideChoice === 'personal' ? 'primary' : 'secondary'}"
          style="flex: 1;"
          onclick={() => (overrideChoice = 'personal')}
        >
          Personal
        </button>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
      <div class="form-group">
        <label for="slice-timesheet" class="form-label">
          <span>Timesheet Code (Optional)</span>
        </label>
        <input
          id="slice-timesheet"
          name="timesheetCode"
          type="text"
          bind:value={overrideTimesheetCode}
          class="form-input"
          placeholder="e.g. OVERRIDE-01"
        />
      </div>

      <div class="form-group">
        <label for="slice-note" class="form-label">
          <span>Operator Note (Optional)</span>
        </label>
        <input
          id="slice-note"
          name="note"
          type="text"
          bind:value={overrideNote}
          class="form-input"
          placeholder="Reason for single-slice override"
        />
      </div>
    </div>

    <div class="notice info" style="margin: 16px 0 0;">
      <Info size={16} />
      <span>
        Whole-slice overrides take absolute precedence over all existing and future rules for this official day/project/entity slice.
      </span>
    </div>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="button ghost"
      onclick={() => (overrideModalOpen = false)}
    >
      Cancel
    </button>
    <button
      type="submit"
      form="slice-override-form"
      class="button primary"
    >
      Save Override
    </button>
  {/snippet}
</Modal>

<!-- EDIT CLASSIFICATION RULE MODAL -->
<Modal
  open={editRuleModalOpen}
  title="Edit Classification Rule"
  description="Modify this rule's parameters. Changes will be previewed before confirmation."
  onclose={() => (editRuleModalOpen = false)}
  maxWidth="560px"
>
  <form
    method="POST"
    action="?/previewRule"
    id="edit-rule-form"
    style="display: flex; flex-direction: column; gap: 12px;"
    use:enhance={preserveStateEnhance}
  >
    <input type="hidden" name="csrfToken" value={csrfToken ?? ''} />
    <input type="hidden" name="returnTab" value={currentTab} />
    <input type="hidden" name="returnSelector" value={selectedSelectorFilter} />
    <input type="hidden" name="type" value="update" />
    <input type="hidden" name="id" value={editRuleId} />
    <input type="hidden" name="classification" value={editRuleClassification} />
    <input type="hidden" name="matchMode" value={editRuleMatchMode} />
    <input type="hidden" name="enabled" value={editRuleEnabled ? 'true' : 'false'} />

    <div class="form-group">
      <span class="form-label">Match Mode</span>
      <div style="display: flex; gap: 8px; margin-top: 4px;">
        <button
          type="button"
          class="button {editRuleMatchMode === 'exact' ? 'primary' : 'secondary'}"
          style="flex: 1;"
          onclick={() => (editRuleMatchMode = 'exact')}
        >
          Exact
        </button>
        <button
          type="button"
          class="button {editRuleMatchMode === 'glob' ? 'primary' : 'secondary'}"
          style="flex: 1;"
          onclick={() => (editRuleMatchMode = 'glob')}
        >
          Glob Pattern
        </button>
      </div>
      <span class="form-hint">
        {#if editRuleMatchMode === 'glob'}
          Wildcards: <code>*</code> matches zero or more characters; <code>?</code> matches one character. Use <code>[*]</code> or <code>[?]</code> for literal characters.
        {:else}
          Matches exact string without interpreting wildcards.
        {/if}
      </span>
    </div>

    <div class="form-group">
      <label for="edit-rule-name" class="form-label">
        <span>Rule Name</span>
      </label>
      <input
        id="edit-rule-name"
        name="name"
        type="text"
        bind:value={editRuleName}
        class="form-input"
        required
      />
    </div>

    <div class="form-group">
      <span class="form-label">Classification Assignment</span>
      <div style="display: flex; gap: 8px; margin-top: 4px;">
        <button
          type="button"
          class="button {editRuleClassification === 'work' ? 'primary' : 'secondary'}"
          style="flex: 1;"
          onclick={() => (editRuleClassification = 'work')}
        >
          Work
        </button>
        <button
          type="button"
          class="button {editRuleClassification === 'personal' ? 'primary' : 'secondary'}"
          style="flex: 1;"
          onclick={() => (editRuleClassification = 'personal')}
        >
          Personal
        </button>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
      <div class="form-group">
        <label for="edit-rule-selector-type" class="form-label">
          <span>Selector Type</span>
        </label>
        <select
          id="edit-rule-selector-type"
          name="selectorType"
          bind:value={editRuleSelectorType}
          class="form-input"
        >
          {#each ALL_SELECTOR_TYPES as st}
            <option value={st}>{st} (Rank {getSelectorSpecificity(st)})</option>
          {/each}
        </select>
      </div>
      <div class="form-group">
        <label for="edit-rule-selector-value" class="form-label">
          <span>Selector Value</span>
        </label>
        <input
          id="edit-rule-selector-value"
          name="selectorValue"
          type="text"
          bind:value={editRuleSelectorValue}
          class="form-input"
          required
        />
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
      <div class="form-group">
        <label for="edit-rule-priority" class="form-label">
          <span>Operator Priority</span>
        </label>
        <input
          id="edit-rule-priority"
          name="priority"
          type="number"
          bind:value={editRulePriority}
          class="form-input"
        />
      </div>
      <div class="form-group">
        <label for="edit-rule-timesheet" class="form-label">
          <span>Timesheet Code (Optional)</span>
        </label>
        <input
          id="edit-rule-timesheet"
          name="timesheetCode"
          type="text"
          bind:value={editRuleTimesheetCode}
          class="form-input"
          placeholder="e.g. CLIENT-01"
        />
      </div>
    </div>

    <div class="form-group" style="margin-top: 4px;">
      <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
        <input
          type="checkbox"
          checked={editRuleEnabled}
          onchange={(e) => (editRuleEnabled = e.currentTarget.checked)}
        />
        <span style="font-size: 13px; color: var(--text);">Rule is Active</span>
      </label>
    </div>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="button ghost"
      onclick={() => (editRuleModalOpen = false)}
    >
      Cancel
    </button>
    <button
      type="submit"
      form="edit-rule-form"
      class="button primary"
    >
      <WandSparkles size={14} />
      <span>Preview Rule Update</span>
    </button>
  {/snippet}
</Modal>
