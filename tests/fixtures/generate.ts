#!/usr/bin/env tsx
/**
 * Generates the synthetic dump fixtures next to this file.
 *
 *   pnpm exec tsx tests/fixtures/generate.ts
 *
 * Everything here is invented. No value is copied from a real export: project
 * names, paths, machine ids and heartbeat ids are all made up, so the fixtures
 * are safe to commit while the real dumps never are.
 *
 * The fixture matrix follows DUMP-DATA-CONTRACT.md §12 — seven aligned days
 * covering zero-activity, near-zero, single-project, multi-project, AI-heavy,
 * project-sum divergence and dependency canonicalization.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTPUT_DIR = dirname(fileURLToPath(import.meta.url));

const USER_ID = '00000000-0000-4000-8000-000000000001';
const MACHINE_A = 'machine-aaaa';
const MACHINE_B = 'machine-bbbb';
const EDITOR_VSCODE = 'agent/1.0 (fixture) vscode/1.0 vscode-wakatime/1.0';
const EDITOR_VIM = 'agent/1.0 (fixture) vim/9.0 vim-wakatime/1.0';

type Json = Record<string, unknown>;

/** The `user` object, carrying the PII fields the importer must refuse to store. */
function user(): Json {
  return {
    id: USER_ID,
    email: 'fixture@example.invalid',
    display_name: 'Fixture Person',
    full_name: 'Fixture Q. Person',
    photo: 'https://example.invalid/avatar.png',
    profile_url: 'https://example.invalid/@fixture',
    github_username: 'fixture',
    username: 'fixture',
    timezone: 'Europe/Lisbon',
    timeout: 15,
    weekday_start: 1,
    writes_only: false,
    plan: 'premium',
    has_premium_features: true
  };
}

/** Formatted duration fields the export always emits alongside total_seconds. */
function formatted(totalSeconds: number): Json {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return {
    decimal: (totalSeconds / 3600).toFixed(2),
    digital: `${hours}:${String(minutes).padStart(2, '0')}`,
    hours,
    minutes,
    seconds,
    text: `${hours} hrs ${minutes} mins`
  };
}

interface AiOptions {
  additions?: number;
  deletions?: number;
  humanAdditions?: number;
  humanDeletions?: number;
  sessions?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  promptLengthSum?: number;
  cost?: number;
}

/** The AI block, zero-valued unless a fixture opts into activity. */
function ai(options: AiOptions = {}): Json {
  const sessions = options.sessions ?? 0;
  return {
    human_additions: options.humanAdditions ?? 0,
    human_deletions: options.humanDeletions ?? 0,
    ai_additions: options.additions ?? 0,
    ai_deletions: options.deletions ?? 0,
    ai_sessions: sessions,
    ai_prompt_events_total: sessions * 4,
    ai_prompt_events_avg_per_session: sessions === 0 ? 0 : 4,
    ai_prompt_events_median_per_session: sessions === 0 ? 0 : 4,
    ai_prompt_length_avg: sessions === 0 ? 0 : 120,
    ai_prompt_length_avg_per_session: sessions === 0 ? 0 : 480,
    ai_prompt_length_median_per_session: sessions === 0 ? 0 : 480,
    ai_prompt_length_sum: options.promptLengthSum ?? 0,
    ai_input_tokens: options.inputTokens ?? 0,
    ai_cached_input_tokens: options.cachedInputTokens ?? 0,
    ai_output_tokens: options.outputTokens ?? 0,
    ai_model_total_cost: options.cost ?? 0,
    ai_model_breakdown: sessions === 0 ? [] : [{ name: 'fixture-model', cost: options.cost ?? 0, lines: 10 }],
    ai_model_costs: sessions === 0 ? {} : { 'fixture-model': options.cost ?? 0 },
    ai_model_line_changes: sessions === 0 ? {} : { 'fixture-model': 10 }
  };
}

function grandTotal(totalSeconds: number, aiOptions: AiOptions = {}): Json {
  return { total_seconds: totalSeconds, ...formatted(totalSeconds), ...ai(aiOptions) };
}

function breakdown(name: string, totalSeconds: number, percent: number, extra: Json = {}): Json {
  return { name, total_seconds: totalSeconds, percent, ...formatted(totalSeconds), ...extra };
}

