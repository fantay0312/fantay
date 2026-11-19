// SPDX-License-Identifier: AGPL-3.0-only
// Colour values the appearance picker offers for 强调色 (stage 2 spec 9.3). They live in a `.ts` file because the
// picker's TSX may not hold a colour literal. Whatever the owner picks is stored as picked; what the transcript draws
// is the engine's `guardAccent` result, so none of these needs to be readable on every theme by itself.

/** The colour 自选 starts from when the layer has never held a custom accent. */
export const SOUL_ACCENT_SEED = '#808080';

/** Quick picks shown beside the colour well: rose, orange, ochre, green, blue, violet. */
export const SOUL_ACCENT_SWATCHES: readonly string[] = ['#d0587e', '#e0703a', '#b8902a', '#3e9a6a', '#3478c4', '#7a5cc8'];

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A typed hex value as the stored form (`#rrggbb`, lower case), or null when it is not one. A missing leading `#` is
 *  accepted, since "ffff00" is a 6-digit hex colour as the field's error line asks for. */
export function soulAccentFromDraft(draft: string): string | null {
  const trimmed = draft.trim();
  const value = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return HEX.test(value) ? value.toLowerCase() : null;
}
