import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runtime } from '../src/lib/server/runtime';
import { csrfTokenForSession } from '../src/lib/server/security/http';
import { actions, load } from '../src/routes/admin/classify/+page.server';
import { SELECTOR_TYPES } from '../src/lib/server/classification/model';

const ROOT = resolve(import.meta.dirname, '..');

function loadClassifySvelte(): string {
  return readFileSync(resolve(ROOT, 'src/routes/admin/classify/+page.svelte'), 'utf-8');
}

function createAuthenticatedEvent(options: {
  url?: string;
  formData?: FormData;
  adminUsername?: string;
  sessionToken?: string;
  skipCsrf?: boolean;
  tamperCsrf?: boolean;
  customCsrf?: string;
}) {
  const url = new URL(options.url ?? 'http://localhost:3002/admin/classify');
  const sessionToken = options.sessionToken ?? 'test-valid-admin-session-token-12345';
  const admin = {
    username: options.adminUsername ?? 'admin',
    sessionExpiresAt: new Date(Date.now() + 3600000).toISOString()
  };

  const validCsrf = csrfTokenForSession(sessionToken, runtime.sessionSecret);
  const formData = options.formData ?? new FormData();

  if (!options.skipCsrf) {
    if (options.customCsrf) {
      formData.set('csrfToken', options.customCsrf);
    } else if (options.tamperCsrf) {
      formData.set('csrfToken', 'invalid-tampered-csrf-token');
    } else if (!formData.has('csrfToken')) {
      formData.set('csrfToken', validCsrf);
    }
  }

  const request = new Request(url, {
    method: 'POST',
    body: formData
  });

  const locals: App.Locals = {
    admin,
    sessionToken,
    csrfToken: validCsrf
  };

  const event = {
    request,
    url,
    locals,
    cookies: {} as any,
    getClientAddress: () => '127.0.0.1',
    params: {},
    route: { id: url.pathname },
    isDataRequest: false,
    setHeaders: () => {},
    fetch: globalThis.fetch
  } as any;

  return { event, validCsrf, sessionToken };
}

function createUnauthenticatedEvent(options?: { formData?: FormData; url?: string }) {
  const url = new URL(options?.url ?? 'http://localhost:3002/admin/classify');
  const formData = options?.formData ?? new FormData();

  const request = new Request(url, {
    method: 'POST',
    body: formData
  });

  const locals: App.Locals = {
    admin: null,
    sessionToken: null,
    csrfToken: null
  };

  const event = {
    request,
    url,
    locals,
    cookies: {} as any,
    getClientAddress: () => '127.0.0.1',
    params: {},
    route: { id: url.pathname },
    isDataRequest: false,
    setHeaders: () => {},
    fetch: globalThis.fetch
  } as any;

  return event;
}

