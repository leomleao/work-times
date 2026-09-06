import type Database from 'better-sqlite3';
import {
  boundedStringList,
  clampCount,
  sourceHashPrefix,
  truncateNullableText,
  truncateText,
  allowlistedValue,
  MAX_LABEL_LENGTH,
  SOURCE_IMPORT_STATUSES,
  SOURCE_IMPORT_TYPES
} from './sanitize.js';

/** Hard cap on ledger rows materialized for the imports page. */
export const MAX_IMPORT_ROWS = 100;
/** Hard cap on warnings surfaced per import row. */
export const MAX_IMPORT_WARNINGS = 25;

export interface SourceImportItem {
  id: number;
  sourceType: string;
  /**
   * Leading hex characters of the payload SHA-256 only. The full digest is a
   * fingerprint of the exact bytes ingested and never reaches the page.
   */
  sourceHashPrefix: string;
  byteSize: number;
  formattedByteSize: string;
  rangeStartDate: string | null;
  rangeEndDate: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  dryRun: boolean;
  dayCount: number;
  recordCount: number;
  duplicateCount: number;
  conflictCount: number;
  warnings: string[];
  /** Warnings dropped by `MAX_IMPORT_WARNINGS`, so the UI can say so. */
  omittedWarnings: number;
  errorSummary: string | null;
}

export interface ImportsViewData {
  sourceImports: SourceImportItem[];
  totalImports: number;
  /** Rows beyond `MAX_IMPORT_ROWS` that the ledger did not materialize. */
  omittedImports: number;
  isEmpty: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function getImportsData(db: Database.Database): ImportsViewData {
  const totalRow = db.prepare('SELECT COUNT(*) AS count FROM source_imports').get() as {
    count: number;
  };
  const totalImports = clampCount(totalRow?.count);

  const rows = db
    .prepare(
      `SELECT id, source_type, source_hash, byte_size,
              range_start_date, range_end_date, started_at, finished_at,
              status, dry_run, day_count, record_count, duplicate_count,
              conflict_count, warnings_json, error_summary
       FROM source_imports
       ORDER BY id DESC LIMIT ?`
    )
    .all(MAX_IMPORT_ROWS) as Array<{
      id: number;
      source_type: string;
      source_hash: string;
      byte_size: number;
      range_start_date: string | null;
      range_end_date: string | null;
      started_at: string;
      finished_at: string | null;
      status: string;
      dry_run: number;
      day_count: number;
      record_count: number;
      duplicate_count: number;
      conflict_count: number;
      warnings_json: string | null;
      error_summary: string | null;
    }>;

  const sourceImports: SourceImportItem[] = rows.map((r) => {
    let parsedWarnings: unknown[] = [];
    if (r.warnings_json) {
      try {
        const parsed = JSON.parse(r.warnings_json);
        if (Array.isArray(parsed)) parsedWarnings = parsed;
      } catch {
        // A malformed warnings blob is reported as "no warnings" rather than
        // failing the whole ledger render.
      }
    }
    const warnings = boundedStringList(parsedWarnings, MAX_IMPORT_WARNINGS);

    const byteSize = clampCount(r.byte_size);

    return {
      id: r.id,
      sourceType: allowlistedValue(r.source_type, SOURCE_IMPORT_TYPES),
      sourceHashPrefix: sourceHashPrefix(r.source_hash),
      byteSize,
      formattedByteSize: formatBytes(byteSize),
      rangeStartDate: truncateNullableText(r.range_start_date, MAX_LABEL_LENGTH),
      rangeEndDate: truncateNullableText(r.range_end_date, MAX_LABEL_LENGTH),
      startedAt: truncateText(r.started_at, MAX_LABEL_LENGTH),
      finishedAt: truncateNullableText(r.finished_at, MAX_LABEL_LENGTH),
      status: allowlistedValue(r.status, SOURCE_IMPORT_STATUSES),
      dryRun: Boolean(r.dry_run),
      dayCount: clampCount(r.day_count),
      recordCount: clampCount(r.record_count),
      duplicateCount: clampCount(r.duplicate_count),
      conflictCount: clampCount(r.conflict_count),
      warnings,
      omittedWarnings: Math.max(0, parsedWarnings.length - warnings.length),
      errorSummary: truncateNullableText(r.error_summary)
    };
  });

  return {
    sourceImports,
    totalImports,
    omittedImports: Math.max(0, totalImports - sourceImports.length),
    isEmpty: sourceImports.length === 0
  };
}
