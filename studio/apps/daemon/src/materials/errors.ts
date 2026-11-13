// Typed failures of the materials domain. Routes translate them into the
// shared `MaterialErrorResponse` envelope; the CLI surfaces the same codes.

import type { MaterialErrorCode, MaterialLibraryUnavailableReason } from '@open-design/contracts';

export class MaterialError extends Error {
  readonly code: MaterialErrorCode;
  readonly status: number;

  constructor(code: MaterialErrorCode, status: number, message: string) {
    super(message);
    this.name = 'MaterialError';
    this.code = code;
    this.status = status;
  }
}

/** The library cannot be used right now; carries the status reason for `/summary`. */
export class MaterialLibraryUnavailableError extends MaterialError {
  readonly reason: MaterialLibraryUnavailableReason;

  constructor(reason: MaterialLibraryUnavailableReason, message: string) {
    super('library-unavailable', 503, message);
    this.name = 'MaterialLibraryUnavailableError';
    this.reason = reason;
  }
}

export function isMaterialError(error: unknown): error is MaterialError {
  return error instanceof MaterialError;
}

export const unsafePath = (message: string): MaterialError => new MaterialError('unsafe-path', 403, message);
export const missingFile = (message: string): MaterialError => new MaterialError('missing-file', 404, message);
export const invalidRequest = (message: string): MaterialError =>
  new MaterialError('invalid-request', 400, message);
export const unknownId = (id: string): MaterialError => new MaterialError('unknown-id', 404, `Unknown ID: ${id}`);
