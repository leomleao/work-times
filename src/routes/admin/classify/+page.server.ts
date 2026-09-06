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

function parseProposal(formData: FormData): RuleChangeInput {
  const rawProposal = formData.get('proposal');
  if (typeof rawProposal === 'string' && rawProposal.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawProposal);
      if (parsed && typeof parsed === 'object' && 'type' in parsed) {
        return parsed as RuleChangeInput;
      }
    } catch {
      // Fall through to parse individual fields
    }
  }

  const type = String(formData.get('type') || formData.get('proposalType') || 'create').trim();

  if (type === 'create') {
    const name = String(formData.get('name') ?? '').trim();
    const classification = String(formData.get('classification') ?? '').trim() as RuleClassification;
    const selectorType = String(formData.get('selectorType') ?? '').trim() as SelectorType;
    const selectorValue = String(formData.get('selectorValue') ?? '').trim();
    const priorityRaw = formData.get('priority');
    const priority = priorityRaw !== null && priorityRaw !== '' ? Number.parseInt(String(priorityRaw), 10) : 0;
    const enabledRaw = formData.get('enabled');
    const enabled = enabledRaw !== null ? enabledRaw !== 'false' && enabledRaw !== '0' : true;
    const timesheetCodeRaw = formData.get('timesheetCode');
    const timesheetCode = timesheetCodeRaw ? String(timesheetCodeRaw).trim() : null;

    return {
      type: 'create',
      rule: {
        name,
        classification,
        selectorType,
        selectorValue,
        priority: Number.isSafeInteger(priority) ? priority : 0,
        enabled,
        timesheetCode: timesheetCode || null
      }
    };
  }

  if (type === 'update') {
    const id = String(formData.get('id') || formData.get('ruleId') || '').trim();
    const nameRaw = formData.get('name');
    const classificationRaw = formData.get('classification');
    const selectorTypeRaw = formData.get('selectorType');
    const selectorValueRaw = formData.get('selectorValue');
    const priorityRaw = formData.get('priority');
    const enabledRaw = formData.get('enabled');
    const timesheetCodeRaw = formData.get('timesheetCode');

    return {
      type: 'update',
      id,
      rule: {
        name: nameRaw !== null ? String(nameRaw).trim() : undefined,
        classification: classificationRaw ? (String(classificationRaw).trim() as RuleClassification) : undefined,
        selectorType: selectorTypeRaw ? (String(selectorTypeRaw).trim() as SelectorType) : undefined,
        selectorValue: selectorValueRaw !== null ? String(selectorValueRaw).trim() : undefined,
        priority: priorityRaw !== null && priorityRaw !== '' ? Number.parseInt(String(priorityRaw), 10) : undefined,
        enabled: enabledRaw !== null ? enabledRaw !== 'false' && enabledRaw !== '0' : undefined,
        timesheetCode: timesheetCodeRaw !== null ? (String(timesheetCodeRaw).trim() || null) : undefined
      }
    };
  }

  if (type === 'delete') {
    const id = String(formData.get('id') || formData.get('ruleId') || '').trim();
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
  const suggestions = runtime.classification.getUnclassifiedSuggestions({ limit: 50 });
  const revisionState = runtime.classification.getRevisionState();

  const maxDateRow = runtime.db
    .prepare('SELECT MAX(date) AS max_date FROM daily_totals')
    .get() as { max_date: string | null } | undefined;
  const archiveMaxDate = maxDateRow?.max_date ?? null;

  let recentSlices: EvaluatedSlice[] = [];
  if (archiveMaxDate) {
    const dateParam = url.searchParams.get('date')?.trim();
    if (dateParam) {
      recentSlices = runtime.classification.classifySlices({ date: dateParam });
    } else {
      const recentDates = runtime.db
        .prepare('SELECT date FROM daily_totals WHERE date <= ? ORDER BY date DESC LIMIT 14')
        .all(archiveMaxDate) as Array<{ date: string }>;
      const startDate =
        recentDates.length > 0 ? recentDates[recentDates.length - 1].date : archiveMaxDate;
      recentSlices = runtime.classification.classifySlices({
        startDate,
        endDate: archiveMaxDate
      });
    }

    recentSlices.sort((a, b) => {
      const cmp = b.date.localeCompare(a.date);
      if (cmp !== 0) return cmp;
      return b.totalSeconds - a.totalSeconds;
    });

    if (recentSlices.length > 100) {
      recentSlices = recentSlices.slice(0, 100);
    }
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
    csrfToken: locals.csrfToken
  };
};

