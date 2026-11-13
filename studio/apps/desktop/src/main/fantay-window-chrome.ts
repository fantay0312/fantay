// SPDX-License-Identifier: Apache-2.0
// Fantay window chrome (spec 02 §10.1/§10.3, amendment C11).
// - Windows: hidden title bar with caption-button overlay; the renderer re-colours it from its live tokens over
//   `od:window:set-titlebar-overlay` (applied on win32 only, a no-op elsewhere).
// - Boot appearance: the last theme the renderer sent through `appearance.setTheme` is kept in desktop-owned state
//   (Electron userData, next to `stability-launch.json`; never the daemon data root), so the splash and the
//   native appearance start in it before the renderer mounts. Default dark.
// Electron is used for types only: callers pass the window, `nativeTheme` and the state directory.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BrowserWindow, BrowserWindowConstructorOptions, NativeTheme } from "electron";
import type { OpenDesignHostActionResult } from "@open-design/host";

export const FANTAY_WINDOW_SET_TITLEBAR_OVERLAY_IPC = "od:window:set-titlebar-overlay";
export const FANTAY_TITLEBAR_HEIGHT = 44;
const TITLEBAR_HEIGHT_MIN = 28;
const TITLEBAR_HEIGHT_MAX = 64;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export type FantayTitleBarOverlay = { color: string; symbolColor: string; height: number };

/** win32 main-window chrome (dark-default `--paper` / `--ink-soft`); every other platform keeps its own frame. */
export function fantayWindowChromeFor(
  platform: NodeJS.Platform,
): Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "titleBarOverlay"> {
  if (platform !== "win32") return {};
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#181818", symbolColor: "#b4b4b4", height: FANTAY_TITLEBAR_HEIGHT },
  };
}

export const FANTAY_WIN32_WINDOW_CHROME = fantayWindowChromeFor(process.platform);

/** `#rrggbb` colours only; `height` an integer 28..64 (default 44). */
export function parseTitleBarOverlay(raw: unknown): FantayTitleBarOverlay | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { color, symbolColor, height } = raw as Record<string, unknown>;
  if (typeof color !== "string" || !HEX_COLOR.test(color)) return null;
  if (typeof symbolColor !== "string" || !HEX_COLOR.test(symbolColor)) return null;
  if (height === undefined) return { color, symbolColor, height: FANTAY_TITLEBAR_HEIGHT };
  if (typeof height !== "number" || !Number.isInteger(height)) return null;
  if (height < TITLEBAR_HEIGHT_MIN || height > TITLEBAR_HEIGHT_MAX) return null;
  return { color, symbolColor, height };
}

export function applyFantayTitleBarOverlay(
  window: Pick<BrowserWindow, "isDestroyed" | "setTitleBarOverlay">,
  raw: unknown,
  platform: NodeJS.Platform,
): OpenDesignHostActionResult {
  const overlay = parseTitleBarOverlay(raw);
  if (overlay == null) return { ok: false, reason: "invalid title bar overlay" };
  if (platform !== "win32") return { ok: true };
  if (window.isDestroyed()) return { ok: false, reason: "window is not available" };
  try {
    window.setTitleBarOverlay(overlay);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// ---- Boot appearance (C11) ----

export type FantayBootTheme = "light" | "dark" | "system";
export const FANTAY_DEFAULT_BOOT_THEME: FantayBootTheme = "light";
export const FANTAY_APPEARANCE_STATE_FILE = "fantay-appearance.json";
/** Splash backgrounds: the existing light splash colour and the dark-default `--paper`. */
export const FANTAY_SPLASH_BACKGROUND = Object.freeze({ light: "#ffffff", dark: "#181818" });

export function isFantayBootTheme(value: unknown): value is FantayBootTheme {
  return value === "light" || value === "dark" || value === "system";
}

function readStoredBootTheme(stateDir: string): FantayBootTheme | null {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, FANTAY_APPEARANCE_STATE_FILE), "utf8")) as unknown;
    const theme = parsed != null && typeof parsed === "object" ? (parsed as { theme?: unknown }).theme : undefined;
    return isFantayBootTheme(theme) ? theme : null;
  } catch {
    return null; // First run, damaged file or unreadable directory.
  }
}

export function readFantayBootTheme(stateDir: string): FantayBootTheme {
  return readStoredBootTheme(stateDir) ?? FANTAY_DEFAULT_BOOT_THEME;
}

/**
 * Persists `theme` when it differs from the stored value; returns whether it wrote. Never throws: a failed write
 * only costs the next boot its splash colour.
 */
export function writeFantayBootTheme(stateDir: string, theme: FantayBootTheme): boolean {
  if (!isFantayBootTheme(theme) || readStoredBootTheme(stateDir) === theme) return false;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, FANTAY_APPEARANCE_STATE_FILE), JSON.stringify({ theme }), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Applies the persisted theme to `nativeTheme.themeSource` and returns the matching splash background. */
export function applyFantayBootAppearance(input: {
  nativeTheme: Pick<NativeTheme, "themeSource" | "shouldUseDarkColors">;
  stateDir: string;
}): { theme: FantayBootTheme; splashBackground: string } {
  const theme = readFantayBootTheme(input.stateDir);
  input.nativeTheme.themeSource = theme;
  const dark = theme === "dark" || (theme === "system" && input.nativeTheme.shouldUseDarkColors);
  return { theme, splashBackground: dark ? FANTAY_SPLASH_BACKGROUND.dark : FANTAY_SPLASH_BACKGROUND.light };
}
