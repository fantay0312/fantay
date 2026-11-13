// SPDX-License-Identifier: Apache-2.0
// Errors of the project design-document service (spec 06 §7.3). Routes map them onto the contract's ApiErrorCodes:
// DesignConflictError → 409 CONFLICT (`details` = DesignConflictDetails, or reason `DESIGN_COVER_STALE` for covers);
// DesignInputError → 400 / 404 / 409 / 413 by reason (see `routes/designs.ts`).

export type DesignInputReason =
  | 'INVALID_DESIGN_PATH'
  | 'INVALID_DESIGN_DATA'
  | 'INVALID_COVER'
  | 'DESIGN_TOO_LARGE'
  | 'LEGACY_NOT_FOUND'
  | 'DESIGN_NOT_FOUND'
  | 'PATH_EXISTS';

export interface DesignInputErrorDetails {
  /** Canonical path to use instead (INVALID_DESIGN_PATH). */
  suggestion?: string;
  /** sha256 of the document already at the path (PATH_EXISTS). */
  currentSha256?: string | null;
  path?: string;
}

export class DesignInputError extends Error {
  constructor(
    readonly reason: DesignInputReason,
    message: string,
    readonly details: DesignInputErrorDetails = {},
  ) {
    super(message);
    this.name = 'DesignInputError';
  }
}

export type DesignConflictReason = 'DESIGN_REVISION_MISMATCH' | 'DESIGN_COVER_STALE';

/** Compare-and-swap failure: the document changed (or vanished, `currentSha256: null`) since the caller read it. */
export class DesignConflictError extends Error {
  constructor(
    readonly currentSha256: string | null,
    readonly path: string,
    readonly reason: DesignConflictReason = 'DESIGN_REVISION_MISMATCH',
  ) {
    super(
      reason === 'DESIGN_COVER_STALE'
        ? `the cover was rendered from another revision of ${path}`
        : currentSha256 === null
          ? `${path} does not exist`
          : `${path} changed (current sha256 ${currentSha256})`,
    );
    this.name = 'DesignConflictError';
  }
}