function editor(name: string, totalSeconds: number, percent: number, aiOptions: AiOptions = {}): Json {
  return breakdown(name, totalSeconds, percent, ai(aiOptions));
}

function machine(name: string, totalSeconds: number, percent: number, machineNameId: string | null): Json {
  return breakdown(name, totalSeconds, percent, { machine_name_id: machineNameId });
}

interface EntityOptions {
  type: 'file' | 'app' | 'domain';
  projectRootCount: number | null;
  aiOptions?: AiOptions;
}

function entity(name: string, totalSeconds: number, percent: number, options: EntityOptions): Json {
  return breakdown(name, totalSeconds, percent, {
    type: options.type,
    project_root_count: options.projectRootCount,
    ...ai(options.aiOptions ?? {})
  });
}

interface ProjectOptions {
  name: string;
  totalSeconds: number;
  percent: number;
  aiOptions?: AiOptions;
  branches?: Json[];
  categories?: Json[];
  dependencies?: Json[];
  editors?: Json[];
  entities?: Json[];
  languages?: Json[];
  machines?: Json[];
  operatingSystems?: Json[];
}

function project(options: ProjectOptions): Json {
  return {
    name: options.name,
    grand_total: { ...grandTotal(options.totalSeconds, options.aiOptions), percent: options.percent },
    branches: options.branches ?? [],
    categories: options.categories ?? [],
    dependencies: options.dependencies ?? [],
    editors: options.editors ?? [],
    entities: options.entities ?? [],
    languages: options.languages ?? [],
    machines: options.machines ?? [],
    operating_systems: options.operatingSystems ?? []
  };
}

interface DayOptions {
  date: string;
  totalSeconds: number;
  aiOptions?: AiOptions;
  categories?: Json[];
  dependencies?: Json[];
  editors?: Json[];
  languages?: Json[];
  machines?: Json[];
  operatingSystems?: Json[];
  projects?: Json[];
}

function day(options: DayOptions): Json {
  return {
    date: options.date,
    grand_total: grandTotal(options.totalSeconds, options.aiOptions),
    categories: options.categories ?? [],
    dependencies: options.dependencies ?? [],
    editors: options.editors ?? [],
    languages: options.languages ?? [],
    machines: options.machines ?? [],
    operating_systems: options.operatingSystems ?? [],
    projects: options.projects ?? []
  };
}

interface HeartbeatOptions {
  id: string;
  time: number;
  entity: string;
  type?: 'file' | 'app' | 'domain';
  category?: string;
  project?: string | null;
  branch?: string | null;
  language?: string | null;
  dependencies?: string[];
  lines?: number | null;
  lineno?: number | null;
  cursorpos?: number | null;
  isWrite?: boolean;
  machineNameId?: string | null;
  userAgentId?: string;
  projectRootCount?: number | null;
  aiSession?: string | null;
  aiSubscriptionPlan?: string | null;
  aiLineChanges?: number | null;
  humanLineChanges?: number | null;
  aiInputTokens?: number;
  aiCachedInputTokens?: number;
  aiOutputTokens?: number;
  aiPromptLength?: number;
}

