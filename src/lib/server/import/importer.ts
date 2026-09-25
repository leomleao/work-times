import type Database from 'better-sqlite3';
import { BatchInserter } from './batch.js';
import {
  canonicalHeartbeatPayload,
  canonicalPayloadHash,
  canonicalizeDependencies,
  heartbeatSliceIdentities,
  normalizeEntity,
  redact,
  sliceIntrinsicIdentities,
  stableStringify,
  toEpochMicroseconds,
  toIsoUtc
} from './canonical.js';
import {
  DumpValidationError,
  MAX_DIRECT_PARSE_BYTES,
  parseDumpFile,
  validateDailyDay,
  validateEnvelope,
  validateHeartbeat,
  validateHeartbeatDay,
  type BreakdownItem,
  type DailyDay,
  type DumpEnvelope,
  type DumpUser
} from './parse.js';
import { UNATTRIBUTED, type Dimension } from '../db/schema.js';

/**
 * Seconds of daily-vs-project divergence tolerated before a warning is raised.
 * Sub-second differences are float noise in the export's own rounding.
 */
const DIVERGENCE_TOLERANCE_SECONDS = 1;

export interface ImportOptions {
  dailyDumpPath: string;
  heartbeatDumpPath: string;
  /** Validate and report without leaving anything behind. Default false. */
  dryRun?: boolean;
  /** Direct-parse ceiling in bytes. Default 96 MiB. */
  maxBytes?: number;
  /**
   * Record post-canonicalization payload conflicts as quarantined variants
   * instead of aborting. Default false: conflicts fail the import closed.
   */
  allowConflicts?: boolean;
  /**
   * Re-import a pair of dumps already imported from these exact bytes. Without
   * it, a repeat is a reported no-op rather than a duplicate-key crash.
   */
  force?: boolean;
  logger?: ImportLogger;
}

export interface ImportLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface ImportReport {
  dryRun: boolean;
  /** True when these exact bytes were already imported and nothing was done. */
  alreadyImported: boolean;
  dailyImportId: number;
  heartbeatImportId: number;
  dailySourceHash: string;
  heartbeatSourceHash: string;
  rangeStartDate: string;
  rangeEndDate: string;
  dayCount: number;
  activeDayCount: number;
  projectCount: number;
  /** Dimension rows offered to the database, before normalization merges. */
  accountDimensionRows: number;
  projectDimensionRows: number;
  /** Dimension rows actually stored, after normalization merges. */
  storedDimensionRows: number;
  sliceCount: number;
  /** Source entity rows folded into an existing slice by path normalization. */
  mergedSliceRows: number;
  unattributedSliceCount: number;
  unattributedSeconds: number;
  sliceIdentityRows: number;
  heartbeatCount: number;
  duplicateHeartbeatIds: number;
  duplicateOccurrences: number;
  conflictingHeartbeatIds: number;
  dependencyRelationships: number;
  canonicalDependencyRows: number;
  divergentDays: number;
  warnings: string[];
}

export class HeartbeatConflictError extends Error {
  constructor(
    readonly externalId: string,
    readonly existingHash: string,
    readonly incomingHash: string
  ) {
    super(
      `Heartbeat ${redact(externalId)} appears twice with different payloads after canonicalization ` +
        `(${existingHash.slice(0, 12)} vs ${incomingHash.slice(0, 12)}). Import failed closed; ` +
        `re-run with allowConflicts to quarantine instead.`
    );
    this.name = 'HeartbeatConflictError';
  }
}

const silentLogger: ImportLogger = { info: () => {}, warn: () => {} };

/**
 * Import both dump files into the database as one atomic unit.
 *
 * Either every row from both dumps lands, or none does: the whole thing runs
 * inside a single SQLite transaction. A dry run performs the identical work
 * and then rolls back, so its counts are exactly what a real import would
 * produce rather than an approximation of it.
 */
