// SPDX-License-Identifier: AGPL-3.0-only
// Reading a SQLite file for looking only: which tables and views are listed, what a page of rows
// looks like as text, and that nothing can be written. Runs the real engine (sql.js) under Node.
import initSqlJs, { type Database } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  describeDatabase,
  isSqliteFile,
  lockDatabase,
  quoteIdentifier,
  readRows,
} from '../../../src/fantay/artifact/viewers/database/read-database';

let database: Database;
let exported: Uint8Array;

beforeAll(async () => {
  const sql = await initSqlJs();
  const source = new sql.Database();
  source.run(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT, balance NUMERIC(10,2), avatar BLOB, big INTEGER);
    CREATE TABLE "订单 ""明细""" (sku VARCHAR(16) PRIMARY KEY, qty INTEGER NOT NULL, note);
    CREATE TABLE empty_table (a, b);
    CREATE VIEW v_city AS SELECT city, count(*) AS people FROM customers GROUP BY city ORDER BY city;
    CREATE VIEW broken_view AS SELECT * FROM missing_table;
    CREATE VIRTUAL TABLE search USING fts3(body);
    INSERT INTO customers VALUES (1, '王伟', '上海', 1234.5, x'00ff10', 9007199254740993);
    INSERT INTO customers VALUES (2, '李芳', NULL, 0, NULL, -1);
    INSERT INTO customers VALUES (3, '张敏', '上海', 88.08, x'', 3);
    INSERT INTO "订单 ""明细""" VALUES ('SKU-1', 2, '${'长'.repeat(5000)}');
  `);
  for (let index = 4; index <= 260; index += 1) source.run(`INSERT INTO customers VALUES (${index}, '客户${index}', '北京', ${index}.5, NULL, ${index})`);
  exported = source.export();
  source.close();
  database = new sql.Database(exported);
  lockDatabase(database);
});

describe('isSqliteFile', () => {
  it('knows a database by its header', () => {
    expect(isSqliteFile(exported)).toBe(true);
    expect(isSqliteFile(new TextEncoder().encode('this file is named like a database but holds plain text'))).toBe(false);
    expect(isSqliteFile(new Uint8Array(4))).toBe(false);
  });
});

describe('quoteIdentifier', () => {
  it('quotes a name and doubles a quote inside it', () => {
    expect(quoteIdentifier('orders')).toBe('"orders"');
    expect(quoteIdentifier('订单 "明细"')).toBe('"订单 ""明细"""');
  });
});

describe('describeDatabase', () => {
  it('lists tables, then views, without the engine\'s own and virtual tables', () => {
    const model = describeDatabase(database);
    const names = model.tables.map((table) => `${table.kind}:${table.name}`);
    expect(names.slice(0, 3)).toEqual(['table:customers', 'table:empty_table', 'table:订单 "明细"']);
    expect(names).toContain('view:v_city');
    expect(names).toContain('view:broken_view');
    expect(names.some((name) => name.includes('sqlite_'))).toBe(false);
    expect(names).not.toContain('table:search');
    expect(names.indexOf('view:v_city')).toBeGreaterThan(names.indexOf('table:订单 "明细"'));
    expect(model.truncated).toBe(false);
  });

  it('describes columns with their declared type and key', () => {
    const customers = describeDatabase(database).tables.find((table) => table.name === 'customers');
    expect(customers?.rowCount).toBe(260);
    expect(customers?.columns).toEqual([
      { name: 'id', type: 'INTEGER', primaryKey: true, notNull: false },
      { name: 'name', type: 'TEXT', primaryKey: false, notNull: true },
      { name: 'city', type: 'TEXT', primaryKey: false, notNull: false },
      { name: 'balance', type: 'NUMERIC(10,2)', primaryKey: false, notNull: false },
      { name: 'avatar', type: 'BLOB', primaryKey: false, notNull: false },
      { name: 'big', type: 'INTEGER', primaryKey: false, notNull: false },
    ]);
  });

  it('counts a view\'s rows and marks a view that cannot be read', () => {
    const model = describeDatabase(database);
    expect(model.tables.find((table) => table.name === 'v_city')).toMatchObject({ kind: 'view', rowCount: 3, readable: true });
    expect(model.tables.find((table) => table.name === 'broken_view')).toMatchObject({ readable: false, rowCount: 0, head: [] });
    expect(model.tables.find((table) => table.name === 'empty_table')).toMatchObject({ rowCount: 0, readable: true, head: [] });
  });

  it('sends the first rows along with each table', () => {
    const customers = describeDatabase(database).tables.find((table) => table.name === 'customers');
    expect(customers?.head).toHaveLength(200);
    expect(customers?.head?.[0]?.cells[1]).toBe('王伟');
  });
});

describe('readRows', () => {
  it('reads values as text with their storage class', () => {
    const model = describeDatabase(database);
    const customers = model.tables.find((table) => table.name === 'customers');
    if (!customers) throw new Error('customers missing');
    const rows = readRows(database, customers, 0, 3);
    expect(rows[0]).toEqual({ cells: ['1', '王伟', '上海', '1234.5', 'BLOB · 3 B', '9007199254740993'], kinds: 'nssnxn' });
    expect(rows[1]).toEqual({ cells: ['2', '李芳', 'NULL', '0', 'NULL', '-1'], kinds: 'nsznzn' });
    expect(rows[2]?.cells[4]).toBe('BLOB · 0 B');
  });

  it('pages with a limit and an offset', () => {
    const customers = describeDatabase(database).tables.find((table) => table.name === 'customers');
    if (!customers) throw new Error('customers missing');
    const page = readRows(database, customers, 250, 200);
    expect(page).toHaveLength(10);
    expect(page[0]?.cells[0]).toBe('251');
    expect(readRows(database, customers, 9999, 50)).toEqual([]);
    expect(readRows(database, customers, 0, 0)).toEqual([]);
  });

  it('reads a table with an awkward name and cuts very long text', () => {
    const orders = describeDatabase(database).tables.find((table) => table.name === '订单 "明细"');
    if (!orders) throw new Error('orders missing');
    const rows = readRows(database, orders, 0, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cells[0]).toBe('SKU-1');
    expect(rows[0]?.cells[2]).toHaveLength(4000);
  });

  it('reads a view like a table', () => {
    const view = describeDatabase(database).tables.find((table) => table.name === 'v_city');
    if (!view) throw new Error('view missing');
    expect(readRows(database, view, 0, 10).map((row) => row.cells)).toEqual([
      ['NULL', '1'],
      ['上海', '2'],
      ['北京', '257'],
    ]);
  });
});

describe('lockDatabase', () => {
  it('lets nothing be written', () => {
    expect(() => database.run("INSERT INTO customers VALUES (999, 'x', 'y', 0, NULL, 0)")).toThrow();
    expect(() => database.run('DROP TABLE customers')).toThrow();
    expect(Number(database.exec('SELECT count(*) FROM customers')[0]?.values[0]?.[0])).toBe(260);
  });
});
