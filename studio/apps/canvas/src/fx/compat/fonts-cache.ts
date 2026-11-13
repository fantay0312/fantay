// SPDX-License-Identifier: Apache-2.0
/** Shim for OpenPencil's `@/app/editor/fonts/cache` (06 §3.4). The browser editor keeps no font download cache. */
export interface DownloadedFontCacheSummary {
  count: number;
  byteLength: number;
  updatedAt: number | null;
}