export const actions: Actions = {
  previewRule: async ({ request, locals }) => {
    const formData = await request.formData();
    const auth = verifyAuthAndCsrf(locals, request, formData);
    if (auth.error) return auth.error;

    let proposal: RuleChangeInput;
    try {
      proposal = parseProposal(formData);
    } catch (err) {
      return fail(400, { error: err instanceof Error ? err.message : 'Invalid proposal' });
    }

    if (proposal.type === 'create') {
      if (!proposal.rule.name || proposal.rule.name.trim().length === 0) {
        return fail(400, { error: 'Rule name cannot be empty' });
      }
      if (proposal.rule.classification !== 'work' && proposal.rule.classification !== 'personal') {
        return fail(400, {
          error: `Invalid classification '${proposal.rule.classification}'. Only work or personal is supported.`
        });
      }
      if (!SELECTOR_TYPES.includes(proposal.rule.selectorType)) {
        return fail(400, { error: `Invalid selector type '${proposal.rule.selectorType}'` });
      }
      if (!proposal.rule.selectorValue || proposal.rule.selectorValue.trim().length === 0) {
        return fail(400, { error: 'Selector value cannot be empty' });
      }
    } else if (proposal.type === 'update') {
      if (!proposal.id) {
        return fail(400, { error: 'Missing rule ID for update' });
      }
      if (
        proposal.rule.classification !== undefined &&
        proposal.rule.classification !== 'work' &&
        proposal.rule.classification !== 'personal'
      ) {
        return fail(400, {
          error: `Invalid classification '${proposal.rule.classification}'. Only work or personal is supported.`
        });
      }
      if (
        proposal.rule.selectorType !== undefined &&
        !SELECTOR_TYPES.includes(proposal.rule.selectorType)
      ) {
        return fail(400, { error: `Invalid selector type '${proposal.rule.selectorType}'` });
      }
    } else if (proposal.type === 'delete') {
      if (!proposal.id) {
        return fail(400, { error: 'Missing rule ID for delete' });
      }
    }

    try {
      const preview = runtime.classification.previewRuleChange(proposal);
      return {
        success: true,
        preview,
        proposal
      };
    } catch (err) {
      return fail(400, { error: err instanceof Error ? err.message : 'Failed to preview rule change' });
    }
  },

  confirmRule: async ({ request, locals }) => {
    const formData = await request.formData();
    const auth = verifyAuthAndCsrf(locals, request, formData);
    if (auth.error) return auth.error;

    const previewDigest = String(
      formData.get('previewDigest') ?? formData.get('expectedDigest') ?? ''
    ).trim();
    if (!previewDigest) {
      return fail(400, { error: 'Rule confirmation requires an exact preview digest' });
    }

    const previewRevisionRaw = formData.get('previewRevision') ?? formData.get('expectedRevision');
    const expectedRevision =
      previewRevisionRaw !== null && previewRevisionRaw !== ''
        ? Number.parseInt(String(previewRevisionRaw), 10)
        : undefined;

    let proposal: RuleChangeInput;
    try {
      proposal = parseProposal(formData);
    } catch (err) {
      return fail(400, { error: err instanceof Error ? err.message : 'Invalid proposal' });
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
        result: mutationResult
      };
    } catch (err) {
      if (err instanceof StalePreviewError) {
        return fail(409, { error: err.message, stale: true });
      }
      if (err instanceof MissingPreviewError) {
        return fail(400, { error: err.message, missingPreview: true });
      }
      return fail(400, { error: err instanceof Error ? err.message : 'Failed to confirm rule change' });
    }
  },

  createAllocation: async ({ request, locals }) => {
    const formData = await request.formData();
    const auth = verifyAuthAndCsrf(locals, request, formData);
    if (auth.error) return auth.error;

    const date = String(formData.get('date') ?? '').trim();
    const projectIdRaw = formData.get('projectId');
    const entity = String(formData.get('entity') ?? '').trim();
    const classification = String(formData.get('classification') ?? '').trim() as RuleClassification;
    const timesheetCodeRaw = formData.get('timesheetCode');
    const noteRaw = formData.get('note');
    const replaceExisting =
      formData.get('replaceExisting') === 'true' || formData.get('replaceExisting') === '1';

    if (!date) {
      return fail(400, { error: 'Date is required for allocation' });
    }
    const projectId = Number.parseInt(String(projectIdRaw ?? ''), 10);
    if (!Number.isSafeInteger(projectId)) {
      return fail(400, { error: 'Valid projectId is required for allocation' });
    }
    if (!entity) {
      return fail(400, { error: 'Entity path is required for allocation' });
    }
    if (classification !== 'work' && classification !== 'personal') {
      return fail(400, {
        error: `Invalid allocation classification '${classification}'. Only work or personal is allowed.`
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
          replaceExisting
        }
      );

      return {
        success: true,
        allocation: result.allocation,
        revision: result.revision
      };
    } catch (err) {
      if (err instanceof AllocationConflictError) {
        return fail(409, {
          conflict: true,
          existingClassification: err.existingClassification,
          proposedClassification: err.proposedClassification,
          error: err.message,
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
      return fail(400, { error: err instanceof Error ? err.message : 'Failed to create allocation' });
    }
  },

  replaceAllocation: async ({ request, locals }) => {
    const formData = await request.formData();
    const auth = verifyAuthAndCsrf(locals, request, formData);
    if (auth.error) return auth.error;

    const date = String(formData.get('date') ?? '').trim();
    const projectIdRaw = formData.get('projectId');
    const entity = String(formData.get('entity') ?? '').trim();
    const classification = String(formData.get('classification') ?? '').trim() as RuleClassification;
    const timesheetCodeRaw = formData.get('timesheetCode');
    const noteRaw = formData.get('note');

    if (!date) {
      return fail(400, { error: 'Date is required for allocation' });
    }
    const projectId = Number.parseInt(String(projectIdRaw ?? ''), 10);
    if (!Number.isSafeInteger(projectId)) {
      return fail(400, { error: 'Valid projectId is required for allocation' });
    }
    if (!entity) {
      return fail(400, { error: 'Entity path is required for allocation' });
    }
    if (classification !== 'work' && classification !== 'personal') {
      return fail(400, {
        error: `Invalid allocation classification '${classification}'. Only work or personal is allowed.`
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
        revision: result.revision
      };
    } catch (err) {
      return fail(400, { error: err instanceof Error ? err.message : 'Failed to replace allocation' });
    }
  },

  deleteAllocation: async ({ request, locals }) => {
    const formData = await request.formData();
    const auth = verifyAuthAndCsrf(locals, request, formData);
    if (auth.error) return auth.error;

    const id = String(formData.get('id') || formData.get('allocationId') || '').trim();
    if (!id) {
      return fail(400, { error: 'Missing allocation ID to delete' });
    }

    const actor = locals.admin?.username ?? 'admin';

    try {
      const result = runtime.classification.deleteAllocation(id, { actor });
      return {
        success: true,
        deletedId: id,
        revision: result.revision
      };
    } catch (err) {
      return fail(400, { error: err instanceof Error ? err.message : 'Failed to delete allocation' });
    }
  }
};
