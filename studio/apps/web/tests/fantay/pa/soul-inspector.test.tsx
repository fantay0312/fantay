// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// The companion inspector (TA · 此刻 · 记忆) and the 上下文 modal (Soul UI spec §5), mounted on the lab fixtures.
import "../helpers/radix-jsdom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../src/i18n";
import { PersonalAgentWorkspace } from "../../../src/fantay/pa/PersonalAgentWorkspace";
import { PaTransportProvider } from "../../../src/fantay/pa/pa-transport";
import { createFixtureTransport } from "../../../src/fantay/pa/lab/fixture-transport";
import { buildFixture, type PaScenarioId } from "../../../src/fantay/pa/lab/fixtures";
import type { PaInspectorTab, PaModalState, PaTransport } from "../../../src/fantay/pa/pa-types";
import { contextGroups, loreReasonText } from "../../../src/fantay/pa/soul/SoulContextModal";
import { memoryFirstLine, soulDueLabel } from "../../../src/fantay/pa/soul/SoulInspector";

// The transcript belongs to another unit; the inspector is tested on its own.
vi.mock("../../../src/fantay/pa/PaTranscript", () => ({ PaTranscript: () => null }));

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

interface MountOptions {
  tab?: PaInspectorTab;
  modal?: PaModalState;
  inspector?: boolean;
  wrap?(transport: PaTransport): PaTransport;
}

function mount(id: PaScenarioId, options: MountOptions = {}) {
  const fixture = buildFixture(id);
  const base = createFixtureTransport(fixture, { latency: 0 });
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const logged: PaTransport = (path = "", method = "GET", body, signal) => {
    calls.push({ path, method, body });
    return base(path, method, body, signal);
  };
  const transport = options.wrap ? options.wrap(logged) : logged;
  const open = options.inspector ?? true;
  render(
    <I18nProvider initial="en">
      <PaTransportProvider transport={transport}>
        <PersonalAgentWorkspace
          active
          onOpenProject={vi.fn()}
          projects={fixture.projects}
          initialState={{
            ...fixture.ui,
            inspectorOpen: open,
            inspectorOpenCompanion: open,
            inspectorTab: options.tab ?? "soul",
            ...(options.modal ? { modal: options.modal } : {}),
          }}
        />
      </PaTransportProvider>
    </I18nProvider>,
  );
  return { calls, fixture };
}

describe("soul inspector helpers", () => {
  const t = ((key: string, vars?: Record<string, unknown>) =>
    `${key}${vars ? JSON.stringify(vars) : ""}`) as unknown as Parameters<typeof soulDueLabel>[0];

  it("labels promise due dates by local day", () => {
    const now = new Date(2026, 10, 14, 21, 0).getTime();
    expect(soulDueLabel(t, new Date(2026, 10, 14, 23, 59).getTime(), now, "en")).toBe("pa.soul.inspector.memory.today");
    expect(soulDueLabel(t, new Date(2026, 10, 15, 0, 1).getTime(), now, "en")).toBe("pa.soul.inspector.memory.tomorrow");
    expect(soulDueLabel(t, new Date(2026, 10, 11, 9, 0).getTime(), now, "en")).toBe('pa.soul.inspector.memory.overdue{"n":3}');
    expect(soulDueLabel(t, new Date(2026, 10, 21, 9, 0).getTime(), now, "zh-CN")).toBe("11月21日");
  });

  it("groups trace blocks into the eight legend rows, dropping empty groups", () => {
    const groups = contextGroups({
      blocks: [
        { id: "frame", zone: "system", tokens: 10 },
        { id: "main", zone: "system", tokens: 5 },
        { id: "cast", zone: "system", tokens: 7 },
        { id: "lore-after", zone: "system", tokens: 3 },
        { id: "now", zone: "tail", tokens: 2 },
        { id: "history", zone: "history", tokens: 40 },
        { id: "something-new", zone: "tail", tokens: 1 },
      ],
    });
    expect(groups).toEqual([
      { id: "style", tokens: 16 },
      { id: "character", tokens: 7 },
      { id: "lore", tokens: 3 },
      { id: "state", tokens: 2 },
      { id: "history", tokens: 40 },
    ]);
  });

  it("words world-book reasons", () => {
    expect(loreReasonText(t, { code: "key", key: "面包" })).toBe('pa.soul.inspector.context.reason.key{"key":"面包"}');
    expect(loreReasonText(t, { code: "over-budget", need: 120, left: 96 })).toBe(
      'pa.soul.inspector.context.reason.overBudget{"need":120,"left":96}',
    );
    expect(loreReasonText(t, { code: "recursion-only" })).toBe("pa.soul.inspector.context.reason.recursionOnly");
  });

  it("takes the first non-empty line without markdown marks", () => {
    expect(memoryFirstLine("\n\n## **Plan** ahead\nsecond")).toBe("Plan ahead");
  });
});

