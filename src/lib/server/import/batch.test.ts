import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { BatchInserter } from './batch.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE t (a INTEGER, b TEXT, UNIQUE (a, b))');
});

function rows(): Array<{ a: number; b: string }> {
  return db.prepare('SELECT a, b FROM t ORDER BY a').all() as Array<{ a: number; b: string }>;
}

describe('BatchInserter', () => {
  it('writes nothing until flushed', () => {
    const batch = new BatchInserter(db, { prefix: 'INSERT INTO t (a, b)', columnCount: 2 });
    batch.add([1, 'one']);
    expect(rows()).toEqual([]);

    batch.flush();
    expect(rows()).toEqual([{ a: 1, b: 'one' }]);
  });

  it('auto-flushes once a chunk fills, then keeps the remainder', () => {
    const batch = new BatchInserter(db, {
      prefix: 'INSERT INTO t (a, b)',
      columnCount: 2,
      rowsPerChunk: 2
    });

    batch.add([1, 'one']);
    batch.add([2, 'two']);
    expect(batch.flushedRows).toBe(2);

    batch.add([3, 'three']);
    expect(batch.flushedRows).toBe(2);

    batch.flush();
    expect(batch.flushedRows).toBe(3);
    expect(rows()).toHaveLength(3);
  });

  it('handles a row count that is not a multiple of the chunk size', () => {
    const batch = new BatchInserter(db, {
      prefix: 'INSERT INTO t (a, b)',
      columnCount: 2,
      rowsPerChunk: 4
    });
    for (let i = 0; i < 10; i++) batch.add([i, `row-${i}`]);
    batch.flush();

    expect(rows()).toHaveLength(10);
  });

  it('stays under the bound-parameter limit for a wide table', () => {
    const columns = Array.from({ length: 20 }, (_, i) => `c${i}`);
    db.exec(`CREATE TABLE wide (${columns.map((c) => `${c} INTEGER`).join(', ')})`);

    const batch = new BatchInserter(db, {
      prefix: `INSERT INTO wide (${columns.join(', ')})`,
      columnCount: columns.length
    });
    for (let i = 0; i < 200; i++) batch.add(columns.map(() => i));
    batch.flush();

    expect(db.prepare('SELECT COUNT(*) AS n FROM wide').get()).toEqual({ n: 200 });
  });

  it('applies a conflict clause across the whole batch', () => {
    const batch = new BatchInserter(db, {
      prefix: 'INSERT INTO t (a, b)',
      columnCount: 2,
      suffix: 'ON CONFLICT (a, b) DO NOTHING'
    });
    batch.add([1, 'one']);
    batch.add([1, 'one']);
    batch.flush();

    expect(rows()).toEqual([{ a: 1, b: 'one' }]);
  });

  it('rejects a row of the wrong width rather than misaligning columns', () => {
    const batch = new BatchInserter(db, { prefix: 'INSERT INTO t (a, b)', columnCount: 2 });
    expect(() => batch.add([1])).toThrow(RangeError);
  });

  it('flushing with nothing pending is a no-op', () => {
    const batch = new BatchInserter(db, { prefix: 'INSERT INTO t (a, b)', columnCount: 2 });
    batch.flush();
    expect(batch.flushedRows).toBe(0);
  });
});
