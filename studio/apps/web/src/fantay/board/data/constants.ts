// SPDX-License-Identifier: AGPL-3.0-only
// Board web data-layer constants (spec 04 §7.1, plan R1). `BOARD_TAB_ID` is the workspace's board root tab
// (`BOARD_TAB` of the W1 host contract), re-exported under the data layer's name.
export { BOARD_TAB as BOARD_TAB_ID } from '../../workspace/board-host-contract';

/** Sync requests arriving within this window are merged into one POST /board/sync. */
export const BOARD_SYNC_COALESCE_MS = 150;
/** `filesGeneration` changes are debounced before a `files-changed` sync. */
export const BOARD_SYNC_FILES_DEBOUNCE_MS = 250;
/** Media task poll interval while a run is in flight or the board shows queued/running media. */
export const BOARD_MEDIA_POLL_MS = 1500;
/** `setViewport` debounce before PUT /board/viewport. */
export const BOARD_VIEWPORT_SAVE_DEBOUNCE_MS = 800;
/** Focus intents fly the camera only when the user has not touched it for this long (else: reveal pill). */
export const BOARD_CAMERA_IDLE_FLY_MS = 3000;
/** 409 rebase rounds before the queue is dropped. */
export const BOARD_PATCH_RETRY_LIMIT = 3;
/** Ops per PATCH (= contracts `BOARD_LIMITS.maxOpsPerPatch`). */
export const BOARD_PATCH_BATCH_MAX_OPS = 200;
/** Undo stack depth. */
export const BOARD_UNDO_DEPTH = 100;
/** Selection → chat context debounce. */
export const BOARD_SELECTION_CONTEXT_DEBOUNCE_MS = 120;
/** Remote `board-changed` events are coalesced into one GET within this window. */
export const BOARD_REMOTE_REFETCH_COALESCE_MS = 100;

/** Plan R1: consecutive undoable applies with the same `coalesceKey` within this window share one undo entry. */
export const BOARD_UNDO_COALESCE_MS = 1500;
/** Offline retry backoff (spec 04 §7.2: 1 s → 30 s). */
export const BOARD_OFFLINE_BACKOFF_INITIAL_MS = 1000;
export const BOARD_OFFLINE_BACKOFF_MAX_MS = 30_000;
/** Focus intents emitted within this window replace each other (latest wins, spec 04 §7.4). */
export const BOARD_FOCUS_MERGE_MS = 300;
/** `dispatchBoardCaptureToChat` gives up when the composer does not ack within this time (spec 04 §7.7). */
export const BOARD_CAPTURE_ACK_TIMEOUT_MS = 10_000;
/** sessionStorage key of the per-tab board client id (spec 04 §7.1). */
export const BOARD_CLIENT_ID_STORAGE_KEY = 'fantay.board.clientId';
