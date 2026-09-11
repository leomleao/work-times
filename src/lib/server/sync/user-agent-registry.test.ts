import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDatabase } from '../db/connection.js';
import { SqliteSyncRepository } from './repository.js';
import { SqliteClassificationService } from '../classification/sqlite.js';
import {
  MAX_REGISTRY_BYTES,
  MAX_REGISTRY_PAGES,
  MAX_REGISTRY_ROWS,
  RegistryRefreshError,
  extractAllowlistedRegistryEntry,
  refreshUserAgentRegistry,
  type RegistryClient,
  type SyncRegistryRepository
} from './user-agent-registry.js';
import { RECONCILE_CODES } from './contracts.js';
import { REGISTRY_PAGINATION_RAW } from './fixtures/index.js';
import type { UserAgentsResponse } from '../wakatime/schemas.js';

describe('User-Agent Registry P4 Execution and Verification', () => {
  let db: Database.Database;
  let repo: SqliteSyncRepository;
  let classification: SqliteClassificationService;

  beforeEach(() => {
    db = openTestDatabase();
    db.prepare(`INSERT OR IGNORE INTO projects (id, name, is_unattributed) VALUES (101, 'proj-1', 0)`).run();
    db.prepare(
      `INSERT OR IGNORE INTO source_imports (id, source_type, source_hash, byte_size)
       VALUES (1, 'daily_dump', 'h1', 100)`
    ).run();
    repo = new SqliteSyncRepository(db);
    classification = new SqliteClassificationService(db);
  });

  afterEach(() => {
    db.close();
  });

  // ==========================================================================
  // 1. Atomicity & Final-Page Failure
  // ==========================================================================
  describe('Atomicity and Rollback on Failure', () => {
    it('publishes all pages atomically in one transaction when all pages succeed', async () => {
      const client: RegistryClient = {
        async getUserAgents(opts) {
          const page = typeof opts === 'number' ? opts : opts?.page ?? 1;
          if (page === 1) {
            return {
              page: 1,
              total: 3,
              total_pages: 2,
              next_page: 2,
              prev_page: null,
              data: [
                {
                  id: '990e8400-e29b-41d4-a716-446655440001',
                  value: 'vscode/1.90.0',
                  editor: 'VS Code',
                  os: 'Mac'
                },
                {
                  id: '990e8400-e29b-41d4-a716-446655440002',
                  value: 'cursor/0.40.0',
                  editor: 'Cursor',
                  os: 'Mac'
                }
              ]
            };
          }
          return {
            page: 2,
            total: 3,
            total_pages: 2,
            next_page: null,
            prev_page: 1,
            data: [
              {
                id: '990e8400-e29b-41d4-a716-446655440003',
                value: 'sublime/4169',
                editor: 'Sublime Text',
                os: 'Linux'
              }
            ]
          };
        }
      };

      const result = await refreshUserAgentRegistry({
        client,
        repository: repo,
        classificationService: classification
      });

      expect(result.publishedCount).toBe(3);
      expect(result.historicalCount).toBe(0);
      expect(result.pageCount).toBe(2);
      expect(result.rowCount).toBe(3);

      const all = repo.listRegistryEntries();
      expect(all).toHaveLength(3);

      // Staging table must be empty after commit
      const stagingCount = (
        db.prepare(`SELECT COUNT(*) as c FROM user_agent_registry_staging`).get() as { c: number }
      ).c;
      expect(stagingCount).toBe(0);
    });

    it('retains previous registry unchanged when failure occurs on the final page', async () => {
      // 1. Initial successful state in published registry
      repo.stageRegistryEntries([
        {
          id: 'initial-uuid-1',
          editor: 'Emacs',
          userAgentValue: 'emacs/29',
          os: 'Linux'
        }
      ]);
      repo.publishRegistryStaging();
      expect(repo.listRegistryEntries()).toHaveLength(1);

      // 2. Multi-page refresh where page 2 fails
      const client: RegistryClient = {
        async getUserAgents(opts) {
          const page = typeof opts === 'number' ? opts : opts?.page ?? 1;
          if (page === 1) {
            return {
              page: 1,
              total: 2,
              total_pages: 2,
              next_page: 2,
              data: [
                {
                  id: 'page1-uuid',
                  value: 'vscode/1.91',
                  editor: 'VS Code',
                  os: 'Mac'
                }
              ]
            };
          }
          throw new Error('500 Internal Server Error on final page');
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toThrow('500 Internal Server Error on final page');

      // Previous registry MUST be untouched
      const entries = repo.listRegistryEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('initial-uuid-1');

      // Staging table must be cleared
      const stagingCount = (
        db.prepare(`SELECT COUNT(*) as c FROM user_agent_registry_staging`).get() as { c: number }
      ).c;
      expect(stagingCount).toBe(0);
    });
  });

  // ==========================================================================
  // 2. Bounds (Max 100 pages, 10,000 rows, 16 MiB payload)
  // ==========================================================================
  describe('Bounds Enforcement', () => {
    it('rejects total_pages > 100 with REGISTRY_PAGE_LIMIT_EXCEEDED and preserves registry', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 1010,
            total_pages: 101, // Exceeds 100 pages limit!
            next_page: 2,
            data: [
              {
                id: 'uuid-1',
                value: 'v/1.0',
                editor: 'Ed',
                os: 'Linux'
              }
            ]
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_PAGE_LIMIT_EXCEEDED
      });

      expect(repo.listRegistryEntries()).toHaveLength(0);
    });

    it('rejects accumulated rows > 10,000 with REGISTRY_ROW_LIMIT_EXCEEDED', async () => {
      const manyRows = Array.from({ length: 10_001 }, (_, i) => ({
        id: `uuid-${i}`,
        value: `ua-${i}`,
        editor: `Editor-${i}`,
        os: 'Linux'
      }));

      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 10_001,
            total_pages: 1,
            next_page: null,
            data: manyRows
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_ROW_LIMIT_EXCEEDED
      });

      expect(repo.listRegistryEntries()).toHaveLength(0);
    });

    it('rejects total bytes > 16 MiB with REGISTRY_BYTE_LIMIT_EXCEEDED', async () => {
      // 17 MiB payload string
      const hugeString = 'x'.repeat(17 * 1024 * 1024);
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 1,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: 'uuid-huge',
                value: hugeString,
                editor: 'Huge',
                os: 'Linux'
              }
            ]
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_BYTE_LIMIT_EXCEEDED
      });

      expect(repo.listRegistryEntries()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 3. Privacy & Allowlisted Attributes
  // ==========================================================================
  describe('Privacy Scrubbing and Allowlist Persistence', () => {
    it('persists only allowlisted attributes and keeps refresh timestamp separate from source dates', async () => {
      const sourceFirstSeen = '2025-01-10T08:00:00Z';
      const sourceLastSeen = '2026-06-15T12:00:00Z';
      const refreshTimestamp = '2026-09-11T20:00:00.000Z';

      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 1,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: '990e8400-e29b-41d4-a716-446655440001',
                value: 'vscode/1.90.0',
                editor: 'VS Code',
                os: 'Mac',
                version: '1.90.0',
                ai_model: 'claude-3-5-sonnet',
                ai_model_version: '20241022',
                ai_model_complexity: 'high',
                is_browser_extension: false,
                is_desktop_app: true,
                created_at: sourceFirstSeen,
                last_seen_at: sourceLastSeen,
                // Extra non-allowlisted / sensitive fields:
                ip: '10.0.0.123',
                email: 'developer@example.com',
                user_id: 'usr_secret_456',
                machine_name: 'private-dev-mac',
                internal_token: 'secret_abc_123',
                untrusted_metadata: { pass: 'xyz' }
              }
            ]
          };
        }
      };

      await refreshUserAgentRegistry({
        client,
        repository: repo,
        classificationService: classification,
        now: () => refreshTimestamp
      });

      const entry = repo.getRegistryEntry('990e8400-e29b-41d4-a716-446655440001');
      expect(entry).not.toBeNull();
      expect(entry?.editor).toBe('VS Code');
      expect(entry?.userAgentValue).toBe('vscode/1.90.0');
      expect(entry?.os).toBe('Mac');
      expect(entry?.version).toBe('1.90.0');
      expect(entry?.aiModel).toBe('claude-3-5-sonnet');
      expect(entry?.aiModelVersion).toBe('20241022');
      expect(entry?.aiModelComplexity).toBe('high');
      expect(entry?.isBrowserExtension).toBe(false);
      expect(entry?.isDesktopApp).toBe(true);
      expect(entry?.firstSeenAt).toBe(sourceFirstSeen);
      expect(entry?.lastSeenAt).toBe(sourceLastSeen);
      expect(entry?.refreshedAt).toBe(refreshTimestamp);

      // Verify raw database row has NO unexpected columns or private data
      const rawRow = db
        .prepare(`SELECT * FROM user_agent_registry WHERE id = '990e8400-e29b-41d4-a716-446655440001'`)
        .get() as Record<string, unknown>;

      expect(rawRow.ip).toBeUndefined();
      expect(rawRow.email).toBeUndefined();
      expect(rawRow.user_id).toBeUndefined();
      expect(rawRow.machine_name).toBeUndefined();
      expect(rawRow.internal_token).toBeUndefined();
      expect(rawRow.untrusted_metadata).toBeUndefined();
    });
  });

  // ==========================================================================
  // 4. Historical Retention
  // ==========================================================================
  describe('Historical Retention', () => {
    it('retains absent historical UUID mappings with is_historical = 1', async () => {
      // 1. First refresh: publishes uuid-old and uuid-surviving
      const client1: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 2,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: 'uuid-old',
                value: 'sublime/3',
                editor: 'Sublime Text',
                os: 'Linux'
              },
              {
                id: 'uuid-surviving',
                value: 'vscode/1.90',
                editor: 'VS Code',
                os: 'Mac'
              }
            ]
          };
        }
      };

      const res1 = await refreshUserAgentRegistry({
        client: client1,
        repository: repo,
        classificationService: classification
      });
      expect(res1.publishedCount).toBe(2);
      expect(res1.historicalCount).toBe(0);

      // 2. Second refresh: omits uuid-old and introduces uuid-new
      const client2: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 2,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: 'uuid-surviving',
                value: 'vscode/1.91',
                editor: 'VS Code',
                os: 'Mac'
              },
              {
                id: 'uuid-new',
                value: 'cursor/0.40',
                editor: 'Cursor',
                os: 'Mac'
              }
            ]
          };
        }
      };

      const res2 = await refreshUserAgentRegistry({
        client: client2,
        repository: repo,
        classificationService: classification
      });
      expect(res2.publishedCount).toBe(2);
      expect(res2.historicalCount).toBe(1);

      // uuid-old must be marked historical
      const oldEntry = repo.getRegistryEntry('uuid-old');
      expect(oldEntry?.isHistorical).toBe(true);

      const survivingEntry = repo.getRegistryEntry('uuid-surviving');
      expect(survivingEntry?.isHistorical).toBe(false);

      const newEntry = repo.getRegistryEntry('uuid-new');
      expect(newEntry?.isHistorical).toBe(false);

      // Historical mappings remain resolvable through classification service
      expect(classification.resolveEditorName('uuid-old')).toBe('Sublime Text (uuid-old)');
      expect(classification.resolveEditorName('uuid-surviving')).toBe('VS Code (uuid-sur)');
      expect(classification.resolveEditorName('uuid-new')).toBe('Cursor (uuid-new)');
    });
  });

  // ==========================================================================
  // 5. Unknown Fallback & Registry Only Resolution
  // ==========================================================================
  describe('Unknown Fallback and Registry Display Resolution', () => {
    it('resolves unknown UUID to Unresolved editor plus UUID and never guesses from daily totals', () => {
      // Insert aggregate daily dimensions for editor
      db.prepare(`
        INSERT INTO daily_dimension_totals
        (date, scope, dimension, name, total_seconds, human_additions, human_deletions, ai_additions, ai_deletions, ai_sessions, source_import_id)
        VALUES ('2026-06-15', 'account', 'editor', 'IntelliJ IDEA', 5000, 0, 0, 0, 0, 0, 1)
      `).run();

      // An unmapped UUID must not guess 'IntelliJ IDEA'
      const display = classification.resolveEditorName('unknown-uuid-777');
      expect(display).toBe('Unresolved editor (unknown-uuid-777)');

      // Once mapped in user_agent_registry, it resolves authoritatively
      db.prepare(`
        INSERT INTO user_agent_registry (id, editor, user_agent_value, os, is_historical)
        VALUES ('unknown-uuid-777', 'PyCharm', 'pycharm/2024.1', 'Mac', 0)
      `).run();
      classification.invalidateIdentityCaches();

      expect(classification.resolveEditorName('unknown-uuid-777')).toBe('PyCharm (unknown-)');
    });
  });

  // ==========================================================================
  // 6. Cache Invalidation After Commit
  // ==========================================================================
  describe('Cache Invalidation Integration', () => {
    it('correctly invalidates both machine and editor caches after commit', async () => {
      // 1. Seed initial machine dimension and cache it
      db.prepare(`
        INSERT INTO daily_dimension_totals
        (date, scope, dimension, name, machine_name_id, total_seconds, human_additions, human_deletions, ai_additions, ai_deletions, ai_sessions, source_import_id)
        VALUES ('2026-06-15', 'account', 'machine', 'WorkMac', 'mach-1', 100, 0, 0, 0, 0, 0, 1)
      `).run();

      expect(classification.resolveMachineName('mach-1')).toBe('WorkMac');
      expect(classification.resolveEditorName('uuid-editor-1')).toBe('Unresolved editor (uuid-editor-1)');

      // 2. Perform a registry refresh that introduces uuid-editor-1
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 1,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: 'uuid-editor-1',
                value: 'zed/0.140',
                editor: 'Zed',
                os: 'Mac'
              }
            ]
          };
        }
      };

      await refreshUserAgentRegistry({
        client,
        repository: repo,
        classificationService: classification
      });

      // Classification cache was invalidated automatically upon commit
      expect(classification.resolveEditorName('uuid-editor-1')).toBe('Zed (uuid-edi)');

      // Explicit clearCaches clears both maps
      classification.clearCaches();
      expect(classification.resolveEditorName('uuid-editor-1')).toBe('Zed (uuid-edi)');
      expect(classification.resolveMachineName('mach-1')).toBe('WorkMac');
    });
  });

  // ==========================================================================
  // 7. Classification Stability Across Label Refreshes
  // ==========================================================================
  describe('Classification Stability', () => {
    it('ensures refreshing editor labels never alters UUID selectors or work/personal classifications', async () => {
      const editorUuid = '990e8400-e29b-41d4-a716-446655440001';

      // 1. Initial registry with editor name 'VS Code'
      repo.stageRegistryEntries([
        {
          id: editorUuid,
          editor: 'VS Code',
          userAgentValue: 'vscode/1.90.0',
          os: 'Mac'
        }
      ]);
      repo.publishRegistryStaging();

      // 2. Create an editor classification rule matching by UUID
      db.prepare(`
        INSERT INTO classification_rules (
          id, name, classification, selector_type, selector_value, match_mode, priority, enabled
        ) VALUES (
          'rule-editor-work', 'VS Code on Work Mac', 'work', 'editor', ?, 'exact', 10, 1
        )
      `).run(editorUuid);

      // 3. Create a day slice and heartbeat with this user_agent_id
      db.prepare(`
        INSERT INTO day_project_entity_slices (
          id, date, project_id, entity, entity_type, kind, total_seconds, is_unattributed, source_import_id
        ) VALUES (
          101, '2026-06-15', 101, 'src/index.ts', 'file', 'entity', 300, 0, 1
        )
      `).run();

      db.prepare(`
        INSERT INTO heartbeats (
          id, external_id, occurred_at_us, occurred_at, local_date, project_id, entity, entity_type, category, user_agent_id, source_import_id, canonical_hash
        ) VALUES (
          5001, 'hb-uuid-1', 1700000000000000, '2026-06-15T12:00:00Z', '2026-06-15', 101, 'src/index.ts', 'file', 'coding', ?, 1, 'hash-hb-1'
        )
      `).run(editorUuid);

      db.prepare(`
        INSERT INTO slice_identities (slice_id, selector_type, value)
        VALUES (101, 'editor', ?)
      `).run(editorUuid);

      db.prepare(`
        INSERT INTO sync_layer_state (
          date, layer, evidence_matches_summary, is_stale, has_failure, has_restriction, unresolved_mismatch, has_detail_downgrade
        ) VALUES (
          '2026-06-15', 'heartbeats', 1, 0, 0, 0, 0, 0
        )
      `).run();

      db.prepare(`
        INSERT INTO heartbeat_memberships (heartbeat_id, date, active)
        VALUES (5001, '2026-06-15', 1)
      `).run();

      // Classify slice before label change
      const evaluatedBefore = classification.classifySlices({ date: '2026-06-15' });
      expect(evaluatedBefore).toHaveLength(1);
      expect(evaluatedBefore[0].decision.classification).toBe('work');
      expect(evaluatedBefore[0].decision.winningRuleId).toBe('rule-editor-work');

      // Rule display value shows friendly label
      const ruleBefore = classification.getRule('rule-editor-work');
      expect(ruleBefore?.selector_value).toBe(editorUuid);
      expect(ruleBefore?.display_value).toBe('VS Code (990e8400)');

      // 4. Upstream refresh changes friendly label to 'Visual Studio Code Insiders'
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 1,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: editorUuid,
                value: 'vscode-insiders/1.91.0',
                editor: 'Visual Studio Code Insiders',
                os: 'Mac'
              }
            ]
          };
        }
      };

      await refreshUserAgentRegistry({
        client,
        repository: repo,
        classificationService: classification
      });

      // 5. Evaluate classification after label refresh
      const evaluatedAfter = classification.classifySlices({ date: '2026-06-15' });
      expect(evaluatedAfter).toHaveLength(1);
      // Classification MUST remain identical ('work')
      expect(evaluatedAfter[0].decision.classification).toBe('work');
      expect(evaluatedAfter[0].decision.winningRuleId).toBe('rule-editor-work');

      // Selector value in rule remains unchanged UUID
      const ruleAfter = classification.getRule('rule-editor-work');
      expect(ruleAfter?.selector_value).toBe(editorUuid);
      // Display value updated to new friendly label
      expect(ruleAfter?.display_value).toBe('Visual Studio Code Insiders (990e8400)');
    });
  });

  // ==========================================================================
  // 8. Pagination Anomalies: Repetition, Conflict, Invalid Envelopes
  // ==========================================================================
  describe('Pagination Anomalies and Contract Fixtures', () => {
    it('detects page repetition loop with REGISTRY_PAGE_REPETITION and leaves registry unchanged', async () => {
      let callCount = 0;
      const client: RegistryClient = {
        async getUserAgents() {
          callCount++;
          if (callCount === 1) {
            return REGISTRY_PAGINATION_RAW.repetitionPage1 as unknown as UserAgentsResponse;
          }
          return REGISTRY_PAGINATION_RAW.repetitionPage2 as unknown as UserAgentsResponse;
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_PAGE_REPETITION
      });

      expect(repo.listRegistryEntries()).toHaveLength(0);
      const stagingCount = (
        db.prepare(`SELECT COUNT(*) as c FROM user_agent_registry_staging`).get() as { c: number }
      ).c;
      expect(stagingCount).toBe(0);
    });

    it('detects duplicate conflicting UUID attributes across pages with REGISTRY_CONFLICTING_ID', async () => {
      let callCount = 0;
      const client: RegistryClient = {
        async getUserAgents() {
          callCount++;
          if (callCount === 1) {
            return REGISTRY_PAGINATION_RAW.repetitionPage1 as unknown as UserAgentsResponse;
          }
          return REGISTRY_PAGINATION_RAW.conflictingPage2 as unknown as UserAgentsResponse;
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_CONFLICTING_ID
      });

      expect(repo.listRegistryEntries()).toHaveLength(0);
    });

    it('detects inconsistent pagination numbers with REGISTRY_INVALID_PAGINATION', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return REGISTRY_PAGINATION_RAW.invalidPaginationNumbers as unknown as UserAgentsResponse;
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_INVALID_PAGINATION
      });

      expect(repo.listRegistryEntries()).toHaveLength(0);
    });

    it('aborts on cancellation signal with RUN_CANCELLED and leaves registry unchanged', async () => {
      const abortController = new AbortController();

      const client: RegistryClient = {
        async getUserAgents() {
          abortController.abort();
          return {
            page: 1,
            total: 1,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: 'uuid-cancelled',
                value: 'val',
                editor: 'Ed',
                os: 'Mac'
              }
            ]
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification,
          signal: abortController.signal
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.RUN_CANCELLED
      });

      expect(repo.listRegistryEntries()).toHaveLength(0);
    });

    it('rejects stale connection generation with STALE_CONNECTION_GENERATION and leaves registry unchanged', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 1,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: 'uuid-1',
                value: 'val',
                editor: 'Ed',
                os: 'Mac'
              }
            ]
          };
        }
      };

      // Current connection generation in repo is 1; expected is 99
      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification,
          expectedConnectionGeneration: 99
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.STALE_CONNECTION_GENERATION
      });

      expect(repo.listRegistryEntries()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 9. Strict Boolean Flags Validation
  // ==========================================================================
  describe('Strict Boolean Flags Validation', () => {
    it('rejects malformed string "false" for is_browser_extension with REGISTRY_INVALID_PAGINATION', () => {
      expect(() => {
        extractAllowlistedRegistryEntry(
          {
            id: 'uuid-bool-1',
            editor: 'VS Code',
            is_browser_extension: 'false'
          },
          '2026-09-11T20:00:00Z'
        );
      }).toThrowError(
        expect.objectContaining({
          code: RECONCILE_CODES.REGISTRY_INVALID_PAGINATION
        })
      );
    });

    it('rejects malformed string "true" for is_desktop_app with REGISTRY_INVALID_PAGINATION', () => {
      expect(() => {
        extractAllowlistedRegistryEntry(
          {
            id: 'uuid-bool-2',
            editor: 'VS Code',
            is_desktop_app: 'true'
          },
          '2026-09-11T20:00:00Z'
        );
      }).toThrowError(
        expect.objectContaining({
          code: RECONCILE_CODES.REGISTRY_INVALID_PAGINATION
        })
      );
    });

    it('rejects numbers like 1 or 0 for flags with REGISTRY_INVALID_PAGINATION', () => {
      expect(() => {
        extractAllowlistedRegistryEntry(
          {
            id: 'uuid-bool-3',
            editor: 'VS Code',
            is_browser_extension: 1
          },
          '2026-09-11T20:00:00Z'
        );
      }).toThrowError(
        expect.objectContaining({
          code: RECONCILE_CODES.REGISTRY_INVALID_PAGINATION
        })
      );

      expect(() => {
        extractAllowlistedRegistryEntry(
          {
            id: 'uuid-bool-4',
            editor: 'VS Code',
            is_desktop_app: 0
          },
          '2026-09-11T20:00:00Z'
        );
      }).toThrowError(
        expect.objectContaining({
          code: RECONCILE_CODES.REGISTRY_INVALID_PAGINATION
        })
      );
    });

    it('treats absent flags (undefined or null) as false', () => {
      const entry1 = extractAllowlistedRegistryEntry(
        {
          id: 'uuid-bool-5',
          editor: 'VS Code'
        },
        '2026-09-11T20:00:00Z'
      );
      expect(entry1.isBrowserExtension).toBe(false);
      expect(entry1.isDesktopApp).toBe(false);

      const entry2 = extractAllowlistedRegistryEntry(
        {
          id: 'uuid-bool-6',
          editor: 'VS Code',
          is_browser_extension: null,
          is_desktop_app: null
        },
        '2026-09-11T20:00:00Z'
      );
      expect(entry2.isBrowserExtension).toBe(false);
      expect(entry2.isDesktopApp).toBe(false);
    });

    it('accepts valid boolean values', () => {
      const entry = extractAllowlistedRegistryEntry(
        {
          id: 'uuid-bool-7',
          editor: 'VS Code',
          is_browser_extension: true,
          is_desktop_app: false
        },
        '2026-09-11T20:00:00Z'
      );
      expect(entry.isBrowserExtension).toBe(true);
      expect(entry.isDesktopApp).toBe(false);
    });
  });

  // ==========================================================================
  // 10. Comprehensive Duplicate-ID Conflict Detection
  // ==========================================================================
  describe('Comprehensive Duplicate-ID Conflict Detection', () => {
    it('detects duplicate conflict on version attribute', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 2,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: 'uuid-dup-test',
                value: 'ed/1',
                editor: 'Ed',
                os: 'Mac',
                version: '1.0.0'
              },
              {
                id: 'uuid-dup-test',
                value: 'ed/1',
                editor: 'Ed',
                os: 'Mac',
                version: '2.0.0'
              }
            ]
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_CONFLICTING_ID
      });
    });

    it('detects duplicate conflict on aiModel attribute', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 2,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: 'uuid-dup-model',
                value: 'ed/1',
                editor: 'Ed',
                os: 'Mac',
                ai_model: 'claude-3-5-sonnet'
              },
              {
                id: 'uuid-dup-model',
                value: 'ed/1',
                editor: 'Ed',
                os: 'Mac',
                ai_model: 'gpt-4o'
              }
            ]
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_CONFLICTING_ID
      });
    });

    it('detects duplicate conflict on aiModelVersion attribute', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 2,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: 'uuid-dup-mv',
                value: 'ed/1',
                editor: 'Ed',
                os: 'Mac',
                ai_model_version: '20241022'
              },
              {
                id: 'uuid-dup-mv',
                value: 'ed/1',
                editor: 'Ed',
                os: 'Mac',
                ai_model_version: '20241101'
              }
            ]
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_CONFLICTING_ID
      });
    });

    it('detects duplicate conflict on aiModelComplexity attribute', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 2,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: 'uuid-dup-mc',
                value: 'ed/1',
                editor: 'Ed',
                os: 'Mac',
                ai_model_complexity: 'low'
              },
              {
                id: 'uuid-dup-mc',
                value: 'ed/1',
                editor: 'Ed',
                os: 'Mac',
                ai_model_complexity: 'high'
              }
            ]
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_CONFLICTING_ID
      });
    });

    it('detects duplicate conflict on isBrowserExtension attribute', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 2,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: 'uuid-dup-ext',
                value: 'ed/1',
                editor: 'Ed',
                os: 'Mac',
                is_browser_extension: false
              },
              {
                id: 'uuid-dup-ext',
                value: 'ed/1',
                editor: 'Ed',
                os: 'Mac',
                is_browser_extension: true
              }
            ]
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_CONFLICTING_ID
      });
    });

    it('detects duplicate conflict on isDesktopApp attribute', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 2,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: 'uuid-dup-app',
                value: 'ed/1',
                editor: 'Ed',
                os: 'Mac',
                is_desktop_app: false
              },
              {
                id: 'uuid-dup-app',
                value: 'ed/1',
                editor: 'Ed',
                os: 'Mac',
                is_desktop_app: true
              }
            ]
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_CONFLICTING_ID
      });
    });

    it('merges source timestamps when non-timestamp identity attributes are identical', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 2,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: 'uuid-merge',
                value: 'vscode/1.90',
                editor: 'VS Code',
                os: 'Mac',
                version: '1.90',
                ai_model: 'claude-3.5',
                ai_model_version: 'v1',
                ai_model_complexity: 'medium',
                is_browser_extension: false,
                is_desktop_app: true,
                created_at: '2026-03-01T00:00:00Z',
                last_seen_at: '2026-05-01T00:00:00Z'
              },
              {
                id: 'uuid-merge',
                value: 'vscode/1.90',
                editor: 'VS Code',
                os: 'Mac',
                version: '1.90',
                ai_model: 'claude-3.5',
                ai_model_version: 'v1',
                ai_model_complexity: 'medium',
                is_browser_extension: false,
                is_desktop_app: true,
                created_at: '2026-01-01T00:00:00Z',
                last_seen_at: '2026-07-01T00:00:00Z'
              }
            ]
          };
        }
      };

      const result = await refreshUserAgentRegistry({
        client,
        repository: repo,
        classificationService: classification
      });

      expect(result.publishedCount).toBe(1);
      const entry = repo.getRegistryEntry('uuid-merge');
      expect(entry?.firstSeenAt).toBe('2026-01-01T00:00:00Z');
      expect(entry?.lastSeenAt).toBe('2026-07-01T00:00:00Z');
    });
  });

  // ==========================================================================
  // 11. Pagination Finite Safe Integer Envelope Validation
  // ==========================================================================
  describe('Pagination Finite Safe Integer Envelope Validation', () => {
    it('rejects fractional page number with REGISTRY_INVALID_PAGINATION', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1.5 as unknown as number,
            total: 10,
            total_pages: 1,
            next_page: null,
            data: []
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_INVALID_PAGINATION
      });
    });

    it('rejects NaN page number with REGISTRY_INVALID_PAGINATION', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: NaN,
            total: 10,
            total_pages: 1,
            next_page: null,
            data: []
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_INVALID_PAGINATION
      });
    });

    it('rejects fractional total_pages with REGISTRY_INVALID_PAGINATION', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 10,
            total_pages: 2.5 as unknown as number,
            next_page: null,
            data: []
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_INVALID_PAGINATION
      });
    });

    it('rejects fractional total with REGISTRY_INVALID_PAGINATION', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 10.7 as unknown as number,
            total_pages: 1,
            next_page: null,
            data: []
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_INVALID_PAGINATION
      });
    });

    it('rejects fractional next_page with REGISTRY_INVALID_PAGINATION', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: 10,
            total_pages: 2,
            next_page: 2.5 as unknown as number,
            data: [
              {
                id: 'uuid-next',
                value: 'ed/1',
                editor: 'Ed',
                os: 'Mac'
              }
            ]
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_INVALID_PAGINATION
      });
    });

    it('rejects unsafe integer values beyond MAX_SAFE_INTEGER', async () => {
      const client: RegistryClient = {
        async getUserAgents() {
          return {
            page: 1,
            total: Number.MAX_SAFE_INTEGER + 10,
            total_pages: 1,
            next_page: null,
            data: []
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: repo,
          classificationService: classification
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.REGISTRY_INVALID_PAGINATION
      });
    });
  });

  // ==========================================================================
  // 12. Stale-Generation CAS Publication Atomicity (Fake Repository)
  // ==========================================================================
  describe('Stale-Generation CAS Publication Atomicity (Fake Repository)', () => {
    it('rejects publication when connection generation changes after precheck, preserving old registry intact', async () => {
      class FakeCasSyncRepository implements SyncRegistryRepository {
        public currentGeneration = 1;
        public oldEntry = {
          id: 'preserved-old-uuid',
          editor: 'Old Preserved Editor',
          userAgentValue: 'old/1.0',
          os: 'Linux',
          version: '1.0',
          aiModel: null,
          aiModelVersion: null,
          aiModelComplexity: null,
          isBrowserExtension: false,
          isDesktopApp: true,
          firstSeenAt: '2026-01-01T00:00:00Z',
          lastSeenAt: '2026-06-01T00:00:00Z',
          isHistorical: false,
          refreshedAt: '2026-06-01T00:00:00Z'
        };
        public staged: any[] = [];
        public entries: Map<string, any> = new Map([
          ['preserved-old-uuid', { ...this.oldEntry }]
        ]);

        clearRegistryStaging(): void {
          this.staged = [];
        }

        stageRegistryEntries(entries: any[]): void {
          this.staged.push(...entries);
        }

        publishRegistryStaging(expectedConnectionGeneration: number): { publishedCount: number; historicalCount: number } {
          // Transactional CAS verification inside publish:
          if (expectedConnectionGeneration !== this.currentGeneration) {
            throw new RegistryRefreshError(
              RECONCILE_CODES.STALE_CONNECTION_GENERATION,
              `Transactional CAS generation mismatch: expected=${expectedConnectionGeneration}, current=${this.currentGeneration}`
            );
          }
          for (const e of this.staged) {
            this.entries.set(e.id, e);
          }
          return { publishedCount: this.staged.length, historicalCount: 0 };
        }

        getRegistryEntry(id: string): any {
          return this.entries.get(id) ?? null;
        }

        listRegistryEntries(): any[] {
          return Array.from(this.entries.values());
        }

        getSyncSettings() {
          return {
            schedulingEnabled: true,
            connectionGeneration: 1, // Precheck observes valid generation 1
            boundArchiveIdentity: null
          };
        }
      }

      const fakeRepo = new FakeCasSyncRepository();
      expect(fakeRepo.listRegistryEntries()).toHaveLength(1);

      const client: RegistryClient = {
        async getUserAgents() {
          // Simulate concurrent connection change right after precheck completes:
          fakeRepo.currentGeneration = 2;
          return {
            page: 1,
            total: 1,
            total_pages: 1,
            next_page: null,
            data: [
              {
                id: 'new-incoming-uuid',
                value: 'new/2.0',
                editor: 'New Editor',
                os: 'Mac'
              }
            ]
          };
        }
      };

      await expect(
        refreshUserAgentRegistry({
          client,
          repository: fakeRepo,
          classificationService: classification,
          expectedConnectionGeneration: 1
        })
      ).rejects.toMatchObject({
        code: RECONCILE_CODES.STALE_CONNECTION_GENERATION
      });

      // Old registry entries MUST be preserved unmodified
      const allEntries = fakeRepo.listRegistryEntries();
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0].id).toBe('preserved-old-uuid');
      expect(allEntries[0].editor).toBe('Old Preserved Editor');

      // Staging must have been cleaned up
      expect(fakeRepo.staged).toHaveLength(0);
    });
  });
});
