import { describe, expect, it, vi } from "vitest";

import {
  OPEN_DESIGN_HOST_GLOBAL,
  isOpenDesignHostBridge,
  setHostMenuLabels,
  setHostTitleBarOverlay,
  subscribeHostMenuCommands,
  type OpenDesignHostBridge,
  type OpenDesignHostMenuCommand,
  type OpenDesignHostMenuLabels,
  type OpenDesignHostTitleBarOverlay,
} from "../src/index.js";
import { createMockOpenDesignHost } from "../src/testing.js";

const LABELS: OpenDesignHostMenuLabels = {
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
};

function scopeWith(host: OpenDesignHostBridge | undefined): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  if (host) scope[OPEN_DESIGN_HOST_GLOBAL] = host;
  return scope;
}

/** A host whose `menu.subscribeCommand` captures the listener so tests can emit commands. */
function hostWithMenu() {
  let emit: ((command: unknown) => void) | null = null;
  const unsubscribe = vi.fn();
  const setLabels = vi.fn(async (_labels: OpenDesignHostMenuLabels) => ({ ok: true as const }));
  const host = createMockOpenDesignHost({
    menu: {
      subscribeCommand: (listener) => {
        emit = listener as (command: unknown) => void;
        return unsubscribe;
      },
      setLabels,
    },
  });
  return { host, unsubscribe, setLabels, emit: (command: unknown) => emit?.(command) };
}

describe("fantay host menu and window capabilities", () => {
  it("keeps the optional blocks out of bridge validation", () => {
    const withBlocks = createMockOpenDesignHost({
      menu: { subscribeCommand: () => () => undefined, setLabels: async () => ({ ok: true }) },
      window: { setTitleBarOverlay: async () => ({ ok: true }) },
    });
    expect(isOpenDesignHostBridge(withBlocks)).toBe(true);
    expect(isOpenDesignHostBridge(createMockOpenDesignHost())).toBe(true);
    // A malformed optional block does not invalidate the bridge either.
    expect(isOpenDesignHostBridge({ ...createMockOpenDesignHost(), menu: {}, window: null })).toBe(true);
  });

  it("delivers known menu commands to the listener and unsubscribes through the host", () => {
    const { host, unsubscribe, emit } = hostWithMenu();
    const received: OpenDesignHostMenuCommand[] = [];
    const stop = subscribeHostMenuCommands((command) => received.push(command), scopeWith(host));

    emit("fantay.board.zoom100");
    emit("fantay.newChat");
    emit("fantay.search");
    expect(received).toEqual(["fantay.board.zoom100", "fantay.newChat", "fantay.search"]);

    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("drops unknown or malformed menu payloads", () => {
    const { host, emit } = hostWithMenu();
    const listener = vi.fn();
    subscribeHostMenuCommands(listener, scopeWith(host));

    emit("fantay.unknown");
    emit("reload");
    emit(42);
    emit(null);
    expect(listener).not.toHaveBeenCalled();
  });

  it("returns a no-op unsubscribe when the host or the menu capability is missing", () => {
    const listener = vi.fn();
    const withoutHost = subscribeHostMenuCommands(listener, scopeWith(undefined));
    const withoutMenu = subscribeHostMenuCommands(listener, scopeWith(createMockOpenDesignHost()));
    const malformedMenu = subscribeHostMenuCommands(
      listener,
      scopeWith({ ...createMockOpenDesignHost(), menu: {} } as unknown as OpenDesignHostBridge),
    );
    expect(() => {
      withoutHost();
      withoutMenu();
      malformedMenu();
    }).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("catches host throws while subscribing and while unsubscribing", () => {
    const throwingSubscribe = createMockOpenDesignHost({
      menu: {
        subscribeCommand: () => {
          throw new Error("ipc down");
        },
        setLabels: async () => ({ ok: true }),
      },
    });
    const stop = subscribeHostMenuCommands(vi.fn(), scopeWith(throwingSubscribe));
    expect(() => stop()).not.toThrow();

    const throwingUnsubscribe = createMockOpenDesignHost({
      menu: {
        subscribeCommand: () => () => {
          throw new Error("already gone");
        },
        setLabels: async () => ({ ok: true }),
      },
    });
    const stop2 = subscribeHostMenuCommands(vi.fn(), scopeWith(throwingUnsubscribe));
    expect(() => stop2()).not.toThrow();

    const nonFunctionUnsubscribe = createMockOpenDesignHost({
      menu: {
        subscribeCommand: () => undefined as unknown as () => void,
        setLabels: async () => ({ ok: true }),
      },
    });
    const stop3 = subscribeHostMenuCommands(vi.fn(), scopeWith(nonFunctionUnsubscribe));
    expect(() => stop3()).not.toThrow();
  });

  it("forwards menu labels and reports a missing capability as a failure", async () => {
    const { host, setLabels } = hostWithMenu();
    await expect(setHostMenuLabels(LABELS, scopeWith(host))).resolves.toEqual({ ok: true });
    expect(setLabels).toHaveBeenCalledWith(LABELS);

    await expect(setHostMenuLabels(LABELS, scopeWith(undefined))).resolves.toEqual({
      ok: false,
      reason: "OpenDesign host is not available",
    });
    await expect(setHostMenuLabels(LABELS, scopeWith(createMockOpenDesignHost()))).resolves.toEqual({
      ok: false,
      reason: "OpenDesign host is not available",
    });
  });

  it("wraps menu label throws and rejections into structured failures", async () => {
    const throwing = createMockOpenDesignHost({
      menu: {
        subscribeCommand: () => () => undefined,
        setLabels: () => {
          throw new Error("sync throw");
        },
      },
    });
    await expect(setHostMenuLabels(LABELS, scopeWith(throwing))).resolves.toEqual({ ok: false, reason: "sync throw" });

    const rejecting = createMockOpenDesignHost({
      menu: {
        subscribeCommand: () => () => undefined,
        setLabels: async () => {
          throw new Error("invalid menu labels");
        },
      },
    });
    await expect(setHostMenuLabels(LABELS, scopeWith(rejecting))).resolves.toEqual({
      ok: false,
      reason: "invalid menu labels",
    });
  });

  it("forwards the title-bar overlay and handles a missing or throwing capability", async () => {
    const setTitleBarOverlay = vi.fn(async (_overlay: OpenDesignHostTitleBarOverlay) => ({ ok: true as const }));
    const host = createMockOpenDesignHost({ window: { setTitleBarOverlay } });
    const overlay = { color: "#141414", symbolColor: "#a9a8a5", height: 44 };

    await expect(setHostTitleBarOverlay(overlay, scopeWith(host))).resolves.toEqual({ ok: true });
    expect(setTitleBarOverlay).toHaveBeenCalledWith(overlay);

    await expect(setHostTitleBarOverlay(overlay, scopeWith(undefined))).resolves.toEqual({
      ok: false,
      reason: "OpenDesign host is not available",
    });
    await expect(setHostTitleBarOverlay(overlay, scopeWith(createMockOpenDesignHost()))).resolves.toEqual({
      ok: false,
      reason: "OpenDesign host is not available",
    });

    const throwing = createMockOpenDesignHost({
      window: {
        setTitleBarOverlay: async () => {
          throw new Error("overlay failed");
        },
      },
    });
    await expect(setHostTitleBarOverlay(overlay, scopeWith(throwing))).resolves.toEqual({
      ok: false,
      reason: "overlay failed",
    });
  });
});
