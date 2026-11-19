// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// The world-book editor and its trigger test (Soul UI spec §7.3), mounted on the `library` lab fixture.
import "../helpers/radix-jsdom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../src/i18n";
import { PersonalAgentWorkspace } from "../../../src/fantay/pa/PersonalAgentWorkspace";
import { PaTransportProvider } from "../../../src/fantay/pa/pa-transport";
import { createFixtureTransport } from "../../../src/fantay/pa/lab/fixture-transport";
import { buildFixture } from "../../../src/fantay/pa/lab/fixtures";
import type { PaModalState, PaTransport } from "../../../src/fantay/pa/pa-types";
import { loreTestMessages } from "../../../src/fantay/pa/soul/SoulLoreTestBench";

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

type Call = { path: string; method: string; body: unknown };

function mount(modal: PaModalState) {
  const fixture = buildFixture("library");
  const base = createFixtureTransport(fixture, { latency: 0 });
  const calls: Call[] = [];
  const transport: PaTransport = (path = "", method = "GET", body, signal) => {
    calls.push({ path, method, body });
    return base(path, method, body, signal);
  };
  render(
    <I18nProvider initial="en">
      <PaTransportProvider transport={transport}>
        <PersonalAgentWorkspace active onOpenProject={vi.fn()} projects={fixture.projects} initialState={{ ...fixture.ui, modal }} />
      </PaTransportProvider>
    </I18nProvider>,
  );
  return { calls };
}

async function openZhou() {
  const result = mount({ kind: "lorebook", lorebookId: "lb-zhou" });
  await waitFor(() => expect(screen.getAllByTestId("pa-lore-entry-row")).toHaveLength(6));
  return result;
}

const row = (entryId: string) => document.querySelector(`[data-testid="pa-lore-entry-row"][data-entry="${entryId}"]`) as HTMLElement;

describe("loreTestMessages", () => {
  it("sends one message per non-empty line, newest (last) first, at most 20 lines of 4000 characters", () => {
    expect(loreTestMessages("first\n\n  second  \r\nthird\n")).toEqual(["third", "second", "first"]);
    const many = Array.from({ length: 25 }, (_, at) => `line ${at}`).join("\n");
    const sent = loreTestMessages(many);
    expect(sent).toHaveLength(20);
    expect(sent[0]).toBe("line 24");
    expect(sent[19]).toBe("line 5");
    expect(loreTestMessages("x".repeat(5000))[0]).toHaveLength(4000);
    expect(loreTestMessages(" \n ")).toEqual([]);
  });
});

