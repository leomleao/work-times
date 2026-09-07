import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  classifySlice,
  type ClassifiableSlice,
  type Classification,
  type ClassificationDecision,
  type ClassificationRule,
  type RuleClassification,
  type SelectorType,
  normalizeSelectorValue,
  SELECTOR_SPECIFICITY,
  SELECTOR_TYPES
} from './model.js';

export class StalePreviewError extends Error {
  constructor(message: string = 'Stale preview: revision has changed') {
    super(message);
    this.name = 'StalePreviewError';
  }
}

export class MissingPreviewError extends Error {
  constructor(
    message: string = 'Rule confirmation requires an exact preview digest; obtain a preview before mutating rules'
  ) {
    super(message);
    this.name = 'MissingPreviewError';
  }
}

export class AllocationConflictError extends Error {
  constructor(
    public readonly existingClassification: string,
    public readonly proposedClassification: string,
    message: string = `Allocation conflict: slice already has classification '${existingClassification}', proposed '${proposedClassification}'`
  ) {
    super(message);
    this.name = 'AllocationConflictError';
  }
}

export interface ClassificationRuleRecord {
  id: string;
  name: string;
  classification: RuleClassification;
  selector_type: SelectorType;
  selector_value: string;
  display_value?: string;
  priority: number;
  enabled: boolean;
  timesheet_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface DailyTimeAllocationRecord {
  id: string;
  date: string;
  project_id: number;
  entity: string;
  classification: RuleClassification;
  allocated_seconds: number;
  timesheet_code: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClassificationRevisionRecord {
  id: number;
  mutation_type:
    | 'rule_created'
    | 'rule_updated'
    | 'rule_deleted'
    | 'allocation_created'
    | 'allocation_deleted';
  target_type: 'rule' | 'allocation';
  target_id: string;
  before_json: string | null;
  after_json: string | null;
  affected_json: string | null;
  actor: string;
  created_at: string;
}

export interface EvaluatedSlice {
  id: number;
  date: string;
  projectId: number;
  projectName: string | null;
  entity: string;
  entityType: 'file' | 'app' | 'domain' | 'unattributed';
  totalSeconds: number;
  isUnattributed: boolean;
  machineIds: string[];
  editors: string[];
  allocation: DailyTimeAllocationRecord | null;
  decision: ClassificationDecision;
}

export interface ShiftedSeconds {
  workToPersonal: number;
  workToUnclassified: number;
  personalToWork: number;
  personalToUnclassified: number;
  unclassifiedToWork: number;
  unclassifiedToPersonal: number;
  totalShifted: number;
  net: {
    work: number;
    personal: number;
    unclassified: number;
  };
}

export interface RulePreviewResult {
  previewRevision: number;
  previewDigest: string;
  affectedSliceCount: number;
  affectedDates: string[];
  shiftedSeconds: ShiftedSeconds;
  proposedRuleId?: string;
}

export interface CreateRuleInput {
  id?: string;
  name: string;
  classification: RuleClassification;
  selectorType: SelectorType;
  selectorValue: string;
  priority?: number;
  enabled?: boolean;
  timesheetCode?: string | null;
}

export interface UpdateRuleInput {
  name?: string;
  classification?: RuleClassification;
  selectorType?: SelectorType;
  selectorValue?: string;
  priority?: number;
  enabled?: boolean;
  timesheetCode?: string | null;
}

export type RuleChangeInput =
  | { type: 'create'; rule: CreateRuleInput }
  | { type: 'update'; id: string; rule: UpdateRuleInput }
  | { type: 'delete'; id: string };

export type NormalizedRuleOperation =
  | {
      type: 'create';
      rule: {
        id?: string;
        name: string;
        classification: RuleClassification;
        selectorType: SelectorType;
        selectorValue: string;
        priority: number;
        enabled: boolean;
        timesheetCode: string | null;
      };
    }
  | {
      type: 'update';
      id: string;
      rule: {
        name?: string;
        classification?: RuleClassification;
        selectorType?: SelectorType;
        selectorValue?: string;
        priority?: number;
        enabled?: boolean;
        timesheetCode?: string | null;
      };
    }
  | {
      type: 'delete';
      id: string;
    };

export interface RuleMutationOptions {
  expectedDigest: string;
  expectedRevision?: number | string;
  actor?: string;
}

export interface CreateAllocationInput {
  id?: string;
  date: string;
  projectId: number;
  entity: string;
  classification: RuleClassification;
  timesheetCode?: string | null;
  note?: string | null;
}

export interface AllocationMutationOptions {
  actor?: string;
  replaceExisting?: boolean;
}

export interface ClassificationCoverage {
  totalSeconds: number;
  classifiedSeconds: number;
  workSeconds: number;
  personalSeconds: number;
  unclassifiedSeconds: number;
  coverageRatio: number;
  coveragePercentage: number;
  totalSlices: number;
  workSlices: number;
  personalSlices: number;
  unclassifiedSlices: number;
  daysCovered: number;
}

export interface UnclassifiedSuggestion {
  selectorType: SelectorType;
  selectorValue: string;
  displayValue: string;
  specificity: number;
  unclassifiedSeconds: number;
  sliceCount: number;
  sampleEntities: string[];
  sampleProjects: string[];
  earliestDate: string | null;
  latestDate: string | null;
}

function roundSeconds(seconds: number): number {
  return Math.round((seconds + Number.EPSILON) * 10_000) / 10_000;
}

function canonicalOperationKey(op: NormalizedRuleOperation): string {
  if (op.type === 'create') {
    return JSON.stringify({
      type: 'create',
      rule: {
        id: op.rule.id ?? null,
        name: op.rule.name,
        classification: op.rule.classification,
        selectorType: op.rule.selectorType,
        selectorValue: op.rule.selectorValue,
        priority: op.rule.priority,
        enabled: op.rule.enabled,
        timesheetCode: op.rule.timesheetCode ?? null
      }
    });
  } else if (op.type === 'update') {
    return JSON.stringify({
      type: 'update',
      id: op.id,
      rule: {
        name: op.rule.name ?? null,
        classification: op.rule.classification ?? null,
        selectorType: op.rule.selectorType ?? null,
        selectorValue: op.rule.selectorValue ?? null,
        priority: op.rule.priority !== undefined ? op.rule.priority : null,
        enabled: op.rule.enabled !== undefined ? op.rule.enabled : null,
        timesheetCode: op.rule.timesheetCode ?? null
      }
    });
  } else {
    return JSON.stringify({
      type: 'delete',
      id: op.id
    });
  }
}

export class SqliteClassificationService {
  private machineNameMap: Map<string, string> | null = null;
  private readonly editorNameMap = new Map<string, string>();

  constructor(private readonly db: Database.Database) {}

  clearCaches(): void {
    this.machineNameMap = null;
  }

  getMachineNameMap(): Map<string, string> {
    if (this.machineNameMap) return this.machineNameMap;

    const map = new Map<string, string>();
    try {
      const directRows = this.db
        .prepare(
          `SELECT machine_name_id, MIN(name) AS name
           FROM daily_dimension_totals
           WHERE scope = 'account'
             AND dimension = 'machine'
             AND machine_name_id IS NOT NULL
           GROUP BY machine_name_id
           HAVING COUNT(DISTINCT name) = 1`
        )
        .all() as Array<{ name: string; machine_name_id: string }>;

      for (const r of directRows) {
        const id = normalizeSelectorValue('machine', r.machine_name_id);
        if (id && !map.has(id)) {
          map.set(id, r.name);
        }
      }
    } catch {
      // Fall back gracefully in test or minimal databases
    }

    this.machineNameMap = map;
    return map;
  }

  getEditorNameMap(): Map<string, string> {
    // A heartbeat's user_agent_id can only be resolved authoritatively through
    // WakaTime's /users/current/user_agents registry. Daily editor totals are
    // aggregate views and cannot be joined to an individual heartbeat by date.
    // Keep IDs unresolved until that registry is persisted by the sync phase.
    return this.editorNameMap;
  }

  resolveMachineName(value: string): string {
    return this.getMachineNameMap().get(normalizeSelectorValue('machine', value)) ?? value;
  }

  resolveEditorName(value: string): string {
    return this.getEditorNameMap().get(value) ?? value;
  }

  getRules(filter?: { enabledOnly?: boolean }): ClassificationRuleRecord[] {
    let sql = `
      SELECT id, name, classification, selector_type, selector_value,
             priority, enabled, timesheet_code, created_at, updated_at
      FROM classification_rules
    `;
    if (filter?.enabledOnly) {
      sql += ` WHERE enabled = 1`;
    }
    sql += ` ORDER BY priority DESC, created_at ASC, id ASC`;

    const rows = this.db.prepare(sql).all() as Array<{
      id: string;
      name: string;
      classification: RuleClassification;
      selector_type: SelectorType;
      selector_value: string;
      priority: number;
      enabled: number;
      timesheet_code: string | null;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((r) => {
      let display_value = r.selector_value;
      if (r.selector_type === 'machine') {
        display_value = this.resolveMachineName(r.selector_value);
      } else if (r.selector_type === 'editor') {
        display_value = this.resolveEditorName(r.selector_value);
      }
      return {
        ...r,
        enabled: Boolean(r.enabled),
        display_value
      };
    });
  }

  getRule(id: string): ClassificationRuleRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, name, classification, selector_type, selector_value,
                priority, enabled, timesheet_code, created_at, updated_at
         FROM classification_rules WHERE id = ?`
      )
      .get(id) as
      | {
          id: string;
          name: string;
          classification: RuleClassification;
          selector_type: SelectorType;
          selector_value: string;
          priority: number;
          enabled: number;
          timesheet_code: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;
    let display_value = row.selector_value;
    if (row.selector_type === 'machine') {
      display_value = this.resolveMachineName(row.selector_value);
    } else if (row.selector_type === 'editor') {
      display_value = this.resolveEditorName(row.selector_value);
    }
    return { ...row, enabled: Boolean(row.enabled), display_value };
  }

  getAllocations(filter?: { date?: string; projectId?: number }): DailyTimeAllocationRecord[] {
    let sql = `
      SELECT id, date, project_id, entity, classification,
             allocated_seconds, timesheet_code, note, created_at, updated_at
      FROM daily_time_allocations
      WHERE 1=1
    `;
    const params: unknown[] = [];
    if (filter?.date) {
      sql += ` AND date = ?`;
      params.push(filter.date);
    }
    if (filter?.projectId !== undefined) {
      sql += ` AND project_id = ?`;
      params.push(filter.projectId);
    }
    sql += ` ORDER BY date ASC, project_id ASC, entity ASC`;

    return this.db.prepare(sql).all(...params) as DailyTimeAllocationRecord[];
  }

  getAllocation(id: string): DailyTimeAllocationRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, date, project_id, entity, classification,
                allocated_seconds, timesheet_code, note, created_at, updated_at
         FROM daily_time_allocations WHERE id = ?`
      )
      .get(id) as DailyTimeAllocationRecord | undefined;
    return row ?? null;
  }

  getAllocationBySlice(
    date: string,
    projectId: number,
    entity: string
  ): DailyTimeAllocationRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, date, project_id, entity, classification,
                allocated_seconds, timesheet_code, note, created_at, updated_at
         FROM daily_time_allocations WHERE date = ? AND project_id = ? AND entity = ?`
      )
      .get(date, projectId, entity) as DailyTimeAllocationRecord | undefined;
    return row ?? null;
  }

  getRevisions(limit: number = 100): ClassificationRevisionRecord[] {
    const sql = `
      SELECT id,
             mutation_type,
             target_type,
             target_id,
             before_json,
             after_json,
             affected_json,
             actor,
             created_at
      FROM classification_revisions
      ORDER BY id DESC LIMIT ?
    `;
    return this.db.prepare(sql).all(limit) as ClassificationRevisionRecord[];
  }

  getRevisionState(): { revision: number; digest: string } {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM classification_revisions')
      .get() as { max_id: number };
    const revision = row.max_id;

    const rules = this.db
      .prepare(
        'SELECT id, updated_at, enabled, priority, classification, selector_type, selector_value FROM classification_rules ORDER BY id ASC'
      )
      .all();
    const allocations = this.db
      .prepare(
        'SELECT id, updated_at, classification, allocated_seconds FROM daily_time_allocations ORDER BY id ASC'
      )
      .all();

    const hash = createHash('sha256')
      .update(`rev:${revision}`)
      .update(JSON.stringify(rules))
      .update(JSON.stringify(allocations))
      .digest('hex');

    const digest = `${revision}:${hash}`;
    return { revision, digest };
  }

  private computePreviewDigest(
    dbState: { revision: number; digest: string },
    op: NormalizedRuleOperation
  ): string {
    const opKey = canonicalOperationKey(op);
    const combinedHash = createHash('sha256')
      .update(dbState.digest)
      .update(opKey)
      .digest('hex');
    return `prev-${dbState.revision}-${combinedHash.slice(0, 32)}`;
  }

  private normalizeRuleOperation(change: RuleChangeInput): NormalizedRuleOperation {
    if (change.type === 'create') {
      const input = change.rule;
      if (typeof input.name !== 'string' || input.name.trim().length === 0) {
        throw new Error('Rule name cannot be empty');
      }
      if (input.classification !== 'work' && input.classification !== 'personal') {
        throw new Error(
          `Invalid classification '${input.classification}', must be 'work' or 'personal'`
        );
      }
      if (!SELECTOR_TYPES.includes(input.selectorType)) {
        throw new Error(`Invalid selector_type '${input.selectorType}'`);
      }
      if (typeof input.selectorValue !== 'string' || input.selectorValue.trim().length === 0) {
        throw new Error('Rule selector_value cannot be empty');
      }

      const normalizedValue = normalizeSelectorValue(input.selectorType, input.selectorValue);
      if (normalizedValue.length === 0) {
        throw new Error('Rule selector_value normalized to empty string');
      }

      return {
        type: 'create',
        rule: {
          id: input.id,
          name: input.name.trim(),
          classification: input.classification,
          selectorType: input.selectorType,
          selectorValue: normalizedValue,
          priority: input.priority ?? 0,
          enabled: input.enabled !== false,
          timesheetCode: input.timesheetCode ? input.timesheetCode.trim() : null
        }
      };
    }

    if (change.type === 'update') {
      const existing = this.getRule(change.id);
      if (!existing) {
        throw new Error(`Rule '${change.id}' not found`);
      }
      const input = change.rule;
      let name = existing.name;
      if (input.name !== undefined) {
        if (typeof input.name !== 'string' || input.name.trim().length === 0) {
          throw new Error('Rule name cannot be empty');
        }
        name = input.name.trim();
      }

      let classification = existing.classification;
      if (input.classification !== undefined) {
        if (input.classification !== 'work' && input.classification !== 'personal') {
          throw new Error(
            `Invalid classification '${input.classification}', must be 'work' or 'personal'`
          );
        }
        classification = input.classification;
      }

      let selectorType = existing.selector_type;
      if (input.selectorType !== undefined) {
        if (!SELECTOR_TYPES.includes(input.selectorType)) {
          throw new Error(`Invalid selector_type '${input.selectorType}'`);
        }
        selectorType = input.selectorType;
      }

      let selectorValue = existing.selector_value;
      if (input.selectorValue !== undefined) {
        if (typeof input.selectorValue !== 'string' || input.selectorValue.trim().length === 0) {
          throw new Error('Rule selector_value cannot be empty');
        }
        selectorValue = normalizeSelectorValue(selectorType, input.selectorValue);
        if (selectorValue.length === 0) {
          throw new Error('Rule selector_value normalized to empty string');
        }
      }

      return {
        type: 'update',
        id: change.id,
        rule: {
          name,
          classification,
          selectorType,
          selectorValue,
          priority: input.priority !== undefined ? input.priority : existing.priority,
          enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
          timesheetCode:
            input.timesheetCode !== undefined
              ? input.timesheetCode ? input.timesheetCode.trim() : null
              : existing.timesheet_code
        }
      };
    }

    if (change.type === 'delete') {
      const existing = this.getRule(change.id);
      if (!existing) {
        throw new Error(`Rule '${change.id}' not found`);
      }
      return {
        type: 'delete',
        id: change.id
      };
    }

    throw new Error(`Unknown change type ${(change as any).type}`);
  }

  previewRuleChange(change: RuleChangeInput): RulePreviewResult {
    const op = this.normalizeRuleOperation(change);
    const dbState = this.getRevisionState();
    const previewDigest = this.computePreviewDigest(dbState, op);
    const currentRules = this.getRules();

    let proposedRuleId: string | undefined;
    const proposedModelRules: ClassificationRule[] = [];

    if (op.type === 'create') {
      proposedRuleId = op.rule.id ?? `rule-${randomUUID()}`;
      const now = new Date().toISOString();
      const newRule: ClassificationRule = {
        id: proposedRuleId,
        classification: op.rule.classification,
        selectorType: op.rule.selectorType,
        selectorValue: op.rule.selectorValue,
        priority: op.rule.priority,
        enabled: op.rule.enabled,
        createdAt: now
      };
      proposedModelRules.push(newRule);
      for (const r of currentRules) {
        proposedModelRules.push({
          id: r.id,
          classification: r.classification,
          selectorType: r.selector_type,
          selectorValue: r.selector_value,
          priority: r.priority,
          enabled: r.enabled,
          createdAt: r.created_at
        });
      }
    } else if (op.type === 'update') {
      proposedRuleId = op.id;
      for (const r of currentRules) {
        if (r.id === op.id) {
          proposedModelRules.push({
            id: r.id,
            classification: op.rule.classification ?? r.classification,
            selectorType: op.rule.selectorType ?? r.selector_type,
            selectorValue: op.rule.selectorValue ?? r.selector_value,
            priority: op.rule.priority ?? r.priority,
            enabled: op.rule.enabled ?? r.enabled,
            createdAt: r.created_at
          });
        } else {
          proposedModelRules.push({
            id: r.id,
            classification: r.classification,
            selectorType: r.selector_type,
            selectorValue: r.selector_value,
            priority: r.priority,
            enabled: r.enabled,
            createdAt: r.created_at
          });
        }
      }
    } else if (op.type === 'delete') {
      proposedRuleId = op.id;
      for (const r of currentRules) {
        if (r.id !== op.id) {
          proposedModelRules.push({
            id: r.id,
            classification: r.classification,
            selectorType: r.selector_type,
            selectorValue: r.selector_value,
            priority: r.priority,
            enabled: r.enabled,
            createdAt: r.created_at
          });
        }
      }
    }

    const currentModelRules: ClassificationRule[] = currentRules.map((r) => ({
      id: r.id,
      classification: r.classification,
      selectorType: r.selector_type,
      selectorValue: r.selector_value,
      priority: r.priority,
      enabled: r.enabled,
      createdAt: r.created_at
    }));

    const rawSlices = this.loadSlicesWithContext();
    const affectedDatesSet = new Set<string>();
    let affectedSliceCount = 0;

    let workToPersonal = 0;
    let workToUnclassified = 0;
    let personalToWork = 0;
    let personalToUnclassified = 0;
    let unclassifiedToWork = 0;
    let unclassifiedToPersonal = 0;
    let totalShifted = 0;

    let netWork = 0;
    let netPersonal = 0;
    let netUnclassified = 0;

    for (const item of rawSlices) {
      if (item.isUnattributed) {
        // Evaluated unattributed slices remain unclassified unless a whole-slice allocation exists,
        // and cannot be affected by rule changes.
        continue;
      }
      const override = item.allocation ? { classification: item.allocation.classification } : null;
      const beforeDecision = classifySlice(item.classifiableSlice, currentModelRules, override);
      const afterDecision = classifySlice(item.classifiableSlice, proposedModelRules, override);

      if (beforeDecision.classification !== afterDecision.classification) {
        affectedSliceCount++;
        affectedDatesSet.add(item.date);
        const seconds = item.totalSeconds;
        totalShifted += seconds;

        const before = beforeDecision.classification;
        const after = afterDecision.classification;

        if (before === 'work') netWork -= seconds;
        else if (before === 'personal') netPersonal -= seconds;
        else netUnclassified -= seconds;

        if (after === 'work') netWork += seconds;
        else if (after === 'personal') netPersonal += seconds;
        else netUnclassified += seconds;

        if (before === 'work' && after === 'personal') workToPersonal += seconds;
        else if (before === 'work' && after === 'unclassified') workToUnclassified += seconds;
        else if (before === 'personal' && after === 'work') personalToWork += seconds;
        else if (before === 'personal' && after === 'unclassified')
          personalToUnclassified += seconds;
        else if (before === 'unclassified' && after === 'work') unclassifiedToWork += seconds;
        else if (before === 'unclassified' && after === 'personal')
          unclassifiedToPersonal += seconds;
      }
    }

    const affectedDates = Array.from(affectedDatesSet).sort();

    return {
      previewRevision: dbState.revision,
      previewDigest,
      affectedSliceCount,
      affectedDates,
      shiftedSeconds: {
        workToPersonal: roundSeconds(workToPersonal),
        workToUnclassified: roundSeconds(workToUnclassified),
        personalToWork: roundSeconds(personalToWork),
        personalToUnclassified: roundSeconds(personalToUnclassified),
        unclassifiedToWork: roundSeconds(unclassifiedToWork),
        unclassifiedToPersonal: roundSeconds(unclassifiedToPersonal),
        totalShifted: roundSeconds(totalShifted),
        net: {
          work: roundSeconds(netWork),
          personal: roundSeconds(netPersonal),
          unclassified: roundSeconds(netUnclassified)
        }
      },
      proposedRuleId
    };
  }

  /**
   * Dedicated test-only seed helper to bypass interactive dry-run preview cycles.
   * Public mutations must go through createRule/updateRule/deleteRule with exact preview digests.
   */
  unsafeSeedRule(
    input: CreateRuleInput,
    options?: { actor?: string }
  ): { rule: ClassificationRuleRecord; revision: ClassificationRevisionRecord } {
    const op = this.normalizeRuleOperation({ type: 'create', rule: input });
    if (op.type !== 'create') throw new Error('Expected create operation');

    const ruleId = op.rule.id ?? `rule-${randomUUID()}`;
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO classification_rules (
            id, name, classification, selector_type, selector_value,
            priority, enabled, timesheet_code, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          ruleId,
          op.rule.name,
          op.rule.classification,
          op.rule.selectorType,
          op.rule.selectorValue,
          op.rule.priority,
          op.rule.enabled ? 1 : 0,
          op.rule.timesheetCode,
          now,
          now
        );

      const createdRule: ClassificationRuleRecord = {
        id: ruleId,
        name: op.rule.name,
        classification: op.rule.classification,
        selector_type: op.rule.selectorType,
        selector_value: op.rule.selectorValue,
        priority: op.rule.priority,
        enabled: op.rule.enabled,
        timesheet_code: op.rule.timesheetCode,
        created_at: now,
        updated_at: now
      };

      const revStmt = this.db.prepare(
        `INSERT INTO classification_revisions (
          mutation_type, target_type, target_id,
          before_json, after_json, affected_json,
          actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const revRes = revStmt.run(
        'rule_created',
        'rule',
        ruleId,
        null,
        JSON.stringify(createdRule),
        null,
        options?.actor ?? 'seed',
        now
      );

      const revision: ClassificationRevisionRecord = {
        id: Number(revRes.lastInsertRowid),
        mutation_type: 'rule_created',
        target_type: 'rule',
        target_id: ruleId,
        before_json: null,
        after_json: JSON.stringify(createdRule),
        affected_json: null,
        actor: options?.actor ?? 'seed',
        created_at: now
      };

      return { rule: createdRule, revision };
    })();
  }

  createRule(
    input: CreateRuleInput,
    options: RuleMutationOptions
  ): { rule: ClassificationRuleRecord; revision: ClassificationRevisionRecord } {
    if (!options?.expectedDigest) {
      throw new MissingPreviewError();
    }

    const op = this.normalizeRuleOperation({ type: 'create', rule: input });
    if (op.type !== 'create') throw new Error('Expected create operation');

    const ruleId = op.rule.id ?? `rule-${randomUUID()}`;
    const preview = this.previewRuleChange({ type: 'create', rule: { ...input, id: op.rule.id } });

    return this.db.transaction(() => {
      const dbState = this.getRevisionState();
      const expectedDigest = this.computePreviewDigest(dbState, op);

      if (options.expectedDigest !== expectedDigest) {
        throw new StalePreviewError(
          `Stale preview or mismatched payload: expected '${options.expectedDigest}', current is '${expectedDigest}'`
        );
      }

      if (options.expectedRevision !== undefined) {
        const expectedRevNum =
          typeof options.expectedRevision === 'number'
            ? options.expectedRevision
            : Number.parseInt(options.expectedRevision, 10);
        if (Number.isSafeInteger(expectedRevNum) && expectedRevNum !== dbState.revision) {
          throw new StalePreviewError(
            `Stale preview: expected revision ${options.expectedRevision}, current is ${dbState.revision}`
          );
        }
      }

      const now = new Date().toISOString();

      this.db
        .prepare(
          `INSERT INTO classification_rules (
            id, name, classification, selector_type, selector_value,
            priority, enabled, timesheet_code, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          ruleId,
          op.rule.name,
          op.rule.classification,
          op.rule.selectorType,
          op.rule.selectorValue,
          op.rule.priority,
          op.rule.enabled ? 1 : 0,
          op.rule.timesheetCode,
          now,
          now
        );

      const createdRule: ClassificationRuleRecord = {
        id: ruleId,
        name: op.rule.name,
        classification: op.rule.classification,
        selector_type: op.rule.selectorType,
        selector_value: op.rule.selectorValue,
        priority: op.rule.priority,
        enabled: op.rule.enabled,
        timesheet_code: op.rule.timesheetCode,
        created_at: now,
        updated_at: now
      };

      const affectedJson = JSON.stringify({
        affectedSliceCount: preview.affectedSliceCount,
        affectedDates: preview.affectedDates,
        shiftedSeconds: preview.shiftedSeconds
      });

      const revStmt = this.db.prepare(
        `INSERT INTO classification_revisions (
          mutation_type, target_type, target_id,
          before_json, after_json, affected_json,
          actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const revRes = revStmt.run(
        'rule_created',
        'rule',
        ruleId,
        null,
        JSON.stringify(createdRule),
        affectedJson,
        options.actor ?? 'system',
        now
      );

      const revision: ClassificationRevisionRecord = {
        id: Number(revRes.lastInsertRowid),
        mutation_type: 'rule_created',
        target_type: 'rule',
        target_id: ruleId,
        before_json: null,
        after_json: JSON.stringify(createdRule),
        affected_json: affectedJson,
        actor: options.actor ?? 'system',
        created_at: now
      };

      return { rule: createdRule, revision };
    })();
  }

  updateRule(
    id: string,
    input: UpdateRuleInput,
    options: RuleMutationOptions
  ): { rule: ClassificationRuleRecord; revision: ClassificationRevisionRecord } {
    if (!options?.expectedDigest) {
      throw new MissingPreviewError();
    }

    const op = this.normalizeRuleOperation({ type: 'update', id, rule: input });
    if (op.type !== 'update') throw new Error('Expected update operation');

    const preview = this.previewRuleChange({ type: 'update', id, rule: input });

    return this.db.transaction(() => {
      const dbState = this.getRevisionState();
      const expectedDigest = this.computePreviewDigest(dbState, op);

      if (options.expectedDigest !== expectedDigest) {
        throw new StalePreviewError(
          `Stale preview or mismatched payload: expected '${options.expectedDigest}', current is '${expectedDigest}'`
        );
      }

      if (options.expectedRevision !== undefined) {
        const expectedRevNum =
          typeof options.expectedRevision === 'number'
            ? options.expectedRevision
            : Number.parseInt(options.expectedRevision, 10);
        if (Number.isSafeInteger(expectedRevNum) && expectedRevNum !== dbState.revision) {
          throw new StalePreviewError(
            `Stale preview: expected revision ${options.expectedRevision}, current is ${dbState.revision}`
          );
        }
      }

      const existing = this.getRule(id);
      if (!existing) {
        throw new Error(`Rule '${id}' not found`);
      }

      const now = new Date().toISOString();
      const updated: ClassificationRuleRecord = {
        id: existing.id,
        name: op.rule.name ?? existing.name,
        classification: op.rule.classification ?? existing.classification,
        selector_type: op.rule.selectorType ?? existing.selector_type,
        selector_value: op.rule.selectorValue ?? existing.selector_value,
        priority: op.rule.priority !== undefined ? op.rule.priority : existing.priority,
        enabled: op.rule.enabled !== undefined ? op.rule.enabled : existing.enabled,
        timesheet_code:
          op.rule.timesheetCode !== undefined ? op.rule.timesheetCode : existing.timesheet_code,
        created_at: existing.created_at,
        updated_at: now
      };

      this.db
        .prepare(
          `UPDATE classification_rules
           SET name = ?, classification = ?, selector_type = ?, selector_value = ?,
               priority = ?, enabled = ?, timesheet_code = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          updated.name,
          updated.classification,
          updated.selector_type,
          updated.selector_value,
          updated.priority,
          updated.enabled ? 1 : 0,
          updated.timesheet_code,
          now,
          id
        );

      const affectedJson = JSON.stringify({
        affectedSliceCount: preview.affectedSliceCount,
        affectedDates: preview.affectedDates,
        shiftedSeconds: preview.shiftedSeconds
      });

      const revStmt = this.db.prepare(
        `INSERT INTO classification_revisions (
          mutation_type, target_type, target_id,
          before_json, after_json, affected_json,
          actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const revRes = revStmt.run(
        'rule_updated',
        'rule',
        id,
        JSON.stringify(existing),
        JSON.stringify(updated),
        affectedJson,
        options.actor ?? 'system',
        now
      );

      const revision: ClassificationRevisionRecord = {
        id: Number(revRes.lastInsertRowid),
        mutation_type: 'rule_updated',
        target_type: 'rule',
        target_id: id,
        before_json: JSON.stringify(existing),
        after_json: JSON.stringify(updated),
        affected_json: affectedJson,
        actor: options.actor ?? 'system',
        created_at: now
      };

      return { rule: updated, revision };
    })();
  }

  deleteRule(
    id: string,
    options: RuleMutationOptions
  ): { revision: ClassificationRevisionRecord } {
    if (!options?.expectedDigest) {
      throw new MissingPreviewError();
    }

    const op = this.normalizeRuleOperation({ type: 'delete', id });
    if (op.type !== 'delete') throw new Error('Expected delete operation');

    const preview = this.previewRuleChange({ type: 'delete', id });

    return this.db.transaction(() => {
      const dbState = this.getRevisionState();
      const expectedDigest = this.computePreviewDigest(dbState, op);

      if (options.expectedDigest !== expectedDigest) {
        throw new StalePreviewError(
          `Stale preview or mismatched payload: expected '${options.expectedDigest}', current is '${expectedDigest}'`
        );
      }

      if (options.expectedRevision !== undefined) {
        const expectedRevNum =
          typeof options.expectedRevision === 'number'
            ? options.expectedRevision
            : Number.parseInt(options.expectedRevision, 10);
        if (Number.isSafeInteger(expectedRevNum) && expectedRevNum !== dbState.revision) {
          throw new StalePreviewError(
            `Stale preview: expected revision ${options.expectedRevision}, current is ${dbState.revision}`
          );
        }
      }

      const existing = this.getRule(id);
      if (!existing) {
        throw new Error(`Rule '${id}' not found`);
      }

      const now = new Date().toISOString();
      this.db.prepare('DELETE FROM classification_rules WHERE id = ?').run(id);

      const affectedJson = JSON.stringify({
        affectedSliceCount: preview.affectedSliceCount,
        affectedDates: preview.affectedDates,
        shiftedSeconds: preview.shiftedSeconds
      });

      const revStmt = this.db.prepare(
        `INSERT INTO classification_revisions (
          mutation_type, target_type, target_id,
          before_json, after_json, affected_json,
          actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const revRes = revStmt.run(
        'rule_deleted',
        'rule',
        id,
        JSON.stringify(existing),
        null,
        affectedJson,
        options.actor ?? 'system',
        now
      );

      const revision: ClassificationRevisionRecord = {
        id: Number(revRes.lastInsertRowid),
        mutation_type: 'rule_deleted',
        target_type: 'rule',
        target_id: id,
        before_json: JSON.stringify(existing),
        after_json: null,
        affected_json: affectedJson,
        actor: options.actor ?? 'system',
        created_at: now
      };

      return { revision };
    })();
  }

  createAllocation(
    input: CreateAllocationInput,
    options?: AllocationMutationOptions
  ): { allocation: DailyTimeAllocationRecord; revision: ClassificationRevisionRecord } {
    if (input.classification !== 'work' && input.classification !== 'personal') {
      throw new Error(
        `Invalid allocation classification '${input.classification}', must be 'work' or 'personal'`
      );
    }

    return this.db.transaction(() => {
      const slice = this.db
        .prepare(
          `SELECT total_seconds FROM day_project_entity_slices
           WHERE date = ? AND project_id = ? AND entity = ?`
        )
        .get(input.date, input.projectId, input.entity) as { total_seconds: number } | undefined;

      if (!slice) {
        throw new Error(
          `Cannot allocate: slice does not exist for date='${input.date}', projectId=${input.projectId}, entity='${input.entity}'`
        );
      }

      const inputRecord = input as unknown as Record<string, unknown>;
      if ('allocatedSeconds' in inputRecord) {
        const callerSecs = inputRecord.allocatedSeconds;
        if (typeof callerSecs === 'number' && Math.abs(callerSecs - slice.total_seconds) > 0.001) {
          throw new Error(
            `Caller-supplied duration (${callerSecs}) does not match slice total_seconds (${slice.total_seconds})`
          );
        }
      }

      const allocatedSeconds = slice.total_seconds;
      const existing = this.getAllocationBySlice(input.date, input.projectId, input.entity);

      if (existing) {
        if (!options?.replaceExisting) {
          throw new AllocationConflictError(
            existing.classification,
            input.classification,
            `Allocation conflict: slice (${input.date}, project ${input.projectId}, entity '${input.entity}') already allocated as '${existing.classification}', proposed '${input.classification}'`
          );
        }

        const now = new Date().toISOString();

        // Migration 002 is authoritative and only allows allocation_created/allocation_deleted.
        // An explicitly confirmed replacement deterministically deletes the existing allocation,
        // appends allocation_deleted, creates the replacement, and appends allocation_created in one transaction.
        this.db.prepare('DELETE FROM daily_time_allocations WHERE id = ?').run(existing.id);

        const deleteAffectedJson = JSON.stringify({
          date: existing.date,
          projectId: existing.project_id,
          entity: existing.entity,
          allocatedSeconds: existing.allocated_seconds,
          removedClassification: existing.classification,
          reason: 'replaced'
        });

        this.db
          .prepare(
            `INSERT INTO classification_revisions (
              mutation_type, target_type, target_id,
              before_json, after_json, affected_json,
              actor, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            'allocation_deleted',
            'allocation',
            existing.id,
            JSON.stringify(existing),
            null,
            deleteAffectedJson,
            options?.actor ?? 'system',
            now
          );

        const newId = input.id ?? `alloc-${randomUUID()}`;
        this.db
          .prepare(
            `INSERT INTO daily_time_allocations (
              id, date, project_id, entity, classification, allocated_seconds,
              timesheet_code, note, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            newId,
            input.date,
            input.projectId,
            input.entity,
            input.classification,
            allocatedSeconds,
            input.timesheetCode ?? null,
            input.note ?? null,
            now,
            now
          );

        const createdRecord: DailyTimeAllocationRecord = {
          id: newId,
          date: input.date,
          project_id: input.projectId,
          entity: input.entity,
          classification: input.classification,
          allocated_seconds: allocatedSeconds,
          timesheet_code: input.timesheetCode ?? null,
          note: input.note ?? null,
          created_at: now,
          updated_at: now
        };

        const createAffectedJson = JSON.stringify({
          date: input.date,
          projectId: input.projectId,
          entity: input.entity,
          allocatedSeconds,
          previousClassification: existing.classification,
          newClassification: input.classification
        });

        const createRevRes = this.db
          .prepare(
            `INSERT INTO classification_revisions (
              mutation_type, target_type, target_id,
              before_json, after_json, affected_json,
              actor, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            'allocation_created',
            'allocation',
            newId,
            null,
            JSON.stringify(createdRecord),
            createAffectedJson,
            options?.actor ?? 'system',
            now
          );

        const revision: ClassificationRevisionRecord = {
          id: Number(createRevRes.lastInsertRowid),
          mutation_type: 'allocation_created',
          target_type: 'allocation',
          target_id: newId,
          before_json: null,
          after_json: JSON.stringify(createdRecord),
          affected_json: createAffectedJson,
          actor: options?.actor ?? 'system',
          created_at: now
        };

        return { allocation: createdRecord, revision };
      }

      // Brand new allocation insert
      const now = new Date().toISOString();
      const allocationId = input.id ?? `alloc-${randomUUID()}`;

      this.db
        .prepare(
          `INSERT INTO daily_time_allocations (
            id, date, project_id, entity, classification, allocated_seconds,
            timesheet_code, note, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          allocationId,
          input.date,
          input.projectId,
          input.entity,
          input.classification,
          allocatedSeconds,
          input.timesheetCode ?? null,
          input.note ?? null,
          now,
          now
        );

      const record: DailyTimeAllocationRecord = {
        id: allocationId,
        date: input.date,
        project_id: input.projectId,
        entity: input.entity,
        classification: input.classification,
        allocated_seconds: allocatedSeconds,
        timesheet_code: input.timesheetCode ?? null,
        note: input.note ?? null,
        created_at: now,
        updated_at: now
      };

      const affectedJson = JSON.stringify({
        date: input.date,
        projectId: input.projectId,
        entity: input.entity,
        allocatedSeconds,
        previousClassification: null,
        newClassification: input.classification
      });

      const revStmt = this.db.prepare(
        `INSERT INTO classification_revisions (
          mutation_type, target_type, target_id,
          before_json, after_json, affected_json,
          actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const revRes = revStmt.run(
        'allocation_created',
        'allocation',
        allocationId,
        null,
        JSON.stringify(record),
        affectedJson,
        options?.actor ?? 'system',
        now
      );

      const revision: ClassificationRevisionRecord = {
        id: Number(revRes.lastInsertRowid),
        mutation_type: 'allocation_created',
        target_type: 'allocation',
        target_id: allocationId,
        before_json: null,
        after_json: JSON.stringify(record),
        affected_json: affectedJson,
        actor: options?.actor ?? 'system',
        created_at: now
      };

      return { allocation: record, revision };
    })();
  }

  replaceAllocation(
    input: CreateAllocationInput,
    options?: AllocationMutationOptions
  ): { allocation: DailyTimeAllocationRecord; revision: ClassificationRevisionRecord } {
    return this.createAllocation(input, { ...options, replaceExisting: true });
  }

  deleteAllocation(
    id: string,
    options?: AllocationMutationOptions
  ): { revision: ClassificationRevisionRecord } {
    return this.db.transaction(() => {
      const existing = this.getAllocation(id);
      if (!existing) {
        throw new Error(`Allocation '${id}' not found`);
      }

      const now = new Date().toISOString();
      this.db.prepare('DELETE FROM daily_time_allocations WHERE id = ?').run(id);

      const affectedJson = JSON.stringify({
        date: existing.date,
        projectId: existing.project_id,
        entity: existing.entity,
        allocatedSeconds: existing.allocated_seconds,
        removedClassification: existing.classification
      });

      const revStmt = this.db.prepare(
        `INSERT INTO classification_revisions (
          mutation_type, target_type, target_id,
          before_json, after_json, affected_json,
          actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const revRes = revStmt.run(
        'allocation_deleted',
        'allocation',
        id,
        JSON.stringify(existing),
        null,
        affectedJson,
        options?.actor ?? 'system',
        now
      );

      const revision: ClassificationRevisionRecord = {
        id: Number(revRes.lastInsertRowid),
        mutation_type: 'allocation_deleted',
        target_type: 'allocation',
        target_id: id,
        before_json: JSON.stringify(existing),
        after_json: null,
        affected_json: affectedJson,
        actor: options?.actor ?? 'system',
        created_at: now
      };

      return { revision };
    })();
  }

  private loadSlicesWithContext(filter?: {
    date?: string;
    startDate?: string;
    endDate?: string;
  }): Array<{
    id: number;
    date: string;
    projectId: number;
    projectName: string | null;
    entity: string;
    entityType: 'file' | 'app' | 'domain' | 'unattributed';
    totalSeconds: number;
    isUnattributed: boolean;
    allocation: DailyTimeAllocationRecord | null;
    classifiableSlice: ClassifiableSlice;
  }> {
    let sliceSql = `
      SELECT
        s.id,
        s.date,
        s.project_id,
        s.entity,
        s.entity_type,
        s.total_seconds,
        s.is_unattributed,
        p.name AS project_name,
        p.is_unattributed AS project_is_unattributed
      FROM day_project_entity_slices s
      JOIN projects p ON p.id = s.project_id
      WHERE 1=1
    `;
    const sliceParams: unknown[] = [];

    if (filter?.date) {
      sliceSql += ` AND s.date = ?`;
      sliceParams.push(filter.date);
    }
    if (filter?.startDate) {
      sliceSql += ` AND s.date >= ?`;
      sliceParams.push(filter.startDate);
    }
    if (filter?.endDate) {
      sliceSql += ` AND s.date <= ?`;
      sliceParams.push(filter.endDate);
    }
    sliceSql += ` ORDER BY s.date ASC, s.id ASC`;

    const sliceRows = this.db.prepare(sliceSql).all(...sliceParams) as Array<{
      id: number;
      date: string;
      project_id: number;
      entity: string;
      entity_type: string;
      total_seconds: number;
      is_unattributed: number;
      project_name: string;
      project_is_unattributed: number;
    }>;

    if (sliceRows.length === 0) return [];

    let identSql = `
      SELECT i.slice_id, i.selector_type, i.value
      FROM slice_identities i
      JOIN day_project_entity_slices s ON s.id = i.slice_id
      WHERE i.selector_type IN ('machine', 'editor')
    `;
    const identParams: unknown[] = [];
    if (filter?.date) {
      identSql += ` AND s.date = ?`;
      identParams.push(filter.date);
    }
    if (filter?.startDate) {
      identSql += ` AND s.date >= ?`;
      identParams.push(filter.startDate);
    }
    if (filter?.endDate) {
      identSql += ` AND s.date <= ?`;
      identParams.push(filter.endDate);
    }

    const identRows = this.db.prepare(identSql).all(...identParams) as Array<{
      slice_id: number;
      selector_type: 'machine' | 'editor';
      value: string;
    }>;

    const identitiesBySlice = new Map<number, { machineIds: string[]; editors: string[] }>();
    for (const r of identRows) {
      let entry = identitiesBySlice.get(r.slice_id);
      if (!entry) {
        entry = { machineIds: [], editors: [] };
        identitiesBySlice.set(r.slice_id, entry);
      }
      if (r.selector_type === 'machine') {
        if (r.value && !entry.machineIds.includes(r.value)) {
          entry.machineIds.push(r.value);
        }
      } else if (r.selector_type === 'editor') {
        if (r.value && !entry.editors.includes(r.value)) {
          entry.editors.push(r.value);
        }
      }
    }

    let allocSql = `
      SELECT id, date, project_id, entity, classification,
             allocated_seconds, timesheet_code, note, created_at, updated_at
      FROM daily_time_allocations
      WHERE 1=1
    `;
    const allocParams: unknown[] = [];
    if (filter?.date) {
      allocSql += ` AND date = ?`;
      allocParams.push(filter.date);
    }
    if (filter?.startDate) {
      allocSql += ` AND date >= ?`;
      allocParams.push(filter.startDate);
    }
    if (filter?.endDate) {
      allocSql += ` AND date <= ?`;
      allocParams.push(filter.endDate);
    }

    const allocRows = this.db.prepare(allocSql).all(...allocParams) as DailyTimeAllocationRecord[];
    const allocationsMap = new Map<string, DailyTimeAllocationRecord>();
    for (const a of allocRows) {
      allocationsMap.set(`${a.date}:${a.project_id}:${a.entity}`, a);
    }

    return sliceRows.map((s) => {
      const idents = identitiesBySlice.get(s.id);
      const machineIds = idents?.machineIds ?? [];
      const editors = idents?.editors ?? [];

      const isUnattributed = Boolean(s.is_unattributed || s.project_is_unattributed);
      const entityType: 'file' | 'app' | 'domain' | 'unattributed' =
        s.entity_type === 'app'
          ? 'app'
          : s.entity_type === 'domain'
            ? 'domain'
            : s.entity_type === 'unattributed' || isUnattributed
              ? 'unattributed'
              : 'file';

      const classifiableSlice: ClassifiableSlice = {
        id: String(s.id),
        project: isUnattributed ? null : s.project_name,
        entityType,
        entity: s.entity,
        machineIds,
        editors
      };

      const allocation = allocationsMap.get(`${s.date}:${s.project_id}:${s.entity}`) ?? null;

      return {
        id: s.id,
        date: s.date,
        projectId: s.project_id,
        projectName: isUnattributed ? null : s.project_name,
        entity: s.entity,
        entityType,
        totalSeconds: s.total_seconds,
        isUnattributed,
        allocation,
        classifiableSlice
      };
    });
  }

  classifySlices(filter?: {
    date?: string;
    startDate?: string;
    endDate?: string;
  }): EvaluatedSlice[] {
    const rules = this.getRules();
    const modelRules: ClassificationRule[] = rules.map((r) => ({
      id: r.id,
      classification: r.classification,
      selectorType: r.selector_type,
      selectorValue: r.selector_value,
      priority: r.priority,
      enabled: r.enabled,
      createdAt: r.created_at
    }));

    const rawSlices = this.loadSlicesWithContext(filter);

    return rawSlices.map((item) => {
      let decision: ClassificationDecision;

      if (item.isUnattributed) {
        if (item.allocation) {
          decision = {
            classification: item.allocation.classification,
            source: 'override',
            winningRuleId: null,
            competingRuleIds: []
          };
        } else {
          decision = {
            classification: 'unclassified',
            source: 'default',
            winningRuleId: null,
            competingRuleIds: []
          };
        }
      } else {
        const override = item.allocation ? { classification: item.allocation.classification } : null;
        decision = classifySlice(item.classifiableSlice, modelRules, override);
      }

      return {
        id: item.id,
        date: item.date,
        projectId: item.projectId,
        projectName: item.projectName,
        entity: item.entity,
        entityType: item.entityType,
        totalSeconds: item.totalSeconds,
        isUnattributed: item.isUnattributed,
        machineIds: item.classifiableSlice.machineIds as string[],
        editors: item.classifiableSlice.editors as string[],
        allocation: item.allocation,
        decision
      };
    });
  }

  getCoverage(filter?: {
    date?: string;
    startDate?: string;
    endDate?: string;
  }): ClassificationCoverage {
    const slices = this.classifySlices(filter);

    let totalSeconds = 0;
    let workSeconds = 0;
    let personalSeconds = 0;
    let unclassifiedSeconds = 0;
    let workSlices = 0;
    let personalSlices = 0;
    let unclassifiedSlices = 0;
    const dates = new Set<string>();

    for (const s of slices) {
      totalSeconds += s.totalSeconds;
      dates.add(s.date);
      switch (s.decision.classification) {
        case 'work':
          workSeconds += s.totalSeconds;
          workSlices++;
          break;
        case 'personal':
          personalSeconds += s.totalSeconds;
          personalSlices++;
          break;
        case 'unclassified':
          unclassifiedSeconds += s.totalSeconds;
          unclassifiedSlices++;
          break;
      }
    }

    totalSeconds = roundSeconds(totalSeconds);
    workSeconds = roundSeconds(workSeconds);
    personalSeconds = roundSeconds(personalSeconds);
    unclassifiedSeconds = roundSeconds(unclassifiedSeconds);
    const classifiedSeconds = roundSeconds(workSeconds + personalSeconds);
    const coverageRatio = totalSeconds > 0 ? classifiedSeconds / totalSeconds : 1.0;
    const coveragePercentage = roundSeconds(coverageRatio * 100);

    return {
      totalSeconds,
      classifiedSeconds,
      workSeconds,
      personalSeconds,
      unclassifiedSeconds,
      coverageRatio,
      coveragePercentage,
      totalSlices: slices.length,
      workSlices,
      personalSlices,
      unclassifiedSlices,
      daysCovered: dates.size
    };
  }

  getUnclassifiedSuggestions(filter?: {
    date?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    limitPerType?: number;
    selectorType?: SelectorType;
  }): UnclassifiedSuggestion[] {
    const slices = this.classifySlices(filter).filter(
      (s) => s.decision.classification === 'unclassified'
    );

    if (slices.length === 0) return [];

    interface CandidateGroup {
      selectorType: SelectorType;
      selectorValue: string;
      unclassifiedSeconds: number;
      slices: EvaluatedSlice[];
    }

    const candidateMap = new Map<string, CandidateGroup>();

    const recordCandidate = (
      type: SelectorType,
      value: string,
      slice: EvaluatedSlice
    ) => {
      const normalizedValue = value.trim();
      if (!normalizedValue || normalizedValue === '__unattributed__') return;

      const key = `${type}:${normalizedValue}`;
      let entry = candidateMap.get(key);
      if (!entry) {
        entry = {
          selectorType: type,
          selectorValue: normalizedValue,
          unclassifiedSeconds: 0,
          slices: []
        };
        candidateMap.set(key, entry);
      }
      entry.unclassifiedSeconds += slice.totalSeconds;
      entry.slices.push(slice);
    };

    for (const s of slices) {
      if (s.isUnattributed) {
        // Do not suggest rules for unattributed slices
        continue;
      }

      const sliceMachines = new Set(s.machineIds);
      for (const m of sliceMachines) {
        recordCandidate('machine', m, s);
      }

      const sliceEditors = new Set(s.editors);
      for (const e of sliceEditors) {
        recordCandidate('editor', e, s);
      }

      if (s.entityType === 'app') {
        recordCandidate('application', s.entity, s);
      } else if (s.entityType === 'domain') {
        recordCandidate('domain', s.entity, s);
      }

      if (s.projectName && !s.isUnattributed) {
        recordCandidate('project', s.projectName, s);
      }

      if (s.entityType === 'file' && s.entity.includes('/')) {
        const parts = s.entity.split('/').filter(Boolean);
        if (parts.length > 1) {
          const prefix1 = s.entity.startsWith('/')
            ? `/${parts.slice(0, 2).join('/')}`
            : parts.slice(0, 2).join('/');
          recordCandidate('folder_prefix', prefix1, s);

          if (parts.length > 2) {
            const prefix2 = s.entity.startsWith('/')
              ? `/${parts.slice(0, parts.length - 1).join('/')}`
              : parts.slice(0, parts.length - 1).join('/');
            if (prefix2 !== prefix1) {
              recordCandidate('folder_prefix', prefix2, s);
            }
          }
        }
      }

      recordCandidate('entity', s.entity, s);
    }

    const allCandidates = Array.from(candidateMap.values());

    const filteredCandidates = filter?.selectorType
      ? allCandidates.filter((cg) => cg.selectorType === filter.selectorType)
      : allCandidates;

    // Group candidates by selectorType to ensure ALL types (application, domain, project, folder, etc.) are represented
    const candidatesByType = new Map<SelectorType, CandidateGroup[]>();
    for (const cg of filteredCandidates) {
      let list = candidatesByType.get(cg.selectorType);
      if (!list) {
        list = [];
        candidatesByType.set(cg.selectorType, list);
      }
      list.push(cg);
    }

    const limitPerType = filter?.limitPerType ?? (filter?.limit ? Math.max(filter.limit, 50) : 50);

    const selectedCandidates: CandidateGroup[] = [];
    for (const [, list] of candidatesByType.entries()) {
      list.sort((a, b) => b.unclassifiedSeconds - a.unclassifiedSeconds);
      selectedCandidates.push(...list.slice(0, limitPerType));
    }

    const suggestions: UnclassifiedSuggestion[] = selectedCandidates.map((cg) => {
      const sampleEntities = Array.from(new Set(cg.slices.map((s) => s.entity))).slice(0, 3);
      const sampleProjects = Array.from(
        new Set(cg.slices.map((s) => s.projectName).filter((p): p is string => Boolean(p)))
      ).slice(0, 3);

      const dates = cg.slices
        .map((s) => s.date)
        .filter((d): d is string => Boolean(d))
        .sort();
      const earliestDate = dates.length > 0 ? dates[0] : null;
      const latestDate = dates.length > 0 ? dates[dates.length - 1] : null;

      return {
        selectorType: cg.selectorType,
        selectorValue: cg.selectorValue,
        displayValue:
          cg.selectorType === 'machine'
            ? this.resolveMachineName(cg.selectorValue)
            : cg.selectorType === 'editor'
              ? this.resolveEditorName(cg.selectorValue)
              : cg.selectorValue,
        specificity: SELECTOR_SPECIFICITY[cg.selectorType],
        unclassifiedSeconds: roundSeconds(cg.unclassifiedSeconds),
        sliceCount: cg.slices.length,
        sampleEntities,
        sampleProjects,
        earliestDate,
        latestDate
      };
    });

    suggestions.sort((a, b) => {
      if (a.specificity !== b.specificity) {
        return a.specificity - b.specificity;
      }
      return b.unclassifiedSeconds - a.unclassifiedSeconds;
    });

    if (filter?.limit && !filter?.limitPerType && !filter?.selectorType) {
      return suggestions.slice(0, filter.limit);
    }

    return suggestions;
  }
}