export async function importDumps(db: Database.Database, options: ImportOptions): Promise<ImportReport> {
  const log = options.logger ?? silentLogger;
  const limit = options.maxBytes ?? MAX_DIRECT_PARSE_BYTES;

  log.info('Reading daily dump');
  const daily = await parseDumpFile(options.dailyDumpPath, limit);
  log.info('Reading heartbeat dump');
  const heartbeat = await parseDumpFile(options.heartbeatDumpPath, limit);

  const dailyEnvelope = validateEnvelope(daily.data, 'daily');
  const heartbeatEnvelope = validateEnvelope(heartbeat.data, 'heartbeat');
  assertEnvelopesAgree(dailyEnvelope, heartbeatEnvelope);

  if (options.force !== true) {
    const previous = findCompletedImport(db, daily.sourceHash, heartbeat.sourceHash);
    if (previous !== null) {
      log.info('These dumps were already imported; nothing to do');
      return previous;
    }
  }

  const context: RunContext = {
    db,
    log,
    dryRun: options.dryRun === true,
    force: options.force === true,
    allowConflicts: options.allowConflicts === true,
    daily,
    heartbeat,
    dailyEnvelope,
    heartbeatEnvelope
  };

  // "Dry run == real run, then undo" is deliberate: it exercises every
  // constraint, so a dry run that passes cannot be followed by a real import
  // that violates a UNIQUE or CHECK the dry run never reached.
  if (context.dryRun) {
    try {
      db.transaction(() => {
        throw new DryRunRollback(executeImport(context));
      })();
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
      log.info('Dry run complete; no changes were written');
      return error.report;
    }
    throw new Error('Dry run did not roll back');
  }

  return db.transaction(() => executeImport(context))();
}

/**
 * Report a prior completed import of these exact bytes, if there is one.
 *
 * Re-running the same pair is the common operator mistake; answering it with a
 * no-op beats a UNIQUE-constraint stack trace, and beats silently writing a
 * second copy of three and a half thousand days.
 */
function findCompletedImport(
  db: Database.Database,
  dailyHash: string,
  heartbeatHash: string
): ImportReport | null {
  const find = db.prepare(
    `SELECT id, range_start_date, range_end_date, day_count, record_count,
            duplicate_count, conflict_count, warnings_json
     FROM source_imports
     WHERE source_type = ? AND source_hash = ? AND status = 'completed' AND dry_run = 0
     ORDER BY id DESC LIMIT 1`
  );

  type Row = {
    id: number;
    range_start_date: string | null;
    range_end_date: string | null;
    day_count: number;
    record_count: number;
    duplicate_count: number;
    conflict_count: number;
    warnings_json: string | null;
  };

  const daily = find.get('daily_dump', dailyHash) as Row | undefined;
  const heartbeats = find.get('heartbeat_dump', heartbeatHash) as Row | undefined;
  if (!daily || !heartbeats) return null;

  const scalar = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  return {
    dryRun: false,
    alreadyImported: true,
    dailyImportId: daily.id,
    heartbeatImportId: heartbeats.id,
    dailySourceHash: dailyHash,
    heartbeatSourceHash: heartbeatHash,
    rangeStartDate: daily.range_start_date ?? '',
    rangeEndDate: daily.range_end_date ?? '',
    dayCount: daily.day_count,
    activeDayCount: scalar('SELECT COUNT(*) AS n FROM daily_totals WHERE total_seconds > 0'),
    projectCount: scalar('SELECT COUNT(*) AS n FROM projects WHERE is_unattributed = 0'),
    accountDimensionRows: scalar("SELECT COUNT(*) AS n FROM daily_dimension_totals WHERE scope = 'account'"),
    projectDimensionRows: scalar("SELECT COUNT(*) AS n FROM daily_dimension_totals WHERE scope = 'project'"),
    storedDimensionRows: scalar('SELECT COUNT(*) AS n FROM daily_dimension_totals'),
    sliceCount: scalar('SELECT COUNT(*) AS n FROM day_project_entity_slices'),
    mergedSliceRows: 0,
    unattributedSliceCount: scalar('SELECT COUNT(*) AS n FROM day_project_entity_slices WHERE is_unattributed = 1'),
    unattributedSeconds: scalar(
      'SELECT COALESCE(SUM(total_seconds), 0) AS n FROM day_project_entity_slices WHERE is_unattributed = 1'
    ),
    sliceIdentityRows: scalar('SELECT COUNT(*) AS n FROM slice_identities'),
    heartbeatCount: heartbeats.record_count,
    duplicateHeartbeatIds: scalar('SELECT COUNT(*) AS n FROM heartbeats WHERE occurrence_count > 1'),
    duplicateOccurrences: heartbeats.duplicate_count,
    conflictingHeartbeatIds: heartbeats.conflict_count,
    dependencyRelationships: scalar('SELECT COUNT(*) AS n FROM heartbeat_dependencies'),
    canonicalDependencyRows: scalar('SELECT COUNT(*) AS n FROM heartbeat_dependencies'),
    divergentDays: scalar('SELECT COUNT(*) AS n FROM daily_totals WHERE ABS(project_sum_delta) > 1'),
    warnings: heartbeats.warnings_json === null ? [] : (JSON.parse(heartbeats.warnings_json) as string[])
  };
}

/** Thrown to unwind a dry-run transaction once its counts have been collected. */
class DryRunRollback extends Error {
  constructor(readonly report: ImportReport) {
    super('dry run rollback');
    this.name = 'DryRunRollback';
  }
}

