// SPDX-License-Identifier: Apache-2.0
// Thin `board-changed` invalidation sent on the project SSE stream after each committed revision (spec 04 B5).
import {
  BOARD_CHANGED_SSE_EVENT,
  type BoardActor,
  type BoardChangeReason,
  type BoardChangedSsePayload,
} from '@open-design/contracts';

export function boardChangedPayload(
  projectId: string,
  revision: number,
  reason: BoardChangeReason,
  actor: BoardActor,
  now: number,
): BoardChangedSsePayload {
  return { type: BOARD_CHANGED_SSE_EVENT, projectId, revision, reason, actor, at: now };
}
