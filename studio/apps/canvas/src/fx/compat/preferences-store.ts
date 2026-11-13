// SPDX-License-Identifier: Apache-2.0
/**
 * Shim for OpenPencil's `@/app/settings/preferences/store` (06 §3.4). Design check and comments
 * are not part of the Fantay editor, so the only preferences the vendored UI reads are constant.
 */
import { readonly, ref } from 'vue';

export const appPreferences = readonly(
  ref({
    designCheck: { showOnCanvas: false },
    comments: { showOnCanvas: false },
  } as const),
);
