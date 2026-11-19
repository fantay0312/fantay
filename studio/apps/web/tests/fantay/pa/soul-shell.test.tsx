// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Soul shell (UI spec §3, §4.2, §4.3, §6.3): the roster's search, ＋ and full-width filter, the pinned Fantay row and
// one list of rows, the four-cell bottom bar, the rail, the chat header in both modes, Fantay's first screen with
// the starter shelf, the 工作 tab strip and the file-drop veil. Everything runs over the lab fixtures.
import "../helpers/radix-jsdom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../src/i18n";
import { paSoulShellEn, paSoulShellZh } from "../../../src/i18n/pa-ui/soul-shell";
import { PersonalAgentWorkspace } from "../../../src/fantay/pa/PersonalAgentWorkspace";
import { PaTransportProvider } from "../../../src/fantay/pa/pa-transport";
import { createFixtureTransport } from "../../../src/fantay/pa/lab/fixture-transport";
import { buildFixture, type PaScenarioId } from "../../../src/fantay/pa/lab/fixtures";
import type { PaUiState } from "../../../src/fantay/pa/pa-types";

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* storage unavailable */
  }
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

function mount(id: PaScenarioId, ui: Partial<PaUiState> = {}, locale: "en" | "zh-CN" = "en") {
  const fixture = buildFixture(id);
  return render(
    <I18nProvider initial={locale}>
      <PaTransportProvider transport={createFixtureTransport(fixture, { latency: 0 })}>
        <PersonalAgentWorkspace active onOpenProject={vi.fn()} projects={fixture.projects} initialState={{ ...fixture.ui, ...ui }} />
      </PaTransportProvider>
    </I18nProvider>,
  );
}

/** Radix menus open on pointerdown in jsdom. */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

describe("soul shell copy", () => {
  it("has a Chinese value for every English key and no empty value", () => {
    expect(Object.keys(paSoulShellZh).sort()).toEqual(Object.keys(paSoulShellEn).sort());
    for (const value of [...Object.values(paSoulShellEn), ...Object.values(paSoulShellZh)]) expect(value.trim()).not.toBe("");
  });
});

