// SPDX-License-Identifier: Apache-2.0
// Accent guard: a colour the owner picks is drawn only after its lightness is moved far enough to read on the
// transcript theme's paper, cards and incoming bubbles (WCAG 2.x contrast 4.5:1), separately for light and dark.
import type { PaChatTheme } from "../api/personal-agent-soul.js";

export type PaColorMode = "light" | "dark";
export interface PaThemeSurfaces { paper: string; cardBg: string; inBg: string }      // #rrggbb

/** The resolved surface colours of the transcript themes in `pa.css` (`fantay` uses the base tokens' values). */
export const PA_THEME_SURFACES: Record<PaChatTheme, Record<PaColorMode, PaThemeSurfaces>> = {
  fantay: {
    light: { paper: "#ffffff", cardBg: "#ffffff", inBg: "#f3f3f3" },
    dark: { paper: "#181818", cardBg: "#232323", inBg: "#2a2a2a" },
  },
  clean: {
    light: { paper: "#f6f8f3", cardBg: "#fbfcf9", inBg: "#ffffff" },
    dark: { paper: "#19221f", cardBg: "#1e2925", inBg: "#232e2a" },
  },
  sakura: {
    light: { paper: "#fdf7f8", cardBg: "#fffafb", inBg: "#ffffff" },
    dark: { paper: "#211a1e", cardBg: "#271f23", inBg: "#2c2328" },
  },
  archive: {
    light: { paper: "#f7f1e3", cardBg: "#fbf6ea", inBg: "#fffaf0" },
    dark: { paper: "#211d16", cardBg: "#262118", inBg: "#2b261d" },
  },
  rain: {
    light: { paper: "#f2f5fa", cardBg: "#f8fafd", inBg: "#ffffff" },
    dark: { paper: "#171d26", cardBg: "#1c2330", inBg: "#212938" },
  },
  ink: {
    light: { paper: "#f8f5ee", cardBg: "#fbf9f3", inBg: "#fdfbf5" },
    dark: { paper: "#1c1b19", cardBg: "#21201d", inBg: "#262522" },
  },
  deepsea: {
    light: { paper: "#eef5f5", cardBg: "#f6fafa", inBg: "#1d4d57" },
    dark: { paper: "#0f1a1f", cardBg: "#142229", inBg: "#173b44" },
  },
};

export interface PaAccentTokens { accent: string; accentInk: string; link: string; adjusted: boolean }
export type PaAccentGuard =
  | { ok: true; light: PaAccentTokens; dark: PaAccentTokens; adjusted: boolean }
  | { ok: false; reason: "invalid" | "unreadable" };

const HEX = /^#[0-9a-fA-F]{6}$/;
const MIN_RATIO = 4.5;
const INK_LIGHT = "#ffffff";
const INK_DARK = "#111111";

type Rgb = readonly [number, number, number];

function parseHex(value: unknown): Rgb | null {
  if (typeof value !== "string" || !HEX.test(value)) return null;
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const toHex = (rgb: Rgb): `#${string}` =>
  `#${rgb.map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("")}`;

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(channel => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as unknown as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1..21; NaN when either colour is not `#rrggbb`. */
export function contrastRatio(a: string, b: string): number {
  const first = parseHex(a);
  const second = parseHex(b);
  if (!first || !second) return Number.NaN;
  const la = luminance(first);
  const lb = luminance(second);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Hue in degrees, saturation and lightness in percent. */
function toHsl(rgb: Rgb): { h: number; s: number; l: number } {
  const [r, g, b] = rgb.map(channel => channel / 255) as unknown as Rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

function fromHsl(h: number, s: number, l: number): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

const passes = (colour: string, surfaces: readonly string[], ratio: number): boolean =>
  surfaces.every(surface => contrastRatio(colour, surface) >= ratio);

/** `colour` itself when it reads on every surface; else the nearest lightness (same hue and saturation) that does. */
function fit(colour: string, surfaces: readonly string[], ratio: number): string | null {
  const rgb = parseHex(colour);
  const first = parseHex(surfaces[0]);
  if (!rgb || !first) return null;
  const input = colour.toLowerCase();
  if (passes(input, surfaces, ratio)) return input;
  const { h, s, l } = toHsl(rgb);
  const step = luminance(first) > 0.5 ? -1 : 1;
  for (let lightness = Math.round(l) + step; lightness >= 0 && lightness <= 100; lightness += step) {
    const candidate = toHex(fromHsl(h, s, lightness));
    if (passes(candidate, surfaces, ratio)) return candidate;
  }
  return null;
}

function guardMode(surfaces: PaThemeSurfaces, input: string): PaAccentTokens | null {
  const accent = fit(input, [surfaces.paper, surfaces.cardBg], MIN_RATIO);
  const link = fit(input, [surfaces.inBg], MIN_RATIO);
  if (accent === null || link === null) return null;
  const accentInk = contrastRatio(INK_LIGHT, accent) >= contrastRatio(INK_DARK, accent) ? INK_LIGHT : INK_DARK;
  return { accent, accentInk, link, adjusted: accent !== input.toLowerCase() };
}

/** null when `accent` is null (the theme's own accent applies). */
export function guardAccent(theme: PaChatTheme, accent: string | null | undefined): PaAccentGuard | null {
  if (accent === null || accent === undefined) return null;
  if (typeof accent !== "string" || !HEX.test(accent)) return { ok: false, reason: "invalid" };
  const modes = Object.hasOwn(PA_THEME_SURFACES, theme) ? PA_THEME_SURFACES[theme] : PA_THEME_SURFACES.fantay;
  const light = guardMode(modes.light, accent);
  const dark = guardMode(modes.dark, accent);
  if (light === null || dark === null) return { ok: false, reason: "unreadable" };
  return { ok: true, light, dark, adjusted: light.adjusted || dark.adjusted };
}