function heartbeat(options: HeartbeatOptions): Json {
  return {
    id: options.id,
    user_id: USER_ID,
    entity: options.entity,
    type: options.type ?? 'file',
    category: options.category ?? 'Coding',
    project: options.project === undefined ? 'alpha' : options.project,
    branch: options.branch === undefined ? 'main' : options.branch,
    language: options.language === undefined ? 'TypeScript' : options.language,
    dependencies: options.dependencies ?? [],
    lines: options.lines === undefined ? 120 : options.lines,
    lineno: options.lineno === undefined ? null : options.lineno,
    cursorpos: options.cursorpos === undefined ? null : options.cursorpos,
    is_write: options.isWrite ?? false,
    time: options.time,
    created_at: new Date(Math.floor(options.time) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    machine_name_id: options.machineNameId === undefined ? MACHINE_A : options.machineNameId,
    user_agent_id: options.userAgentId ?? EDITOR_VSCODE,
    project_root_count: options.projectRootCount === undefined ? null : options.projectRootCount,
    ai_session: options.aiSession ?? null,
    ai_subscription_plan: options.aiSubscriptionPlan ?? null,
    ai_line_changes: options.aiLineChanges === undefined ? null : options.aiLineChanges,
    human_line_changes: options.humanLineChanges === undefined ? null : options.humanLineChanges,
    ai_input_tokens: options.aiInputTokens ?? 0,
    ai_cached_input_tokens: options.aiCachedInputTokens ?? 0,
    ai_output_tokens: options.aiOutputTokens ?? 0,
    ai_prompt_length: options.aiPromptLength ?? 0
  };
}

/** Midnight UTC epoch seconds for a fixture date, so times land in the right day. */
function midnight(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

// ---------------------------------------------------------------------------
// The seven-day matrix
// ---------------------------------------------------------------------------

const DATES = [
  '2026-01-01', // zero activity
  '2026-01-02', // near-zero: projects present, zero seconds, zero percents
  '2026-01-03', // normal, single project, file + app entities
  '2026-01-04', // multi-project, domain entity, null machine id, +-0.01 percents
  '2026-01-05', // AI-heavy
  '2026-01-06', // project-sum divergence
  '2026-01-07' //  dependency canonicalization + canonically identical duplicate id
] as const;

const dailyDays: Json[] = [
  day({ date: DATES[0], totalSeconds: 0 }),

  day({
    date: DATES[1],
    totalSeconds: 0,
    categories: [breakdown('Coding', 0, 0)],
    projects: [
      project({
        name: 'alpha',
        totalSeconds: 0,
        percent: 0,
        categories: [breakdown('Coding', 0, 0)],
        entities: [
          entity('/fixtures/alpha/src/quiet.ts', 0, 0, { type: 'file', projectRootCount: 1 })
        ]
      })
    ]
  }),

  day({
    date: DATES[2],
    totalSeconds: 3600,
    categories: [breakdown('Coding', 3000, 83.33), breakdown('Writing Tests', 600, 16.67)],
    dependencies: [breakdown('zod', 3600, 100)],
    editors: [editor('VS Code', 3600, 100)],
    languages: [breakdown('TypeScript', 3600, 100)],
    machines: [machine('fixture-laptop', 3600, 100, MACHINE_A)],
    operatingSystems: [breakdown('Mac', 3600, 100)],
    projects: [
      project({
        name: 'alpha',
        totalSeconds: 3600,
        percent: 100,
        branches: [breakdown('main', 3600, 100)],
        categories: [breakdown('Coding', 3000, 83.33), breakdown('Writing Tests', 600, 16.67)],
        dependencies: [breakdown('zod', 3600, 100)],
        editors: [editor('VS Code', 3600, 100)],
        languages: [breakdown('TypeScript', 3600, 100)],
        machines: [machine('fixture-laptop', 3600, 100, MACHINE_A)],
        operatingSystems: [breakdown('Mac', 3600, 100)],
        entities: [
          entity('/fixtures/alpha/src/index.ts', 3000, 83.33, { type: 'file', projectRootCount: 1 }),
          entity('Terminal', 600, 16.67, { type: 'app', projectRootCount: null })
        ]
      })
    ]
  }),

  day({
    date: DATES[3],
    totalSeconds: 5400,
    categories: [breakdown('Coding', 5400, 100.01)],
    editors: [editor('VS Code', 3600, 66.67), editor('Vim', 1800, 33.34)],
    machines: [
      machine('fixture-laptop', 3600, 66.67, MACHINE_A),
      machine('fixture-unknown', 1800, 33.34, null)
    ],
    projects: [
      project({
        name: 'alpha',
        totalSeconds: 2400,
        percent: 44.44,
        entities: [entity('/fixtures/alpha/src/index.ts', 2400, 100, { type: 'file', projectRootCount: 1 })]
      }),
      project({
        name: 'beta',
        totalSeconds: 1800,
        percent: 33.33,
        machines: [machine('fixture-unknown', 1800, 100, null)],
        entities: [entity('/fixtures/beta/lib/util.py', 1800, 100, { type: 'file', projectRootCount: null })]
      }),
      project({
        name: 'gamma',
        totalSeconds: 1200,
        percent: 22.23,
        entities: [entity('docs.example.invalid', 1200, 100, { type: 'domain', projectRootCount: null })]
      })
    ]
  }),

  day({
    date: DATES[4],
    totalSeconds: 7200,
    aiOptions: {
      additions: 400,
      deletions: 50,
      humanAdditions: 20,
      humanDeletions: 5,
      sessions: 3,
      inputTokens: 12_000,
      cachedInputTokens: 8_000,
      outputTokens: 4_000,
      promptLengthSum: 1_440,
      cost: 1.25
    },
    categories: [breakdown('AI Coding', 7200, 100)],
    editors: [
      editor('VS Code', 7200, 100, { additions: 400, deletions: 50, sessions: 3, cost: 1.25 })
    ],
    projects: [
      project({
        name: 'alpha',
        totalSeconds: 7200,
        percent: 100,
        aiOptions: { additions: 400, deletions: 50, sessions: 3, cost: 1.25 },
        editors: [editor('VS Code', 7200, 100, { additions: 400, deletions: 50, sessions: 3 })],
        entities: [
          entity('/fixtures/alpha/src/agent.ts', 7200, 100, {
            type: 'file',
            projectRootCount: 1,
            aiOptions: { additions: 400, deletions: 50, sessions: 3 }
          })
        ]
      })
    ]
  }),

  // grand_total is authoritative; the projects only account for 100s of it.
  day({
    date: DATES[5],
    totalSeconds: 1000,
    categories: [breakdown('Coding', 1000, 100)],
    projects: [
      project({
        name: 'alpha',
        totalSeconds: 100,
        percent: 10,
        entities: [entity('/fixtures/alpha/src/index.ts', 100, 100, { type: 'file', projectRootCount: 1 })]
      })
    ]
  }),

  day({
    date: DATES[6],
    totalSeconds: 1800,
    categories: [breakdown('Coding', 1800, 100)],
    dependencies: [breakdown('zod', 900, 50), breakdown('vitest', 900, 50)],
    projects: [
      project({
        name: 'alpha',
        totalSeconds: 1800,
        percent: 100,
        dependencies: [breakdown('zod', 900, 50), breakdown('vitest', 900, 50)],
        entities: [
          entity('/fixtures/alpha/src/deps.ts', 1800, 100, { type: 'file', projectRootCount: 1 })
        ]
      })
    ]
  })
];

/** The heartbeat that appears twice with reordered, duplicated dependencies. */
const DUPLICATE_ID = 'hb-duplicate-0007';

const heartbeatDays: Json[] = [
  { date: DATES[0], heartbeats: [] },

  {
    date: DATES[1],
    heartbeats: [
      heartbeat({
        id: 'hb-nearzero-0001',
        time: midnight(DATES[1]) + 32_400,
        entity: '/fixtures/alpha/src/quiet.ts',
        projectRootCount: 1
      }),
      // Every documented-nullable field null at once.
      heartbeat({
        id: 'hb-nearzero-0002',
        time: midnight(DATES[1]) + 32_460.5,
        entity: '/fixtures/orphan/scratch.txt',
        project: null,
        branch: null,
        language: null,
        lines: null,
        machineNameId: null
      })
    ]
  },

  {
    date: DATES[2],
    heartbeats: [
      heartbeat({
        id: 'hb-normal-0001',
        time: midnight(DATES[2]) + 36_000,
        entity: '/fixtures/alpha/src/index.ts',
        dependencies: ['zod'],
        lineno: 42,
        cursorpos: 7,
        isWrite: true,
        projectRootCount: 1
      }),
      heartbeat({
        id: 'hb-normal-0002',
        time: midnight(DATES[2]) + 36_120,
        entity: 'Terminal',
        type: 'app',
        category: 'Writing Tests',
        language: null,
        lines: null,
        userAgentId: EDITOR_VIM,
        machineNameId: MACHINE_B
      })
    ]
  },

  {
    date: DATES[3],
    heartbeats: [
      heartbeat({
        id: 'hb-multi-0001',
        time: midnight(DATES[3]) + 36_000,
        entity: '/fixtures/alpha/src/index.ts',
        projectRootCount: 1
      }),
      heartbeat({
        id: 'hb-multi-0002',
        time: midnight(DATES[3]) + 39_600,
        entity: '/fixtures/beta/lib/util.py',
        project: 'beta',
        language: 'Python',
        branch: null,
        machineNameId: null,
        userAgentId: EDITOR_VIM
      }),
      heartbeat({
        id: 'hb-multi-0003',
        time: midnight(DATES[3]) + 43_200,
        entity: 'docs.example.invalid',
        type: 'domain',
        project: 'gamma',
        language: null,
        lines: null
      })
    ]
  },

  {
    date: DATES[4],
    heartbeats: [
      heartbeat({
        id: 'hb-ai-0001',
        time: midnight(DATES[4]) + 36_000,
        entity: '/fixtures/alpha/src/agent.ts',
        category: 'AI Coding',
        aiSession: '00000000-0000-4000-8000-00000000aaaa',
        aiSubscriptionPlan: 'pro',
        aiLineChanges: 120,
        humanLineChanges: 8,
        aiInputTokens: 6_000,
        aiCachedInputTokens: 4_000,
        aiOutputTokens: 2_000,
        aiPromptLength: 480,
        isWrite: true,
        projectRootCount: 1
      })
    ]
  },

  {
    date: DATES[5],
    heartbeats: [
      heartbeat({
        id: 'hb-divergent-0001',
        time: midnight(DATES[5]) + 36_000,
        entity: '/fixtures/alpha/src/index.ts',
        projectRootCount: 1
      })
    ]
  },

  {
    date: DATES[6],
    heartbeats: [
      // Unsorted with a repeat: canonicalization must sort and dedupe.
      heartbeat({
        id: DUPLICATE_ID,
        time: midnight(DATES[6]) + 36_000,
        entity: '/fixtures/alpha/src/deps.ts',
        dependencies: ['zod', 'vitest', 'zod', 'better-sqlite3'],
        projectRootCount: 1
      }),
      // Same id, same set, different order: an exact duplicate after
      // canonicalization, so the import stays idempotent instead of failing.
      heartbeat({
        id: DUPLICATE_ID,
        time: midnight(DATES[6]) + 36_000,
        entity: '/fixtures/alpha/src/deps.ts',
        dependencies: ['better-sqlite3', 'zod', 'vitest'],
        projectRootCount: 1
      }),
      heartbeat({
        id: 'hb-deps-0002',
        time: midnight(DATES[6]) + 36_600,
        entity: '/fixtures/alpha/src/deps.ts',
        dependencies: [],
        projectRootCount: 1
      })
    ]
  }
];

// ---------------------------------------------------------------------------
// Conflicting-duplicate pair, for the fail-closed path
// ---------------------------------------------------------------------------

const CONFLICT_DATE = '2026-02-01';
const CONFLICT_ID = 'hb-conflict-0001';

const conflictDailyDays: Json[] = [
  day({
    date: CONFLICT_DATE,
    totalSeconds: 600,
    categories: [breakdown('Coding', 600, 100)],
    projects: [
      project({
        name: 'alpha',
        totalSeconds: 600,
        percent: 100,
        entities: [entity('/fixtures/alpha/src/index.ts', 600, 100, { type: 'file', projectRootCount: 1 })]
      })
    ]
  })
];

const conflictHeartbeatDays: Json[] = [
  {
    date: CONFLICT_DATE,
    heartbeats: [
      heartbeat({
        id: CONFLICT_ID,
        time: midnight(CONFLICT_DATE) + 36_000,
        entity: '/fixtures/alpha/src/index.ts',
        projectRootCount: 1
      }),
      // Same id, genuinely different payload: not reconcilable by sorting.
      heartbeat({
        id: CONFLICT_ID,
        time: midnight(CONFLICT_DATE) + 36_000,
        entity: '/fixtures/alpha/src/other.ts',
        projectRootCount: 1
      })
    ]
  }
];

function envelope(days: Json[], dates: readonly string[]): Json {
  return {
    user: user(),
    range: {
      start: midnight(dates[0]),
      end: midnight(dates.at(-1) as string) + 86_399
    },
    days
  };
}

function write(filename: string, value: Json): void {
  const path = join(OUTPUT_DIR, filename);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote ${filename}\n`);
}

write('synthetic-daily.json', envelope(dailyDays, DATES));
write('synthetic-heartbeats.json', envelope(heartbeatDays, DATES));
write('conflict-daily.json', envelope(conflictDailyDays, [CONFLICT_DATE]));
write('conflict-heartbeats.json', envelope(conflictHeartbeatDays, [CONFLICT_DATE]));
