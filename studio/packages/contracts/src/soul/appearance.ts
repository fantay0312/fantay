// SPDX-License-Identifier: Apache-2.0
// Chat appearance: the seven curated themes and the layer resolver (default < character < chat).
import { paChatAppearanceSchema } from "../api/personal-agent-soul.js";
import type { PaChatAppearance, PaChatTheme, PaResolvedAppearance } from "../api/personal-agent-soul.js";

export const PA_DEFAULT_APPEARANCE: PaResolvedAppearance = {
  theme: "fantay", shape: "soft", font: "ui", scale: "md", pacing: "paced",
  layout: "bubble", pattern: "none", avatarFrame: "circle", accent: null, stage: "off",
};

export interface PaThemeMeta {
  name: { zh: string; en: string };
  pattern: "none" | "grid" | "ruled" | "dots";     // the theme's default pattern
  avatarFrame: "circle" | "squircle";              // the theme's default frame
  font: PaResolvedAppearance["font"];              // the theme's default font
}

export const PA_THEME_META: Record<PaChatTheme, PaThemeMeta> = {
  fantay: { name: { zh: "默认", en: "Default" }, pattern: "none", avatarFrame: "circle", font: "ui" },
  clean: { name: { zh: "清简", en: "Clean" }, pattern: "none", avatarFrame: "circle", font: "ui" },
  sakura: { name: { zh: "樱花手帐", en: "Sakura journal" }, pattern: "dots", avatarFrame: "squircle", font: "kai" },
  archive: { name: { zh: "旧档案", en: "Old archive" }, pattern: "ruled", avatarFrame: "squircle", font: "serif" },
  rain: { name: { zh: "夜雨", en: "Night rain" }, pattern: "none", avatarFrame: "circle", font: "ui" },
  ink: { name: { zh: "水墨", en: "Ink wash" }, pattern: "none", avatarFrame: "circle", font: "kai" },
  deepsea: { name: { zh: "深海", en: "Deep sea" }, pattern: "grid", avatarFrame: "circle", font: "ui" },
};

type AppearanceLayer = PaChatAppearance | null | undefined;

/** The value of `key` in the last layer that sets it to a valid value; undefined when no layer does. */
function lastSet<K extends keyof PaChatAppearance>(layers: readonly AppearanceLayer[], key: K):
  Exclude<PaChatAppearance[K], undefined> | undefined {
  const field = paChatAppearanceSchema.shape[key];
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (!layer) continue;
    const value = layer[key];
    if (value !== undefined && field.safeParse(value).success) return value as Exclude<PaChatAppearance[K], undefined>;
  }
  return undefined;
}

/** Later layers win; undefined keys are skipped. `font`, `pattern` and `avatarFrame` that no layer sets come from the
 *  resolved theme's meta; `layout` defaults to 'bubble', `accent` to null and `stage` to 'off'. */
export function resolveAppearance(...layers: ReadonlyArray<PaChatAppearance | null | undefined>): PaResolvedAppearance {
  const theme = lastSet(layers, "theme") ?? PA_DEFAULT_APPEARANCE.theme;
  const meta = PA_THEME_META[theme];
  return {
    theme,
    shape: lastSet(layers, "shape") ?? PA_DEFAULT_APPEARANCE.shape,
    font: lastSet(layers, "font") ?? meta.font,
    scale: lastSet(layers, "scale") ?? PA_DEFAULT_APPEARANCE.scale,
    pacing: lastSet(layers, "pacing") ?? PA_DEFAULT_APPEARANCE.pacing,
    layout: lastSet(layers, "layout") ?? "bubble",
    pattern: lastSet(layers, "pattern") ?? meta.pattern,
    avatarFrame: lastSet(layers, "avatarFrame") ?? meta.avatarFrame,
    accent: lastSet(layers, "accent") ?? null,
    stage: lastSet(layers, "stage") ?? "off",
  };
}