describe("roster (full)", () => {
  it("has search with ＋, a three-segment filter, the pinned Fantay row and no place rows or section headers", async () => {
    mount("first-run-soul");
    const roster = await screen.findByTestId("pa-roster");
    expect(roster.getAttribute("data-variant")).toBe("full");
    expect(within(roster).getByRole("textbox", { name: "Search chats and members" })).toBeTruthy();
    expect(within(roster).getByTestId("pa-roster-plus").getAttribute("aria-label")).toBe("New");
    const filter = within(roster).getByTestId("pa-roster-filter");
    expect(within(filter).getAllByRole("radio").map((item) => item.textContent)).toEqual(["All", "Chat", "Work"]);
    expect(await within(roster).findByTestId("pa-roster-fantay")).toBeTruthy();
    expect(screen.queryByTestId("pa-place-activity")).toBeNull();
    expect(within(roster).queryByText("Groups")).toBeNull();
    expect(within(roster).queryByText("Channel chats")).toBeNull();
  });

  it("draws the four-cell bottom bar and marks 工作 active on both work pages", async () => {
    mount("first-run-soul");
    const bar = await screen.findByTestId("pa-bottom-bar");
    const labels = within(bar)
      .getAllByRole("button")
      .map((cell) => (cell.textContent ?? "").replace(/\s+/g, ""));
    expect(labels).toEqual(["Library", "Memory", "Work", "Connect"]);
    fireEvent.click(within(bar).getByTestId("pa-place-tasks"));
    await screen.findByTestId("pa-tasks-page");
    expect(within(bar).getByTestId("pa-place-tasks").getAttribute("aria-current")).toBe("page");
    fireEvent.mouseDown(screen.getByTestId("pa-work-tab-goals"), { button: 0 });
    await screen.findByTestId("pa-activity-page");
    expect(within(bar).getByTestId("pa-place-tasks").getAttribute("aria-current")).toBe("page");
  });

  it("lists the ＋ menu items", async () => {
    mount("first-run-soul");
    openMenu(await screen.findByTestId("pa-roster-plus"));
    const menu = await screen.findByTestId("pa-roster-plus-menu");
    // jsdom has no layout, so the popper may report the anchor as detached and hide the content: query hidden too.
    expect(within(menu).getAllByRole("menuitem", { hidden: true }).map((item) => item.textContent)).toEqual([
      "New character",
      "Import character card",
      "New group chat",
      "Browse starters",
    ]);
  });

  it("filters companion rows into 聊天 and work rows into 工作, keeping Fantay pinned", async () => {
    mount("companion-chat");
    const roster = await screen.findByTestId("pa-roster");
    const companion = await waitFor(() => {
      const row = within(roster)
        .getAllByTestId("pa-roster-row")
        .find((item) => item.getAttribute("data-mode") === "companion");
      expect(row).toBeTruthy();
      return row!;
    });
    const companionId = companion.getAttribute("data-agent-id");
    const ids = () => within(roster).queryAllByTestId("pa-roster-row").map((row) => row.getAttribute("data-agent-id"));
    fireEvent.mouseDown(within(roster).getByTestId("pa-roster-filter-work"), { button: 0 });
    fireEvent.click(within(roster).getByTestId("pa-roster-filter-work"));
    await waitFor(() => expect(ids()).not.toContain(companionId));
    expect(within(roster).getByTestId("pa-roster-fantay")).toBeTruthy();
    fireEvent.click(within(roster).getByTestId("pa-roster-filter-chat"));
    await waitFor(() => expect(ids()).toContain(companionId));
    for (const row of within(roster).getAllByTestId("pa-roster-row")) expect(row.getAttribute("data-mode")).not.toBe("work");
  });

  it("shows the quiet 聊天 empty block when no one can chat yet", async () => {
    mount("first-run-soul", { rosterFilter: "chat" });
    const empty = await screen.findByTestId("pa-roster-empty-chat");
    expect(within(empty).getByText("No one to chat with yet")).toBeTruthy();
    expect(within(empty).getByRole("button", { name: "Browse starters" })).toBeTruthy();
  });

  it("previews 正在输入… only while a chat turn really runs", async () => {
    mount("companion-group");
    const roster = await screen.findByTestId("pa-roster");
    const room = await waitFor(() => {
      const row = within(roster)
        .getAllByTestId("pa-roster-row")
        .find((item) => item.getAttribute("data-kind") === "group");
      expect(row).toBeTruthy();
      return row!;
    });
    expect(within(room).getByText("typing…")).toBeTruthy();
    expect(within(roster).queryAllByText("typing…")).toHaveLength(1);
  });

  it("carries the warm needs-you count on its row and on the 工作 cell", async () => {
    mount("needs-you");
    const bar = await screen.findByTestId("pa-bottom-bar");
    await waitFor(() => expect(within(bar).getByTestId("pa-bar-needs").textContent).toMatch(/^\d+$/));
    expect((await screen.findAllByTestId("pa-roster-needs")).length).toBeGreaterThan(0);
  });
});

describe("chat header", () => {
  it("shows the companion status line, 历史 and the chat menu, and no model picker", async () => {
    mount("companion-chat");
    const header = await screen.findByTestId("pa-chat-header");
    await waitFor(() => expect(header.getAttribute("data-mode")).toBe("companion"));
    expect(within(header).getByTestId("pa-header-status").textContent?.trim()).not.toBe("");
    expect(within(header).getByTestId("pa-header-history")).toBeTruthy();
    expect(within(header).getByTestId("pa-header-info").getAttribute("aria-label")).toBe("Info");
    expect(screen.queryByTestId("pa-header-model-picker")).toBeNull();
    openMenu(within(header).getByTestId("pa-header-menu"));
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent ?? "");
    expect(items[0]).toBe("Chat settings…");
    expect(items[1]).toBe("Appearance…");
    expect(items.some((text) => text.startsWith("Switch to work mode"))).toBe(true);
  });

  it("names who is typing in a room", async () => {
    mount("companion-group");
    const status = await screen.findByTestId("pa-header-status");
    expect(status.textContent).toMatch(/typing…$/);
    expect(status.getAttribute("role")).toBe("status");
  });

  it("keeps a work chat without status line or chat menu, with 新对话 inside 历史", async () => {
    mount("fantay-chat");
    const header = await screen.findByTestId("pa-chat-header");
    expect(header.getAttribute("data-mode")).toBe("work");
    expect(within(header).queryByTestId("pa-header-status")).toBeNull();
    expect(within(header).queryByTestId("pa-header-menu")).toBeNull();
    expect(within(header).queryByRole("button", { name: "New chat" })).toBeNull();
    openMenu(within(header).getByTestId("pa-header-history"));
    expect(await screen.findByRole("menuitem", { name: "New chat" })).toBeTruthy();
  });
});

