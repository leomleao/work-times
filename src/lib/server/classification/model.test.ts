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
});
