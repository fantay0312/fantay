// SPDX-License-Identifier: Apache-2.0
// Fantay native menu (spec 02 §10.4, amendment B5). `applyFantayMenu` is a pure transform of the desktop
// application-menu template built in `index.ts`: it adds the File items and the Settings entry, replaces the
// page-zoom roles with the board zoom / sidebar View items, and makes every added item forward its `fantay.*`
// command id (menu id = command id) to the renderer over `od:menu:command`. Labels arrive localized from the
// renderer over `od:menu:set-labels`. Electron is used for types only.
import type { MenuItemConstructorOptions } from "electron";
import type { OpenDesignHostMenuCommand, OpenDesignHostMenuLabels } from "@open-design/host";

export const FANTAY_MENU_COMMAND_IPC = "od:menu:command";
export const FANTAY_MENU_SET_LABELS_IPC = "od:menu:set-labels";
export const FANTAY_MENU_LABEL_MAX_LENGTH = 80;

export const DEFAULT_FANTAY_MENU_LABELS: OpenDesignHostMenuLabels = Object.freeze({
  file: "File",
  newProject: "New Project",
  newChat: "New Chat",
  importDesign: "Import Design File…",
  settings: "Settings…",
  toggleSidebar: "Toggle Sidebar",
  zoomIn: "Zoom In",
  zoomOut: "Zoom Out",
  zoomFit: "Zoom to Fit",
  zoom100: "Zoom to 100%",
});

const FANTAY_MENU_LABEL_KEYS = Object.keys(DEFAULT_FANTAY_MENU_LABELS) as (keyof OpenDesignHostMenuLabels)[];

/** Every key must be a non-blank string of at most 80 characters; unknown keys are dropped. */
export function parseFantayMenuLabels(raw: unknown): OpenDesignHostMenuLabels | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const labels = { ...DEFAULT_FANTAY_MENU_LABELS };
  for (const key of FANTAY_MENU_LABEL_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0 || value.length > FANTAY_MENU_LABEL_MAX_LENGTH) {
      return null;
    }
    labels[key] = value;
  }
  return labels;
}

export function sameFantayMenuLabels(a: OpenDesignHostMenuLabels, b: OpenDesignHostMenuLabels): boolean {
  return FANTAY_MENU_LABEL_KEYS.every((key) => a[key] === b[key]);
}

export type FantayMenuContext = {
  platform: NodeJS.Platform;
  labels: OpenDesignHostMenuLabels;
  send: (command: OpenDesignHostMenuCommand) => void;
};

type MenuItems = MenuItemConstructorOptions[];
type AcceleratorOptions = Pick<MenuItemConstructorOptions, "accelerator" | "registerAccelerator">;

const PAGE_ZOOM_ROLES = new Set(["resetzoom", "zoomin", "zoomout"]);

function separator(): MenuItemConstructorOptions {
  return { type: "separator" };
}

function commandItem(
  ctx: FantayMenuContext,
  command: OpenDesignHostMenuCommand,
  label: string,
  accelerator: AcceleratorOptions = {},
): MenuItemConstructorOptions {
  return { id: command, label, ...accelerator, click: () => ctx.send(command) };
}

function fileItems(ctx: FantayMenuContext): MenuItems {
  return [
    commandItem(ctx, "fantay.newProject", ctx.labels.newProject, { accelerator: "CmdOrCtrl+Shift+N" }),
    commandItem(ctx, "fantay.newChat", ctx.labels.newChat, { accelerator: "CmdOrCtrl+N" }),
    separator(),
    commandItem(ctx, "fantay.design.import", ctx.labels.importDesign, { accelerator: "CmdOrCtrl+Shift+O" }),
  ];
}

function settingsItem(ctx: FantayMenuContext): MenuItemConstructorOptions {
  return commandItem(ctx, "fantay.openSettings", ctx.labels.settings, { accelerator: "CmdOrCtrl+," });
}

