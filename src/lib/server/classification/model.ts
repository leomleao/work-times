export const CLASSIFICATIONS = ['work', 'personal', 'unclassified'] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

export const SELECTOR_TYPES = [
  'machine',
  'editor',
  'application',
  'domain',
  'project',
  'folder_prefix',
  'entity'
] as const;

export type SelectorType = (typeof SELECTOR_TYPES)[number];

/**
 * Higher values are narrower. An explicit operator priority is evaluated
 * before this rank, and a one-off override bypasses reusable rules entirely.
 */
export const SELECTOR_SPECIFICITY: Readonly<Record<SelectorType, number>> = {
  machine: 10,
  editor: 10,
  application: 10,
  domain: 10,
  project: 40,
  folder_prefix: 50,
  entity: 60
};

export interface ClassificationRuleLike {
  selectorType: SelectorType;
  selectorValue: string;
  priority: number;
  createdAt: string;
}

export type RuleClassification = Exclude<Classification, 'unclassified'>;

export interface ClassificationRule extends ClassificationRuleLike {
  id: string;
  classification: RuleClassification;
  enabled?: boolean;
}

export interface ClassifiableSlice {
  id: string;
  project: string | null;
  entityType: 'file' | 'app' | 'domain' | 'unattributed';
  entity: string;
  machineIds: readonly string[];
  editors: readonly string[];
}

export interface SliceOverride {
  classification: Classification;
}

export interface ClassificationDecision {
  classification: Classification;
  source: 'override' | 'rule' | 'ambiguous' | 'default';
  winningRuleId: string | null;
  competingRuleIds: string[];
}

function normalizePath(value: string): string {
  const normalized = value.trim().normalize('NFC').replaceAll('\\', '/').replace(/\/$/, '');
  return /^[a-z]:\//i.test(normalized) ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function normalizeSelectorValue(type: SelectorType, value: string): string {
  const trimmed = value.trim().normalize('NFC');

  switch (type) {
    case 'folder_prefix':
    case 'entity':
      return normalizePath(trimmed);
    case 'machine':
    case 'editor':
    case 'application':
    case 'domain':
      return trimmed.toLocaleLowerCase('en-US');
    case 'project':
      return trimmed;
  }
}

function folderMatches(entity: string, prefix: string): boolean {
  const normalizedEntity = normalizePath(entity);
  const normalizedPrefix = normalizePath(prefix);
  return normalizedEntity === normalizedPrefix || normalizedEntity.startsWith(`${normalizedPrefix}/`);
}

export function ruleMatchesSlice(rule: ClassificationRuleLike, slice: ClassifiableSlice): boolean {
  const value = normalizeSelectorValue(rule.selectorType, rule.selectorValue);

  switch (rule.selectorType) {
    case 'machine':
      return slice.machineIds.some(
        (candidate) => normalizeSelectorValue('machine', candidate) === value
      );
    case 'editor':
      return slice.editors.some((candidate) => normalizeSelectorValue('editor', candidate) === value);
    case 'application':
      return (
        slice.entityType === 'app' && normalizeSelectorValue('application', slice.entity) === value
      );
    case 'domain':
      return slice.entityType === 'domain' && normalizeSelectorValue('domain', slice.entity) === value;
    case 'project':
      return slice.project !== null && normalizeSelectorValue('project', slice.project) === value;
    case 'folder_prefix':
      return slice.entityType === 'file' && folderMatches(slice.entity, value);
    case 'entity':
      return normalizeSelectorValue('entity', slice.entity) === value;
  }
}

/**
 * Returns true only when two matching rules have the same operator-controlled
 * precedence. Stable sort fields are deliberately excluded: a cross-dimension
 * work/personal tie must remain visible, not be silently decided by creation time.
 */
export function hasEqualEffectivePrecedence(
  left: ClassificationRuleLike,
  right: ClassificationRuleLike
): boolean {
  if (left.priority !== right.priority) return false;
  if (SELECTOR_SPECIFICITY[left.selectorType] !== SELECTOR_SPECIFICITY[right.selectorType]) {
    return false;
  }

  if (left.selectorType === 'folder_prefix' && right.selectorType === 'folder_prefix') {
    return normalizePath(left.selectorValue).length === normalizePath(right.selectorValue).length;
  }

  return true;
}

export function classifySlice(
  slice: ClassifiableSlice,
  rules: readonly ClassificationRule[],
  override?: SliceOverride | null
): ClassificationDecision {
  if (override) {
    return {
      classification: override.classification,
      source: 'override',
      winningRuleId: null,
      competingRuleIds: []
    };
  }

  const matching = rules
    .filter((rule) => rule.enabled !== false && ruleMatchesSlice(rule, slice))
    .sort(compareRulePrecedence);

  const first = matching[0];
  if (!first) {
    return {
      classification: 'unclassified',
      source: 'default',
      winningRuleId: null,
      competingRuleIds: []
    };
  }

  const tied = matching.filter((rule) => hasEqualEffectivePrecedence(first, rule));
  if (new Set(tied.map((rule) => rule.classification)).size > 1) {
    return {
      classification: 'unclassified',
      source: 'ambiguous',
      winningRuleId: null,
      competingRuleIds: tied.map((rule) => rule.id).sort()
    };
  }

  return {
    classification: first.classification,
    source: 'rule',
    winningRuleId: first.id,
    competingRuleIds: []
  };
}

export function compareRulePrecedence(
  left: ClassificationRuleLike,
  right: ClassificationRuleLike
): number {
  if (left.priority !== right.priority) return right.priority - left.priority;

  const specificity =
    SELECTOR_SPECIFICITY[right.selectorType] - SELECTOR_SPECIFICITY[left.selectorType];
  if (specificity !== 0) return specificity;

  if (left.selectorType === 'folder_prefix' && right.selectorType === 'folder_prefix') {
    const pathLength =
      normalizePath(right.selectorValue).length - normalizePath(left.selectorValue).length;
    if (pathLength !== 0) return pathLength;
  }

  const created = left.createdAt.localeCompare(right.createdAt);
  if (created !== 0) return created;
  return left.selectorValue.localeCompare(right.selectorValue);
}