interface RunContext {
  db: Database.Database;
  log: ImportLogger;
  dryRun: boolean;
  force: boolean;
  allowConflicts: boolean;
  daily: { byteSize: number; sourceHash: string };
  heartbeat: { byteSize: number; sourceHash: string };
  dailyEnvelope: DumpEnvelope;
  heartbeatEnvelope: DumpEnvelope;
}

/**
 * Both dumps must describe the same account over the same aligned range. A
 * mismatch means the operator paired files from different exports, which would
 * silently attach one account's heartbeats to another's summaries.
 */
function assertEnvelopesAgree(daily: DumpEnvelope, heartbeats: DumpEnvelope): void {
  if (daily.user.id !== heartbeats.user.id) {
    throw new DumpValidationError(
      `Dumps belong to different accounts (${redact(daily.user.id)} vs ${redact(heartbeats.user.id)})`
    );
  }
  if (daily.range.start !== heartbeats.range.start || daily.range.end !== heartbeats.range.end) {
    throw new DumpValidationError('Dumps cover different ranges');
  }
  if (daily.days.length !== heartbeats.days.length) {
    throw new DumpValidationError(
      `Dumps have different day counts (${daily.days.length} vs ${heartbeats.days.length})`
    );
  }
}

function executeImport(context: RunContext): ImportReport {
  const { db, log, dailyEnvelope, heartbeatEnvelope } = context;

  const dailyImportId = openSourceImport(context, 'daily_dump', context.daily);
  const heartbeatImportId = openSourceImport(context, 'heartbeat_dump', context.heartbeat);

  upsertAccountSettings(db, dailyEnvelope.user, dailyImportId);

  const statements = prepareStatements(db);
  const batches = createBatches(db);
  const projects = new ProjectRegistry(db);
  const warnings: string[] = [];

  const totals = {
    dayCount: 0,
    activeDayCount: 0,
    accountDimensionRows: 0,
    projectDimensionRows: 0,
    sliceCount: 0,
    mergedSliceRows: 0,
    unattributedSliceCount: 0,
    unattributedSeconds: 0,
    heartbeatCount: 0,
    duplicateHeartbeatIds: 0,
    duplicateOccurrences: 0,
    conflictingHeartbeatIds: 0,
    dependencyRelationships: 0,
    canonicalDependencyRows: 0,
    divergentDays: 0
  };

  /** External heartbeat id to the canonical hash first accepted for it. */
  const seenHeartbeats = new Map<string, string>();
  /** Per-day accumulation of heartbeat-contributed slice identities. */
  const identityCounts = new Map<
    string,
    { sliceId: number; selectorType: string; value: string; count: number }
  >();

  let firstDate: string | null = null;
  let lastDate: string | null = null;

  for (let index = 0; index < dailyEnvelope.days.length; index++) {
    const day = validateDailyDay(dailyEnvelope.days[index], index);
    const heartbeatDay = validateHeartbeatDay(heartbeatEnvelope.days[index], index);

    if (day.date !== heartbeatDay.date) {
      throw new DumpValidationError(
        `Day #${index} is ${day.date} in the daily dump but ${heartbeatDay.date} in the heartbeat dump`
      );
    }

    firstDate ??= day.date;
    lastDate = day.date;
    totals.dayCount++;
    if (day.grandTotal.total_seconds > 0) totals.activeDayCount++;

    const projectSum = day.projects.reduce((sum, project) => sum + project.grandTotal.total_seconds, 0);
    const delta = day.grandTotal.total_seconds - projectSum;

    if (Math.abs(delta) > DIVERGENCE_TOLERANCE_SECONDS) {
      totals.divergentDays++;
      // Tolerated, not fatal: the daily grand_total stays authoritative and the
      // difference becomes the day's unattributed slice.
      const warning =
        `${day.date}: daily total ${day.grandTotal.total_seconds.toFixed(1)}s diverges from ` +
        `project sum ${projectSum.toFixed(1)}s by ${delta.toFixed(1)}s`;
      warnings.push(warning);
      log.warn(warning);
    }

    // Safeguard: an overlapping dump must not overwrite existing data showing live API, sync, or dump provenance
    const existingLive = db
      .prepare(
        `SELECT accepted_snapshot_version, accepted_source_reference
         FROM sync_layer_state
         WHERE date = ? AND (
           accepted_snapshot_version >= 1 OR
           accepted_content_hash IS NOT NULL OR
           accepted_source_reference IS NOT NULL
         )`
      )
      .get(day.date) as { accepted_snapshot_version: number; accepted_source_reference: string | null } | undefined;

    const existingDaily = db
      .prepare(
        `SELECT dt.date, si.source_type
         FROM daily_totals dt
         LEFT JOIN source_imports si ON si.id = dt.source_import_id
         WHERE dt.date = ?`
      )
      .get(day.date) as { date: string; source_type: string | null } | undefined;

    if (!context.force && (existingLive || existingDaily)) {
      const ver = existingLive?.accepted_snapshot_version ?? 1;
      const ref = existingLive?.accepted_source_reference ?? existingDaily?.source_type ?? 'existing';
      throw new Error(
        `Cannot overwrite existing data for ${day.date} (version ${ver}, source ${ref}) with an overlapping dump.`
      );
    }

    writeDailyTotal(statements, day, projectSum, delta, dailyImportId, context.daily.sourceHash);
    statements.insertSourcePayload.run(
      dailyImportId,
      'dump:daily.days[]',
      day.date,
      canonicalPayloadHash(day.raw),
      stableStringify(day.raw)
    );

    totals.accountDimensionRows += writeAccountDimensions(batches, day, dailyImportId);

    /** Project, entity, and source type to slice id for heartbeat identities. */
    const sliceIndex = new Map<string, number>();
    let entitySecondsForDay = 0;

    for (const project of day.projects) {
      const projectId = projects.idFor(project.name, day.date);

      // Account-scope project rollup. Kept in the same table as every other
      // dimension so a query can never sum it together with project scope.
      batches.dimensions.add([
        day.date, 'account', null, 'project', project.name, null, null, null,
        project.grandTotal.total_seconds, project.percent,
        project.grandTotal.human_additions, project.grandTotal.human_deletions,
        project.grandTotal.ai_additions, project.grandTotal.ai_deletions,
        project.grandTotal.ai_sessions, stableStringify(project.grandTotal.raw), dailyImportId
      ]);
      totals.accountDimensionRows++;

      const projectDimensions: Array<[Dimension, BreakdownItem[]]> = [
        ['branch', project.branches],
        ['category', project.categories],
        ['dependency', project.dependencies],
        ['editor', project.editors],
        ['language', project.languages],
        ['machine', project.machines],
        ['operating_system', project.operating_systems],
        ['entity', project.entities]
      ];

      for (const [dimension, items] of projectDimensions) {
        for (const item of items) {
          const isEntity = dimension === 'entity';
          const name = isEntity ? normalizeEntity(item.name, item.entity_type ?? 'file') : item.name;
          batches.dimensions.add([
            day.date, 'project', projectId, dimension, name,
            isEntity ? item.entity_type : null,
            dimension === 'machine' ? item.machine_name_id : null,
            isEntity ? item.project_root_count : null,
            item.total_seconds, item.percent,
            item.human_additions, item.human_deletions,
            item.ai_additions, item.ai_deletions, item.ai_sessions,
            stableStringify(item.raw), dailyImportId
          ]);
          totals.projectDimensionRows++;
        }
      }

      // The official additive slices: one per daily project entity row. These
      // carry the only per-entity duration the application ever reports.
      for (const entity of project.entities) {
        const entityType = entity.entity_type ?? 'file';
        const name = normalizeEntity(entity.name, entityType);
        const key = sliceKey(project.name, name, entityType);
        const merged = sliceIndex.has(key);
        const { id: sliceId } = statements.insertSlice.get(
          day.date, projectId, name, entityType, 'entity', entity.total_seconds, entity.percent,
          entity.project_root_count, entity.human_additions, entity.human_deletions,
          entity.ai_additions, entity.ai_deletions, entity.ai_sessions, 0, dailyImportId
        ) as { id: number };

        entitySecondsForDay += entity.total_seconds;
        if (merged) totals.mergedSliceRows++;
        else totals.sliceCount++;
        sliceIndex.set(key, sliceId);

        for (const identity of sliceIntrinsicIdentities({
          projectName: project.name,
          entity: name,
          entityType
        })) {
          batches.identities.add([sliceId, identity.selectorType, identity.value, 'slice', 0]);
        }
      }
    }

    // Residual slice: authoritative daily time the entity rows do not account
    // for. Clamped at zero, never invented. Also created for a day that has
    // heartbeats but no official entity rows, so that day's evidence has an
    // owner.
    const residual = day.grandTotal.total_seconds - entitySecondsForDay;
    let unattributedSliceId: number | null = null;
    if (residual > DIVERGENCE_TOLERANCE_SECONDS || heartbeatDay.heartbeats.length > 0) {
      const seconds = Math.max(0, residual);
      unattributedSliceId = (
        statements.insertSlice.get(
          day.date, projects.unattributedId, UNATTRIBUTED, 'unattributed', 'unattributed_residual',
          seconds, null, null, 0, 0, 0, 0, 0, 1, dailyImportId
        ) as { id: number }
      ).id;
      totals.sliceCount++;
      totals.unattributedSliceCount++;
      totals.unattributedSeconds += seconds;
    }

    // Heartbeats are evidence for the day's slices. They contribute identity
    // associations and never a single second of duration.
    for (let i = 0; i < heartbeatDay.heartbeats.length; i++) {
      const beat = validateHeartbeat(heartbeatDay.heartbeats[i], day.date, i);
      const canonicalPayload = canonicalHeartbeatPayload(beat.raw);
      const canonicalHash = canonicalPayloadHash(canonicalPayload);
      const dependencies = canonicalizeDependencies(beat.dependencies);

      totals.dependencyRelationships += beat.dependencies.length;

      const previousHash = seenHeartbeats.get(beat.id);
      if (previousHash !== undefined) {
        totals.duplicateOccurrences++;

        if (previousHash === canonicalHash) {
          // Canonically identical repeat: idempotent, just count the occurrence.
          totals.duplicateHeartbeatIds++;
          statements.bumpHeartbeatOccurrence.run(beat.id);
          statements.bumpVariantOccurrence.run(beat.id, canonicalHash);
          continue;
        }

        totals.conflictingHeartbeatIds++;
        if (!context.allowConflicts) {
          throw new HeartbeatConflictError(beat.id, previousHash, canonicalHash);
        }

        const conflict = `Quarantined conflicting payload for heartbeat ${redact(beat.id)} on ${day.date}`;
        warnings.push(conflict);
        log.warn(conflict);
        statements.insertVariant.run(
          beat.id, canonicalHash, stableStringify(canonicalPayload), 'conflict', heartbeatImportId
        );
        continue;
      }

      seenHeartbeats.set(beat.id, canonicalHash);

      const occurredAtUs = toEpochMicroseconds(beat.time);
      const entity = normalizeEntity(beat.entity, beat.type);
      const projectId = beat.project === null ? null : projects.idFor(beat.project, day.date);

      const heartbeatId = Number(
        statements.insertHeartbeat.run(
          beat.id, occurredAtUs, toIsoUtc(occurredAtUs), day.date, entity, beat.type, beat.category,
          projectId, beat.project, beat.branch, beat.language, beat.project_root_count,
          beat.machine_name_id, beat.user_agent_id, beat.lines, beat.lineno, beat.cursorpos,
          beat.is_write ? 1 : 0, beat.ai_session, beat.ai_subscription_plan, beat.ai_line_changes,
          beat.human_line_changes, beat.ai_input_tokens, beat.ai_cached_input_tokens,
          beat.ai_output_tokens, beat.ai_prompt_length, canonicalHash, heartbeatImportId
        ).lastInsertRowid
      );

      // Dump evidence is the active baseline until a live heartbeat snapshot
      // replaces this day's membership set during reconciliation.
      statements.insertMembership.run(day.date, heartbeatId);

      statements.insertVariant.run(
        beat.id, canonicalHash, stableStringify(canonicalPayload), 'canonical', heartbeatImportId
      );

      for (let position = 0; position < dependencies.length; position++) {
        batches.dependencies.add([heartbeatId, dependencies[position], position]);
        totals.canonicalDependencyRows++;
      }

      // Attach the heartbeat's machine and editor identity to the slice it
      // belongs to. When the daily export has no matching entity row (the
      // sparse days that record heartbeats but zero seconds), it lands on the
      // day's unattributed slice rather than being discarded.
      // URL heartbeats attach only to a matching URL slice. Without one they
      // remain raw evidence and never lend identities to a residual slice.
      const matchingSliceId = beat.project === null
        ? undefined
        : sliceIndex.get(sliceKey(beat.project, entity, beat.type));
      const sliceId = matchingSliceId ??
        (beat.type === 'url' ? undefined : unattributedSliceId ?? undefined);

      if (sliceId !== undefined) {
        for (const identity of heartbeatSliceIdentities({
          machineNameId: beat.machine_name_id,
          userAgentId: beat.user_agent_id
        })) {
          const key = `${sliceId}\u0000${identity.selectorType}\u0000${identity.value}`;
          const existing = identityCounts.get(key);
          if (existing) existing.count++;
          else
            identityCounts.set(key, {
              sliceId,
              selectorType: identity.selectorType,
              value: identity.value,
              count: 1
            });
        }
      }

      totals.heartbeatCount++;
    }

    // Flush per day so peak memory stays bounded by a single day's rows, and so
    // the identity upserts see their slices already written.
    batches.dimensions.flush();
    batches.dependencies.flush();
    batches.identities.flush();

    for (const entry of identityCounts.values()) {
      batches.identities.add([entry.sliceId, entry.selectorType, entry.value, 'heartbeat', entry.count]);
    }
    identityCounts.clear();
    batches.identities.flush();
  }

  batches.dimensions.flush();
  batches.dependencies.flush();
  batches.identities.flush();

  const sliceIdentityRows = (
    db.prepare('SELECT COUNT(*) AS n FROM slice_identities').get() as { n: number }
  ).n;
  const storedDimensionRows = (
    db.prepare('SELECT COUNT(*) AS n FROM daily_dimension_totals').get() as { n: number }
  ).n;

  if (totals.mergedSliceRows > 0) {
    const warning =
      `${totals.mergedSliceRows} entity rows merged into an existing slice after path normalization ` +
      `(case-variant or trailing-slash duplicates of the same file)`;
    warnings.push(warning);
    log.warn(warning);
  }

  const rangeStartDate = firstDate ?? '';
  const rangeEndDate = lastDate ?? '';
  const warningsJson = warnings.length > 0 ? JSON.stringify(warnings) : null;

  statements.closeSourceImport.run(
    rangeStartDate, rangeEndDate, totals.dayCount, totals.dayCount, 0, 0, warningsJson, dailyImportId
  );
  statements.closeSourceImport.run(
    rangeStartDate, rangeEndDate, totals.dayCount, totals.heartbeatCount,
    totals.duplicateOccurrences, totals.conflictingHeartbeatIds, warningsJson, heartbeatImportId
  );

  log.info(
    `Imported ${totals.dayCount} days, ${totals.sliceCount} slices, ` +
      `${totals.heartbeatCount} heartbeats, ${totals.canonicalDependencyRows} dependency rows`
  );

  return {
    dryRun: context.dryRun,
    alreadyImported: false,
    dailyImportId,
    heartbeatImportId,
    dailySourceHash: context.daily.sourceHash,
    heartbeatSourceHash: context.heartbeat.sourceHash,
    rangeStartDate,
    rangeEndDate,
    projectCount: projects.count,
    sliceIdentityRows,
    storedDimensionRows,
    warnings,
    ...totals
  };
}