describe("companion inspector", () => {
  it("shows the hero and the TA tab of a direct companion chat", async () => {
    mount("companion-chat");
    const body = await screen.findByTestId("pa-soul-inspector");
    const inspector = screen.getByTestId("pa-inspector");
    expect(within(inspector).getByText("Info")).toBeTruthy();
    expect(within(body).getByRole("heading", { name: "小月" })).toBeTruthy();
    expect(within(body).getByTestId("pa-soul-facts").textContent).toMatch(/^Day \d+ · \d+ messages$/);
    const tabs = within(body).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Profile", "Now", "Memory1"]);
    const links = within(body).getByTestId("pa-soul-profile-links");
    expect(within(links).getByText("Edit profile")).toBeTruthy();
    expect(within(links).getByText("Sakura journal")).toBeTruthy();
    expect(within(links).getByText("Chat settings")).toBeTruthy();
    expect(within(links).getByTestId("pa-profile-model-picker")).toBeTruthy();
    const about = within(body).getByTestId("pa-soul-about");
    expect(within(about).getByText("Starter")).toBeTruthy();
    expect(within(about).getByText("窗边工作室的日常")).toBeTruthy();
    expect(within(body).getByText(/小月 is a character played by AI/)).toBeTruthy();
    // No work machinery in the companion inspector.
    expect(screen.queryByTestId("pa-inspector-model-picker")).toBeNull();
    expect(within(body).queryByText(/Activity|Approvals/)).toBeNull();
  });

  it("lists 想记下, 约定 and 记得的事 in the 记忆 tab, and saves a candidate", async () => {
    const { calls } = mount("companion-chat", { tab: "memory" });
    const pending = await screen.findByTestId("pa-soul-pending");
    expect(within(pending).getByText("陪阿树去逛河岸的旧书市集，先看旧画册")).toBeTruthy();
    const promises = screen.getByTestId("pa-soul-promises");
    const rows = within(promises).getAllByTestId("pa-soul-promise");
    expect(rows[0]!.textContent).toContain("海报定稿后，第一个发给阿树看");
    expect(within(rows[0]!).getByRole("checkbox", { name: "Mark as kept" })).toBeTruthy();
    const remembered = screen.getByTestId("pa-soul-remembered");
    expect(within(remembered).getAllByTestId("pa-soul-memory")).toHaveLength(2);
    expect(within(remembered).getByText("Moment")).toBeTruthy();
    expect(screen.getByTestId("pa-soul-memory-add")).toBeTruthy();

    fireEvent.click(within(pending).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === "POST" && call.path === "/memory-candidates/cand-xy-06/resolve")).toBe(true),
    );
    await waitFor(() => expect(screen.queryByTestId("pa-soul-pending")).toBeNull());
  });

  it("marks a promise as kept through saveMemory", async () => {
    const { calls } = mount("companion-chat", { tab: "memory" });
    const promises = await screen.findByTestId("pa-soul-promises");
    fireEvent.click(within(promises).getAllByRole("checkbox", { name: "Mark as kept" })[0]!);
    await waitFor(() => {
      const patch = calls.find((call) => call.method === "PATCH" && call.path === "/memories/mem-xy-promise");
      expect(patch).toBeTruthy();
      expect((patch!.body as { validUntil?: number }).validUntil).toEqual(expect.any(Number));
      expect((patch!.body as { kind?: string }).kind).toBe("promise");
    });
  });

  it("shows story state, the interlude and the quick selects in the 此刻 tab", async () => {
    mount("story-game", { tab: "scene" });
    const state = await screen.findByTestId("pa-soul-state");
    expect(within(state).getByText("Story state")).toBeTruthy();
    const rows = within(state).getAllByTestId("pa-soul-state-row");
    expect(rows.length).toBeGreaterThanOrEqual(4);
    // 金币 was set by the user; 生命 lost 2 in the newest reply.
    expect(within(state).getByRole("img", { name: "Edited by you" })).toBeTruthy();
    expect(state.textContent).toContain("−2");
    const event = screen.getByTestId("pa-soul-event");
    expect(within(event).getByText("2 turns left")).toBeTruthy();
    expect(within(event).getByRole("button", { name: "End" })).toBeTruthy();
    const chat = screen.getByTestId("pa-soul-chat-block");
    expect(within(chat).getByText("My persona")).toBeTruthy();
    expect(within(chat).getByText("Style")).toBeTruthy();
    expect(within(chat).getByText("History carried")).toBeTruthy();
    expect(within(chat).getByText("Short")).toBeTruthy();
    expect(within(chat).queryByText("Who replies")).toBeNull();
    expect(screen.getByTestId("pa-soul-context-open").textContent).toMatch(/^What .+ read$/);
  });

  it("edits a state value through its popover and the state route", async () => {
    const { calls } = mount("story-game", { tab: "scene" });
    const state = await screen.findByTestId("pa-soul-state");
    const numberRow = within(state)
      .getAllByTestId("pa-soul-state-row")
      .find((row) => row.getAttribute("data-kind") === "number")!;
    fireEvent.click(numberRow);
    const editor = await screen.findByTestId("pa-soul-state-editor");
    fireEvent.click(within(editor).getAllByRole("button").find((button) => button.getAttribute("aria-label")?.endsWith("+"))!);
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST" && call.path === "/soul/chat/state");
      expect(post).toBeTruthy();
      expect((post!.body as { ops: Array<{ op: string }> }).ops[0]!.op).toBe("set");
    });
  });

  it("shows members, settings links and the room footnote for a group chat", async () => {
    mount("companion-group");
    const body = await screen.findByTestId("pa-soul-inspector");
    expect(within(body).getByText("3 members")).toBeTruthy();
    expect(within(body).getAllByTestId("pa-soul-member")).toHaveLength(3);
    expect(within(body).getByText("Edit group chat")).toBeTruthy();
    expect(within(body).getByText("Every character here is played by AI.")).toBeTruthy();
  });

  it("keeps the work inspector for a work chat, without the hero model picker", async () => {
    mount("fantay-chat", { tab: "activity" });
    const inspector = await screen.findByTestId("pa-inspector");
    expect(screen.queryByTestId("pa-soul-inspector")).toBeNull();
    expect(within(inspector).getAllByRole("tab").map((tab) => tab.textContent?.replace(/\d+$/, ""))).toEqual([
      "Activity",
      "Approvals",
      "Profile",
    ]);
    expect(within(inspector).getByText("Details")).toBeTruthy();
    expect(screen.queryByTestId("pa-inspector-model-picker")).toBeNull();
  });
});