// `registerAccelerator: false` shows the shortcut without stealing the key on Windows/Linux, where the board's own
// keydown handles it while the board has focus. macOS ignores the flag, so only modifier chords get accelerators
// there (B5): zoom to fit has none on any platform, otherwise Shift+1 would swallow "!" in every text field.
function viewItems(ctx: FantayMenuContext): MenuItems {
  return [
    commandItem(ctx, "fantay.toggleSidebar", ctx.labels.toggleSidebar, { accelerator: "CmdOrCtrl+\\" }),
    separator(),
    commandItem(ctx, "fantay.board.zoomIn", ctx.labels.zoomIn, { accelerator: "CmdOrCtrl+=", registerAccelerator: false }),
    commandItem(ctx, "fantay.board.zoomOut", ctx.labels.zoomOut, { accelerator: "CmdOrCtrl+-", registerAccelerator: false }),
    commandItem(ctx, "fantay.board.zoomFit", ctx.labels.zoomFit),
    commandItem(ctx, "fantay.board.zoom100", ctx.labels.zoom100, { accelerator: "CmdOrCtrl+0", registerAccelerator: false }),
    separator(),
  ];
}

function submenuItems(menu: MenuItemConstructorOptions): MenuItems | null {
  return Array.isArray(menu.submenu) ? menu.submenu : null;
}

function isTopMenu(menu: MenuItemConstructorOptions, label: string, role: string): boolean {
  return menu.label === label || (typeof menu.role === "string" && menu.role.toLowerCase() === role);
}

function isPageZoomItem(item: MenuItemConstructorOptions): boolean {
  return typeof item.role === "string" && PAGE_ZOOM_ROLES.has(item.role.toLowerCase());
}

/** Drops the page-zoom roles and the separator directly before them. */
function withoutPageZoom(items: MenuItems): MenuItems {
  const kept: MenuItems = [];
  for (const item of items) {
    if (isPageZoomItem(item)) {
      if (kept[kept.length - 1]?.type === "separator") kept.pop();
      continue;
    }
    kept.push(item);
  }
  return kept;
}

/** Settings goes after About (and after the update item that sits with it), behind a separator. */
function withSettingsInAppMenu(items: MenuItems, ctx: FantayMenuContext): MenuItems {
  const about = items.findIndex((item) => typeof item.role === "string" && item.role.toLowerCase() === "about");
  if (about < 0) return [settingsItem(ctx), separator(), ...items];
  let at = about + 1;
  if (items[at]?.id === "check-for-updates") at += 1;
  return [...items.slice(0, at), separator(), settingsItem(ctx), ...items.slice(at)];
}

export function applyFantayMenu(
  template: readonly MenuItemConstructorOptions[],
  ctx: FantayMenuContext,
): MenuItemConstructorOptions[] {
  const darwin = ctx.platform === "darwin";
  const result: MenuItemConstructorOptions[] = [];
  let fileDone = false;
  template.forEach((menu, index) => {
    const items = submenuItems(menu);
    if (darwin && index === 0) {
      result.push(items == null ? menu : { ...menu, submenu: withSettingsInAppMenu(items, ctx) });
      result.push({ label: ctx.labels.file, submenu: fileItems(ctx) });
      fileDone = true;
      return;
    }
    if (!darwin && !fileDone && items != null && isTopMenu(menu, "File", "filemenu")) {
      result.push({
        ...menu,
        label: ctx.labels.file,
        submenu: [...fileItems(ctx), separator(), settingsItem(ctx), separator(), ...items],
      });
      fileDone = true;
      return;
    }
    if (items != null && isTopMenu(menu, "View", "viewmenu")) {
      result.push({ ...menu, submenu: [...viewItems(ctx), ...withoutPageZoom(items)] });
      return;
    }
    result.push(menu);
  });
  if (!darwin && !fileDone) {
    result.unshift({ label: ctx.labels.file, submenu: [...fileItems(ctx), separator(), settingsItem(ctx)] });
  }
  return result;
}
