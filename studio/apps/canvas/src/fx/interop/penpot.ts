// SPDX-License-Identifier: Apache-2.0
/**
 * Penpot `.penpot` — a later-phase hook (06 §8.6): an isolated MPL-2.0 package will port the
 * Penpot exporter/importer and enable this entry. Until then Penpot files reach the editor as SVG.
 */
export const PENPOT_INTEROP_ENABLED = false;
export const PENPOT_EXTENSIONS = ['penpot'] as const;