function sliceKey(projectName: string, entity: string, entityType: string): string {
  return `${projectName}\u0000${entity}\u0000${entityType}`;
}

/** Resolves project names to ids, creating rows and widening activity bounds. */
class ProjectRegistry {
  readonly #cache = new Map<string, { id: number; lastDate: string }>();
  readonly #insert: Database.Statement;
  readonly #touch: Database.Statement;
  readonly unattributedId: number;

  constructor(db: Database.Database) {
    this.#insert = db.prepare(
      `INSERT INTO projects (name, first_activity_date, last_activity_date)
       VALUES (?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET
         last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       RETURNING id`
    );
    // MIN/MAX here are the two-argument scalar forms, and YYYY-MM-DD compares
    // correctly as text, so the bounds widen regardless of visit order.
    this.#touch = db.prepare(
      `UPDATE projects
       SET first_activity_date = MIN(COALESCE(first_activity_date, ?), ?),
           last_activity_date  = MAX(COALESCE(last_activity_date, ?), ?)
       WHERE id = ?`
    );

    const row = db.prepare('SELECT id FROM projects WHERE name = ?').get(UNATTRIBUTED) as
      | { id: number }
      | undefined;
    if (!row) throw new Error('Missing __unattributed__ pseudo-project; migrations are incomplete');
    this.unattributedId = row.id;
  }

  /** Distinct real project names seen so far, excluding the pseudo-project. */
  get count(): number {
    return this.#cache.size;
  }

  idFor(name: string, activityDate: string): number {
    const cached = this.#cache.get(name);
    if (cached !== undefined) {
      // Skip the update while a project keeps appearing within the same day;
      // otherwise every heartbeat would issue its own redundant UPDATE.
      if (cached.lastDate !== activityDate) {
        this.#touch.run(activityDate, activityDate, activityDate, activityDate, cached.id);
        cached.lastDate = activityDate;
      }
      return cached.id;
    }

    const { id } = this.#insert.get(name, activityDate, activityDate) as { id: number };
    this.#touch.run(activityDate, activityDate, activityDate, activityDate, id);
    this.#cache.set(name, { id, lastDate: activityDate });
    return id;
  }
}

