import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { verifyCsrfToken } from '$lib/server/security/http';
import {
  SELECTOR_TYPES,
  type RuleClassification,
  type SelectorType
} from '$lib/server/classification/model';
import {
  type EvaluatedSlice,
  type RuleChangeInput,
  AllocationConflictError,
  MissingPreviewError,
  StalePreviewError
} from '$lib/server/classification/sqlite';

const STRICT_INTEGER_REGEX = /^(0|-?[1-9]\d*)$/;
const STRICT_NON_NEGATIVE_INTEGER_REGEX = /^(0|[1-9]\d*)$/;

function parseStrictInteger(value: unknown, name: string, options?: { nonNegative?: boolean }): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Invalid ${name}: must be a safe integer`);
    }
    if (options?.nonNegative && value < 0) {
      throw new Error(`Invalid ${name}: must be non-negative`);
    }
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const regex = options?.nonNegative ? STRICT_NON_NEGATIVE_INTEGER_REGEX : STRICT_INTEGER_REGEX;
    if (!regex.test(trimmed)) {
      throw new Error(`Invalid ${name}: '${value}' is not a valid integer`);
    }
    const num = Number(trimmed);
    if (!Number.isSafeInteger(num)) {
      throw new Error(`Invalid ${name}: '${value}' exceeds safe integer range`);
    }
    if (options?.nonNegative && num < 0) {
      throw new Error(`Invalid ${name}: must be non-negative`);
    }
    return num;
  }

  throw new Error(`Invalid ${name}: expected integer value`);
}

function validateProposalObject(obj: Record<string, unknown>): RuleChangeInput {
  const type = obj.type;
  if (type !== 'create' && type !== 'update' && type !== 'delete') {
    throw new Error(`Invalid proposal type: '${String(type)}'. Must be 'create', 'update', or 'delete'`);
  }

  if (type === 'create') {
    if (!obj.rule || typeof obj.rule !== 'object' || Array.isArray(obj.rule)) {
      throw new Error("Create proposal requires a 'rule' object");
    }
    const r = obj.rule as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) {
      throw new Error('Rule name cannot be empty');
    }
    const classification = String(r.classification ?? '').trim();
    if (classification !== 'work' && classification !== 'personal') {
      throw new Error(`Invalid classification '${classification}'. Only work or personal is supported.`);
    }
    const selectorType = String(r.selectorType ?? '').trim() as SelectorType;
    if (!SELECTOR_TYPES.includes(selectorType)) {
      throw new Error(`Invalid selector type '${selectorType}'`);
    }
    const selectorValue = typeof r.selectorValue === 'string' ? r.selectorValue.trim() : '';
    if (!selectorValue) {
      throw new Error('Selector value cannot be empty');
    }

    let priority = 0;
    if (r.priority !== undefined && r.priority !== null && r.priority !== '') {
      priority = parseStrictInteger(r.priority, 'priority');
    }

    let enabled = true;
    if (r.enabled !== undefined && r.enabled !== null) {
      if (typeof r.enabled === 'boolean') {
        enabled = r.enabled;
      } else if (typeof r.enabled === 'string') {
        enabled = r.enabled !== 'false' && r.enabled !== '0';
      } else {
        throw new Error('Invalid enabled flag: must be boolean');
      }
    }

    const timesheetCode =
      typeof r.timesheetCode === 'string' && r.timesheetCode.trim().length > 0
        ? r.timesheetCode.trim()
        : null;

    return {
      type: 'create',
      rule: {
        name,
        classification,
        selectorType,
        selectorValue,
        priority,
        enabled,
        timesheetCode
      }
    };
  }

  if (type === 'update') {
    const id = typeof obj.id === 'string' ? obj.id.trim() : '';
    if (!id) {
      throw new Error('Missing rule ID for update');
    }
    if (!obj.rule || typeof obj.rule !== 'object' || Array.isArray(obj.rule)) {
      throw new Error("Update proposal requires a 'rule' object");
    }
    const r = obj.rule as Record<string, unknown>;

    let name: string | undefined = undefined;
    if (r.name !== undefined && r.name !== null) {
      if (typeof r.name !== 'string' || r.name.trim().length === 0) {
        throw new Error('Rule name cannot be empty');
      }
      name = r.name.trim();
    }

    let classification: RuleClassification | undefined = undefined;
    if (r.classification !== undefined && r.classification !== null) {
      const cls = String(r.classification).trim();
      if (cls !== 'work' && cls !== 'personal') {
        throw new Error(`Invalid classification '${cls}'. Only work or personal is supported.`);
      }
      classification = cls;
    }

    let selectorType: SelectorType | undefined = undefined;
    if (r.selectorType !== undefined && r.selectorType !== null) {
      const st = String(r.selectorType).trim() as SelectorType;
      if (!SELECTOR_TYPES.includes(st)) {
        throw new Error(`Invalid selector type '${st}'`);
      }
      selectorType = st;
    }

    let selectorValue: string | undefined = undefined;
    if (r.selectorValue !== undefined && r.selectorValue !== null) {
      if (typeof r.selectorValue !== 'string' || r.selectorValue.trim().length === 0) {
        throw new Error('Selector value cannot be empty');
      }
      selectorValue = r.selectorValue.trim();
    }

    let priority: number | undefined = undefined;
    if (r.priority !== undefined && r.priority !== null && r.priority !== '') {
      priority = parseStrictInteger(r.priority, 'priority');
    }

    let enabled: boolean | undefined = undefined;
    if (r.enabled !== undefined && r.enabled !== null) {
      if (typeof r.enabled === 'boolean') {
        enabled = r.enabled;
      } else if (typeof r.enabled === 'string') {
        enabled = r.enabled !== 'false' && r.enabled !== '0';
      } else {
        throw new Error('Invalid enabled flag: must be boolean');
      }
    }

    let timesheetCode: string | null | undefined = undefined;
    if (r.timesheetCode !== undefined) {
      if (r.timesheetCode === null) {
        timesheetCode = null;
      } else if (typeof r.timesheetCode === 'string') {
        timesheetCode = r.timesheetCode.trim() || null;
      }
    }

    return {
      type: 'update',
      id,
      rule: {
        name,
        classification,
        selectorType,
        selectorValue,
        priority,
        enabled,
        timesheetCode
      }
    };
  }

  if (type === 'delete') {
    const id = typeof obj.id === 'string' ? obj.id.trim() : '';
    if (!id) {
      throw new Error('Missing rule ID for delete');
    }
    return {
      type: 'delete',
      id
    };
  }

  throw new Error(`Unsupported proposal type: ${String(type)}`);
}

function parseProposal(formData: FormData): RuleChangeInput {
  if (formData.has('proposal')) {
    const rawProposal = formData.get('proposal');
    if (rawProposal === null || rawProposal === undefined) {
      throw new Error('Missing proposal payload');
    }
    const str = typeof rawProposal === 'string' ? rawProposal.trim() : String(rawProposal).trim();
    if (str.length === 0) {
      throw new Error('Proposal field was supplied but is empty');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(str);
    } catch {
      throw new Error('Malformed proposal JSON');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Proposal must be a JSON object');
    }

    return validateProposalObject(parsed as Record<string, unknown>);
  }

  // Loose form field parsing
  const type = String(formData.get('type') || formData.get('proposalType') || 'create').trim();

  if (type === 'create') {
    const name = String(formData.get('name') ?? '').trim();
    if (!name) {
      throw new Error('Rule name cannot be empty');
    }
    const classification = String(formData.get('classification') ?? '').trim() as RuleClassification;
    if (classification !== 'work' && classification !== 'personal') {
      throw new Error(`Invalid classification '${classification}'. Only work or personal is supported.`);
    }
    const selectorType = String(formData.get('selectorType') ?? '').trim() as SelectorType;
    if (!SELECTOR_TYPES.includes(selectorType)) {
      throw new Error(`Invalid selector type '${selectorType}'`);
    }
    const selectorValue = String(formData.get('selectorValue') ?? '').trim();
    if (!selectorValue) {
      throw new Error('Selector value cannot be empty');
    }

    const priorityRaw = formData.get('priority');
    let priority = 0;
    if (priorityRaw !== null && priorityRaw !== '') {
      priority = parseStrictInteger(priorityRaw, 'priority');
    }

    const enabledRaw = formData.get('enabled');
    const enabled = enabledRaw !== null ? enabledRaw !== 'false' && enabledRaw !== '0' : true;
    const timesheetCodeRaw = formData.get('timesheetCode');
    const timesheetCode = timesheetCodeRaw ? String(timesheetCodeRaw).trim() || null : null;

    return {
      type: 'create',
      rule: {
        name,
        classification,
        selectorType,
        selectorValue,
        priority,
        enabled,
        timesheetCode
      }
    };
  }

  if (type === 'update') {
    const id = String(formData.get('id') || formData.get('ruleId') || '').trim();
    if (!id) {
      throw new Error('Missing rule ID for update');
    }

    const nameRaw = formData.get('name');
    let name: string | undefined = undefined;
    if (nameRaw !== null) {
      const trimmed = String(nameRaw).trim();
      if (trimmed.length === 0) {
        throw new Error('Rule name cannot be empty');
      }
      name = trimmed;
    }

    const classificationRaw = formData.get('classification');
    let classification: RuleClassification | undefined = undefined;
    if (classificationRaw !== null && classificationRaw !== '') {
      const cls = String(classificationRaw).trim() as RuleClassification;
      if (cls !== 'work' && cls !== 'personal') {
        throw new Error(`Invalid classification '${cls}'. Only work or personal is supported.`);
      }
      classification = cls;
    }

    const selectorTypeRaw = formData.get('selectorType');
    let selectorType: SelectorType | undefined = undefined;
    if (selectorTypeRaw !== null && selectorTypeRaw !== '') {
      const st = String(selectorTypeRaw).trim() as SelectorType;
      if (!SELECTOR_TYPES.includes(st)) {
        throw new Error(`Invalid selector type '${st}'`);
      }
      selectorType = st;
    }

    const selectorValueRaw = formData.get('selectorValue');
    let selectorValue: string | undefined = undefined;
    if (selectorValueRaw !== null) {
      const trimmed = String(selectorValueRaw).trim();
      if (trimmed.length === 0) {
        throw new Error('Selector value cannot be empty');
      }
      selectorValue = trimmed;
    }

    const priorityRaw = formData.get('priority');
    let priority: number | undefined = undefined;
    if (priorityRaw !== null && priorityRaw !== '') {
      priority = parseStrictInteger(priorityRaw, 'priority');
    }

    const enabledRaw = formData.get('enabled');
    const enabled = enabledRaw !== null ? enabledRaw !== 'false' && enabledRaw !== '0' : undefined;

    const timesheetCodeRaw = formData.get('timesheetCode');
    let timesheetCode: string | null | undefined = undefined;
    if (timesheetCodeRaw !== null) {
      timesheetCode = String(timesheetCodeRaw).trim() || null;
    }

    return {
      type: 'update',
      id,
      rule: {
        name,
        classification,
        selectorType,
        selectorValue,
        priority,
        enabled,
        timesheetCode
      }
    };
  }

  if (type === 'delete') {
    const id = String(formData.get('id') || formData.get('ruleId') || '').trim();
    if (!id) {
      throw new Error('Missing rule ID for delete');
    }
    return {
      type: 'delete',
      id
    };
  }

  throw new Error(`Unsupported proposal type: ${type}`);
}

function verifyAuthAndCsrf(locals: App.Locals, request: Request, formData: FormData) {
  if (!locals.admin || !locals.sessionToken) {
    return { error: fail(401, { error: 'Unauthorized' }) };
  }

  const submitted = (formData.get('csrfToken') || request.headers.get('x-csrf-token')) as string | null;
  if (!verifyCsrfToken(submitted, locals.sessionToken, runtime.sessionSecret)) {
    return { error: fail(403, { error: 'Invalid or missing CSRF token' }) };
  }

  return { admin: locals.admin };
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const coverage = runtime.classification.getCoverage();
  const rules = runtime.classification.getRules();
  const allocations = runtime.classification.getAllocations();
  const revisions = runtime.classification.getRevisions(50);
  const suggestions = runtime.classification.getUnclassifiedSuggestions({ limitPerType: 50 });
  const revisionState = runtime.classification.getRevisionState();
  const machineNames = Object.fromEntries(runtime.classification.getMachineNameMap());
  const editorNames = Object.fromEntries(runtime.classification.getEditorNameMap());

  const maxDateRow = runtime.db
    .prepare('SELECT MAX(date) AS max_date FROM daily_totals')
    .get() as { max_date: string | null } | undefined;
  const archiveMaxDate = maxDateRow?.max_date ?? null;

  let recentSlices: EvaluatedSlice[] = [];
  const dateParam = url.searchParams.get('date')?.trim();
  if (dateParam) {
    recentSlices = runtime.classification.classifySlices({ date: dateParam });
  } else {
    // Populate recent dates from distinct dates that actually exist in day_project_entity_slices, newest first and bounded (14 dates)
    const distinctDates = runtime.db
      .prepare(
        'SELECT DISTINCT date FROM day_project_entity_slices ORDER BY date DESC LIMIT 14'
      )
      .all() as Array<{ date: string }>;

    if (distinctDates.length > 0) {
      const newestDate = distinctDates[0].date;
      const oldestDate = distinctDates[distinctDates.length - 1].date;
      recentSlices = runtime.classification.classifySlices({
        startDate: oldestDate,
        endDate: newestDate
      });
    }
  }

  recentSlices.sort((a, b) => {
    const cmp = b.date.localeCompare(a.date);
    if (cmp !== 0) return cmp;
    return b.totalSeconds - a.totalSeconds;
  });

  if (recentSlices.length > 100) {
    recentSlices = recentSlices.slice(0, 100);
  }

  return {
    coverage,
    rules,
    allocations,
    revisions,
    suggestions,
    archiveMaxDate,
    recentSlices,
    revisionState,
    machineNames,
    editorNames,
    csrfToken: locals.csrfToken
  };
};

export const actions: Actions = {
  previewRule: async ({ request, locals }) => {
    const formData = await request.formData();
    const auth = verifyAuthAndCsrf(locals, request, formData);
    if (auth.error) return auth.error;

    const returnTab = formData.get('returnTab')?.toString();
    const returnSelector = formData.get('returnSelector')?.toString();

    let proposal: RuleChangeInput;
    try {
      proposal = parseProposal(formData);
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : 'Invalid proposal',
        returnTab,
        returnSelector
      });
    }

    try {
      const preview = runtime.classification.previewRuleChange(proposal);
      return {
        success: true,
        preview,
        proposal,
        returnTab,
        returnSelector
      };
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : 'Failed to preview rule change',
        returnTab,
        returnSelector
      });
    }
  },

  confirmRule: async ({ request, locals }) => {
    const formData = await request.formData();
    const auth = verifyAuthAndCsrf(locals, request, formData);
    if (auth.error) return auth.error;

    const returnTab = formData.get('returnTab')?.toString();
    const returnSelector = formData.get('returnSelector')?.toString();

    const previewDigest = String(
      formData.get('previewDigest') ?? formData.get('expectedDigest') ?? ''
    ).trim();
    if (!previewDigest) {
      return fail(400, {
        error: 'Rule confirmation requires an exact preview digest',
        returnTab,
        returnSelector
      });
    }

    const previewRevisionRaw = formData.get('previewRevision') ?? formData.get('expectedRevision');
    let expectedRevision: number | undefined = undefined;
    if (previewRevisionRaw !== null && previewRevisionRaw !== '') {
      try {
        expectedRevision = parseStrictInteger(previewRevisionRaw, 'expectedRevision', { nonNegative: true });
      } catch (err) {
        return fail(400, {
          error: err instanceof Error ? err.message : 'Invalid expectedRevision',
          returnTab,
          returnSelector
        });
      }
    }

    let proposal: RuleChangeInput;
    try {
      proposal = parseProposal(formData);
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : 'Invalid proposal',
        returnTab,
        returnSelector
      });
    }

    const actor = locals.admin?.username ?? 'admin';

    try {
      let mutationResult;
      if (proposal.type === 'create') {
        mutationResult = runtime.classification.createRule(proposal.rule, {
          expectedDigest: previewDigest,
          expectedRevision,
          actor
        });
      } else if (proposal.type === 'update') {
        mutationResult = runtime.classification.updateRule(proposal.id, proposal.rule, {
          expectedDigest: previewDigest,
          expectedRevision,
          actor
        });
      } else if (proposal.type === 'delete') {
        mutationResult = runtime.classification.deleteRule(proposal.id, {
          expectedDigest: previewDigest,
          expectedRevision,
          actor
        });
      }

      return {
        success: true,
        confirmed: true,
        proposal,
        result: mutationResult,
        returnTab,
        returnSelector
      };
    } catch (err) {
      if (err instanceof StalePreviewError) {
        return fail(409, {
          error: err.message,
          stale: true,
          returnTab,
          returnSelector
        });
      }
      if (err instanceof MissingPreviewError) {
        return fail(400, {
          error: err.message,
          missingPreview: true,
          returnTab,
          returnSelector
        });
      }
      return fail(400, {
        error: err instanceof Error ? err.message : 'Failed to confirm rule change',
        returnTab,
        returnSelector
      });
    }
  },

  createAllocation: async ({ request, locals }) => {
    const formData = await request.formData();
    const auth = verifyAuthAndCsrf(locals, request, formData);
    if (auth.error) return auth.error;

    const returnTab = formData.get('returnTab')?.toString();
    const returnSelector = formData.get('returnSelector')?.toString();

    const date = String(formData.get('date') ?? '').trim();
    const projectIdRaw = formData.get('projectId');
    const entity = String(formData.get('entity') ?? '').trim();
    const classification = String(formData.get('classification') ?? '').trim() as RuleClassification;
    const timesheetCodeRaw = formData.get('timesheetCode');
    const noteRaw = formData.get('note');

    if (!date) {
      return fail(400, { error: 'Date is required for allocation', returnTab, returnSelector });
    }
    if (projectIdRaw === null || projectIdRaw === '') {
      return fail(400, { error: 'Valid projectId is required for allocation', returnTab, returnSelector });
    }
    let projectId: number;
    try {
      projectId = parseStrictInteger(projectIdRaw, 'projectId', { nonNegative: true });
    } catch {
      return fail(400, { error: 'Valid projectId is required for allocation', returnTab, returnSelector });
    }
    if (!entity) {
      return fail(400, { error: 'Entity path is required for allocation', returnTab, returnSelector });
    }
    if (classification !== 'work' && classification !== 'personal') {
      return fail(400, {
        error: `Invalid allocation classification '${classification}'. Only work or personal is allowed.`,
        returnTab,
        returnSelector
      });
    }

    const timesheetCode = timesheetCodeRaw ? String(timesheetCodeRaw).trim() || null : null;
    const note = noteRaw ? String(noteRaw).trim() || null : null;
    const actor = locals.admin?.username ?? 'admin';

    try {
      const result = runtime.classification.createAllocation(
        {
          date,
          projectId,
          entity,
          classification,
          timesheetCode,
          note
        },
        {
          actor,
          replaceExisting: false
        }
      );

      return {
        success: true,
        allocation: result.allocation,
        revision: result.revision,
        returnTab,
        returnSelector
      };
    } catch (err) {
      if (err instanceof AllocationConflictError) {
        return fail(409, {
          conflict: true,
          existingClassification: err.existingClassification,
          proposedClassification: err.proposedClassification,
          error: err.message,
          returnTab,
          returnSelector,
          targetSlice: {
            date,
            projectId,
            entity,
            classification,
            timesheetCode,
            note
          }
        });
      }
      return fail(400, {
        error: err instanceof Error ? err.message : 'Failed to create allocation',
        returnTab,
        returnSelector
      });
    }
  },

  replaceAllocation: async ({ request, locals }) => {
    const formData = await request.formData();
    const auth = verifyAuthAndCsrf(locals, request, formData);
    if (auth.error) return auth.error;

    const returnTab = formData.get('returnTab')?.toString();
    const returnSelector = formData.get('returnSelector')?.toString();

    const date = String(formData.get('date') ?? '').trim();
    const projectIdRaw = formData.get('projectId');
    const entity = String(formData.get('entity') ?? '').trim();
    const classification = String(formData.get('classification') ?? '').trim() as RuleClassification;
    const timesheetCodeRaw = formData.get('timesheetCode');
    const noteRaw = formData.get('note');

    if (!date) {
      return fail(400, { error: 'Date is required for allocation replacement', returnTab, returnSelector });
    }
    if (projectIdRaw === null || projectIdRaw === '') {
      return fail(400, { error: 'Valid projectId is required for allocation replacement', returnTab, returnSelector });
    }
    let projectId: number;
    try {
      projectId = parseStrictInteger(projectIdRaw, 'projectId', { nonNegative: true });
    } catch {
      return fail(400, { error: 'Valid projectId is required for allocation replacement', returnTab, returnSelector });
    }
    if (!entity) {
      return fail(400, { error: 'Entity path is required for allocation replacement', returnTab, returnSelector });
    }
    if (classification !== 'work' && classification !== 'personal') {
      return fail(400, {
        error: `Invalid allocation classification '${classification}'. Only work or personal is allowed.`,
        returnTab,
        returnSelector
      });
    }

    const timesheetCode = timesheetCodeRaw ? String(timesheetCodeRaw).trim() || null : null;
    const note = noteRaw ? String(noteRaw).trim() || null : null;
    const actor = locals.admin?.username ?? 'admin';

    try {
      const result = runtime.classification.replaceAllocation(
        {
          date,
          projectId,
          entity,
          classification,
          timesheetCode,
          note
        },
        { actor }
      );

      return {
        success: true,
        replaced: true,
        allocation: result.allocation,
        revision: result.revision,
        returnTab,
        returnSelector
      };
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : 'Failed to replace allocation',
        returnTab,
        returnSelector
      });
    }
  },

  deleteAllocation: async ({ request, locals }) => {
    const formData = await request.formData();
    const auth = verifyAuthAndCsrf(locals, request, formData);
    if (auth.error) return auth.error;

    const returnTab = formData.get('returnTab')?.toString();
    const returnSelector = formData.get('returnSelector')?.toString();

    const id = String(formData.get('id') || formData.get('allocationId') || '').trim();
    if (!id) {
      return fail(400, { error: 'Missing allocation ID to delete', returnTab, returnSelector });
    }

    const actor = locals.admin?.username ?? 'admin';

    try {
      const result = runtime.classification.deleteAllocation(id, { actor });
      return {
        success: true,
        deletedId: id,
        revision: result.revision,
        returnTab,
        returnSelector
      };
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : 'Failed to delete allocation',
        returnTab,
        returnSelector
      });
    }
  }
};
