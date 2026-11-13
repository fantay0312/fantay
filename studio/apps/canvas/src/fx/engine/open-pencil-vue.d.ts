// SPDX-License-Identifier: Apache-2.0
/**
 * Type-only wrapper for `@open-pencil/vue` 0.16.0, wired through tsconfig.json `paths` (Vite
 * and Vitest resolve the real package; nothing here exists at runtime).
 *
 * The published declarations inline private copies of a few core classes (`SkiaRenderer`,
 * `ResourceCache`), so the editor that `useSelectionState()` returns is not assignable to the
 * `Editor` type the same package re-exports from `@open-pencil/core/editor` (separate private
 * declarations never match). Upstream type-checks against sources and never sees this. The
 * wrapper re-exports the package and gives that one member the shared core type, so the
 * vendored UI type-checks unchanged. Revisit on the 0.17 upgrade (06 §1).
 */
import type { Editor } from '@open-pencil/core/editor';
import type { useSelectionState as sdkUseSelectionState } from '../../../node_modules/@open-pencil/vue/dist/index.js';

export * from '../../../node_modules/@open-pencil/vue/dist/index.js';

type SdkSelectionState = ReturnType<typeof sdkUseSelectionState>;

export declare function useSelectionState(): Omit<SdkSelectionState, 'editor'> & {
  editor: SdkSelectionState['editor'] & Editor;
};
