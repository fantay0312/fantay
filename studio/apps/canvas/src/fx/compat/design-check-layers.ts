// SPDX-License-Identifier: Apache-2.0
/**
 * Shim for OpenPencil's `@/app/editor/design-check/layers` (06 §3.4). Design check is not part of
 * phase 1, so the Layers panel never shows issue marks.
 */
import type { DesignIssueSeverity } from '../engine/op';

export interface LayerIssueMark {
  severity: DesignIssueSeverity;
  count: number;
  own: boolean;
}

export function layerIssueMarks(_issues?: readonly unknown[], _graph?: unknown): Map<string, LayerIssueMark> | null {
  return null;
}
