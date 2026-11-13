// SPDX-License-Identifier: Apache-2.0
/** Shim for OpenPencil's `@/app/tauri/env` (06 §3.4): the Fantay editor never runs inside Tauri. */
export function isTauri(): boolean {
  return false;
}
