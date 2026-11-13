// Language of the splash status line.
//
// The splash is up before the renderer, which is the only place the app's
// language lives (a manual pick in localStorage, else the OS locale). So the
// main process remembers the language the UI last ran in — read from the
// mounted app's `<html lang>` — and the next boot's splash starts from it.
// A first boot has nothing stored and falls back to the OS language, which is
// also what the renderer falls back to.
//
// Only languages with a label table below are distinguished; every other app
// language shows the English labels, as the splash always did.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SplashBootStage =
  | "starting"
  | "engine"
  | "engineReady"
  | "interface"
  | "interfaceReady"
  | "workspace"
  | "finishing";

export type SplashLocale = "en" | "zh-CN" | "zh-TW";
export const SPLASH_DEFAULT_LOCALE: SplashLocale = "en";
export const SPLASH_LOCALE_STATE_FILE = "fantay-boot-locale.json";

const SPLASH_STAGE_LABELS: Record<SplashLocale, Record<SplashBootStage, string>> = {
  en: {
    starting: "Starting Fantay",
    engine: "Starting the local engine",
    engineReady: "Local engine ready",
    interface: "Preparing the interface",
    interfaceReady: "Interface ready",
    workspace: "Opening your workspace",
    finishing: "Almost ready",
  },
  "zh-CN": {
    starting: "正在启动 Fantay",
    engine: "正在启动本地引擎",
    engineReady: "本地引擎已就绪",
    interface: "正在准备界面",
    interfaceReady: "界面已就绪",
    workspace: "正在打开工作区",
    finishing: "即将完成",
  },
  "zh-TW": {
    starting: "正在啟動 Fantay",
    engine: "正在啟動本機引擎",
    engineReady: "本機引擎已就緒",
    interface: "正在準備介面",
    interfaceReady: "介面已就緒",
    workspace: "正在開啟工作區",
    finishing: "即將完成",
  },
};

export function splashStageLabel(stage: SplashBootStage, locale: SplashLocale): string {
  return SPLASH_STAGE_LABELS[locale][stage];
}

function isSplashLocale(value: unknown): value is SplashLocale {
  return typeof value === "string" && Object.hasOwn(SPLASH_STAGE_LABELS, value);
}

/**
 * Maps a BCP-47 tag to a splash label table, or null when `tag` is not a
 * usable tag. Chinese splits the way the renderer's `resolveSystemLocale`
 * does (Hant / TW / HK / MO are Traditional); any other language is English.
 */
export function resolveSplashLocale(tag: unknown): SplashLocale | null {
  if (typeof tag !== "string") return null;
  const [language, regionOrScript] = tag.trim().toLowerCase().split(/[-_]/);
  if (!language) return null;
  if (language !== "zh") return "en";
  return regionOrScript === "hant" || regionOrScript === "tw" || regionOrScript === "hk" || regionOrScript === "mo"
    ? "zh-TW"
    : "zh-CN";
}

export function readSplashLocale(stateDir: string): SplashLocale | null {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, SPLASH_LOCALE_STATE_FILE), "utf8")) as unknown;
    const locale = parsed != null && typeof parsed === "object" ? (parsed as { locale?: unknown }).locale : undefined;
    return isSplashLocale(locale) ? locale : null;
  } catch {
    return null; // First run, damaged file or unreadable directory.
  }
}

/**
 * Persists the splash language for `tag` when it differs from the stored one;
 * returns whether it wrote. Never throws: a failed write only costs the next
 * boot its status-line language.
 */
export function writeSplashLocale(stateDir: string, tag: unknown): boolean {
  const locale = resolveSplashLocale(tag);
  if (locale == null || readSplashLocale(stateDir) === locale) return false;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, SPLASH_LOCALE_STATE_FILE), JSON.stringify({ locale }), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
