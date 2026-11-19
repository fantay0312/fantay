// SPDX-License-Identifier: AGPL-3.0-only
// Shared shapes of the workspace surface system. A "surface" is one tool the right-hand workspace can
// show (预览 / 代码 / 浏览器 / 文件 / 画板 / 设计系统). Three engines may ask for one, and the user can
// always open one by hand:
//   · agent    — the model says so with `<od-focus tool="…"/>` (packages/contracts artifact-focus-marker)
//   · activity — code reads the turn's tool calls (`turn-changes.ts`) and infers the fitting surface
//   · content  — the long-standing file-kind ranking in `components/auto-open-file.ts`
// Pure types only; no React and no imports from FileWorkspace or ProjectView.

/** Mirror of `ARTIFACT_FOCUS_TOOLS` in `@open-design/contracts` (equality is asserted by a test). */
export const WORKSPACE_SURFACE_IDS = ['preview', 'code', 'browser', 'files', 'board', 'design-system'] as const;
export type WorkspaceSurfaceId = (typeof WORKSPACE_SURFACE_IDS)[number];

/** Who asked. When they disagree the order is user > agent > activity > content. */
export type SurfaceEngine = 'user' | 'agent' | 'activity' | 'content';

/** What the 代码 surface shows for its selected file. */
export type CodeSurfaceView = 'source' | 'changes';

/** One request to show a surface. Produced by `surface-router.ts`, carried out by ProjectView / FileWorkspace. */
export interface SurfaceIntent {
  surface: WorkspaceSurfaceId;
  engine: SurfaceEngine;
  /** Project-relative file: required for `preview`, optional for `code`. */
  file?: string;
  /** http(s) address, `browser` only. */
  url?: string;
  /** `code` only. */
  view?: CodeSurfaceView;
}

/**
 * One edit an agent tool call made to a file, as text before and after.
 * `before === null` means the call wrote the whole file (a Write, or a patch that adds the file).
 */
export interface TurnFileHunk {
  before: string | null;
  after: string;
}

/** Everything one turn did to one file, in call order. */
export interface TurnFileChange {
  /** Project-relative path, forward slashes. */
  path: string;
  status: 'created' | 'modified' | 'deleted';
  hunks: TurnFileHunk[];
  /** Line counts over all hunks; a whole-file write counts every line as added. */
  added: number;
  removed: number;
}
