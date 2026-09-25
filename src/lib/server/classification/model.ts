export const MATCH_MODES = ['exact', 'glob'] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

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
  id?: string;
  selectorType: SelectorType;
  selectorValue: string;
  matchMode?: MatchMode;
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
  entityType: 'file' | 'app' | 'domain' | 'url' | 'unattributed';
  entity: string;
  machineIds: readonly string[];
  editors: readonly string[];
  kind?: 'entity' | 'project_summary' | 'unattributed_residual';
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

export type GlobToken =
  | { type: 'LITERAL'; value: string }
  | { type: 'STAR' }
  | { type: 'QUESTION' };

export const MAX_PATTERN_LENGTH = 500;

export interface CompiledPattern {
  readonly selectorType: SelectorType;
  readonly matchMode: MatchMode;
  readonly raw: string;
  readonly tokens: readonly GlobToken[];
  readonly literalCharCount: number;
  test(candidate: string): boolean;
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

export function folderMatches(entity: string, prefix: string): boolean {
  const normalizedEntity = normalizePath(entity);
  const normalizedPrefix = normalizePath(prefix);
  return normalizedEntity === normalizedPrefix || normalizedEntity.startsWith(`${normalizedPrefix}/`);
}

/**
 * Linear greedy matcher with backtrack indices over Unicode code points.
 * Provably regex-free, ReDoS-free, recursion-free, and bounded by O(N * M).
 */
export function matchGlobTokens(tokens: readonly GlobToken[], candidate: string): boolean {
  const candidateCodePoints = Array.from(candidate);
  let tIdx = 0;
  let cIdx = 0;
  let lastStarIdx = -1;
  let backtrackCandidateIdx = -1;

  while (cIdx < candidateCodePoints.length) {
    const token = tokens[tIdx];

    if (token && token.type === 'LITERAL') {
      const litCodePoints = Array.from(token.value);
      let match = true;
      if (cIdx + litCodePoints.length <= candidateCodePoints.length) {
        for (let i = 0; i < litCodePoints.length; i++) {
          if (candidateCodePoints[cIdx + i] !== litCodePoints[i]) {
            match = false;
            break;
          }
        }
      } else {
        match = false;
      }

      if (match) {
        cIdx += litCodePoints.length;
        tIdx++;
        continue;
      }
    } else if (token && token.type === 'QUESTION') {
      cIdx++;
      tIdx++;
      continue;
    } else if (token && token.type === 'STAR') {
      lastStarIdx = tIdx;
      tIdx++;
      backtrackCandidateIdx = cIdx;
      continue;
    }

    if (lastStarIdx !== -1) {
      tIdx = lastStarIdx + 1;
      backtrackCandidateIdx++;
      cIdx = backtrackCandidateIdx;
    } else {
      return false;
    }
  }

  while (tIdx < tokens.length && tokens[tIdx].type === 'STAR') {
    tIdx++;
  }

  return tIdx === tokens.length && cIdx === candidateCodePoints.length;
}

export function compilePattern(
  selectorType: SelectorType,
  selectorValue: string,
  matchMode: MatchMode = 'exact'
): CompiledPattern {
  if (selectorValue.length > MAX_PATTERN_LENGTH) {
    throw new Error(`Pattern length ${selectorValue.length} exceeds limit of ${MAX_PATTERN_LENGTH}`);
  }

  const normalized = normalizeSelectorValue(selectorType, selectorValue);

  if (matchMode === 'exact') {
    const literalCount = Array.from(normalized).length;
    return {
      selectorType,
      matchMode: 'exact',
      raw: selectorValue,
      tokens: [{ type: 'LITERAL', value: normalized }],
      literalCharCount: literalCount,
      test: (candidate: string) => {
        const normCand = normalizeSelectorValue(selectorType, candidate);
        if (selectorType === 'folder_prefix') {
          return folderMatches(candidate, normalized);
        }
        return normCand === normalized;
      }
    };
  }

  // Glob mode: tokenize normalized pattern with bracket escaping
  const tokens: GlobToken[] = [];
  let literalAcc = '';
  let literalCharCount = 0;

  const flushLiteral = () => {
    if (literalAcc.length > 0) {
      tokens.push({ type: 'LITERAL', value: literalAcc });
      literalCharCount += Array.from(literalAcc).length;
      literalAcc = '';
    }
  };

  let i = 0;
  while (i < normalized.length) {
    if (normalized.startsWith('[*]', i)) {
      literalAcc += '*';
      i += 3;
    } else if (normalized.startsWith('[?]', i)) {
      literalAcc += '?';
      i += 3;
    } else if (normalized[i] === '*') {
      flushLiteral();
      if (tokens.length === 0 || tokens[tokens.length - 1].type !== 'STAR') {
        tokens.push({ type: 'STAR' });
      }
      i++;
    } else if (normalized[i] === '?') {
      flushLiteral();
      tokens.push({ type: 'QUESTION' });
      i++;
    } else {
      literalAcc += normalized[i];
      i++;
    }
  }
  flushLiteral();

  const lowerTokens: GlobToken[] = tokens.map((t) =>
    t.type === 'LITERAL' ? { type: 'LITERAL', value: t.value.toLocaleLowerCase('en-US') } : t
  );

  return {
    selectorType,
    matchMode: 'glob',
    raw: selectorValue,
    tokens,
    literalCharCount,
    test: (candidate: string) => {
      const normCand = normalizeSelectorValue(selectorType, candidate);
      if (
        (selectorType === 'folder_prefix' || selectorType === 'entity') &&
        /^[a-z]:\//i.test(normCand)
      ) {
        return matchGlobTokens(lowerTokens, normCand);
      }
      return matchGlobTokens(tokens, normCand);
    }
  };
}

export function ruleMatchesSlice(rule: ClassificationRuleLike, slice: ClassifiableSlice): boolean {
  // Coarse project summaries and unattributed residuals never match automatic classification rules
  if (slice.kind === 'project_summary' || slice.kind === 'unattributed_residual') {
    return false;
  }

  const matchMode = rule.matchMode ?? 'exact';
  const compiled = compilePattern(rule.selectorType, rule.selectorValue, matchMode);

  switch (rule.selectorType) {
    case 'machine':
      // P1 Invariant: canonical-only machine identity matching
      return slice.machineIds.some((candidate) => compiled.test(candidate));
    case 'editor':
      // P1 Invariant: canonical-only editor identity matching
      return slice.editors.some((candidate) => compiled.test(candidate));
    case 'application':
      return slice.entityType === 'app' && compiled.test(slice.entity);
    case 'domain':
      return slice.entityType === 'domain' && compiled.test(slice.entity);
    case 'project':
      return slice.project !== null && compiled.test(slice.project);
    case 'folder_prefix':
      return slice.entityType === 'file' && compiled.test(slice.entity);
    case 'entity':
      return compiled.test(slice.entity);
  }
}

/**
 * Computes the transitive lexicographic 4-tuple key:
 * (priority, selectorSpecificity, matchModeRank, modeSpecificity)
 */
export function getRulePrecedenceKey(rule: ClassificationRuleLike): [number, number, number, number] {
  const priority = rule.priority;
  const selectorSpecificity = SELECTOR_SPECIFICITY[rule.selectorType];
  const isExact = (rule.matchMode ?? 'exact') === 'exact';
  const matchModeRank = isExact ? 1 : 0;
  let modeSpecificity = 0;

  if (isExact) {
    if (rule.selectorType === 'folder_prefix') {
      modeSpecificity = normalizePath(rule.selectorValue).length;
    } else {
      modeSpecificity = 0;
    }
  } else {
    modeSpecificity = compilePattern(rule.selectorType, rule.selectorValue, 'glob').literalCharCount;
  }

  return [priority, selectorSpecificity, matchModeRank, modeSpecificity];
}

/**
 * Returns true only when two matching rules have the exact same operator-controlled
 * effective precedence. Stable sort fields (createdAt, selectorValue) are deliberately excluded.
 */
export function hasEqualEffectivePrecedence(
  left: ClassificationRuleLike,
  right: ClassificationRuleLike
): boolean {
  const kLeft = getRulePrecedenceKey(left);
  const kRight = getRulePrecedenceKey(right);
  return (
    kLeft[0] === kRight[0] &&
    kLeft[1] === kRight[1] &&
    kLeft[2] === kRight[2] &&
    kLeft[3] === kRight[3]
  );
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

  // Coarse project summaries and unattributed residuals remain unclassified by default
  // Automatic classification of coarse data is deferred.
  if (slice.kind === 'project_summary' || slice.kind === 'unattributed_residual') {
    return {
      classification: 'unclassified',
      source: 'default',
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
  const kLeft = getRulePrecedenceKey(left);
  const kRight = getRulePrecedenceKey(right);

  // 1. priority DESC
  if (kLeft[0] !== kRight[0]) return kRight[0] - kLeft[0];
  // 2. selectorSpecificity DESC
  if (kLeft[1] !== kRight[1]) return kRight[1] - kLeft[1];
  // 3. matchModeRank DESC (exact > glob)
  if (kLeft[2] !== kRight[2]) return kRight[2] - kLeft[2];
  // 4. modeSpecificity DESC
  if (kLeft[3] !== kRight[3]) return kRight[3] - kLeft[3];

  const created = left.createdAt.localeCompare(right.createdAt);
  if (created !== 0) return created;
  const idCompare = (left.id ?? '').localeCompare(right.id ?? '');
  if (idCompare !== 0) return idCompare;
  return left.selectorValue.localeCompare(right.selectorValue);
}
