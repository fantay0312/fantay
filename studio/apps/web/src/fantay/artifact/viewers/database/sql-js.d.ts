// SPDX-License-Identifier: AGPL-3.0-only
// The part of sql.js 1.x the database viewer uses. The package ships no typings and `@types/sql.js`
// is not installed; delete this file if it ever is.
declare module 'sql.js' {
  export type SqlValue = number | bigint | string | Uint8Array | null;

  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }

  export interface Statement {
    step(): boolean;
    /** The current row. `useBigInt` returns integers as BigInt, so 64-bit ids are not rounded. */
    get(params?: SqlValue[] | null, config?: { useBigInt?: boolean }): SqlValue[];
    free(): boolean;
  }

  export class Database {
    constructor(data?: Uint8Array | null);
    run(sql: string): Database;
    exec(sql: string, params?: SqlValue[]): QueryExecResult[];
    prepare(sql: string, params?: SqlValue[]): Statement;
    /** The database as the bytes of a file. */
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export interface SqlJsConfig {
    /** Where the engine's .wasm file is served from. */
    locateFile?(file: string): string;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}

// The build without Node's `fs` and `crypto` branches, for bundling into a worker.
declare module 'sql.js/dist/sql-wasm-browser.js' {
  import initSqlJs from 'sql.js';

  export default initSqlJs;
}