describe('Classification Admin UI & Route Contracts (tests/classification-ui-route.test.ts)', () => {
  beforeEach(() => {
    // Clear mutable classification tables (classification_revisions is append-only)
    runtime.db.prepare('DELETE FROM daily_time_allocations').run();
    runtime.db.prepare('DELETE FROM classification_rules').run();
  });

  afterEach(() => {
    runtime.db.prepare('DELETE FROM daily_time_allocations').run();
    runtime.db.prepare('DELETE FROM classification_rules').run();
  });

  describe('Requirement: Auth & CSRF Protection', () => {
    it('rejects unauthenticated requests with 401 across all actions', async () => {
      const previewRes = await (actions.previewRule as any)(createUnauthenticatedEvent());
      expect(previewRes.status).toBe(401);
      expect(previewRes.data.error).toBe('Unauthorized');

      const confirmRes = await (actions.confirmRule as any)(createUnauthenticatedEvent());
      expect(confirmRes.status).toBe(401);
      expect(confirmRes.data.error).toBe('Unauthorized');

      const createAllocRes = await (actions.createAllocation as any)(createUnauthenticatedEvent());
      expect(createAllocRes.status).toBe(401);
      expect(createAllocRes.data.error).toBe('Unauthorized');

      const replaceAllocRes = await (actions.replaceAllocation as any)(createUnauthenticatedEvent());
      expect(replaceAllocRes.status).toBe(401);
      expect(replaceAllocRes.data.error).toBe('Unauthorized');

      const deleteAllocRes = await (actions.deleteAllocation as any)(createUnauthenticatedEvent());
      expect(deleteAllocRes.status).toBe(401);
      expect(deleteAllocRes.data.error).toBe('Unauthorized');
    });

    it('rejects authenticated requests with missing or invalid CSRF tokens with 403', async () => {
      const missingCsrf = createAuthenticatedEvent({ skipCsrf: true });
      const res1 = await (actions.previewRule as any)(missingCsrf.event);
      expect(res1.status).toBe(403);
      expect(res1.data.error).toBe('Invalid or missing CSRF token');

      const tamperedCsrf = createAuthenticatedEvent({ tamperCsrf: true });
      const res2 = await (actions.confirmRule as any)(tamperedCsrf.event);
      expect(res2.status).toBe(403);
      expect(res2.data.error).toBe('Invalid or missing CSRF token');

      const tamperedAlloc = createAuthenticatedEvent({ tamperCsrf: true });
      const res3 = await (actions.createAllocation as any)(tamperedAlloc.event);
      expect(res3.status).toBe(403);
      expect(res3.data.error).toBe('Invalid or missing CSRF token');
    });

    it('accepts valid session with matching HMAC CSRF token', async () => {
      const formData = new FormData();
      formData.set('type', 'create');
      formData.set('name', 'Telemetry Ingest Machine');
      formData.set('classification', 'work');
      formData.set('selectorType', 'machine');
      formData.set('selectorValue', 'prod-builder-01');

      const { event } = createAuthenticatedEvent({ formData });
      const res = await (actions.previewRule as any)(event);
      expect(res.success).toBe(true);
      expect(res.preview).toBeDefined();
      expect(res.preview.previewDigest).toMatch(/^prev-\d+-/);
    });
  });

  describe('Requirement: Two-Step Reusable-Rule Flow (Preview & Confirmation)', () => {
    it('previews normalized create proposal and returns exact RulePreviewResult', async () => {
      const formData = new FormData();
      formData.set('type', 'create');
      formData.set('name', 'Work Repo Rule');
      formData.set('classification', 'work');
      formData.set('selectorType', 'project');
      formData.set('selectorValue', 'work-times');
      formData.set('priority', '15');
      formData.set('timesheetCode', 'WT-001');

      const { event } = createAuthenticatedEvent({ formData });
      const previewRes = await (actions.previewRule as any)(event);

      expect(previewRes.success).toBe(true);
      expect(previewRes.proposal).toEqual({
        type: 'create',
        rule: {
          name: 'Work Repo Rule',
          classification: 'work',
          selectorType: 'project',
          selectorValue: 'work-times',
          matchMode: 'exact',
          priority: 15,
          enabled: true,
          timesheetCode: 'WT-001'
        }
      });
      expect(previewRes.preview).toBeDefined();
      expect(typeof previewRes.preview.previewDigest).toBe('string');
      expect(previewRes.preview.previewDigest.length).toBeGreaterThan(10);
      expect(previewRes.preview.shiftedSeconds).toBeDefined();
      expect(previewRes.preview.shiftedSeconds.workToPersonal).toBe(0);
      expect(previewRes.preview.shiftedSeconds.personalToWork).toBe(0);
    });

    it('requires explicit confirmation with exact proposal and preview digest to commit', async () => {
      // 1. Preview
      const createFormData = new FormData();
      createFormData.set('type', 'create');
      createFormData.set('name', 'Client App');
      createFormData.set('classification', 'work');
      createFormData.set('selectorType', 'project');
      createFormData.set('selectorValue', 'client-app');
      createFormData.set('priority', '20');

      const { event: previewEvent } = createAuthenticatedEvent({ formData: createFormData });
      const previewRes = await (actions.previewRule as any)(previewEvent);
      expect(previewRes.success).toBe(true);

      // Verify rule does not exist yet before confirmation
      const rulesBefore = runtime.classification.getRules();
      expect(rulesBefore.some((r) => r.name === 'Client App')).toBe(false);

      // 2. Confirm
      const confirmFormData = new FormData();
      confirmFormData.set('previewDigest', previewRes.preview.previewDigest);
      confirmFormData.set('previewRevision', String(previewRes.preview.previewRevision));
      confirmFormData.set('proposal', JSON.stringify(previewRes.proposal));

      const { event: confirmEvent } = createAuthenticatedEvent({ formData: confirmFormData });
      const confirmRes = await (actions.confirmRule as any)(confirmEvent);

      expect(confirmRes.success).toBe(true);
      expect(confirmRes.confirmed).toBe(true);
      expect(confirmRes.result.rule.name).toBe('Client App');
      expect(confirmRes.result.rule.selector_value).toBe('client-app');

      // Verify rule now exists in database
      const rulesAfter = runtime.classification.getRules();
      const created = rulesAfter.find((r) => r.name === 'Client App');
      expect(created).toBeDefined();
      expect(created?.classification).toBe('work');
      expect(created?.priority).toBe(20);

      // Verify audit revision logged
      const revisions = runtime.classification.getRevisions(10);
      expect(revisions.some((rev) => rev.target_id === created?.id && rev.mutation_type === 'rule_created')).toBe(true);
    });

    it('executes two-step flow for rule update and delete', async () => {
      // Seed initial rule via safe preview-confirm flow
      const seedPreview = runtime.classification.previewRuleChange({
        type: 'create',
        rule: {
          name: 'To Be Modified',
          classification: 'personal',
          selectorType: 'domain',
          selectorValue: 'reddit.com',
          priority: 5
        }
      });
      const { rule: createdRule } = runtime.classification.createRule(
        {
          name: 'To Be Modified',
          classification: 'personal',
          selectorType: 'domain',
          selectorValue: 'reddit.com',
          priority: 5
        },
        { expectedDigest: seedPreview.previewDigest, actor: 'admin' }
      );

      // Update flow
      const updateFormData = new FormData();
      updateFormData.set('type', 'update');
      updateFormData.set('id', createdRule.id);
      updateFormData.set('priority', '50');

      const { event: updatePrevEvt } = createAuthenticatedEvent({ formData: updateFormData });
      const updatePrevRes = await (actions.previewRule as any)(updatePrevEvt);
      expect(updatePrevRes.success).toBe(true);

      const confirmUpdateFormData = new FormData();
      confirmUpdateFormData.set('previewDigest', updatePrevRes.preview.previewDigest);
      confirmUpdateFormData.set('proposal', JSON.stringify(updatePrevRes.proposal));
      const { event: confirmUpdateEvt } = createAuthenticatedEvent({ formData: confirmUpdateFormData });
      const confirmUpdateRes = await (actions.confirmRule as any)(confirmUpdateEvt);
      expect(confirmUpdateRes.success).toBe(true);
      expect(confirmUpdateRes.result.rule.priority).toBe(50);

      // Delete flow
      const deleteFormData = new FormData();
      deleteFormData.set('type', 'delete');
      deleteFormData.set('id', createdRule.id);

      const { event: deletePrevEvt } = createAuthenticatedEvent({ formData: deleteFormData });
      const deletePrevRes = await (actions.previewRule as any)(deletePrevEvt);
      expect(deletePrevRes.success).toBe(true);

      const confirmDeleteFormData = new FormData();
      confirmDeleteFormData.set('previewDigest', deletePrevRes.preview.previewDigest);
      confirmDeleteFormData.set('proposal', JSON.stringify(deletePrevRes.proposal));
      const { event: confirmDeleteEvt } = createAuthenticatedEvent({ formData: confirmDeleteFormData });
      const confirmDeleteRes = await (actions.confirmRule as any)(confirmDeleteEvt);
      expect(confirmDeleteRes.success).toBe(true);
      expect(runtime.classification.getRule(createdRule.id)).toBeNull();
    });
  });

  describe('Requirement: Stale/Altered Payload Rejection via Service', () => {
    it('rejects confirmation when preview digest is missing with 400', async () => {
      const formData = new FormData();
      formData.set(
        'proposal',
        JSON.stringify({
          type: 'create',
          rule: {
            name: 'Unchecked',
            classification: 'work',
            selectorType: 'project',
            selectorValue: 'work-times'
          }
        })
      );
      // no previewDigest

      const { event } = createAuthenticatedEvent({ formData });
      const res = await (actions.confirmRule as any)(event);
      expect(res.status).toBe(400);
      expect(res.data.error).toContain('preview digest');
    });

    it('rejects confirmation when proposal payload was altered after preview with 409 stale error', async () => {
      // 1. Get preview for classification: 'work'
      const createFormData = new FormData();
      createFormData.set('type', 'create');
      createFormData.set('name', 'Original Proposal');
      createFormData.set('classification', 'work');
      createFormData.set('selectorType', 'project');
      createFormData.set('selectorValue', 'core-api');

      const { event: previewEvent } = createAuthenticatedEvent({ formData: createFormData });
      const previewRes = await (actions.previewRule as any)(previewEvent);
      expect(previewRes.success).toBe(true);

      // 2. Alter proposal before confirming (e.g. flip to personal)
      const alteredProposal = {
        ...previewRes.proposal,
        rule: {
          ...previewRes.proposal.rule,
          classification: 'personal' // ALTERED!
        }
      };

      const confirmFormData = new FormData();
      confirmFormData.set('previewDigest', previewRes.preview.previewDigest);
      confirmFormData.set('proposal', JSON.stringify(alteredProposal));

      const { event: confirmEvent } = createAuthenticatedEvent({ formData: confirmFormData });
      const confirmRes = await (actions.confirmRule as any)(confirmEvent);

      expect(confirmRes.status).toBe(409);
      expect(confirmRes.data.stale).toBe(true);
      expect(confirmRes.data.error).toMatch(/stale preview or mismatched payload/i);
    });

    it('rejects confirmation when database revision has changed since preview with 409 stale error', async () => {
      // 1. Get preview
      const previewRes = runtime.classification.previewRuleChange({
        type: 'create',
        rule: {
          name: 'Stale Check Rule',
          classification: 'work',
          selectorType: 'project',
          selectorValue: 'stale-proj'
        }
      });

      // 2. Advance DB revision by creating an unrelated rule
      const interveningPreview = runtime.classification.previewRuleChange({
        type: 'create',
        rule: {
          name: 'Intervening',
          classification: 'work',
          selectorType: 'machine',
          selectorValue: 'builder-x'
        }
      });
      runtime.classification.createRule(
        {
          name: 'Intervening',
          classification: 'work',
          selectorType: 'machine',
          selectorValue: 'builder-x'
        },
        { expectedDigest: interveningPreview.previewDigest, actor: 'admin' }
      );

      // 3. Attempt confirmation with now-stale preview digest
      const confirmFormData = new FormData();
      confirmFormData.set('previewDigest', previewRes.previewDigest);
      confirmFormData.set(
        'proposal',
        JSON.stringify({
          type: 'create',
          rule: {
            name: 'Stale Check Rule',
            classification: 'work',
            selectorType: 'project',
            selectorValue: 'stale-proj'
          }
        })
      );

      const { event: confirmEvent } = createAuthenticatedEvent({ formData: confirmFormData });
      const confirmRes = await (actions.confirmRule as any)(confirmEvent);

      expect(confirmRes.status).toBe(409);
      expect(confirmRes.data.stale).toBe(true);
    });
  });

  describe('Requirement: Work ↔ Personal Impact Rendering Data', () => {
    it('surfaces exact work↔personal shifted seconds and affected slice/date counts in preview', () => {
      // Seed projects, daily_totals, and slices
      runtime.db.prepare(`INSERT OR IGNORE INTO projects (id, name) VALUES (201, 'client-shift-test')`).run();
      runtime.db.prepare(
        `INSERT OR IGNORE INTO source_imports (id, source_type, source_hash, byte_size)
         VALUES (99, 'daily_dump', 'hash-shift-test', 500)`
      ).run();
      runtime.db.prepare(
        `INSERT OR REPLACE INTO daily_totals (date, total_seconds, grand_total_json, source_import_id, source_hash)
         VALUES ('2026-04-10', 7200, '{}', 99, 'hash-shift-test')`
      ).run();
      runtime.db.prepare(
        `INSERT OR REPLACE INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, source_import_id)
         VALUES (9901, '2026-04-10', 201, 'src/important.ts', 'file', 7200, 99)`
      ).run();

      // Initially classify project as work
      const p1 = runtime.classification.previewRuleChange({
        type: 'create',
        rule: {
          name: 'Project Work Rule',
          classification: 'work',
          selectorType: 'project',
          selectorValue: 'client-shift-test',
          priority: 10
        }
      });
      runtime.classification.createRule(
        {
          name: 'Project Work Rule',
          classification: 'work',
          selectorType: 'project',
          selectorValue: 'client-shift-test',
          priority: 10
        },
        { expectedDigest: p1.previewDigest, actor: 'admin' }
      );

      // Now preview a narrower rule for entity src/important.ts as PERSONAL
      const preview = runtime.classification.previewRuleChange({
        type: 'create',
        rule: {
          name: 'Entity Personal Exception',
          classification: 'personal',
          selectorType: 'entity',
          selectorValue: 'src/important.ts',
          priority: 10
        }
      });

      // Visibly surfaces affected historical slice/date counts and shifted-seconds
      expect(preview.affectedSliceCount).toBe(1);
      expect(preview.affectedDates).toEqual(['2026-04-10']);
      expect(preview.shiftedSeconds.workToPersonal).toBe(7200);
      expect(preview.shiftedSeconds.personalToWork).toBe(0);
      expect(preview.shiftedSeconds.totalShifted).toBe(7200);
      expect(preview.shiftedSeconds.net.work).toBe(-7200);
      expect(preview.shiftedSeconds.net.personal).toBe(7200);
    });

    it('surfaces personalToWork shifted seconds when flipping personal time to work', () => {
      // Seed slice
      runtime.db.prepare(`INSERT OR IGNORE INTO projects (id, name) VALUES (202, 'personal-blog')`).run();
      runtime.db.prepare(
        `INSERT OR REPLACE INTO daily_totals (date, total_seconds, grand_total_json, source_import_id, source_hash)
         VALUES ('2026-04-11', 3600, '{}', 99, 'hash-shift-test')`
      ).run();
      runtime.db.prepare(
        `INSERT OR REPLACE INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, source_import_id)
         VALUES (9902, '2026-04-11', 202, 'content/post.md', 'file', 3600, 99)`
      ).run();

      // Rule: project personal-blog is personal
      const p1 = runtime.classification.previewRuleChange({
        type: 'create',
        rule: {
          name: 'Blog Personal',
          classification: 'personal',
          selectorType: 'project',
          selectorValue: 'personal-blog'
        }
      });
      runtime.classification.createRule(
        {
          name: 'Blog Personal',
          classification: 'personal',
          selectorType: 'project',
          selectorValue: 'personal-blog'
        },
        { expectedDigest: p1.previewDigest, actor: 'admin' }
      );

      // Preview entity content/post.md as WORK
      const preview = runtime.classification.previewRuleChange({
        type: 'create',
        rule: {
          name: 'Work Post',
          classification: 'work',
          selectorType: 'entity',
          selectorValue: 'content/post.md'
        }
      });

      expect(preview.shiftedSeconds.personalToWork).toBe(3600);
      expect(preview.shiftedSeconds.workToPersonal).toBe(0);
      expect(preview.affectedSliceCount).toBe(1);
    });
  });

  describe('Requirement: Whole-Slice Allocation Create, Conflict Surfacing & Replacement', () => {
    beforeEach(() => {
      runtime.db.prepare(`INSERT OR IGNORE INTO projects (id, name) VALUES (301, 'alloc-project')`).run();
      runtime.db.prepare(
        `INSERT OR IGNORE INTO source_imports (id, source_type, source_hash, byte_size)
         VALUES (99, 'daily_dump', 'hash-alloc-test', 500)`
      ).run();
      runtime.db.prepare(
        `INSERT OR REPLACE INTO daily_totals (date, total_seconds, grand_total_json, source_import_id, source_hash)
         VALUES ('2026-05-01', 5400, '{}', 99, 'hash-alloc-test')`
      ).run();
      runtime.db.prepare(
        `INSERT OR REPLACE INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, source_import_id)
         VALUES (9903, '2026-05-01', 301, 'src/hotfix.ts', 'file', 5400, 99)`
      ).run();
    });

    it('creates whole-slice allocation without partial seconds or start/end dates', async () => {
      const formData = new FormData();
      formData.set('date', '2026-05-01');
      formData.set('projectId', '301');
      formData.set('entity', 'src/hotfix.ts');
      formData.set('classification', 'work');
      formData.set('timesheetCode', 'HOTFIX-01');
      formData.set('note', 'Weekend emergency hotfix');

      const { event } = createAuthenticatedEvent({ formData });
      const res = await (actions.createAllocation as any)(event);

      expect(res.success).toBe(true);
      expect(res.allocation).toBeDefined();
      expect(res.allocation.allocated_seconds).toBe(5400); // exactly slice total_seconds, no partial seconds
      expect(res.allocation.classification).toBe('work');

      const stored = runtime.classification.getAllocationBySlice('2026-05-01', 301, 'src/hotfix.ts');
      expect(stored).toBeDefined();
      expect(stored?.classification).toBe('work');
    });

    it('surfaces conflict when slice already has an allocation and refuses silent overwrite', async () => {
      // 1. Initial allocation as WORK
      runtime.classification.createAllocation({
        date: '2026-05-01',
        projectId: 301,
        entity: 'src/hotfix.ts',
        classification: 'work'
      });

      // 2. Attempt to create allocation for same slice as PERSONAL without replaceExisting
      const conflictFormData = new FormData();
      conflictFormData.set('date', '2026-05-01');
      conflictFormData.set('projectId', '301');
      conflictFormData.set('entity', 'src/hotfix.ts');
      conflictFormData.set('classification', 'personal'); // CONFLICT!

      const { event: conflictEvent } = createAuthenticatedEvent({ formData: conflictFormData });
      const conflictRes = await (actions.createAllocation as any)(conflictEvent);

      expect(conflictRes.status).toBe(409);
      expect(conflictRes.data.conflict).toBe(true);
      expect(conflictRes.data.existingClassification).toBe('work');
      expect(conflictRes.data.proposedClassification).toBe('personal');
      expect(conflictRes.data.error).toMatch(/allocation conflict/i);

      // Verify no silent overwrite occurred
      const stored = runtime.classification.getAllocationBySlice('2026-05-01', 301, 'src/hotfix.ts');
      expect(stored?.classification).toBe('work');
    });

    it('performs explicit confirmed replacement via replaceAllocation', async () => {
      // 1. Initial allocation as WORK
      runtime.classification.createAllocation({
        date: '2026-05-01',
        projectId: 301,
        entity: 'src/hotfix.ts',
        classification: 'work'
      });

      // 2. Explicit replace action
      const replaceFormData = new FormData();
      replaceFormData.set('date', '2026-05-01');
      replaceFormData.set('projectId', '301');
      replaceFormData.set('entity', 'src/hotfix.ts');
      replaceFormData.set('classification', 'personal');
      replaceFormData.set('note', 'Confirmed replacement to personal');

      const { event: replaceEvent } = createAuthenticatedEvent({ formData: replaceFormData });
      const replaceRes = await (actions.replaceAllocation as any)(replaceEvent);

      expect(replaceRes.success).toBe(true);
      expect(replaceRes.replaced).toBe(true);
      expect(replaceRes.allocation.classification).toBe('personal');

      const stored = runtime.classification.getAllocationBySlice('2026-05-01', 301, 'src/hotfix.ts');
      expect(stored?.classification).toBe('personal');

      // 3. Delete allocation
      const deleteFormData = new FormData();
      deleteFormData.set('id', replaceRes.allocation.id);

      const { event: deleteEvent } = createAuthenticatedEvent({ formData: deleteFormData });
      const deleteRes = await (actions.deleteAllocation as any)(deleteEvent);
      expect(deleteRes.success).toBe(true);
      expect(runtime.classification.getAllocation(replaceRes.allocation.id)).toBeNull();
    });
  });

  describe('Requirement: No Synthetic Sentinel Copy & Sane Loader Data', () => {
    it('returns real all-history coverage, rules, allocations, revisions, suggestions, and bounded recent slices', async () => {
      // Seed one active day in daily_totals
      runtime.db.prepare(
        `INSERT OR REPLACE INTO daily_totals (date, total_seconds, grand_total_json, source_import_id, source_hash)
         VALUES ('2026-06-15', 3600, '{}', 99, 'hash-loader-test')`
      ).run();

      const { event } = createAuthenticatedEvent({ url: 'http://localhost:3002/admin/classify' });
      const data: any = await load(event);

      expect(data.coverage).toBeDefined();
      expect(typeof data.coverage.coveragePercentage).toBe('number');
      expect(data.rules).toBeInstanceOf(Array);
      expect(data.allocations).toBeInstanceOf(Array);
      expect(data.revisions).toBeInstanceOf(Array);
      expect(data.suggestions).toBeInstanceOf(Array);
      expect(data.recentSlices).toBeInstanceOf(Array);

      // Verify archiveMaxDate determined from daily_totals
      expect(data.archiveMaxDate).toBe('2026-06-15');

      // Verify page payload bounded
      expect(data.recentSlices.length).toBeLessThanOrEqual(100);
    });

    it('ensures +page.svelte contains no synthetic mock identities or timer copy', () => {
      const svelteSrc = loadClassifySvelte();

      // Verify removal of synthetic mock candidate items
      expect(svelteSrc).not.toContain("'cand-1'");
      expect(svelteSrc).not.toContain("'workstation-mbp'");
      expect(svelteSrc).not.toContain("'cand-5'");
      expect(svelteSrc).not.toContain('com.apple.dt.Xcode');
      expect(svelteSrc).not.toContain('slice_2026_09_04_weekend_hotfix');
      expect(svelteSrc).not.toContain('slice_2026_08_30_homelab_tuning');

      // Verify removal of mock metrics & timers
      expect(svelteSrc).not.toContain('926h Work · 184h Personal');
      expect(svelteSrc).not.toContain('138h 15m');
      expect(svelteSrc).not.toContain('setTimeout');

      // Verify all seven identity selectors are present
      for (const sel of SELECTOR_TYPES) {
        expect(svelteSrc).toContain(`'${sel}'`);
      }

      // Verify accurate precedence display text:
      // manual priority first; entity > longest folder_prefix > project > machine/editor/application/domain equal broad tier
      expect(svelteSrc).toContain('Manual Priority');
      expect(svelteSrc).toContain('Folder Prefix');
      expect(svelteSrc).toContain('Machine / Editor / App / Domain [10]');
      expect(svelteSrc).toContain('Equal broad tier');
      expect(svelteSrc).toContain('Ambiguity Rule');
      expect(svelteSrc).toContain('Suggestions never auto-apply');
    });
  });

  describe('Requirement: Strict Proposal JSON Parsing and Structure Validation', () => {
    it('rejects malformed JSON with HTTP 400 action failure and does NOT throw 500 or fall back to loose fields', async () => {
      const formData = new FormData();
      formData.set('proposal', '{ malformed json: true');
      // Loose fields that should NOT be fallen back to
      formData.set('type', 'create');
      formData.set('name', 'Fallback Proposal');
      formData.set('classification', 'work');
      formData.set('selectorType', 'project');
      formData.set('selectorValue', 'fallback-proj');

      const { event } = createAuthenticatedEvent({ formData });
      const res = await (actions.previewRule as any)(event);

      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(/malformed proposal json/i);

      // Verify rule was not created or previewed
      const rules = runtime.classification.getRules();
      expect(rules.some((r) => r.name === 'Fallback Proposal')).toBe(false);
    });

    it('rejects empty or whitespace-only proposal field with HTTP 400', async () => {
      const formData = new FormData();
      formData.set('proposal', '   ');

      const { event } = createAuthenticatedEvent({ formData });
      const res = await (actions.previewRule as any)(event);

      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(/empty/i);
    });

    it('rejects malformed proposal JSON on confirmRule with HTTP 400', async () => {
      const formData = new FormData();
      formData.set('previewDigest', 'prev-12345-abcdef');
      formData.set('proposal', 'not-valid-json');

      const { event } = createAuthenticatedEvent({ formData });
      const res = await (actions.confirmRule as any)(event);

      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(/malformed proposal json/i);
    });

    it('rejects structurally invalid proposals (missing type, bad type, missing rule object) with HTTP 400', async () => {
      // Missing type
      const fd1 = new FormData();
      fd1.set('proposal', JSON.stringify({ name: 'No Type' }));
      const { event: ev1 } = createAuthenticatedEvent({ formData: fd1 });
      const res1 = await (actions.previewRule as any)(ev1);
      expect(res1.status).toBe(400);
      expect(res1.data.error).toMatch(/invalid proposal type/i);

      // Unsupported type
      const fd2 = new FormData();
      fd2.set('proposal', JSON.stringify({ type: 'destroy', id: '123' }));
      const { event: ev2 } = createAuthenticatedEvent({ formData: fd2 });
      const res2 = await (actions.previewRule as any)(ev2);
      expect(res2.status).toBe(400);
      expect(res2.data.error).toMatch(/invalid proposal type/i);

      // Create without rule object
      const fd3 = new FormData();
      fd3.set('proposal', JSON.stringify({ type: 'create' }));
      const { event: ev3 } = createAuthenticatedEvent({ formData: fd3 });
      const res3 = await (actions.previewRule as any)(ev3);
      expect(res3.status).toBe(400);
      expect(res3.data.error).toMatch(/rule/i);

      // Create with empty rule name
      const fd4 = new FormData();
      fd4.set(
        'proposal',
        JSON.stringify({
          type: 'create',
          rule: {
            name: '',
            classification: 'work',
            selectorType: 'project',
            selectorValue: 'proj'
          }
        })
      );
      const { event: ev4 } = createAuthenticatedEvent({ formData: fd4 });
      const res4 = await (actions.previewRule as any)(ev4);
      expect(res4.status).toBe(400);
      expect(res4.data.error).toMatch(/name cannot be empty/i);

      // Update without id
      const fd5 = new FormData();
      fd5.set('proposal', JSON.stringify({ type: 'update', rule: { name: 'New Name' } }));
      const { event: ev5 } = createAuthenticatedEvent({ formData: fd5 });
      const res5 = await (actions.previewRule as any)(ev5);
      expect(res5.status).toBe(400);
      expect(res5.data.error).toMatch(/missing rule id/i);

      // Delete without id
      const fd6 = new FormData();
      fd6.set('proposal', JSON.stringify({ type: 'delete' }));
      const { event: ev6 } = createAuthenticatedEvent({ formData: fd6 });
      const res6 = await (actions.previewRule as any)(ev6);
      expect(res6.status).toBe(400);
      expect(res6.data.error).toMatch(/missing rule id/i);
    });
  });

  describe('Requirement: Refusal of replaceExisting Bypass on createAllocation', () => {
    beforeEach(() => {
      runtime.db.prepare(`INSERT OR IGNORE INTO projects (id, name) VALUES (301, 'alloc-project')`).run();
      runtime.db.prepare(
        `INSERT OR IGNORE INTO source_imports (id, source_type, source_hash, byte_size)
         VALUES (99, 'daily_dump', 'hash-alloc-test', 500)`
      ).run();
      runtime.db.prepare(
        `INSERT OR REPLACE INTO daily_totals (date, total_seconds, grand_total_json, source_import_id, source_hash)
         VALUES ('2026-05-01', 5400, '{}', 99, 'hash-alloc-test')`
      ).run();
      runtime.db.prepare(
        `INSERT OR REPLACE INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, source_import_id)
         VALUES (9903, '2026-05-01', 301, 'src/hotfix.ts', 'file', 5400, 99)`
      ).run();
    });

    it('refuses to replace existing allocation even when form provides replaceExisting: true or 1', async () => {
      // 1. Initial allocation as WORK
      runtime.classification.createAllocation({
        date: '2026-05-01',
        projectId: 301,
        entity: 'src/hotfix.ts',
        classification: 'work'
      });

      // 2. Attempt to bypass conflict check with replaceExisting: true on createAllocation
      const bypassFormData = new FormData();
      bypassFormData.set('date', '2026-05-01');
      bypassFormData.set('projectId', '301');
      bypassFormData.set('entity', 'src/hotfix.ts');
      bypassFormData.set('classification', 'personal');
      bypassFormData.set('replaceExisting', 'true'); // ATTACK: attempt bypass

      const { event: bypassEvent } = createAuthenticatedEvent({ formData: bypassFormData });
      const bypassRes = await (actions.createAllocation as any)(bypassEvent);

      expect(bypassRes.status).toBe(409);
      expect(bypassRes.data.conflict).toBe(true);
      expect(bypassRes.data.existingClassification).toBe('work');
      expect(bypassRes.data.proposedClassification).toBe('personal');

      // Verify the allocation was NOT replaced
      const existing = runtime.classification.getAllocationBySlice('2026-05-01', 301, 'src/hotfix.ts');
      expect(existing?.classification).toBe('work');

      // 3. Same attempt with replaceExisting: '1'
      const bypassFormData2 = new FormData();
      bypassFormData2.set('date', '2026-05-01');
      bypassFormData2.set('projectId', '301');
      bypassFormData2.set('entity', 'src/hotfix.ts');
      bypassFormData2.set('classification', 'personal');
      bypassFormData2.set('replaceExisting', '1');

      const { event: bypassEvent2 } = createAuthenticatedEvent({ formData: bypassFormData2 });
      const bypassRes2 = await (actions.createAllocation as any)(bypassEvent2);

      expect(bypassRes2.status).toBe(409);
      expect(bypassRes2.data.conflict).toBe(true);
      const existing2 = runtime.classification.getAllocationBySlice('2026-05-01', 301, 'src/hotfix.ts');
      expect(existing2?.classification).toBe('work');
    });
  });

  describe('Requirement: Strict Integer Validation & parseInt Trailing Junk Rejection', () => {
    it('rejects expectedRevision with trailing junk, negative numbers, or invalid syntax on confirmRule', async () => {
      const testCases = ['12junk', '-1', 'rev-1', '12.5', '1e5', '0123'];

      for (const badRevision of testCases) {
        const formData = new FormData();
        formData.set('previewDigest', 'prev-digest-12345');
        formData.set('expectedRevision', badRevision);
        formData.set(
          'proposal',
          JSON.stringify({
            type: 'create',
            rule: {
              name: 'Valid Rule',
              classification: 'work',
              selectorType: 'project',
              selectorValue: 'proj'
            }
          })
        );

        const { event } = createAuthenticatedEvent({ formData });
        const res = await (actions.confirmRule as any)(event);

        expect(res.status).toBe(400);
        expect(res.data.error).toMatch(/expectedRevision/i);
      }
    });

    it('rejects priority with trailing junk or non-integer syntax in loose form and proposal JSON', async () => {
      // Loose form priority with trailing junk
      const fd1 = new FormData();
      fd1.set('type', 'create');
      fd1.set('name', 'Bad Priority Rule');
      fd1.set('classification', 'work');
      fd1.set('selectorType', 'project');
      fd1.set('selectorValue', 'val');
      fd1.set('priority', '15junk');

      const { event: ev1 } = createAuthenticatedEvent({ formData: fd1 });
      const res1 = await (actions.previewRule as any)(ev1);
      expect(res1.status).toBe(400);
      expect(res1.data.error).toMatch(/priority/i);

      // Proposal JSON priority with trailing junk
      const fd2 = new FormData();
      fd2.set(
        'proposal',
        JSON.stringify({
          type: 'create',
          rule: {
            name: 'Bad JSON Priority Rule',
            classification: 'work',
            selectorType: 'project',
            selectorValue: 'val',
            priority: '20junk'
          }
        })
      );

      const { event: ev2 } = createAuthenticatedEvent({ formData: fd2 });
      const res2 = await (actions.previewRule as any)(ev2);
      expect(res2.status).toBe(400);
      expect(res2.data.error).toMatch(/priority/i);
    });

    it('rejects projectId with trailing junk or invalid syntax on createAllocation and replaceAllocation', async () => {
      const fdCreate = new FormData();
      fdCreate.set('date', '2026-05-01');
      fdCreate.set('projectId', '301junk'); // Trailing junk!
      fdCreate.set('entity', 'src/hotfix.ts');
      fdCreate.set('classification', 'work');

      const { event: evCreate } = createAuthenticatedEvent({ formData: fdCreate });
      const resCreate = await (actions.createAllocation as any)(evCreate);
      expect(resCreate.status).toBe(400);
      expect(resCreate.data.error).toMatch(/projectId/i);

      const fdReplace = new FormData();
      fdReplace.set('date', '2026-05-01');
      fdReplace.set('projectId', '301junk');
      fdReplace.set('entity', 'src/hotfix.ts');
      fdReplace.set('classification', 'personal');

      const { event: evReplace } = createAuthenticatedEvent({ formData: fdReplace });
      const resReplace = await (actions.replaceAllocation as any)(evReplace);
      expect(resReplace.status).toBe(400);
      expect(resReplace.data.error).toMatch(/projectId/i);
    });
  });

  describe('Requirement: Loader Populates Recent Slices from Slice-Bearing Dates', () => {
    it('populates recentSlices from day_project_entity_slices dates rather than empty daily_totals calendar rows', async () => {
      // Seed project
      runtime.db.prepare(`INSERT OR IGNORE INTO projects (id, name) VALUES (501, 'slice-date-test')`).run();
      runtime.db.prepare(
        `INSERT OR IGNORE INTO source_imports (id, source_type, source_hash, byte_size)
         VALUES (99, 'daily_dump', 'hash-slice-dates', 500)`
      ).run();

      // Seed real slices on 2026-02-10 and 2026-02-15
      runtime.db.prepare(
        `INSERT OR REPLACE INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, source_import_id)
         VALUES (9910, '2026-02-10', 501, 'src/slice1.ts', 'file', 3600, 99)`
      ).run();
      runtime.db.prepare(
        `INSERT OR REPLACE INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, source_import_id)
         VALUES (9911, '2026-02-15', 501, 'src/slice2.ts', 'file', 7200, 99)`
      ).run();

      // Seed newer daily_totals days that have NO slices (e.g. 2026-08-01 through 2026-08-10)
      for (let day = 1; day <= 10; day++) {
        const d = `2026-08-${String(day).padStart(2, '0')}`;
        runtime.db.prepare(
          `INSERT OR REPLACE INTO daily_totals (date, total_seconds, grand_total_json, source_import_id, source_hash)
           VALUES (?, 0, '{}', 99, 'hash-empty-days')`
        ).run(d);
      }

      const { event } = createAuthenticatedEvent({ url: 'http://localhost:3002/admin/classify' });
      const data: any = await load(event);

      // Even though daily_totals has 10 newer empty days, recentSlices must be loaded from slice-bearing dates
      expect(data.recentSlices.length).toBeGreaterThanOrEqual(2);
      const datesWithSlices = new Set(data.recentSlices.map((s: any) => s.date));
      expect(datesWithSlices.has('2026-02-15')).toBe(true);
      expect(datesWithSlices.has('2026-02-10')).toBe(true);
    });
  });

  describe('Requirement: Full Update Rule Workflow & UI Integration', () => {
    it('executes rule update workflow through previewRule, surfaces work↔personal shift, and confirms with exact digest', async () => {
      // 1. Seed project and slice
      runtime.db.prepare(`INSERT OR IGNORE INTO projects (id, name) VALUES (601, 'update-shift-proj')`).run();
      runtime.db.prepare(
        `INSERT OR IGNORE INTO source_imports (id, source_type, source_hash, byte_size)
         VALUES (99, 'daily_dump', 'hash-update-test', 500)`
      ).run();
      runtime.db.prepare(
        `INSERT OR REPLACE INTO day_project_entity_slices (id, date, project_id, entity, entity_type, total_seconds, source_import_id)
         VALUES (9920, '2026-03-20', 601, 'src/service.ts', 'file', 4800, 99)`
      ).run();

      // 2. Create initial rule: project is WORK
      const seedPrev = runtime.classification.previewRuleChange({
        type: 'create',
        rule: {
          name: 'Update Target Rule',
          classification: 'work',
          selectorType: 'project',
          selectorValue: 'update-shift-proj',
          priority: 5
        }
      });
      const { rule: createdRule } = runtime.classification.createRule(
        {
          name: 'Update Target Rule',
          classification: 'work',
          selectorType: 'project',
          selectorValue: 'update-shift-proj',
          priority: 5
        },
        { expectedDigest: seedPrev.previewDigest, actor: 'admin' }
      );

      // Verify slice starts as work
      const beforeSlices = runtime.classification.classifySlices({ date: '2026-03-20' });
      expect(beforeSlices[0].decision.classification).toBe('work');

      // 3. Preview updating the rule from WORK to PERSONAL
      const updateFormData = new FormData();
      updateFormData.set('type', 'update');
      updateFormData.set('id', createdRule.id);
      updateFormData.set('name', 'Updated Rule Name');
      updateFormData.set('classification', 'personal'); // FLIP TO PERSONAL
      updateFormData.set('priority', '30');

      const { event: updatePrevEvt } = createAuthenticatedEvent({ formData: updateFormData });
      const updatePrevRes = await (actions.previewRule as any)(updatePrevEvt);

      expect(updatePrevRes.success).toBe(true);
      expect(updatePrevRes.proposal.type).toBe('update');
      expect(updatePrevRes.proposal.id).toBe(createdRule.id);
      expect(updatePrevRes.preview).toBeDefined();

      // Surfacing visible work↔personal shifted seconds
      expect(updatePrevRes.preview.shiftedSeconds.workToPersonal).toBe(4800);
      expect(updatePrevRes.preview.affectedSliceCount).toBe(1);
      expect(updatePrevRes.preview.affectedDates).toEqual(['2026-03-20']);

      // 4. Confirm update
      const confirmUpdateFormData = new FormData();
      confirmUpdateFormData.set('previewDigest', updatePrevRes.preview.previewDigest);
      confirmUpdateFormData.set('previewRevision', String(updatePrevRes.preview.previewRevision));
      confirmUpdateFormData.set('proposal', JSON.stringify(updatePrevRes.proposal));

      const { event: confirmUpdateEvt } = createAuthenticatedEvent({ formData: confirmUpdateFormData });
      const confirmUpdateRes = await (actions.confirmRule as any)(confirmUpdateEvt);

      expect(confirmUpdateRes.success).toBe(true);
      expect(confirmUpdateRes.confirmed).toBe(true);
      expect(confirmUpdateRes.result.rule.name).toBe('Updated Rule Name');
      expect(confirmUpdateRes.result.rule.classification).toBe('personal');
      expect(confirmUpdateRes.result.rule.priority).toBe(30);

      // Verify slice now evaluates to personal
      const afterSlices = runtime.classification.classifySlices({ date: '2026-03-20' });
      expect(afterSlices[0].decision.classification).toBe('personal');

      // Verify audit revision logged
      const revisions = runtime.classification.getRevisions(10);
      expect(
        revisions.some((rev) => rev.target_id === createdRule.id && rev.mutation_type === 'rule_updated')
      ).toBe(true);
    });

    it('verifies update rule workflow integration in +page.svelte', () => {
      const svelteSrc = loadClassifySvelte();

      // Verify Edit button and modal bindings
      expect(svelteSrc).toContain('openEditRule');
      expect(svelteSrc).toContain('editRuleModalOpen');
      expect(svelteSrc).toContain('Edit Classification Rule');
      expect(svelteSrc).toContain('action="?/previewRule"');

      // Verify update action handling in modal
      expect(svelteSrc).toContain('value="update"');
      expect(svelteSrc).toContain('proposal.type === \'update\'');
      expect(svelteSrc).toContain('shiftedSeconds.workToPersonal');
      expect(svelteSrc).toContain('shiftedSeconds.personalToWork');
    });

    it('verifies +page.svelte respects SvelteKit server-only boundary with no runtime $lib/server imports', () => {
      const svelteSrc = loadClassifySvelte();

      // Find all imports from $lib/server that are not type-only
      const serverImportRegex = /import\s+(?:(?!(?:type\s+))[^;]+)\s+from\s+['"]\$lib\/server[^'"]*['"]/g;
      const matches = [...svelteSrc.matchAll(serverImportRegex)];
      expect(matches).toHaveLength(0);

      // Verify SelectorType is imported as a type only
      expect(svelteSrc).toMatch(/import\s+type\s+\{[^}]*SelectorType[^}]*\}\s+from\s+['"]\$lib\/server\/classification\/model['"]/);
      expect(svelteSrc).not.toMatch(/import\s+\{[^}]*SELECTOR_TYPES[^}]*\}\s+from\s+['"]\$lib\/server/);

      // Verify all seven selector types are defined in ALL_SELECTOR_TYPES
      expect(svelteSrc).toContain('ALL_SELECTOR_TYPES');
      for (const selector of ['machine', 'editor', 'application', 'domain', 'project', 'folder_prefix', 'entity']) {
        expect(svelteSrc).toContain(`'${selector}'`);
      }
    });

    it('verifies view state and selector filter persistence via progressive enhancement and hidden fields', async () => {
      const svelteSrc = loadClassifySvelte();

      // Verify enhance and state imports
      expect(svelteSrc).toContain("import { enhance } from '$app/forms'");
      expect(svelteSrc).toContain("import { page } from '$app/state'");
      expect(svelteSrc).toContain('preserveStateEnhance');

      // Verify forms use progressive enhancement
      expect(svelteSrc).toContain('use:enhance={preserveStateEnhance}');
      expect(svelteSrc).toContain('name="returnSelector"');
      expect(svelteSrc).toContain('name="returnTab"');

      // Verify server actions handle and echo returnTab and returnSelector
      const formData = new FormData();
      formData.set('type', 'create');
      formData.set('name', 'Personal Antigravity');
      formData.set('selectorType', 'editor');
      formData.set('selectorValue', 'Antigravity');
      formData.set('classification', 'personal');
      formData.set('returnTab', 'suggestions');
      formData.set('returnSelector', 'editor');

      const { event } = createAuthenticatedEvent({ formData });
      const previewRes = await (actions.previewRule as any)(event);
      expect(previewRes.success).toBe(true);
      expect(previewRes.returnTab).toBe('suggestions');
      // Verify selector filter buttons display unclassified candidate counts rather than hardcoded specificity rank numbers
      expect(svelteSrc).toContain('candidateCounts');
      expect(svelteSrc).toContain('Machine ({candidateCounts.machine})');
      expect(svelteSrc).toContain('Editor ({candidateCounts.editor})');
      expect(svelteSrc).toContain('Project ({candidateCounts.project})');
      expect(svelteSrc).not.toContain('Machine (10)');
      expect(svelteSrc).not.toContain('Project (40)');

      // A friendly label must never be submitted in place of the canonical
      // identity when an existing rule is edited.
      expect(svelteSrc).toContain('editRuleSelectorValue = rule.selector_value');
      expect(svelteSrc).not.toContain('editRuleSelectorValue = rule.display_value');
    });
  });
});
