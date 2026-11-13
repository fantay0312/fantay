import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, test, vi } from "vitest";

import {
  DEFAULT_FANTAY_MENU_LABELS,
  FANTAY_MENU_LABEL_MAX_LENGTH,
  applyFantayMenu,
  parseFantayMenuLabels,
  sameFantayMenuLabels,
} from "../../src/main/fantay-menu.js";

function baseTemplate(): MenuItemConstructorOptions[] {
  return [
    {
      label: "Fantay",
      submenu: [
        { role: "about" },
        { id: "check-for-updates", label: "Check for Updates…" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [{ role: "undo" }, { role: "redo" }],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];
}

describe("Fantay native menu transform", () => {
  test("validates and compares menu label payloads", () => {
    expect(parseFantayMenuLabels(null)).toBeNull();
    expect(parseFantayMenuLabels([])).toBeNull();
    expect(parseFantayMenuLabels({ ...DEFAULT_FANTAY_MENU_LABELS, file: "   " })).toBeNull();
    expect(
      parseFantayMenuLabels({
        ...DEFAULT_FANTAY_MENU_LABELS,
        zoomIn: "x".repeat(FANTAY_MENU_LABEL_MAX_LENGTH + 1),
      }),
    ).toBeNull();

    const parsed = parseFantayMenuLabels({
      ...DEFAULT_FANTAY_MENU_LABELS,
      file: "文件",
      extraIgnored: "ignored",
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.file).toBe("文件");
    expect(sameFantayMenuLabels(DEFAULT_FANTAY_MENU_LABELS, DEFAULT_FANTAY_MENU_LABELS)).toBe(true);
    expect(sameFantayMenuLabels(DEFAULT_FANTAY_MENU_LABELS, parsed!)).toBe(false);
  });

  test("transforms macOS menu: Settings in App menu, File menu added, View zoom roles replaced (B5)", () => {
    const send = vi.fn();
    const original = baseTemplate();
    const snapshot = JSON.stringify(original);

    const out = applyFantayMenu(original, {
      platform: "darwin",
      labels: DEFAULT_FANTAY_MENU_LABELS,
      send,
    });

    expect(JSON.stringify(original)).toBe(snapshot);
    expect(out[0]?.label).toBe("Fantay");
    const appSubmenu = out[0]?.submenu as MenuItemConstructorOptions[];
    const settingsIdx = appSubmenu.findIndex((item) => item.id === "fantay.openSettings");
    const updateIdx = appSubmenu.findIndex((item) => item.id === "check-for-updates");
    expect(settingsIdx).toBeGreaterThan(updateIdx);
    expect(appSubmenu[settingsIdx]?.accelerator).toBe("CmdOrCtrl+,");

    expect(out[1]?.label).toBe("File");
    const fileSubmenu = out[1]?.submenu as MenuItemConstructorOptions[];
    expect(fileSubmenu.map((item) => item.id ?? item.type)).toEqual([
      "fantay.newProject",
      "fantay.newChat",
      "separator",
      "fantay.design.import",
    ]);

    const viewMenu = out.find((menu) => menu.label === "View");
    const viewSubmenu = viewMenu?.submenu as MenuItemConstructorOptions[];
    expect(viewSubmenu.some((item) => item.role === "resetZoom" || item.role === "zoomIn" || item.role === "zoomOut")).toBe(false);
    expect(viewSubmenu.some((item) => item.role === "reload")).toBe(true);
    expect(viewSubmenu.some((item) => item.role === "togglefullscreen")).toBe(true);

    const zoomFit = viewSubmenu.find((item) => item.id === "fantay.board.zoomFit");
    expect(zoomFit).toBeDefined();
    // B5: no Shift+1 / Shift+2 accelerator on any platform
    expect(zoomFit?.accelerator).toBeUndefined();

    const zoomIn = viewSubmenu.find((item) => item.id === "fantay.board.zoomIn");
    expect(zoomIn?.accelerator).toBe("CmdOrCtrl+=");
    expect(zoomIn?.registerAccelerator).toBe(false);

    fileSubmenu[0]?.click?.({} as never, undefined, {} as never);
    expect(send).toHaveBeenCalledWith("fantay.newProject");
  });

  test("transforms Windows/Linux menu: prepends File menu with Settings when File is absent", () => {
    const send = vi.fn();
    const out = applyFantayMenu(baseTemplate().slice(1), {
      platform: "win32",
      labels: DEFAULT_FANTAY_MENU_LABELS,
      send,
    });

    expect(out[0]?.label).toBe("File");
    const fileSubmenu = out[0]?.submenu as MenuItemConstructorOptions[];
    expect(fileSubmenu.some((item) => item.id === "fantay.openSettings")).toBe(true);
    expect(fileSubmenu.some((item) => item.id === "fantay.newChat")).toBe(true);
  });
});