describe("Fantay's first screen", () => {
  it("greets with the new body, at most two chips and the three-card starter shelf", async () => {
    mount("first-run-soul");
    const empty = await screen.findByTestId("pa-empty-chat");
    expect(within(empty).getByText("Hand me things to get done. To chat or play, meet a few new friends.")).toBeTruthy();
    const shelf = within(empty).getByTestId("pa-starter-shelf");
    expect(within(shelf).getAllByTestId("pa-starter-tile").map((tile) => tile.getAttribute("data-starter"))).toEqual([
      "xiaoyue",
      "storyteller",
      "zhou",
    ]);
    expect(within(shelf).getByRole("button", { name: "All characters" })).toBeTruthy();
    expect(within(empty).queryByText(/Feishu|WeChat/)).toBeNull();
  });

  it("installs a starter from its card and opens the chat", async () => {
    mount("first-run-soul");
    const shelf = await screen.findByTestId("pa-starter-shelf");
    const card = within(shelf).getAllByTestId("pa-starter-tile")[0]!;
    await act(async () => {
      fireEvent.click(card);
    });
    await waitFor(() => expect(screen.getByTestId("pa-chat-header").getAttribute("data-mode")).toBe("companion"), { timeout: 4000 });
  });
});

describe("file drop", () => {
  function drag(type: "dragEnter" | "dragOver" | "drop", target: HTMLElement, files: File[] = []) {
    fireEvent[type](target, { dataTransfer: { types: ["Files"], files, dropEffect: "none" } });
  }

  it("shows the veil while files hover and drops it after the drop", async () => {
    mount("first-run-soul");
    const host = await screen.findByTestId("pa-workspace");
    drag("dragEnter", host);
    expect(await screen.findByTestId("pa-drop-veil")).toBeTruthy();
    expect(screen.getByText("Drop to import a character card")).toBeTruthy();
    drag("drop", host, [new File(["x"], "notes.txt", { type: "text/plain" })]);
    await waitFor(() => expect(screen.queryByTestId("pa-drop-veil")).toBeNull());
    // A file that is not a card opens nothing (the toast says why).
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("rail", () => {
  it("lists faces under ＋ and Fantay, with the four places and no filter", async () => {
    // The rail is the 720–899 px layout; jsdom has no layout, so the host reports 860 px.
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "pa-workspace" ? new DOMRect(0, 0, 860, 800) : new DOMRect(0, 0, 0, 0);
    });
    try {
      mount("companion-group");
      const roster = await screen.findByTestId("pa-roster");
      await waitFor(() => expect(roster.getAttribute("data-variant")).toBe("rail"));
      expect(within(roster).getByTestId("pa-roster-plus")).toBeTruthy();
      expect(within(roster).getByTestId("pa-roster-fantay")).toBeTruthy();
      await waitFor(() => expect(within(roster).getAllByTestId("pa-roster-row").length).toBeGreaterThan(1));
      for (const id of ["pa-place-library", "pa-place-memory", "pa-place-tasks", "pa-place-connections"])
        expect(within(roster).getByTestId(id)).toBeTruthy();
      expect(within(roster).queryByTestId("pa-roster-filter")).toBeNull();
      expect(within(roster).queryByText("typing…")).toBeNull();
    } finally {
      rect.mockRestore();
    }
  });
});
