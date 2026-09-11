import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATIONS,
  classifySlice,
  compareRulePrecedence,
  compilePattern,
  MAX_PATTERN_LENGTH,
  normalizeSelectorValue,
  ruleMatchesSlice,
  type ClassifiableSlice,
  type ClassificationRule
} from './model';

const slice: ClassifiableSlice = {
  id: 'slice-1',
  project: 'personal-repository',
  entityType: 'file',
  entity: '/projects/personal-repository/src/index.ts',
  machineIds: ['work-laptop'],
  editors: ['Visual Studio Code']
};

function rule(
  id: string,
  selectorType: ClassificationRule['selectorType'],
  selectorValue: string,
  classification: ClassificationRule['classification'],
  priority = 0
): ClassificationRule {
  return {
    id,
    selectorType,
    selectorValue,
    classification,
    priority,
    createdAt: '2026-01-01T00:00:00.000Z'
  };
}

describe('classification model', () => {
  it('keeps the privacy classes intentionally small', () => {
    expect(CLASSIFICATIONS).toEqual(['work', 'personal', 'unclassified']);
  });

  it('orders a personal project ahead of a broad work machine', () => {
    const rules = [
      {
        selectorType: 'machine' as const,
        selectorValue: 'work-laptop',
        priority: 0,
        createdAt: '2026-01-01T00:00:00.000Z'
      },
      {
        selectorType: 'project' as const,
        selectorValue: 'personal-repository',
        priority: 0,
        createdAt: '2026-01-02T00:00:00.000Z'
      }
    ];

    expect(rules.sort(compareRulePrecedence)[0]?.selectorType).toBe('project');
  });

  it('prefers the longest matching folder prefix', () => {
    const rules = [
      {
        selectorType: 'folder_prefix' as const,
        selectorValue: '/projects',
        priority: 0,
        createdAt: '2026-01-01T00:00:00.000Z'
      },
      {
        selectorType: 'folder_prefix' as const,
        selectorValue: '/projects/personal',
        priority: 0,
        createdAt: '2026-01-01T00:00:00.000Z'
      }
    ];

    expect(rules.sort(compareRulePrecedence)[0]?.selectorValue).toBe('/projects/personal');
  });

  it('lets a specific personal project override a broad work machine', () => {
    const decision = classifySlice(slice, [
      rule('machine-work', 'machine', 'work-laptop', 'work'),
      rule('project-personal', 'project', 'personal-repository', 'personal')
    ]);

    expect(decision).toMatchObject({
      classification: 'personal',
      source: 'rule',
      winningRuleId: 'project-personal'
    });
  });

  it('keeps conflicting rules at equal effective precedence unclassified', () => {
    const decision = classifySlice(slice, [
      rule('project-work', 'project', 'personal-repository', 'work'),
      rule('project-personal', 'project', 'personal-repository', 'personal')
    ]);

    expect(decision).toEqual({
      classification: 'unclassified',
      source: 'ambiguous',
      winningRuleId: null,
      competingRuleIds: ['project-personal', 'project-work']
    });
  });

  it('treats machine, editor, application, and domain as one equal specificity tier', () => {
    const decision = classifySlice(slice, [
      rule('machine-work', 'machine', 'work-laptop', 'work'),
      rule('editor-personal', 'editor', 'Visual Studio Code', 'personal')
    ]);

    expect(decision).toEqual({
      classification: 'unclassified',
      source: 'ambiguous',
      winningRuleId: null,
      competingRuleIds: ['editor-personal', 'machine-work']
    });
  });

  it('uses manual priority to resolve an otherwise ambiguous decision', () => {
    const decision = classifySlice(slice, [
      rule('project-work', 'project', 'personal-repository', 'work'),
      rule('project-personal', 'project', 'personal-repository', 'personal', 10)
    ]);

    expect(decision.classification).toBe('personal');
    expect(decision.source).toBe('rule');
  });

  it('applies a one-off whole-slice override before every reusable rule', () => {
    const decision = classifySlice(
      slice,
      [rule('project-work', 'project', 'personal-repository', 'work', 100)],
      { classification: 'personal' }
    );

    expect(decision).toMatchObject({ classification: 'personal', source: 'override' });
  });

  it('matches folder prefixes on path boundaries only', () => {
    expect(
      ruleMatchesSlice(
        rule('folder', 'folder_prefix', '/projects/personal-repository', 'personal'),
        slice
      )
    ).toBe(true);
    expect(
      ruleMatchesSlice(
        rule('folder', 'folder_prefix', '/projects/personal-repository/src/index', 'personal'),
        slice
      )
    ).toBe(false);
  });

  it('normalizes Windows selector paths without changing Unix case', () => {
    expect(normalizeSelectorValue('entity', 'C:\\Work\\Repo\\')).toBe('c:/work/repo');
    expect(normalizeSelectorValue('entity', '/Users/Leo/Repo/')).toBe('/Users/Leo/Repo');
  });

  // TC-02: Priority Outranks Tier
  it('TC-02: explicit priority outranks structural selector tier', () => {
    const ruleMachine: ClassificationRule = {
      ...rule('rule-m', 'machine', 'work-pc', 'work', 10),
      matchMode: 'exact'
    };
    const ruleProject: ClassificationRule = {
      ...rule('rule-p', 'project', 'secret-project', 'personal', 0),
      matchMode: 'glob'
    };
    const s: ClassifiableSlice = {
      id: 's-tc02',
      project: 'secret-project',
      entityType: 'file',
      entity: '/test.ts',
      machineIds: ['work-pc'],
      editors: []
    };
    const decision = classifySlice(s, [ruleMachine, ruleProject]);
    expect(decision.classification).toBe('work');
    expect(decision.winningRuleId).toBe('rule-m');
  });

  // TC-03: Equal Exact Broad Tier
  it('TC-03: two exact rules in broad identity tier with different string lengths remain strictly equal and resolve to ambiguous', () => {
    const ruleMachine: ClassificationRule = {
      ...rule('rule-m', 'machine', 'desktop-a', 'work', 0),
      matchMode: 'exact'
    };
    const ruleEditor: ClassificationRule = {
      ...rule('rule-ed', 'editor', 'Visual Studio Code Insiders Edition', 'personal', 0),
      matchMode: 'exact'
    };
    const s: ClassifiableSlice = {
      id: 's-tc03',
      project: 'proj',
      entityType: 'file',
      entity: '/test.ts',
      machineIds: ['desktop-a'],
      editors: ['Visual Studio Code Insiders Edition']
    };
    const decision = classifySlice(s, [ruleMachine, ruleEditor]);
    expect(decision.classification).toBe('unclassified');
    expect(decision.source).toBe('ambiguous');
    expect(decision.competingRuleIds).toEqual(['rule-ed', 'rule-m']);
  });

  // TC-04: Cross-Selector Precedence
  it('TC-04: cross-selector precedence: glob project (Tier 40) beats exact machine (Tier 10) when priority is equal', () => {
    const ruleMachine: ClassificationRule = {
      ...rule('rule-m', 'machine', 'desktop-a', 'work', 0),
      matchMode: 'exact'
    };
    const ruleProject: ClassificationRule = {
      ...rule('rule-p', 'project', '*secret*', 'personal', 0),
      matchMode: 'glob'
    };
    const s: ClassifiableSlice = {
      id: 's-tc04',
      project: 'my-secret-project',
      entityType: 'file',
      entity: '/test.ts',
      machineIds: ['desktop-a'],
      editors: []
    };
    const decision = classifySlice(s, [ruleMachine, ruleProject]);
    expect(decision.classification).toBe('personal');
    expect(decision.winningRuleId).toBe('rule-p');
  });

  // TC-05: Star Across Slashes
  it('TC-05: glob * crosses slashes across directory boundaries', () => {
    const r: ClassificationRule = {
      id: 'r-glob',
      selectorType: 'folder_prefix',
      selectorValue: '*u081715*',
      matchMode: 'glob',
      classification: 'work',
      priority: 0,
      createdAt: '2026-01-01T00:00:00Z'
    };
    const fileSlice: ClassifiableSlice = {
      id: 's-tc05-match',
      project: 'proj',
      entityType: 'file',
      entity: 'c:/users/u081715/scripts/test.vbs',
      machineIds: [],
      editors: []
    };
    expect(ruleMatchesSlice(r, fileSlice)).toBe(true);

    const nonMatchingSlice: ClassifiableSlice = {
      id: 's-tc05-nomatch',
      project: 'proj',
      entityType: 'file',
      entity: 'c:/users/other/scripts/test.vbs',
      machineIds: [],
      editors: []
    };
    expect(ruleMatchesSlice(r, nonMatchingSlice)).toBe(false);
  });

  // TC-06: Question Unicode Point
  it('TC-06: glob ? matches single unicode code point including surrogate pairs', () => {
    const r: ClassificationRule = {
      id: 'r-q',
      selectorType: 'project',
      selectorValue: 'test?',
      matchMode: 'glob',
      classification: 'work',
      priority: 0,
      createdAt: '2026-01-01T00:00:00Z'
    };
    expect(
      ruleMatchesSlice(r, {
        id: '1',
        project: 'test1',
        entityType: 'file',
        entity: '/x',
        machineIds: [],
        editors: []
      })
    ).toBe(true);
    expect(
      ruleMatchesSlice(r, {
        id: '2',
        project: 'testA',
        entityType: 'file',
        entity: '/x',
        machineIds: [],
        editors: []
      })
    ).toBe(true);
    expect(
      ruleMatchesSlice(r, {
        id: '3',
        project: 'test🍝',
        entityType: 'file',
        entity: '/x',
        machineIds: [],
        editors: []
      })
    ).toBe(true);
    expect(
      ruleMatchesSlice(r, {
        id: '4',
        project: 'test12',
        entityType: 'file',
        entity: '/x',
        machineIds: [],
        editors: []
      })
    ).toBe(false);
  });

  // TC-07: Literal Characters in Exact Mode
  it('TC-07: exact mode treats * and [1] as literal characters without interpreting wildcards or brackets', () => {
    const r: ClassificationRule = {
      id: 'r-exact-lit',
      selectorType: 'entity',
      selectorValue: 'test*file[1]',
      matchMode: 'exact',
      classification: 'work',
      priority: 0,
      createdAt: '2026-01-01T00:00:00Z'
    };
    expect(
      ruleMatchesSlice(r, {
        id: '1',
        project: 'proj',
        entityType: 'file',
        entity: 'test*file[1]',
        machineIds: [],
        editors: []
      })
    ).toBe(true);
    expect(
      ruleMatchesSlice(r, {
        id: '2',
        project: 'proj',
        entityType: 'file',
        entity: 'testXfile1',
        machineIds: [],
        editors: []
      })
    ).toBe(false);
  });

  // TC-08: Bracket Escaping in Glob Mode
  it('TC-08: glob mode bracket escaping [*] and [?], while other brackets are literal', () => {
    const rStar: ClassificationRule = {
      id: 'r-star',
      selectorType: 'project',
      selectorValue: 'test[*]file',
      matchMode: 'glob',
      classification: 'work',
      priority: 0,
      createdAt: '2026-01-01T00:00:00Z'
    };
    expect(
      ruleMatchesSlice(rStar, {
        id: '1',
        project: 'test*file',
        entityType: 'file',
        entity: '/x',
        machineIds: [],
        editors: []
      })
    ).toBe(true);
    expect(
      ruleMatchesSlice(rStar, {
        id: '2',
        project: 'testingfile',
        entityType: 'file',
        entity: '/x',
        machineIds: [],
        editors: []
      })
    ).toBe(false);

    const rQ: ClassificationRule = {
      id: 'r-q',
      selectorType: 'project',
      selectorValue: 'test[?]file',
      matchMode: 'glob',
      classification: 'work',
      priority: 0,
      createdAt: '2026-01-01T00:00:00Z'
    };
    expect(
      ruleMatchesSlice(rQ, {
        id: '1',
        project: 'test?file',
        entityType: 'file',
        entity: '/x',
        machineIds: [],
        editors: []
      })
    ).toBe(true);
    expect(
      ruleMatchesSlice(rQ, {
        id: '2',
        project: 'testafile',
        entityType: 'file',
        entity: '/x',
        machineIds: [],
        editors: []
      })
    ).toBe(false);

    const rBrackets: ClassificationRule = {
      id: 'r-b',
      selectorType: 'project',
      selectorValue: 'test[draft]file',
      matchMode: 'glob',
      classification: 'work',
      priority: 0,
      createdAt: '2026-01-01T00:00:00Z'
    };
    expect(
      ruleMatchesSlice(rBrackets, {
        id: '1',
        project: 'test[draft]file',
        entityType: 'file',
        entity: '/x',
        machineIds: [],
        editors: []
      })
    ).toBe(true);
    expect(
      ruleMatchesSlice(rBrackets, {
        id: '2',
        project: 'testdfile',
        entityType: 'file',
        entity: '/x',
        machineIds: [],
        editors: []
      })
    ).toBe(false);
  });

  // TC-09: Casing Parity per Selector
  it('TC-09: casing parity: machine/editor match case-insensitively, project and Unix/relative paths preserve case', () => {
    const rMachine: ClassificationRule = {
      id: 'r-m',
      selectorType: 'machine',
      selectorValue: 'DESKTOP-*',
      matchMode: 'glob',
      classification: 'work',
      priority: 0,
      createdAt: '2026-01-01T00:00:00Z'
    };
    expect(
      ruleMatchesSlice(rMachine, {
        id: '1',
        project: 'p',
        entityType: 'file',
        entity: '/x',
        machineIds: ['desktop-alpha'],
        editors: []
      })
    ).toBe(true);

    const rProj: ClassificationRule = {
      id: 'r-p',
      selectorType: 'project',
      selectorValue: 'WorkRepo*',
      matchMode: 'glob',
      classification: 'work',
      priority: 0,
      createdAt: '2026-01-01T00:00:00Z'
    };
    expect(
      ruleMatchesSlice(rProj, {
        id: '1',
        project: 'WorkRepo-backend',
        entityType: 'file',
        entity: '/x',
        machineIds: [],
        editors: []
      })
    ).toBe(true);
    expect(
      ruleMatchesSlice(rProj, {
        id: '2',
        project: 'workrepo-backend',
        entityType: 'file',
        entity: '/x',
        machineIds: [],
        editors: []
      })
    ).toBe(false);
  });

  // TC-13: Canonical-Only Identity Invariant
  it('TC-13: classifier engine strictly matches canonical IDs in machineIds/editors without fuzzy hostname or friendly name heuristics', () => {
    const rFriendlyMachine: ClassificationRule = {
      id: 'r-fm',
      selectorType: 'machine',
      selectorValue: 'PC080213',
      matchMode: 'exact',
      classification: 'work',
      priority: 0,
      createdAt: '2026-01-01T00:00:00Z'
    };
    const s: ClassifiableSlice = {
      id: 's-canon',
      project: 'proj',
      entityType: 'file',
      entity: '/file.ts',
      machineIds: ['00ca4c40-47fb-4638-9cb5-9856a9fae0b0'],
      editors: ['00020036-8f52-44ca-b5d1-9f9b5ad033ea']
    };
    // Must NOT match friendly string against canonical UUID
    expect(ruleMatchesSlice(rFriendlyMachine, s)).toBe(false);

    const rCanonMachine: ClassificationRule = {
      id: 'r-cm',
      selectorType: 'machine',
      selectorValue: '00ca4c40-47fb-4638-9cb5-9856a9fae0b0',
      matchMode: 'exact',
      classification: 'work',
      priority: 0,
      createdAt: '2026-01-01T00:00:00Z'
    };
    expect(ruleMatchesSlice(rCanonMachine, s)).toBe(true);
  });

  it('enforces MAX_PATTERN_LENGTH = 500 in compilePattern', () => {
    expect(MAX_PATTERN_LENGTH).toBe(500);
    const valid500 = 'a'.repeat(500);
    expect(() => compilePattern('project', valid500, 'glob')).not.toThrow();

    const invalid501 = 'a'.repeat(501);
    expect(() => compilePattern('project', invalid501, 'glob')).toThrow(
      /exceeds limit of 500/
    );
  });

  it('tie-breaks rules of equal effective precedence by createdAt ASC, then id ASC', () => {
    const ruleA: ClassificationRule = {
      id: 'rule-alpha',
      selectorType: 'application',
      selectorValue: 'slack',
      classification: 'work',
      priority: 0,
      createdAt: '2026-01-01T00:00:00.000Z'
    };

    const ruleB: ClassificationRule = {
      id: 'rule-beta',
      selectorType: 'application',
      selectorValue: 'slack',
      classification: 'work',
      priority: 0,
      createdAt: '2026-01-01T00:00:00.000Z'
    };

    // Both same precedence and same createdAt -> id ASC breaks tie ('rule-alpha' < 'rule-beta')
    expect(compareRulePrecedence(ruleA, ruleB)).toBeLessThan(0);
    expect(compareRulePrecedence(ruleB, ruleA)).toBeGreaterThan(0);

    // Rule with earlier createdAt strictly wins regardless of id
    const ruleEarlier: ClassificationRule = {
      id: 'rule-zebra',
      selectorType: 'application',
      selectorValue: 'slack',
      classification: 'work',
      priority: 0,
      createdAt: '2025-12-31T23:59:59.000Z'
    };
    expect(compareRulePrecedence(ruleEarlier, ruleA)).toBeLessThan(0);
  });

  it('matches Windows drive path candidates case-insensitively in glob mode with leading wildcards', () => {
    const globRule: ClassificationRule = {
      id: 'r-win-glob',
      selectorType: 'folder_prefix',
      selectorValue: '*USERS*',
      matchMode: 'glob',
      classification: 'work',
      priority: 0,
      createdAt: '2026-01-01T00:00:00Z'
    };

    // Windows candidate with backslashes
    const winSlice: ClassifiableSlice = {
      id: 's-win',
      project: 'proj',
      entityType: 'file',
      entity: 'C:\\Users\\John\\repo\\main.ts',
      machineIds: [],
      editors: []
    };
    expect(ruleMatchesSlice(globRule, winSlice)).toBe(true);

    // Windows candidate with forward slashes
    const winSliceForward: ClassifiableSlice = {
      id: 's-win-fwd',
      project: 'proj',
      entityType: 'file',
      entity: 'C:/Users/John/repo/main.ts',
      machineIds: [],
      editors: []
    };
    expect(ruleMatchesSlice(globRule, winSliceForward)).toBe(true);

    // Unix path candidate preserves case and does not match uppercase *USERS*
    const unixSlice: ClassifiableSlice = {
      id: 's-unix',
      project: 'proj',
      entityType: 'file',
      entity: '/users/john/repo/main.ts',
      machineIds: [],
      editors: []
    };
    expect(ruleMatchesSlice(globRule, unixSlice)).toBe(false);

    // Matching case on Unix matches
    const unixCaseMatchRule: ClassificationRule = {
      ...globRule,
      selectorValue: '*users*'
    };
    expect(ruleMatchesSlice(unixCaseMatchRule, unixSlice)).toBe(true);
  });

  describe('TC-09: Glob pattern matching across selector types and casing boundaries', () => {
    it('matches machine selectors with glob patterns case-insensitively against canonical identities', () => {
      const globRule: ClassificationRule = {
        id: 'r-machine-glob',
        selectorType: 'machine',
        selectorValue: 'desktop-*',
        matchMode: 'glob',
        classification: 'work',
        priority: 0,
        createdAt: '2026-01-01T00:00:00Z'
      };

      const matchSlice: ClassifiableSlice = {
        id: 's1',
        project: 'proj',
        entityType: 'file',
        entity: 'src/main.ts',
        machineIds: ['desktop-office-42'],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, matchSlice)).toBe(true);

      const matchUpperSlice: ClassifiableSlice = {
        id: 's2',
        project: 'proj',
        entityType: 'file',
        entity: 'src/main.ts',
        machineIds: ['DESKTOP-BUILDER-01'],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, matchUpperSlice)).toBe(true);

      const nonMatchSlice: ClassifiableSlice = {
        id: 's3',
        project: 'proj',
        entityType: 'file',
        entity: 'src/main.ts',
        machineIds: ['laptop-macbook'],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, nonMatchSlice)).toBe(false);
    });

    it('matches editor selectors with glob patterns case-insensitively', () => {
      const globRule: ClassificationRule = {
        id: 'r-editor-glob',
        selectorType: 'editor',
        selectorValue: '*code*',
        matchMode: 'glob',
        classification: 'work',
        priority: 0,
        createdAt: '2026-01-01T00:00:00Z'
      };

      const matchSlice: ClassifiableSlice = {
        id: 's1',
        project: 'proj',
        entityType: 'file',
        entity: 'src/main.ts',
        machineIds: [],
        editors: ['Visual Studio Code']
      };
      expect(ruleMatchesSlice(globRule, matchSlice)).toBe(true);

      const nonMatchSlice: ClassifiableSlice = {
        id: 's2',
        project: 'proj',
        entityType: 'file',
        entity: 'src/main.ts',
        machineIds: [],
        editors: ['Sublime Text', 'Vim']
      };
      expect(ruleMatchesSlice(globRule, nonMatchSlice)).toBe(false);
    });

    it('matches application selectors with glob patterns case-insensitively for app slices only', () => {
      const globRule: ClassificationRule = {
        id: 'r-app-glob',
        selectorType: 'application',
        selectorValue: 'slack*',
        matchMode: 'glob',
        classification: 'work',
        priority: 0,
        createdAt: '2026-01-01T00:00:00Z'
      };

      const matchSlice: ClassifiableSlice = {
        id: 's1',
        project: 'proj',
        entityType: 'app',
        entity: 'Slack - Announcements',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, matchSlice)).toBe(true);

      const matchUpperSlice: ClassifiableSlice = {
        id: 's2',
        project: 'proj',
        entityType: 'app',
        entity: 'SLACK - DEV TEAM',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, matchUpperSlice)).toBe(true);

      const nonMatchAppSlice: ClassifiableSlice = {
        id: 's3',
        project: 'proj',
        entityType: 'app',
        entity: 'Discord',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, nonMatchAppSlice)).toBe(false);

      const nonAppSlice: ClassifiableSlice = {
        id: 's4',
        project: 'proj',
        entityType: 'file',
        entity: 'slack/config.json',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, nonAppSlice)).toBe(false);
    });

    it('matches domain selectors with glob patterns case-insensitively for domain slices only', () => {
      const globRule: ClassificationRule = {
        id: 'r-domain-glob',
        selectorType: 'domain',
        selectorValue: '*.github.com',
        matchMode: 'glob',
        classification: 'work',
        priority: 0,
        createdAt: '2026-01-01T00:00:00Z'
      };

      const matchSlice: ClassifiableSlice = {
        id: 's1',
        project: null,
        entityType: 'domain',
        entity: 'gist.github.com',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, matchSlice)).toBe(true);

      const matchUpperSlice: ClassifiableSlice = {
        id: 's2',
        project: null,
        entityType: 'domain',
        entity: 'API.GITHUB.COM',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, matchUpperSlice)).toBe(true);

      const nonMatchApexSlice: ClassifiableSlice = {
        id: 's3',
        project: null,
        entityType: 'domain',
        entity: 'github.com',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, nonMatchApexSlice)).toBe(false);

      const otherDomainSlice: ClassifiableSlice = {
        id: 's4',
        project: null,
        entityType: 'domain',
        entity: 'gitlab.com',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, otherDomainSlice)).toBe(false);
    });

    it('matches directly drive-qualified Windows paths case-insensitively and normalizes backslashes', () => {
      const globRule: ClassificationRule = {
        id: 'r-win-drive-glob',
        selectorType: 'folder_prefix',
        selectorValue: 'C:/Projects/*/src/*',
        matchMode: 'glob',
        classification: 'work',
        priority: 0,
        createdAt: '2026-01-01T00:00:00Z'
      };

      const winBackslashSlice: ClassifiableSlice = {
        id: 's1',
        project: 'proj',
        entityType: 'file',
        entity: 'c:\\projects\\work-app\\src\\index.ts',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, winBackslashSlice)).toBe(true);

      const winUpperSlice: ClassifiableSlice = {
        id: 's2',
        project: 'proj',
        entityType: 'file',
        entity: 'C:/PROJECTS/CLIENT-APP/SRC/main.ts',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, winUpperSlice)).toBe(true);

      const diffDriveSlice: ClassifiableSlice = {
        id: 's3',
        project: 'proj',
        entityType: 'file',
        entity: 'D:/Projects/work-app/src/index.ts',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, diffDriveSlice)).toBe(false);
    });

    it('matches leading-wildcard Windows paths case-insensitively', () => {
      const globRule: ClassificationRule = {
        id: 'r-win-lead-glob',
        selectorType: 'folder_prefix',
        selectorValue: '*Users/*/Documents/*',
        matchMode: 'glob',
        classification: 'personal',
        priority: 0,
        createdAt: '2026-01-01T00:00:00Z'
      };

      const winSlice: ClassifiableSlice = {
        id: 's1',
        project: 'proj',
        entityType: 'file',
        entity: 'c:\\Users\\dev\\Documents\\tax-return.pdf',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, winSlice)).toBe(true);

      const winUpperSlice: ClassifiableSlice = {
        id: 's2',
        project: 'proj',
        entityType: 'file',
        entity: 'C:/USERS/dev/DOCUMENTS/receipt.pdf',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, winUpperSlice)).toBe(true);
    });

    it('preserves case strictly for Unix paths in glob matching', () => {
      const globRule: ClassificationRule = {
        id: 'r-unix-case',
        selectorType: 'folder_prefix',
        selectorValue: '/Users/*/Code/*',
        matchMode: 'glob',
        classification: 'work',
        priority: 0,
        createdAt: '2026-01-01T00:00:00Z'
      };

      const matchingUnixSlice: ClassifiableSlice = {
        id: 's1',
        project: 'proj',
        entityType: 'file',
        entity: '/Users/dev/Code/repo/main.ts',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, matchingUnixSlice)).toBe(true);

      const lowerUnixSlice: ClassifiableSlice = {
        id: 's2',
        project: 'proj',
        entityType: 'file',
        entity: '/users/dev/code/repo/main.ts',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, lowerUnixSlice)).toBe(false);
    });

    it('preserves case strictly for relative paths in glob matching', () => {
      const globRule: ClassificationRule = {
        id: 'r-rel-case',
        selectorType: 'folder_prefix',
        selectorValue: 'src/*/Components/*',
        matchMode: 'glob',
        classification: 'work',
        priority: 0,
        createdAt: '2026-01-01T00:00:00Z'
      };

      const matchingSlice: ClassifiableSlice = {
        id: 's1',
        project: 'proj',
        entityType: 'file',
        entity: 'src/admin/Components/Table.svelte',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, matchingSlice)).toBe(true);

      const mismatchedSlice: ClassifiableSlice = {
        id: 's2',
        project: 'proj',
        entityType: 'file',
        entity: 'src/admin/components/Table.svelte',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, mismatchedSlice)).toBe(false);
    });

    it('preserves case strictly for project selectors in glob matching', () => {
      const globRule: ClassificationRule = {
        id: 'r-proj-case',
        selectorType: 'project',
        selectorValue: 'Client-*',
        matchMode: 'glob',
        classification: 'work',
        priority: 0,
        createdAt: '2026-01-01T00:00:00Z'
      };

      const matchSlice: ClassifiableSlice = {
        id: 's1',
        project: 'Client-Portal',
        entityType: 'file',
        entity: 'src/main.ts',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, matchSlice)).toBe(true);

      const lowercaseSlice: ClassifiableSlice = {
        id: 's2',
        project: 'client-portal',
        entityType: 'file',
        entity: 'src/main.ts',
        machineIds: [],
        editors: []
      };
      expect(ruleMatchesSlice(globRule, lowercaseSlice)).toBe(false);
    });
  });

  describe('pure slice-kind behavior', () => {
    it('leaves coarse project_summary slices unclassified by default even when matching broad project rules exist', () => {
      const projectRule: ClassificationRule = {
        id: 'rule-proj',
        selectorType: 'project',
        selectorValue: 'work-times',
        matchMode: 'exact',
        classification: 'work',
        priority: 100,
        createdAt: '2026-01-01T00:00:00Z'
      };

      const coarseSlice: ClassifiableSlice = {
        id: 'slice-coarse',
        project: 'work-times',
        entityType: 'app',
        entity: 'work-times',
        machineIds: ['work-laptop'],
        editors: ['VS Code'],
        kind: 'project_summary'
      };

      // Rule must NOT match coarse slice
      expect(ruleMatchesSlice(projectRule, coarseSlice)).toBe(false);

      // Classification decision must be unclassified / default
      const decision = classifySlice(coarseSlice, [projectRule]);
      expect(decision.classification).toBe('unclassified');
      expect(decision.source).toBe('default');
      expect(decision.winningRuleId).toBeNull();
    });

    it('allows explicit whole-slice override on coarse project_summary slices', () => {
      const coarseSlice: ClassifiableSlice = {
        id: 'slice-coarse-override',
        project: 'work-times',
        entityType: 'app',
        entity: 'work-times',
        machineIds: [],
        editors: [],
        kind: 'project_summary'
      };

      const decision = classifySlice(coarseSlice, [], { classification: 'work' });
      expect(decision.classification).toBe('work');
      expect(decision.source).toBe('override');
      expect(decision.winningRuleId).toBeNull();
    });

    it('leaves unattributed_residual slices unclassified by default and ignores rules', () => {
      const broadRule: ClassificationRule = {
        id: 'rule-broad-entity',
        selectorType: 'entity',
        selectorValue: '__unattributed__',
        matchMode: 'exact',
        classification: 'personal',
        priority: 50,
        createdAt: '2026-01-01T00:00:00Z'
      };

      const residualSlice: ClassifiableSlice = {
        id: 'slice-residual',
        project: null,
        entityType: 'unattributed',
        entity: '__unattributed__',
        machineIds: [],
        editors: [],
        kind: 'unattributed_residual'
      };

      expect(ruleMatchesSlice(broadRule, residualSlice)).toBe(false);

      const decision = classifySlice(residualSlice, [broadRule]);
      expect(decision.classification).toBe('unclassified');
      expect(decision.source).toBe('default');
    });

    it('evaluates entity slices normally under existing rules', () => {
      const projectRule: ClassificationRule = {
        id: 'rule-proj-normal',
        selectorType: 'project',
        selectorValue: 'work-times',
        matchMode: 'exact',
        classification: 'work',
        priority: 10,
        createdAt: '2026-01-01T00:00:00Z'
      };

      const entitySlice: ClassifiableSlice = {
        id: 'slice-file',
        project: 'work-times',
        entityType: 'file',
        entity: '/src/main.ts',
        machineIds: [],
        editors: [],
        kind: 'entity'
      };

      expect(ruleMatchesSlice(projectRule, entitySlice)).toBe(true);
      const decision = classifySlice(entitySlice, [projectRule]);
      expect(decision.classification).toBe('work');
      expect(decision.source).toBe('rule');
      expect(decision.winningRuleId).toBe('rule-proj-normal');
    });
  });
});
