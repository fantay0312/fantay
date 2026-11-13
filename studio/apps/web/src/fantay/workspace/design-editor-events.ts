// SPDX-License-Identifier: AGPL-3.0-only
// "Open in design editor" request (spec 05 §6.5, plan §3.1/R10). The generation media tools dispatch
// it on `window` (their `media-tools/events.ts` re-exports this module); the design host's
// `DesignEditorEventBridge` serves it and must call `ack` within 1500 ms, else the sender reports
// `unavailable`.
import type { BoardMediaFile } from '@open-design/contracts';

export const FANTAY_OPEN_DESIGN_EDITOR_EVENT = 'fantay:open-design-editor';

export interface OpenDesignEditorDetail {
  projectId: string;
  request: { kind: 'new-from-image'; image: BoardMediaFile; title: string; sourceNodeId: string };
  ack(result: { ok: boolean; message?: string }): void;
}
