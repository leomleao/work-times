/**
 * Pure normalization adapter for summary observations (API and Dump).
 *
 * Implements Stage A of Milestone P3 (docs/NEXT-MILESTONE.md §2.1-2.3):
 * - Distinguishes missing date, incomplete body, restriction, and authoritative zero.
 * - Produces entity_detail or coarse project_summary slices plus collision-proof unattributed_residual identity.
 * - Preserves tiny positive residuals; rejects nonfinite, negative, and overcounts beyond 0.001s tolerance.
 * - Produces deterministic content hashes and preserves source fidelity without manufacturing envelopes.
 */

import { normalizeEntity, sha256Hex, stableStringify } from '../import/canonical.js';
import { isValidDateString } from '../sync/calendar.js';
import {
  DURATION_COMPARISON_TOLERANCE_SECONDS,
  MAX_RESPONSE_PAYLOAD_BYTES,
  RECONCILE_CODES,
  type EntityDetailState,
  type LayerResult,
  type NormalizedProjectSummary,
  type NormalizedScopedDimension,
  type NormalizedSlice,
  type NormalizedSummaryDay,
  type ProjectScopeCompleteness,
  type SummaryCompleteness,
  type SummaryFidelity,
  type NormalizeSummaryOptions
} from './types.js';

const SCOPED_DIMENSION_DEFINITIONS: Array<{ keys: string[]; dimName: NormalizedScopedDimension['dimension'] }> = [
  { keys: ['branches'], dimName: 'branch' },
  { keys: ['categories'], dimName: 'category' },
  { keys: ['dependencies'], dimName: 'dependency' },
  { keys: ['editors'], dimName: 'editor' },
  { keys: ['languages'], dimName: 'language' },
  { keys: ['machines'], dimName: 'machine' },
  { keys: ['operating_systems', 'operatingSystems'], dimName: 'operating_system' }
];

function extractScopedDimensions(
  source: Record<string, unknown>,
  scope: 'account' | 'project',
  projectName: string | null,
  seenDimensionKeys: Set<string>
): { error?: string; dimensions: NormalizedScopedDimension[] } {
  const dimensions: NormalizedScopedDimension[] = [];
  for (const def of SCOPED_DIMENSION_DEFINITIONS) {
    for (const dimKey of def.keys) {
      if (!Object.prototype.hasOwnProperty.call(source, dimKey)) {
        continue;
      }
      const items = source[dimKey];
      if (!Array.isArray(items)) {
        return { error: RECONCILE_CODES.INCOMPLETE_BODY, dimensions: [] };
      }
      const dimName = def.dimName;
      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return { error: RECONCILE_CODES.INCOMPLETE_BODY, dimensions: [] };
        }
        const rawItem = item as Record<string, unknown>;
        const name = rawItem.name;
        if (typeof name !== 'string' || name.trim().length === 0) {
          return { error: RECONCILE_CODES.INCOMPLETE_BODY, dimensions: [] };
        }
        const hasSecsSnake = Object.prototype.hasOwnProperty.call(rawItem, 'total_seconds');
        const hasSecsCamel = Object.prototype.hasOwnProperty.call(rawItem, 'totalSeconds');
        if (!hasSecsSnake && !hasSecsCamel) {
          return { error: RECONCILE_CODES.INCOMPLETE_BODY, dimensions: [] };
        }
        let secs: number | undefined = undefined;
        if (hasSecsSnake) {
          const s = rawItem.total_seconds;
          if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) {
            return { error: RECONCILE_CODES.INCOMPLETE_BODY, dimensions: [] };
          }
          secs = s;
        }
        if (hasSecsCamel) {
          const s = rawItem.totalSeconds;
          if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) {
            return { error: RECONCILE_CODES.INCOMPLETE_BODY, dimensions: [] };
          }
          if (secs === undefined) secs = s;
        }
        if (secs === undefined) {
          return { error: RECONCILE_CODES.INCOMPLETE_BODY, dimensions: [] };
        }

        let percent: number | null = null;
        if (Object.prototype.hasOwnProperty.call(rawItem, 'percent')) {
          const p = rawItem.percent;
          if (typeof p !== 'number' || !Number.isFinite(p) || p < 0) {
            return { error: RECONCILE_CODES.INCOMPLETE_BODY, dimensions: [] };
          }
          percent = p;
        }

        let machineNameId: string | null = null;
        if (Object.prototype.hasOwnProperty.call(rawItem, 'machine_name_id')) {
          if (rawItem.machine_name_id !== null && typeof rawItem.machine_name_id !== 'string') {
            return { error: RECONCILE_CODES.INCOMPLETE_BODY, dimensions: [] };
          }
          machineNameId = rawItem.machine_name_id;
        } else if (Object.prototype.hasOwnProperty.call(rawItem, 'machineNameId')) {
          if (rawItem.machineNameId !== null && typeof rawItem.machineNameId !== 'string') {
            return { error: RECONCILE_CODES.INCOMPLETE_BODY, dimensions: [] };
          }
          machineNameId = rawItem.machineNameId as string | null;
        }

        let entityType: 'file' | 'app' | 'domain' | 'url' | null = null;
        const hasType = Object.prototype.hasOwnProperty.call(rawItem, 'type');
        const hasEntityType = Object.prototype.hasOwnProperty.call(rawItem, 'entity_type');
        if (hasType) {
          const t = rawItem.type;
          if (t !== null && t !== 'file' && t !== 'app' && t !== 'domain' && t !== 'url') {
            return { error: RECONCILE_CODES.INCOMPLETE_BODY, dimensions: [] };
          }
          entityType = (t as any) ?? null;
        }
        if (hasEntityType) {
          const t = rawItem.entity_type;
          if (t !== null && t !== 'file' && t !== 'app' && t !== 'domain' && t !== 'url') {
            return { error: RECONCILE_CODES.INCOMPLETE_BODY, dimensions: [] };
          }
          if (entityType === null) entityType = (t as any) ?? null;
        }

        // Semantic identity: scope/project/dimension/name/entityType/machineNameId
        const semanticKey = `${scope}\0${projectName ?? ''}\0${dimName}\0${name}\0${entityType ?? ''}\0${machineNameId ?? ''}`;
        if (seenDimensionKeys.has(semanticKey)) {
          return { error: RECONCILE_CODES.INCOMPLETE_BODY, dimensions: [] };
        }
        seenDimensionKeys.add(semanticKey);

        dimensions.push({
          scope,
          projectName,
          dimension: dimName,
          name,
          entityType,
          machineNameId,
          totalSeconds: secs,
          percent,
          rawJson: stableStringify(rawItem)
        });
      }
    }
  }
  return { dimensions };
}

