import type Database from 'better-sqlite3';

export interface SourceImportItem {
  id: number;
  sourceType: string;
  sourceHash: string;
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
  errorSummary: string | null;
}

export interface ImportsViewData {
  sourceImports: SourceImportItem[];
  totalImports: number;
  isEmpty: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function getImportsData(db: Database.Database): ImportsViewData {
  const totalRow = db.prepare('SELECT COUNT(*) AS count FROM source_imports').get() as {
    count: number;
  };
  const totalImports = totalRow?.count ?? 0;

  const rows = db
    .prepare(
      `SELECT id, source_type, source_hash, byte_size,
              range_start_date, range_end_date, started_at, finished_at,
              status, dry_run, day_count, record_count, duplicate_count,
              conflict_count, warnings_json, error_summary
       FROM source_imports
       ORDER BY id DESC LIMIT 100`
    )
    .all() as Array<{
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
    let warnings: string[] = [];
    if (r.warnings_json) {
      try {
        const parsed = JSON.parse(r.warnings_json);
        if (Array.isArray(parsed)) {
          warnings = parsed.map((w) => String(w));
        }
      } catch {}
    }

    return {
      id: r.id,
      sourceType: r.source_type,
      sourceHash: r.source_hash,
      byteSize: r.byte_size,
      formattedByteSize: formatBytes(r.byte_size),
      rangeStartDate: r.range_start_date,
      rangeEndDate: r.range_end_date,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      dryRun: Boolean(r.dry_run),
      dayCount: r.day_count,
      recordCount: r.record_count,
      duplicateCount: r.duplicate_count,
      conflictCount: r.conflict_count,
      warnings,
      errorSummary: r.error_summary
    };
  });

  return {
    sourceImports,
    totalImports,
    isEmpty: sourceImports.length === 0
  };
}
