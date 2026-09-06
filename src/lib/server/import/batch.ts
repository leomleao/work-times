import type Database from 'better-sqlite3';

/** SQLite's default cap on bound parameters per statement. */
const SQLITE_MAX_VARIABLES = 999;

/**
 * Multi-row insert helper.
 *
 * Emits `INSERT ... VALUES (?,?),(?,?),...` statements sized to stay under the
 * bound-parameter limit, and caches one prepared statement per distinct row
 * count so a long run only ever prepares two shapes: the full chunk and the
 * final remainder.
 *
 * This is what keeps the 220k dependency relationships and the per-slice
 * identity rows from becoming 220k separate round trips.
 */
export class BatchInserter<T extends readonly unknown[]> {
  readonly #db: Database.Database;
  readonly #prefix: string;
  readonly #suffix: string;
  readonly #columnCount: number;
  readonly #rowsPerChunk: number;
  readonly #statements = new Map<number, Database.Statement>();
  #pending: T[] = [];
  #flushed = 0;

  constructor(
    db: Database.Database,
    options: {
      /** e.g. `INSERT INTO t (a, b)` — without the VALUES clause. */
      prefix: string;
      columnCount: number;
      /** e.g. `ON CONFLICT (...) DO NOTHING`. Optional. */
      suffix?: string;
      /** Override the rows-per-statement chunk (tests). */
      rowsPerChunk?: number;
    }
  ) {
    if (options.columnCount < 1) throw new RangeError('columnCount must be at least 1');

    this.#db = db;
    this.#prefix = options.prefix;
    this.#suffix = options.suffix ? ` ${options.suffix}` : '';
    this.#columnCount = options.columnCount;
    this.#rowsPerChunk =
      options.rowsPerChunk ?? Math.max(1, Math.floor(SQLITE_MAX_VARIABLES / options.columnCount));
  }

  /** Number of rows written by flushes so far. */
  get flushedRows(): number {
    return this.#flushed;
  }

  add(row: T): void {
    if (row.length !== this.#columnCount) {
      throw new RangeError(`Expected ${this.#columnCount} values per row, received ${row.length}`);
    }
    this.#pending.push(row);
    if (this.#pending.length >= this.#rowsPerChunk) this.flush();
  }

  flush(): void {
    while (this.#pending.length > 0) {
      const chunk = this.#pending.splice(0, this.#rowsPerChunk);
      this.#statementFor(chunk.length).run(chunk.flat());
      this.#flushed += chunk.length;
    }
  }

  #statementFor(rowCount: number): Database.Statement {
    const cached = this.#statements.get(rowCount);
    if (cached) return cached;

    const tuple = `(${Array.from({ length: this.#columnCount }, () => '?').join(',')})`;
    const values = Array.from({ length: rowCount }, () => tuple).join(',');
    const statement = this.#db.prepare(`${this.#prefix} VALUES ${values}${this.#suffix}`);
    this.#statements.set(rowCount, statement);
    return statement;
  }
}