function extractOptionalCountMetric(
  source: Record<string, unknown>,
  snakeKey: string,
  camelKey: string
): { valid: boolean; value: number | undefined } {
  const hasSnake = Object.prototype.hasOwnProperty.call(source, snakeKey);
  const hasCamel = Object.prototype.hasOwnProperty.call(source, camelKey);

  if (!hasSnake && !hasCamel) {
    return { valid: true, value: undefined };
  }

  let resultValue: number | undefined = undefined;

  if (hasSnake) {
    const val = source[snakeKey];
    if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val) || val < 0) {
      return { valid: false, value: undefined };
    }
    resultValue = val;
  }

  if (hasCamel) {
    const val = source[camelKey];
    if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val) || val < 0) {
      return { valid: false, value: undefined };
    }
    if (resultValue === undefined) {
      resultValue = val;
    }
  }

  return { valid: true, value: resultValue };
}

export function normalizeSummaryDay(
  input: unknown,
  options: NormalizeSummaryOptions
): LayerResult<NormalizedSummaryDay> {
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_PAYLOAD_BYTES;
  const observedAt = options.observedAt ?? new Date().toISOString();
  const targetDate = options.date;

  // 1. Date format validation
  if (!isValidDateString(targetDate)) {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.MISSING_REQUESTED_DATE,
      retryAt: null
    };
  }

  // 2. Size & JSON parse guard
  let payload = input;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    const byteSize = Buffer.isBuffer(input) ? input.length : Buffer.byteLength(input, 'utf8');
    if (byteSize > maxBytes) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.RESPONSE_SIZE_EXCEEDED,
        retryAt: null
      };
    }
    const str = typeof input === 'string' ? input : input.toString('utf8');
    try {
      payload = JSON.parse(str);
    } catch {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY,
        retryAt: null
      };
    }
  }

  if (!payload || typeof payload !== 'object') {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.INCOMPLETE_BODY,
      retryAt: null
    };
  }

  const rawObj = payload as Record<string, unknown>;

  // 2. Upstream restriction detection (e.g. 402/403 or plan limits)
  if (
    rawObj.error === 'payment_required' ||
    rawObj.code === 'HTTP_402' ||
    rawObj.code === 'HTTP_403' ||
    (typeof rawObj.status === 'number' && (rawObj.status === 402 || rawObj.status === 403))
  ) {
    const code = String(rawObj.code || (rawObj.status === 402 ? 'HTTP_402' : 'HTTP_403'));
    return {
      kind: 'restricted',
      code,
      retryAt: typeof rawObj.retry_at === 'string' ? rawObj.retry_at : ''
    };
  }

  // 3. Locate the target date in the observation
  let dayRecord: Record<string, unknown> | null = null;

  const candidateDays = Array.isArray(rawObj.data)
    ? rawObj.data
    : Array.isArray(rawObj.days)
      ? rawObj.days
      : null;

  if (candidateDays !== null) {
    if (candidateDays.length === 0) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.MISSING_REQUESTED_DATE,
        retryAt: null
      };
    }
    for (const item of candidateDays) {
      if (item && typeof item === 'object') {
        const itemObj = item as Record<string, unknown>;
        const itemDate = itemObj.date ?? (itemObj.range as any)?.date;
        if (itemDate === targetDate) {
          dayRecord = itemObj;
          break;
        }
      }
    }
    if (!dayRecord) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.MISSING_REQUESTED_DATE,
        retryAt: null
      };
    }
  } else if (rawObj.data !== undefined || rawObj.days !== undefined) {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.INCOMPLETE_BODY,
      retryAt: null
    };
  } else if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.MISSING_REQUESTED_DATE,
        retryAt: null
      };
    }
    for (const item of payload) {
      if (item && typeof item === 'object') {
        const itemObj = item as Record<string, unknown>;
        const itemDate = itemObj.date ?? (itemObj.range as any)?.date;
        if (itemDate === targetDate) {
          dayRecord = itemObj;
          break;
        }
      }
    }
    if (!dayRecord) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.MISSING_REQUESTED_DATE,
        retryAt: null
      };
    }
  } else {
    // Single day object
    const objDate = rawObj.date ?? (rawObj.range as any)?.date;
    if (objDate === targetDate) {
      dayRecord = rawObj;
    } else {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.MISSING_REQUESTED_DATE,
        retryAt: null
      };
    }
  }

  // 4. Validate grand_total structure
  const rawGrandTotal = (dayRecord.grand_total ?? dayRecord.grandTotal) as
    | Record<string, unknown>
    | undefined;
  if (!rawGrandTotal || typeof rawGrandTotal !== 'object') {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.INCOMPLETE_BODY,
      retryAt: null
    };
  }

  const totalSeconds = rawGrandTotal.total_seconds;
  if (typeof totalSeconds !== 'number' || !Number.isFinite(totalSeconds)) {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.INCOMPLETE_BODY,
      retryAt: null
    };
  }

  if (totalSeconds < 0) {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.NEGATIVE_RESIDUAL,
      retryAt: null
    };
  }

  // 5. Timezone validation: Require verified response/account timezone (no silent UTC default)
  const rangeObj = dayRecord.range as Record<string, unknown> | undefined;
  const userObj = rawObj.user as Record<string, unknown> | undefined;
  const dayTimezone =
    (typeof rangeObj?.timezone === 'string' ? rangeObj.timezone : undefined) ??
    (typeof dayRecord.timezone === 'string' ? dayRecord.timezone : undefined) ??
    (typeof userObj?.timezone === 'string' ? userObj.timezone : undefined);

  if (!dayTimezone && !options.accountTimezone) {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.TIMEZONE_MISMATCH,
      retryAt: null
    };
  }

  if (options.accountTimezone && dayTimezone && dayTimezone !== options.accountTimezone) {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.TIMEZONE_MISMATCH,
      retryAt: null
    };
  }

  const timezone = dayTimezone ?? options.accountTimezone!;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.TIMEZONE_MISMATCH,
      retryAt: null
    };
  }

  // 6. Validate projects: Omitted projects field must fail closed; cannot establish verified zero or complete totals
  const rawProjects = dayRecord.projects;
  if (rawProjects === undefined || rawProjects === null || !Array.isArray(rawProjects)) {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.INCOMPLETE_BODY,
      retryAt: null
    };
  }

  const normalizedProjects: NormalizedProjectSummary[] = [];
  const projectScopes: Record<string, ProjectScopeCompleteness> = {};
  const projectScopedDimensions: NormalizedScopedDimension[] = [];
  const seenProjectNames = new Set<string>();
  const seenDimensionKeys = new Set<string>();
  let projectSumSeconds = 0;

  for (let pIdx = 0; pIdx < rawProjects.length; pIdx++) {
    const rawProj = rawProjects[pIdx];
    if (!rawProj || typeof rawProj !== 'object') {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY,
        retryAt: null
      };
    }

    const projName = rawProj.name;
    if (typeof projName !== 'string' || projName.trim().length === 0) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY,
        retryAt: null
      };
    }

    if (seenProjectNames.has(projName)) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.MATHEMATICAL_INVARIANT_VIOLATION,
        retryAt: null
      };
    }
    seenProjectNames.add(projName);

    const projGrandTotal = (rawProj.grand_total ?? rawProj.grandTotal) as
      | Record<string, unknown>
      | undefined;
    const projSecs =
      rawProj.total_seconds ??
      rawProj.totalSeconds ??
      projGrandTotal?.total_seconds ??
      projGrandTotal?.totalSeconds;
    if (typeof projSecs !== 'number' || !Number.isFinite(projSecs)) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY,
        retryAt: null
      };
    }

    if (projSecs < 0) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.MATHEMATICAL_INVARIANT_VIOLATION,
        retryAt: null
      };
    }

    projectSumSeconds += projSecs;

    // Evaluate entityDetailState: absent vs empty vs present
    let detailState: EntityDetailState;
    const rawEntities = rawProj.entities;
    const entitiesNormalized: NormalizedProjectSummary['entities'] = [];
    const seenEntityKeys = new Set<string>();

    if (rawEntities === undefined) {
      detailState = 'absent';
    } else if (Array.isArray(rawEntities)) {
      if (rawEntities.length === 0) {
        detailState = 'empty';
      } else {
        detailState = 'present';
        for (let eIdx = 0; eIdx < rawEntities.length; eIdx++) {
          const rawEnt = rawEntities[eIdx];
          if (!rawEnt || typeof rawEnt !== 'object' || Array.isArray(rawEnt)) {
            return {
              kind: 'failed',
              code: RECONCILE_CODES.INCOMPLETE_BODY,
              retryAt: null
            };
          }

          const entName = rawEnt.name;
          if (typeof entName !== 'string' || entName.trim().length === 0) {
            return {
              kind: 'failed',
              code: RECONCILE_CODES.INCOMPLETE_BODY,
              retryAt: null
            };
          }

          const entSecs = rawEnt.total_seconds ?? rawEnt.totalSeconds;
          if (typeof entSecs !== 'number' || !Number.isFinite(entSecs)) {
            return {
              kind: 'failed',
              code: RECONCILE_CODES.INCOMPLETE_BODY,
              retryAt: null
            };
          }

          if (entSecs < 0) {
            return {
              kind: 'failed',
              code: RECONCILE_CODES.MATHEMATICAL_INVARIANT_VIOLATION,
              retryAt: null
            };
          }

          const rawType = rawEnt.type ?? rawEnt.entity_type;
          if (rawType !== 'app' && rawType !== 'domain' && rawType !== 'file' && rawType !== 'url') {
            return {
              kind: 'failed',
              code: RECONCILE_CODES.INCOMPLETE_BODY,
              retryAt: null
            };
          }
          const entType: 'file' | 'app' | 'domain' | 'url' = rawType;

          const normEntity = normalizeEntity(entName, entType);
          const entityKey = `${normEntity}\0${entType}`;
          if (seenEntityKeys.has(entityKey)) {
            return {
              kind: 'failed',
              code: RECONCILE_CODES.INCOMPLETE_BODY,
              retryAt: null
            };
          }
          seenEntityKeys.add(entityKey);

          let percent: number | undefined = undefined;
          if (Object.prototype.hasOwnProperty.call(rawEnt, 'percent')) {
            if (typeof rawEnt.percent !== 'number' || !Number.isFinite(rawEnt.percent) || rawEnt.percent < 0) {
              return {
                kind: 'failed',
                code: RECONCILE_CODES.INCOMPLETE_BODY,
                retryAt: null
              };
            }
            percent = rawEnt.percent;
          }

          let projectRootCount: number | null | undefined = undefined;
          const hasSnakeRoot = Object.prototype.hasOwnProperty.call(rawEnt, 'project_root_count');
          const hasCamelRoot = Object.prototype.hasOwnProperty.call(rawEnt, 'projectRootCount');
          if (hasSnakeRoot) {
            const val = rawEnt.project_root_count;
            if (val === null) {
              projectRootCount = null;
            } else if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val) || val < 0) {
              return {
                kind: 'failed',
                code: RECONCILE_CODES.INCOMPLETE_BODY,
                retryAt: null
              };
            } else {
              projectRootCount = val;
            }
          }
          if (hasCamelRoot) {
            const val = rawEnt.projectRootCount;
            if (val === null) {
              if (projectRootCount === undefined) projectRootCount = null;
            } else if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val) || val < 0) {
              return {
                kind: 'failed',
                code: RECONCILE_CODES.INCOMPLETE_BODY,
                retryAt: null
              };
            } else {
              if (projectRootCount === undefined) projectRootCount = val;
            }
          }

          const hAdd = extractOptionalCountMetric(rawEnt, 'human_additions', 'humanAdditions');
          if (!hAdd.valid) return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
          const hDel = extractOptionalCountMetric(rawEnt, 'human_deletions', 'humanDeletions');
          if (!hDel.valid) return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
          const aAdd = extractOptionalCountMetric(rawEnt, 'ai_additions', 'aiAdditions');
          if (!aAdd.valid) return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
          const aDel = extractOptionalCountMetric(rawEnt, 'ai_deletions', 'aiDeletions');
          if (!aDel.valid) return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
          const aSess = extractOptionalCountMetric(rawEnt, 'ai_sessions', 'aiSessions');
          if (!aSess.valid) return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };

          entitiesNormalized.push({
            name: normEntity,
            type: entType,
            totalSeconds: entSecs,
            percent,
            projectRootCount,
            humanAdditions: hAdd.value,
            humanDeletions: hDel.value,
            aiAdditions: aAdd.value,
            aiDeletions: aDel.value,
            aiSessions: aSess.value
          });
        }
      }
    } else {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY,
        retryAt: null
      };
    }

    // Extract project-scoped dimensions (branches, categories, dependencies, editors, languages, machines, operating_systems)
    const projDims = extractScopedDimensions(
      rawProj as Record<string, unknown>,
      'project',
      projName,
      seenDimensionKeys
    );
    if (projDims.error) {
      return {
        kind: 'failed',
        code: projDims.error,
        retryAt: null
      };
    }
    projectScopedDimensions.push(...projDims.dimensions);

    // Validate both project percent aliases (percent, project_percent, projectPercent)
    // and nested grand-total percent before selecting a value.
    // Finite nonnegative only, and never turn malformed data into zero.
    let projPercent: number = 0;
    let selectedPercent: number | undefined = undefined;

    const validatePercentCandidate = (val: unknown, isSupplied: boolean): boolean => {
      if (!isSupplied) return true;
      return typeof val === 'number' && Number.isFinite(val) && val >= 0;
    };

    // 1. rawProj.percent
    const hasP1 = Object.prototype.hasOwnProperty.call(rawProj, 'percent');
    if (!validatePercentCandidate(rawProj.percent, hasP1)) {
      return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
    }
    if (hasP1 && selectedPercent === undefined) {
      selectedPercent = rawProj.percent as number;
    }

    // 2. rawProj.project_percent
    const hasP2 = Object.prototype.hasOwnProperty.call(rawProj, 'project_percent');
    if (!validatePercentCandidate((rawProj as any).project_percent, hasP2)) {
      return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
    }
    if (hasP2 && selectedPercent === undefined) {
      selectedPercent = (rawProj as any).project_percent as number;
    }

    // 3. rawProj.projectPercent
    const hasP3 = Object.prototype.hasOwnProperty.call(rawProj, 'projectPercent');
    if (!validatePercentCandidate((rawProj as any).projectPercent, hasP3)) {
      return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
    }
    if (hasP3 && selectedPercent === undefined) {
      selectedPercent = (rawProj as any).projectPercent as number;
    }

    // 4. Nested grand-total percent
    if (projGrandTotal) {
      const hasGtP1 = Object.prototype.hasOwnProperty.call(projGrandTotal, 'percent');
      if (!validatePercentCandidate(projGrandTotal.percent, hasGtP1)) {
        return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
      }
      if (hasGtP1 && selectedPercent === undefined) {
        selectedPercent = projGrandTotal.percent as number;
      }

      const hasGtP2 = Object.prototype.hasOwnProperty.call(projGrandTotal, 'project_percent');
      if (!validatePercentCandidate((projGrandTotal as any).project_percent, hasGtP2)) {
        return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
      }
      if (hasGtP2 && selectedPercent === undefined) {
        selectedPercent = (projGrandTotal as any).project_percent as number;
      }

      const hasGtP3 = Object.prototype.hasOwnProperty.call(projGrandTotal, 'projectPercent');
      if (!validatePercentCandidate((projGrandTotal as any).projectPercent, hasGtP3)) {
        return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
      }
      if (hasGtP3 && selectedPercent === undefined) {
        selectedPercent = (projGrandTotal as any).projectPercent as number;
      }
    }

    if (selectedPercent !== undefined) {
      projPercent = selectedPercent;
    } else {
      projPercent = 0;
    }

    // If totalSeconds > 0 but entities: [], it is coarse and hasEntityDetail is false
    const hasProjEntityDetail = detailState === 'present' && entitiesNormalized.length > 0;
    const normProj: NormalizedProjectSummary = {
      name: projName,
      totalSeconds: projSecs,
      percent: projPercent,
      entityDetailState: detailState,
      hasEntityDetail: hasProjEntityDetail,
      entities: entitiesNormalized
    };
    normalizedProjects.push(normProj);

    projectScopes[projName] = {
      projectName: projName,
      totalSeconds: projSecs,
      entityDetailState: detailState,
      entityCount: entitiesNormalized.length
    };
  }

  // 7. Determine Fidelity and Completeness
  let fidelity: SummaryFidelity;
  let overallEntityDetailState: SummaryCompleteness['overallEntityDetailState'];
  const isVerifiedZero =
    totalSeconds === 0 &&
    (rawProjects.length === 0 ||
      normalizedProjects.every((p) => p.totalSeconds === 0 && p.entityDetailState === 'empty'));

  const hasDetailedProjects = normalizedProjects.some(
    (p) => p.entityDetailState === 'present' && p.entities.length > 0
  );
  // Coarse: absent entities, OR empty entities with positive seconds
  const hasCoarseProjects = normalizedProjects.some(
    (p) => p.entityDetailState === 'absent' || (p.entityDetailState === 'empty' && p.totalSeconds > 0)
  );

  if (isVerifiedZero) {
    fidelity = 'verified_zero';
    overallEntityDetailState = 'empty';
  } else if (rawProjects.length === 0) {
    // Explicit empty projects but positive account total -> account residual only
    fidelity = 'coarse_project';
    overallEntityDetailState = 'coarse_only';
  } else if (!hasDetailedProjects) {
    // No projects have entity detail: all are coarse or 0-second empty
    fidelity = 'coarse_project';
    overallEntityDetailState = 'coarse_only';
  } else if (!hasCoarseProjects) {
    // Has detailed projects and NO coarse projects
    fidelity = 'entity_detail';
    overallEntityDetailState = 'complete_detail';
  } else {
    // Has detailed projects AND has coarse projects -> mixed
    fidelity = 'entity_detail';
    overallEntityDetailState = 'mixed';
  }

  // 8. Numerical bounds & overcount validation:
  // Validate entity sums against each project's total with 0.001s tolerance
  for (const p of normalizedProjects) {
    if (p.entityDetailState === 'present' && p.entities.length > 0) {
      const projEntitySum = p.entities.reduce((sum, e) => sum + e.totalSeconds, 0);
      if (projEntitySum - p.totalSeconds > DURATION_COMPARISON_TOLERANCE_SECONDS) {
        return {
          kind: 'failed',
          code: RECONCILE_CODES.OVERCOUNT_TOLERANCE_EXCEEDED,
          retryAt: null
        };
      }
    }
  }

  // Validate project totals against account total with 0.001s tolerance
  if (projectSumSeconds - totalSeconds > DURATION_COMPARISON_TOLERANCE_SECONDS) {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.OVERCOUNT_TOLERANCE_EXCEEDED,
      retryAt: null
    };
  }

  const projectSumDelta = totalSeconds - projectSumSeconds;

  // 9. Generate Slices: Preserve mixed summary fidelity
  const rawSlices: NormalizedSlice[] = [];

  if (fidelity !== 'verified_zero') {
    for (const proj of normalizedProjects) {
      if (proj.entityDetailState === 'present' && proj.entities.length > 0) {
        let entitySum = 0;
        for (const ent of proj.entities) {
          entitySum += ent.totalSeconds;
          rawSlices.push({
            projectName: proj.name,
            entity: ent.name,
            entityType: ent.type,
            totalSeconds: ent.totalSeconds,
            kind: 'entity',
            isUnattributed: false,
            projectRootCount: ent.projectRootCount ?? null,
            humanAdditions: ent.humanAdditions ?? 0,
            humanDeletions: ent.humanDeletions ?? 0,
            aiAdditions: ent.aiAdditions ?? 0,
            aiDeletions: ent.aiDeletions ?? 0,
            aiSessions: ent.aiSessions ?? 0
          });
        }
        // Project-local residual for projects with entity detail whose entity sum < project total
        const projResidual = proj.totalSeconds - entitySum;
        if (projResidual > 0) {
          rawSlices.push({
            projectName: proj.name,
            entity: proj.name,
            entityType: 'app',
            totalSeconds: projResidual,
            kind: 'project_summary',
            isUnattributed: false,
            projectRootCount: null,
            humanAdditions: 0,
            humanDeletions: 0,
            aiAdditions: 0,
            aiDeletions: 0,
            aiSessions: 0
          });
        }
      } else {
        // Coarse project (absent or empty entities): emit project_summary slice for known coarse seconds
        if (proj.totalSeconds > 0) {
          rawSlices.push({
            projectName: proj.name,
            entity: proj.name,
            entityType: 'app',
            totalSeconds: proj.totalSeconds,
            kind: 'project_summary',
            isUnattributed: false,
            projectRootCount: null,
            humanAdditions: 0,
            humanDeletions: 0,
            aiAdditions: 0,
            aiDeletions: 0,
            aiSessions: 0
          });
        }
      }
    }

    // Retain positive account-level residual in dedicated unattributed_residual slice
    // (Preserves every positive residual, including sub-microsecond values)
    const accountResidual = totalSeconds - projectSumSeconds;
    if (accountResidual > 0) {
      rawSlices.push({
        projectName: '__unattributed__',
        entity: '__unattributed__',
        entityType: 'unattributed',
        totalSeconds: accountResidual,
        kind: 'unattributed_residual',
        isUnattributed: true,
        projectRootCount: null,
        humanAdditions: 0,
        humanDeletions: 0,
        aiAdditions: 0,
        aiDeletions: 0,
        aiSessions: 0
      });
    }
  }

  // Merge slices with identical (projectName, entity, entityType, kind)
  const sliceMap = new Map<string, NormalizedSlice>();
  for (const s of rawSlices) {
    const key = `${s.projectName}\0${s.entity}\0${s.entityType}\0${s.kind}`;
    const existing = sliceMap.get(key);
    if (existing) {
      existing.totalSeconds += s.totalSeconds;
      existing.humanAdditions += s.humanAdditions;
      existing.humanDeletions += s.humanDeletions;
      existing.aiAdditions += s.aiAdditions;
      existing.aiDeletions += s.aiDeletions;
      existing.aiSessions += s.aiSessions;
    } else {
      sliceMap.set(key, { ...s });
    }
  }
  const slices = Array.from(sliceMap.values());

  // 10. Check mathematical sum invariant
  const sliceSum = slices.reduce((sum, s) => sum + s.totalSeconds, 0);
  if (Math.abs(sliceSum - totalSeconds) > DURATION_COMPARISON_TOLERANCE_SECONDS) {
    return {
      kind: 'failed',
      code: RECONCILE_CODES.MATHEMATICAL_INVARIANT_VIOLATION,
      retryAt: null
    };
  }

  // 11. Scoped Dimensions: Strictly validate dimension rows (no silent dropping or defaulting to 0)
  const scopedDimensions: NormalizedScopedDimension[] = [];

  // Account-scope project dimensions
  for (const proj of normalizedProjects) {
    const dimKey = `account\0\0project\0${proj.name}\0\0`;
    if (seenDimensionKeys.has(dimKey)) {
      return {
        kind: 'failed',
        code: RECONCILE_CODES.INCOMPLETE_BODY,
        retryAt: null
      };
    }
    seenDimensionKeys.add(dimKey);
    scopedDimensions.push({
      scope: 'account',
      projectName: null,
      dimension: 'project',
      name: proj.name,
      totalSeconds: proj.totalSeconds,
      percent: proj.percent
    });
  }

  // Add project-scoped dimensions collected during project processing
  scopedDimensions.push(...projectScopedDimensions);

  // Extract account-scoped dimensions from dayRecord
  const accountDims = extractScopedDimensions(dayRecord, 'account', null, seenDimensionKeys);
  if (accountDims.error) {
    return {
      kind: 'failed',
      code: accountDims.error,
      retryAt: null
    };
  }
  scopedDimensions.push(...accountDims.dimensions);

  const gtHAdd = extractOptionalCountMetric(rawGrandTotal, 'human_additions', 'humanAdditions');
  if (!gtHAdd.valid) return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
  const gtHDel = extractOptionalCountMetric(rawGrandTotal, 'human_deletions', 'humanDeletions');
  if (!gtHDel.valid) return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
  const gtAAdd = extractOptionalCountMetric(rawGrandTotal, 'ai_additions', 'aiAdditions');
  if (!gtAAdd.valid) return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
  const gtADel = extractOptionalCountMetric(rawGrandTotal, 'ai_deletions', 'aiDeletions');
  if (!gtADel.valid) return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
  const gtASess = extractOptionalCountMetric(rawGrandTotal, 'ai_sessions', 'aiSessions');
  if (!gtASess.valid) return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };

  const gtAiIn = extractOptionalCountMetric(rawGrandTotal, 'ai_input_tokens', 'aiInputTokens');
  if (!gtAiIn.valid) return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
  const gtAiOut = extractOptionalCountMetric(rawGrandTotal, 'ai_output_tokens', 'aiOutputTokens');
  if (!gtAiOut.valid) return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };

  if (Object.prototype.hasOwnProperty.call(rawGrandTotal, 'percent')) {
    const p = rawGrandTotal.percent;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0) {
      return { kind: 'failed', code: RECONCILE_CODES.INCOMPLETE_BODY, retryAt: null };
    }
  }

  const grandTotalNormalized: NormalizedSummaryDay['grandTotal'] = {
    total_seconds: totalSeconds,
    human_additions: gtHAdd.value ?? 0,
    human_deletions: gtHDel.value ?? 0,
    ai_additions: gtAAdd.value ?? 0,
    ai_deletions: gtADel.value ?? 0,
    ai_sessions: gtASess.value ?? 0,
    ai_input_tokens: gtAiIn.value,
    ai_output_tokens: gtAiOut.value
  };

  const completeness: SummaryCompleteness = {
    hasAccountTotals: true,
    hasProjectTotals: true,
    hasEntityDetail: fidelity === 'entity_detail' || isVerifiedZero,
    isVerifiedZero,
    overallEntityDetailState,
    projectScopes,
    missingFields: []
  };

  // Sort projects and their entities deterministically by name ASC, type ASC
  normalizedProjects.sort((a, b) => a.name.localeCompare(b.name));
  for (const p of normalizedProjects) {
    p.entities.sort((a, b) => {
      const nComp = a.name.localeCompare(b.name);
      if (nComp !== 0) return nComp;
      return a.type.localeCompare(b.type);
    });
  }

  // Sort scopedDimensions deterministically across all semantic tie fields:
  // scope ASC, projectName ASC, dimension ASC, name ASC, entityType ASC, machineNameId ASC
  scopedDimensions.sort((a, b) => {
    const sComp = a.scope.localeCompare(b.scope);
    if (sComp !== 0) return sComp;
    const pComp = (a.projectName ?? '').localeCompare(b.projectName ?? '');
    if (pComp !== 0) return pComp;
    const dComp = a.dimension.localeCompare(b.dimension);
    if (dComp !== 0) return dComp;
    const nComp = a.name.localeCompare(b.name);
    if (nComp !== 0) return nComp;
    const tComp = (a.entityType ?? '').localeCompare(b.entityType ?? '');
    if (tComp !== 0) return tComp;
    return (a.machineNameId ?? '').localeCompare(b.machineNameId ?? '');
  });

  // Sort slices deterministically by projectName ASC, entity ASC, entityType ASC, kind ASC
  slices.sort((a, b) => {
    const pComp = a.projectName.localeCompare(b.projectName);
    if (pComp !== 0) return pComp;
    const eComp = a.entity.localeCompare(b.entity);
    if (eComp !== 0) return eComp;
    const tComp = a.entityType.localeCompare(b.entityType);
    if (tComp !== 0) return tComp;
    return a.kind.localeCompare(b.kind);
  });

  const normalizedSummaryDay: NormalizedSummaryDay = {
    date: targetDate,
    timezone,
    totalSeconds,
    projectSumSeconds,
    projectSumDelta,
    fidelity,
    completeness,
    grandTotal: grandTotalNormalized,
    projects: normalizedProjects,
    scopedDimensions,
    slices
  };

  // Deterministic content hash across all normalized accepted fields whose change affects stored truth:
  // timezone, totals, fidelity/completeness, full project/entity metrics, scoped dimensions, and all summary slices.
  // observedAt stays strictly outside the content hash.
  const canonicalStructure = {
    date: normalizedSummaryDay.date,
    timezone: normalizedSummaryDay.timezone,
    totalSeconds: normalizedSummaryDay.totalSeconds,
    projectSumSeconds: normalizedSummaryDay.projectSumSeconds,
    projectSumDelta: normalizedSummaryDay.projectSumDelta,
    fidelity: normalizedSummaryDay.fidelity,
    completeness: {
      hasAccountTotals: normalizedSummaryDay.completeness.hasAccountTotals,
      hasProjectTotals: normalizedSummaryDay.completeness.hasProjectTotals,
      hasEntityDetail: normalizedSummaryDay.completeness.hasEntityDetail,
      isVerifiedZero: normalizedSummaryDay.completeness.isVerifiedZero,
      overallEntityDetailState: normalizedSummaryDay.completeness.overallEntityDetailState,
      projectScopes: normalizedSummaryDay.completeness.projectScopes,
      missingFields: normalizedSummaryDay.completeness.missingFields
    },
    grandTotal: normalizedSummaryDay.grandTotal,
    projects: normalizedSummaryDay.projects.map((p) => ({
      name: p.name,
      totalSeconds: p.totalSeconds,
      percent: p.percent,
      entityDetailState: p.entityDetailState,
      hasEntityDetail: p.hasEntityDetail,
      entities: p.entities.map((e) => ({
        name: e.name,
        type: e.type,
        totalSeconds: e.totalSeconds,
        percent: e.percent,
        projectRootCount: e.projectRootCount,
        humanAdditions: e.humanAdditions,
        humanDeletions: e.humanDeletions,
        aiAdditions: e.aiAdditions,
        aiDeletions: e.aiDeletions,
        aiSessions: e.aiSessions
      }))
    })),
    scopedDimensions: normalizedSummaryDay.scopedDimensions.map((d) => ({
      scope: d.scope,
      projectName: d.projectName,
      dimension: d.dimension,
      name: d.name,
      entityType: d.entityType,
      machineNameId: d.machineNameId,
      totalSeconds: d.totalSeconds,
      percent: d.percent,
      rawJson: d.rawJson
    })),
    slices: normalizedSummaryDay.slices.map((s) => ({
      projectName: s.projectName,
      entity: s.entity,
      entityType: s.entityType,
      totalSeconds: s.totalSeconds,
      kind: s.kind,
      isUnattributed: s.isUnattributed,
      projectRootCount: s.projectRootCount,
      humanAdditions: s.humanAdditions,
      humanDeletions: s.humanDeletions,
      aiAdditions: s.aiAdditions,
      aiDeletions: s.aiDeletions,
      aiSessions: s.aiSessions
    }))
  };

  const contentHash = sha256Hex(stableStringify(canonicalStructure));

  return {
    kind: 'complete',
    value: normalizedSummaryDay,
    contentHash,
    observedAt
  };
}