describe("SoulLorebookModal", () => {
  it("lists the book's entries with their switches, the pinned constant entry and the facts", async () => {
    await openZhou();
    const modal = screen.getByTestId("pa-lorebook-modal");
    expect((within(modal).getByTestId("pa-lore-name") as HTMLInputElement).value).toBe("旧档室与钟楼");
    expect(within(modal).getByTestId("pa-lore-facts").textContent).toBe("Entries 6 · Always on 1");
    expect(within(row("e1")).getByRole("img", { name: "Always on" })).toBeTruthy();
    expect(within(row("e2")).queryByRole("img", { name: "Always on" })).toBeNull();
    expect(within(row("e2")).getByText("修复台, 台面, 工具, 镊子, 放大镜")).toBeTruthy();
    expect(within(row("e2")).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    // The first entry is selected and its form shows the six basics; 高级 stays folded.
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("借阅规矩");
    expect(screen.getByRole("button", { name: "Advanced" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("runs the trigger test on the draft, newest line first, and marks the entries that fire", async () => {
    const { calls } = await openZhou();
    const bench = screen.getByTestId("pa-lore-test");
    expect(within(bench).getByText("Paste dialogue to see which entries come to mind.")).toBeTruthy();
    fireEvent.change(within(bench).getByRole("textbox"), { target: { value: "我们从石桥那边回来\n修复台上那只怀表还在" } });
    await waitFor(() => expect(within(bench).getAllByTestId("pa-lore-test-row").length).toBe(6));
    const sent = calls.filter((call) => call.path === "/soul/lorebooks/test");
    expect(sent.length).toBeGreaterThan(0);
    const body = sent.at(-1)?.body as { messages: string[]; lorebook: { name: string; entries: unknown[] } };
    expect(body.messages).toEqual(["修复台上那只怀表还在", "我们从石桥那边回来"]);
    expect(body.lorebook.entries).toHaveLength(6);
    expect(within(bench).getByText(/^\d would be carried · 0 skipped for budget · [\d,]+ \/ 4,000$/)).toBeTruthy();
    expect(within(bench).getByText('Matched "修复台"')).toBeTruthy();
    expect(within(bench).getAllByText("No keyword matched").length).toBeGreaterThan(0);
    expect(row("e2").hasAttribute("data-firing")).toBe(true);
    expect(row("e6").hasAttribute("data-firing")).toBe(false);

    // An unsaved edit re-runs the test: turning 修复台 off drops it from the carried entries.
    fireEvent.click(within(row("e2")).getByRole("switch"));
    await waitFor(() => expect(row("e2").hasAttribute("data-firing")).toBe(false));
    expect(within(bench).getByText("Turned off")).toBeTruthy();
  });

  it("saves only the fields that changed, then closes", async () => {
    const { calls } = await openZhou();
    fireEvent.click(within(row("e3")).getByRole("button"));
    const title = screen.getByLabelText("Title") as HTMLInputElement;
    expect(title.value).toBe("07 号怀表");
    fireEvent.change(title, { target: { value: "07 号银壳怀表" } });
    expect(within(row("e3")).getByText("07 号银壳怀表")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pa-lore-save"));
    await waitFor(() => expect(screen.queryByTestId("pa-lorebook-modal")).toBeNull());
    const patch = calls.find((call) => call.path === "/soul/lorebooks/lb-zhou" && call.method === "PATCH");
    const body = patch?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["entries", "revision"]);
    expect((body.entries as Array<{ id: string; title: string }>).find((entry) => entry.id === "e3")?.title).toBe("07 号银壳怀表");
  });

  it("creates a new book and binds it to the character it was opened for", async () => {
    const { calls } = mount({ kind: "lorebook", lorebookId: null, bindAgentId: "ag-alan" });
    const modal = await screen.findByTestId("pa-lorebook-modal");
    expect(within(modal).getByText("No entries yet. Add one with something the character should know.")).toBeTruthy();
    const save = within(modal).getByTestId("pa-lore-save");
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(modal).getByTestId("pa-lore-name"), { target: { value: "夜航台规矩" } });
    fireEvent.click(within(modal).getByTestId("pa-lore-new-entry"));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "电台频率" } });
    expect(within(modal).getByTestId("pa-lore-facts").textContent).toBe("Entries 1 · Always on 0");
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByTestId("pa-lorebook-modal")).toBeNull());
    const created = calls.find((call) => call.path === "/soul/lorebooks" && call.method === "POST");
    expect((created?.body as { name: string }).name).toBe("夜航台规矩");
    const bind = calls.find((call) => call.path === "/soul/characters/ag-alan" && call.method === "PUT");
    const ids = (bind?.body as { lorebookIds: string[] }).lorebookIds;
    expect(ids.at(-1)).toMatch(/^lb-lab-/);
  });

  it("marks a keyword that is not a valid regex and notes regexes only the local service can run", async () => {
    await openZhou();
    const keys = screen.getByLabelText("Keywords");
    fireEvent.change(keys, { target: { value: "/[/" } });
    fireEvent.keyDown(keys, { key: "Enter" });
    expect(await screen.findByText("This regex is not valid")).toBeTruthy();
    fireEvent.change(keys, { target: { value: "/钟.+楼/" } });
    fireEvent.keyDown(keys, { key: "Enter" });
    expect(await screen.findByText("Needs the local service to match")).toBeTruthy();
  });

  it("asks before discarding unsaved changes", async () => {
    await openZhou();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "借阅的规矩" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Discard changes?")).toBeTruthy();
    expect(screen.getByTestId("pa-lorebook-modal")).toBeTruthy();
  });

  it("shows an imported book's review items in its settings and opens the requested entry", async () => {
    mount({ kind: "lorebook", lorebookId: "lb-harbor", entryId: "e4" });
    await waitFor(() => expect(screen.getAllByTestId("pa-lore-entry-row").length).toBeGreaterThan(0));
    const selected = document.querySelector('[data-testid="pa-lore-entry-row"][data-selected]');
    expect(selected?.getAttribute("data-entry")).toBe("e4");
    fireEvent.click(screen.getByTestId("pa-lore-book-row"));
    const review = await screen.findByTestId("pa-lore-review");
    expect(within(review).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  });
});
