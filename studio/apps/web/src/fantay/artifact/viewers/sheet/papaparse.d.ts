// SPDX-License-Identifier: AGPL-3.0-only
// The part of Papa Parse 5 the sheet reader uses. The package ships no typings and `@types/papaparse`
// is not installed; delete this file if it ever is.
declare module 'papaparse' {
  export interface ParseMeta {
    delimiter: string;
    linebreak: string;
    aborted: boolean;
    truncated: boolean;
    cursor: number;
  }

  export interface ParseResult {
    data: string[][];
    errors: unknown[];
    meta: ParseMeta;
  }

  export interface Parser {
    pause(): void;
    resume(): void;
    abort(): void;
  }

  export interface ParseConfig {
    /** Empty to detect it from the first lines. */
    delimiter?: string;
    delimitersToGuess?: string[];
    header?: boolean;
    skipEmptyLines?: boolean | 'greedy';
    /** Characters per chunk when the input is a string. */
    chunkSize?: number;
    /** Called after each chunk; the parser can be paused and resumed from here. */
    chunk?(results: ParseResult, parser: Parser): void;
    /** With `chunk`, called with no results once the input is exhausted or the parse is aborted. */
    complete?(results?: ParseResult): void;
    error?(error: unknown): void;
  }

  export function parse(input: string, config?: ParseConfig): ParseResult | undefined;

  const Papa: { parse: typeof parse };
  export default Papa;
}