function openSourceImport(
  context: RunContext,
  sourceType: 'daily_dump' | 'heartbeat_dump',
  file: { byteSize: number; sourceHash: string }
): number {
  const info = context.db
    .prepare(
      `INSERT INTO source_imports (source_type, source_hash, byte_size, dry_run)
       VALUES (?, ?, ?, ?)`
    )
    .run(sourceType, file.sourceHash, file.byteSize, context.dryRun ? 1 : 0);
  return Number(info.lastInsertRowid);
}

function upsertAccountSettings(db: Database.Database, user: DumpUser, sourceImportId: number): void {
  db.prepare(
    `INSERT INTO account_settings
       (wakatime_user_id, timezone, weekday_start, keystroke_timeout_seconds,
        writes_only, plan, has_premium_features, source_import_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (wakatime_user_id) DO UPDATE SET
       timezone                  = excluded.timezone,
       weekday_start             = excluded.weekday_start,
       keystroke_timeout_seconds = excluded.keystroke_timeout_seconds,
       writes_only               = excluded.writes_only,
       plan                      = excluded.plan,
       has_premium_features      = excluded.has_premium_features,
       source_import_id          = excluded.source_import_id,
       updated_at                = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  ).run(
    user.id,
    user.timezone ?? 'UTC',
    user.weekday_start ?? 0,
    user.timeout ?? 15,
    user.writes_only ? 1 : 0,
    user.plan,
    user.has_premium_features ? 1 : 0,
    sourceImportId
  );
}

function writeDailyTotal(
  statements: Statements,
  day: DailyDay,
  projectSum: number,
  delta: number,
  sourceImportId: number,
  sourceHash: string
): void {
  const total = day.grandTotal;
  const modelData = {
    breakdown: total.raw.ai_model_breakdown ?? null,
    costs: total.raw.ai_model_costs ?? null,
    line_changes: total.raw.ai_model_line_changes ?? null
  };

  statements.insertDailyTotal.run(
    day.date,
    total.total_seconds,
    total.human_additions,
    total.human_deletions,
    total.ai_additions,
    total.ai_deletions,
    total.ai_sessions,
    total.ai_input_tokens,
    total.ai_cached_input_tokens,
    total.ai_output_tokens,
    total.ai_prompt_length_sum,
    total.ai_model_total_cost,
    stableStringify(modelData),
    stableStringify(total.raw),
    projectSum,
    delta,
    sourceImportId,
    sourceHash
  );
}

function writeAccountDimensions(batches: Batches, day: DailyDay, sourceImportId: number): number {
  const dimensions: Array<[Dimension, BreakdownItem[]]> = [
    ['category', day.categories],
    ['dependency', day.dependencies],
    ['editor', day.editors],
    ['language', day.languages],
    ['machine', day.machines],
    ['operating_system', day.operating_systems]
  ];

  let written = 0;
  for (const [dimension, items] of dimensions) {
    for (const item of items) {
      batches.dimensions.add([
        day.date, 'account', null, dimension, item.name, null,
        dimension === 'machine' ? item.machine_name_id : null, null,
        item.total_seconds, item.percent,
        item.human_additions, item.human_deletions,
        item.ai_additions, item.ai_deletions, item.ai_sessions,
        stableStringify(item.raw), sourceImportId
      ]);
      written++;
    }
  }
  return written;
}

interface Statements {
  insertSourcePayload: Database.Statement;
  insertDailyTotal: Database.Statement;
  insertSlice: Database.Statement;
  insertHeartbeat: Database.Statement;
  insertMembership: Database.Statement;
  insertVariant: Database.Statement;
  bumpHeartbeatOccurrence: Database.Statement;
  bumpVariantOccurrence: Database.Statement;
  closeSourceImport: Database.Statement;
}

function prepareStatements(db: Database.Database): Statements {
  return {
    insertSourcePayload: db.prepare(
      `INSERT INTO source_payloads (source_import_id, endpoint, covered_date, payload_hash, payload_json)
       VALUES (?, ?, ?, ?, ?)`
    ),
    insertDailyTotal: db.prepare(
      `INSERT INTO daily_totals
         (date, total_seconds, human_additions, human_deletions, ai_additions, ai_deletions,
          ai_sessions, ai_input_tokens, ai_cached_input_tokens, ai_output_tokens,
          ai_prompt_length_sum, ai_model_total_cost, ai_model_data_json, grand_total_json,
          project_sum_seconds, project_sum_delta, source_import_id, source_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    // Normalization can map two source entity rows onto one slice (WakaTime
    // records the same Windows path with inconsistent drive casing, and
    // occasionally with a trailing slash). They are the same file, and their
    // seconds are additive within the project, so the rows merge by summing
    // rather than colliding.
    insertSlice: db.prepare(
      `INSERT INTO day_project_entity_slices
         (date, project_id, entity, entity_type, kind, total_seconds, percent, project_root_count,
          human_additions, human_deletions, ai_additions, ai_deletions, ai_sessions,
          is_unattributed, source_import_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (date, project_id, entity, entity_type, kind) DO UPDATE SET
         total_seconds      = total_seconds + excluded.total_seconds,
         percent            = COALESCE(percent, 0) + COALESCE(excluded.percent, 0),
         project_root_count = COALESCE(project_root_count, excluded.project_root_count),
         human_additions    = human_additions + excluded.human_additions,
         human_deletions    = human_deletions + excluded.human_deletions,
         ai_additions       = ai_additions + excluded.ai_additions,
         ai_deletions       = ai_deletions + excluded.ai_deletions,
         ai_sessions        = ai_sessions + excluded.ai_sessions
       RETURNING id`
    ),
    insertHeartbeat: db.prepare(
      `INSERT INTO heartbeats
         (external_id, occurred_at_us, occurred_at, local_date, entity, entity_type, category,
          project_id, project_name, branch, language, project_root_count, machine_name_id,
          user_agent_id, lines, lineno, cursorpos, is_write, ai_session, ai_subscription_plan,
          ai_line_changes, human_line_changes, ai_input_tokens, ai_cached_input_tokens,
          ai_output_tokens, ai_prompt_length, canonical_hash, source_import_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    insertMembership: db.prepare(
      `INSERT INTO heartbeat_memberships (date, heartbeat_id, active)
       VALUES (?, ?, 1)
       ON CONFLICT(date, heartbeat_id) DO NOTHING`
    ),
    insertVariant: db.prepare(
      `INSERT INTO heartbeat_variants (external_id, canonical_hash, raw_json, conflict_state, source_import_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (external_id, canonical_hash) DO UPDATE SET
         occurrence_count = occurrence_count + 1,
         last_seen_at     = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ),
    bumpHeartbeatOccurrence: db.prepare(
      `UPDATE heartbeats
       SET occurrence_count = occurrence_count + 1,
           last_seen_at     = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE external_id = ?`
    ),
    bumpVariantOccurrence: db.prepare(
      `UPDATE heartbeat_variants
       SET occurrence_count = occurrence_count + 1,
           last_seen_at     = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE external_id = ? AND canonical_hash = ?`
    ),
    closeSourceImport: db.prepare(
      `UPDATE source_imports
       SET finished_at      = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           status           = 'completed',
           range_start_date = ?,
           range_end_date   = ?,
           day_count        = ?,
           record_count     = ?,
           duplicate_count  = ?,
           conflict_count   = ?,
           warnings_json    = ?
       WHERE id = ?`
    )
  };
}

interface Batches {
  dimensions: BatchInserter<readonly unknown[]>;
  dependencies: BatchInserter<readonly unknown[]>;
  identities: BatchInserter<readonly unknown[]>;
}

function createBatches(db: Database.Database): Batches {
  return {
    dimensions: new BatchInserter(db, {
      prefix: `INSERT INTO daily_dimension_totals
        (date, scope, project_id, dimension, name, entity_type, machine_name_id,
         project_root_count, total_seconds, percent, human_additions, human_deletions,
         ai_additions, ai_deletions, ai_sessions, raw_json, source_import_id)`,
      columnCount: 17,
      // Same normalization collapse as the slices, for the entity dimension.
      // The first row's raw_json is kept; only the measures accumulate.
      suffix: `ON CONFLICT (date, scope, project_key, dimension, name) DO UPDATE SET
                 total_seconds   = total_seconds + excluded.total_seconds,
                 percent         = COALESCE(percent, 0) + COALESCE(excluded.percent, 0),
                 human_additions = human_additions + excluded.human_additions,
                 human_deletions = human_deletions + excluded.human_deletions,
                 ai_additions    = ai_additions + excluded.ai_additions,
                 ai_deletions    = ai_deletions + excluded.ai_deletions,
                 ai_sessions     = ai_sessions + excluded.ai_sessions`
    }),
    dependencies: new BatchInserter(db, {
      prefix: 'INSERT INTO heartbeat_dependencies (heartbeat_id, name, position)',
      columnCount: 3,
      suffix: 'ON CONFLICT (heartbeat_id, name) DO NOTHING'
    }),
    identities: new BatchInserter(db, {
      prefix: 'INSERT INTO slice_identities (slice_id, selector_type, value, source, observed_heartbeats)',
      columnCount: 5,
      suffix: `ON CONFLICT (slice_id, selector_type, value) DO UPDATE SET
                 observed_heartbeats = observed_heartbeats + excluded.observed_heartbeats`
    })
  };
}
