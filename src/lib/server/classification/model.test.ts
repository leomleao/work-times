import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATIONS,
  classifySlice,
  compareRulePrecedence,
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
});