describe("上下文 modal", () => {
  it("shows what the newest reply read", async () => {
    mount("companion-chat", { inspector: false, modal: { kind: "context", conversationId: "conv-xiaoyue", messageId: "xy-13b" } });
    const modal = await screen.findByTestId("pa-context-modal");
    expect(within(modal).getByText("What 小月 read")).toBeTruthy();
    await within(modal).findByTestId("pa-context-trace");
    const facts = within(modal).getByTestId("pa-context-facts");
    expect(within(facts).getByText("Structured")).toBeTruthy();
    expect(within(facts).getByText("13 of 13 messages")).toBeTruthy();
    expect(within(facts).getByText("104 / 200")).toBeTruthy();
    expect(within(modal).getByText(/^about 4,994 \/ 200,000 tokens \(estimate\)$/)).toBeTruthy();
    expect(within(modal).getAllByTestId("pa-context-legend-row").map((row) => row.textContent?.replace(/[\d,%]+/g, ""))).toEqual([
      "Style & rules",
      "My persona",
      "Character",
      "World books",
      "Memory",
      "State & turn record",
      "Examples",
      "History",
    ]);
    const lore = within(modal).getAllByTestId("pa-context-lore-row");
    expect(lore).toHaveLength(3);
    expect(within(lore[0]!).getByText("Included")).toBeTruthy();
    expect(lore[1]!.textContent).toContain('Matched "面包"');
    expect(within(lore[2]!).getByText("Over budget")).toBeTruthy();
    expect(lore[2]!.textContent).toContain("Needs 120, 96 left");
    expect(within(modal).getByText("1 entries that did not trigger are not listed.")).toBeTruthy();
    expect(within(within(modal).getByTestId("pa-context-memories")).getAllByRole("button")).toHaveLength(2);
    expect(within(modal).getByTestId("pa-context-summary").textContent).toBe("As 阿树 · Style 真人聊天 · Turn record OK");
    expect(within(modal).queryByTestId("pa-context-warnings")).toBeNull();
    expect(within(modal).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["This reply", "Preview next turn"]);
  });

  it("previews the next turn with a refresh", async () => {
    const { calls } = mount("companion-chat", {
      inspector: false,
      modal: { kind: "context", conversationId: "conv-xiaoyue", messageId: "xy-13b" },
    });
    const modal = await screen.findByTestId("pa-context-modal");
    await within(modal).findByTestId("pa-context-trace");
    fireEvent.click(within(modal).getByRole("radio", { name: "Preview next turn" }));
    await waitFor(() => expect(calls.some((call) => call.path === "/soul/chat/preview")).toBe(true));
    expect(await within(modal).findByText("A preview of the next turn. Nothing is sent.")).toBeTruthy();
    expect(within(modal).getByRole("button", { name: "Refresh preview" })).toBeTruthy();
    await within(modal).findByTestId("pa-context-trace");
    expect(within(modal).getByTestId("pa-context-summary").textContent).toBe("As 阿树 · Style 真人聊天");
  });

  it("opens on the preview with 这条回复 disabled when there is no reply", async () => {
    mount("companion-chat", { inspector: false, modal: { kind: "context", conversationId: "conv-xiaoyue", messageId: null } });
    const modal = await screen.findByTestId("pa-context-modal");
    const reply = within(modal).getByRole("radio", { name: "This reply" });
    expect(reply.hasAttribute("disabled") || reply.getAttribute("data-disabled") !== null).toBe(true);
    expect(within(modal).getByRole("radio", { name: "Preview next turn" }).getAttribute("aria-checked")).toBe("true");
  });

  it("lists the trace warnings in one neutral callout", async () => {
    mount("story-game", { inspector: false, modal: { kind: "context", conversationId: "conv-storyteller", messageId: "sg-07" } });
    const modal = await screen.findByTestId("pa-context-modal");
    const warnings = await within(modal).findByTestId("pa-context-warnings");
    expect(warnings.textContent).toBe("Not enough room; the examples were left out this time.");
    expect(within(modal).queryByTestId("pa-context-lore")).toBeNull();
  });

  it("says the record is gone when the trace was pruned, and keeps the preview usable", async () => {
    mount("companion-chat", {
      inspector: false,
      modal: { kind: "context", conversationId: "conv-xiaoyue", messageId: "xy-11" },
      wrap: (transport) => ((path = "", method = "GET", body, signal) =>
        path.startsWith("/soul/trace/") ? Promise.resolve(null) : transport(path, method, body, signal)) as PaTransport,
    });
    const modal = await screen.findByTestId("pa-context-modal");
    expect(await within(modal).findByText("The record for this reply is gone (each chat keeps the newest 5).")).toBeTruthy();
    fireEvent.click(within(modal).getByRole("radio", { name: "Preview next turn" }));
    await within(modal).findByTestId("pa-context-trace");
  });

  it("shows a load error with retry", async () => {
    let fail = true;
    mount("companion-chat", {
      inspector: false,
      modal: { kind: "context", conversationId: "conv-xiaoyue", messageId: "xy-13b" },
      wrap: (transport) => ((path = "", method = "GET", body, signal) =>
        path.startsWith("/soul/trace/") && fail ? Promise.reject(new Error("boom")) : transport(path, method, body, signal)) as PaTransport,
    });
    const modal = await screen.findByTestId("pa-context-modal");
    expect(await within(modal).findByText("Couldn't load the record")).toBeTruthy();
    fail = false;
    fireEvent.click(within(modal).getByRole("button", { name: "Retry" }));
    await within(modal).findByTestId("pa-context-trace");
  });
});
