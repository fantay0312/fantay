import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  FANTAY_APPEARANCE_STATE_FILE,
  FANTAY_DEFAULT_BOOT_THEME,
  FANTAY_SPLASH_BACKGROUND,
  FANTAY_TITLEBAR_HEIGHT,
  applyFantayBootAppearance,
  applyFantayTitleBarOverlay,
  fantayWindowChromeFor,
  parseTitleBarOverlay,
  readFantayBootTheme,
  writeFantayBootTheme,
} from "../../src/main/fantay-window-chrome.js";

describe("Fantay window chrome and dark boot persistence", () => {
  test("returns hidden titlebar overlay only on win32", () => {
    expect(fantayWindowChromeFor("darwin")).toEqual({});
    expect(fantayWindowChromeFor("linux")).toEqual({});
    expect(fantayWindowChromeFor("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#181818",
        symbolColor: "#b4b4b4",
        height: FANTAY_TITLEBAR_HEIGHT,
      },
    });
  });

  test("validates and applies titleBarOverlay payloads", () => {
    expect(parseTitleBarOverlay(null)).toBeNull();
    expect(parseTitleBarOverlay({ color: "red", symbolColor: "#ffffff" })).toBeNull();
    expect(parseTitleBarOverlay({ color: "#141414", symbolColor: "#ffffff", height: 12 })).toBeNull();
    expect(parseTitleBarOverlay({ color: "#141414", symbolColor: "#ffffff" })).toEqual({
      color: "#141414",
      symbolColor: "#ffffff",
      height: FANTAY_TITLEBAR_HEIGHT,
    });

    const setTitleBarOverlay = vi.fn();
    const win = { isDestroyed: () => false, setTitleBarOverlay };

    expect(applyFantayTitleBarOverlay(win, { color: "bad", symbolColor: "#fff" }, "win32").ok).toBe(false);
    expect(applyFantayTitleBarOverlay(win, { color: "#141414", symbolColor: "#ffffff" }, "darwin")).toEqual({ ok: true });
    expect(setTitleBarOverlay).not.toHaveBeenCalled();

    expect(applyFantayTitleBarOverlay(win, { color: "#141414", symbolColor: "#ffffff", height: 44 }, "win32")).toEqual({
      ok: true,
    });
    expect(setTitleBarOverlay).toHaveBeenCalledWith({
      color: "#141414",
      symbolColor: "#ffffff",
      height: 44,
    });

    const destroyed = { isDestroyed: () => true, setTitleBarOverlay };
    expect(applyFantayTitleBarOverlay(destroyed, { color: "#141414", symbolColor: "#ffffff" }, "win32").ok).toBe(false);
  });

  test("persists boot theme in desktop stateDir and defaults to light (C11)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fantay-boot-theme-"));
    try {
      expect(readFantayBootTheme(dir)).toBe(FANTAY_DEFAULT_BOOT_THEME);

      const nativeTheme = { themeSource: "system" as "system" | "light" | "dark", shouldUseDarkColors: true };
      expect(applyFantayBootAppearance({ nativeTheme, stateDir: dir })).toEqual({
        theme: "light",
        splashBackground: FANTAY_SPLASH_BACKGROUND.light,
      });
      expect(nativeTheme.themeSource).toBe("light");

      expect(writeFantayBootTheme(dir, "dark")).toBe(true);
      expect(writeFantayBootTheme(dir, "dark")).toBe(false);
      expect(readFantayBootTheme(dir)).toBe("dark");

      expect(applyFantayBootAppearance({ nativeTheme, stateDir: dir })).toEqual({
        theme: "dark",
        splashBackground: FANTAY_SPLASH_BACKGROUND.dark,
      });
      expect(nativeTheme.themeSource).toBe("dark");

      writeFileSync(join(dir, FANTAY_APPEARANCE_STATE_FILE), "{corrupted", "utf8");
      expect(readFantayBootTheme(dir)).toBe("light");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
