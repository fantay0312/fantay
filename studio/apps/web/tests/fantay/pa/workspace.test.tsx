// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import "../helpers/radix-jsdom";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaConversation, PaMessage, PaSnapshot, PaTask } from "@open-design/contracts";
import { I18nProvider } from "../../../src/i18n";
import { PersonalAgentWorkspace } from "../../../src/fantay/pa/PersonalAgentWorkspace";
import { paRequest } from "../../../src/fantay/pa/pa-api";
vi.mock("../../../src/fantay/pa/pa-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/fantay/pa/pa-api")>()),
  paRequest: vi.fn(),
}));
// Render counters: pass-through wrappers around the roster/header avatars and the transcript messages.
const renders = vi.hoisted(() => ({ avatar: 0, message: 0 }));
vi.mock("../../../src/fantay/pa/PaAvatar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/fantay/pa/PaAvatar")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    PaAvatar: (props: Parameters<typeof actual.PaAvatar>[0]) => {
      renders.avatar += 1;
      return createElement(actual.PaAvatar, props);
    },
    PaGroupAvatar: (props: Parameters<typeof actual.PaGroupAvatar>[0]) => {
      renders.avatar += 1;
      return createElement(actual.PaGroupAvatar, props);
    },
  };
});
vi.mock("../../../src/fantay/pa/PaMessage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/fantay/pa/PaMessage")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    PaMessage: (props: Parameters<typeof actual.PaMessage>[0]) => {
      renders.message += 1;
      return createElement(actual.PaMessage, props);
    },
    // The transcripts render each turn through PaTurnBody; count it as the message render.
    PaTurnBody: (props: Parameters<typeof actual.PaTurnBody>[0]) => {
      renders.message += 1;
      return createElement(actual.PaTurnBody, props);
    },
  };
});

const stamp = { createdAt: 1, updatedAt: 1, revision: 1 };
const snapshot: PaSnapshot = {
  agents: [
    {
      ...stamp,
      id: "a",
      name: "Writer",
      avatar: "W",
      role: "Write documents",
      enabled: true,
      tools: ["respond", "create_project"],
      model: { runtime: "claude", modelId: "sonnet" },
    },
    {
      ...stamp,
      id: "b",
      name: "Reviewer",
      avatar: "R",
      role: "Review documents",
      enabled: true,
      tools: ["respond", "create_project"],
      model: { runtime: "claude", modelId: "haiku" },
    },
  ],
  groups: [
    {
      ...stamp,
      id: "g",
      name: "Studio",
      memberIds: ["a", "b"],
      moderatorId: "a",
      mode: "review",
      conversationId: "group-chat",
    },
  ],
  conversations: [
    { ...stamp, id: "direct", title: "Writer", agentId: "a", groupId: null },
    {
      ...stamp,
      id: "group-chat",
      title: "Studio",
      agentId: null,
      groupId: "g",
    },
  ],
  messages: [],
  tasks: [],
  attempts: [],
  artifacts: [],
  memories: [],
  node: {
    id: "local",
    protocolVersion: 1,
    location: "local",
    available: true,
    capabilities: ["text"],
    heartbeatAt: 1,
  },
};
const controlRecord = {
  id: "control",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  backgroundEnabled: true,
  paused: false,
  suspended: false,
  maxConcurrent: 2,
  defaultMaxAttempts: 6,
  defaultTimeoutMs: 300000,
  waitingExpiryMs: 86400000,
  activeCount: 0,
  pendingCount: 0,
  lastResumeAt: null,
};
let current: PaSnapshot = snapshot;
function serve(next: PaSnapshot) {
  current = next;
}
function waitingTask(id: string, extra: Partial<PaTask>): PaTask {
  return {
    ...stamp,
    id,
    requestId: `req-${id}-0000`,
    conversationId: "direct",
    goal: "Summarize the papers",
    kind: "discussion",
    projectName: "",
    projectId: null,
    projectConversationId: null,
    status: "waiting",
    waitingReason: null,
    error: null,
    participantIds: ["a"],
    nextParticipant: 0,
    budget: { maxAttempts: 6, timeoutMs: 300000 },
    authorization: { localProject: false, externalWrites: false, version: 1, revoked: false },
    amendments: [],
    evidence: [],
    ...extra,
  };
}
function ownerMessage(taskId: string): PaMessage {
  return {
    ...stamp,
    id: `m-${taskId}`,
    conversationId: "direct",
    taskId,
    senderId: "owner",
    content: "Summarize the papers",
    targetAgentIds: [],
    replyTo: null,
  };
}
beforeEach(() => {
  // The workspace mirrors the open conversation per viewer; every test starts from the default.
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  HTMLElement.prototype.scrollIntoView = vi.fn();
  current = snapshot;
  vi.mocked(paRequest)
    .mockReset()
    .mockImplementation(async (path = "") =>
      path === "/models"
        ? []
        : path === "/channels"
          ? { channels: [], inbox: [], outbox: [] }
          : path === "/control"
            ? controlRecord
            : path === "/feed"
              ? { items: [{ sequence: 1, taskId: "t-planned", kind: "task.accepted", at: 1 }], nextBefore: null }
            : (current as never),
    );
});
afterEach(cleanup);
function mount() {
  return render(
    <I18nProvider initial="en">
      <PersonalAgentWorkspace active onOpenProject={vi.fn()} />
    </I18nProvider>,
  );
}
describe("PA workspace", () => {
  it("shows persisted activity, linked goals and routine status in the workspace", async () => {
    serve({
      ...snapshot,
      tasks: [waitingTask("t-planned", { status: "completed" })],
      goals: [{ ...stamp, id: "goal", name: "Reading plan", description: "Review the papers", taskIds: ["t-planned"] }],
      routines: [{ ...stamp, id: "routine", name: "Daily review", prompt: "Summarize", conversationId: "direct",
        time: "09:00", timezone: "Asia/Taipei", enabled: false, nextRunAt: null, lastError: null, lastTaskId: "t-planned" }],
    });
    mount();
    // 工作 (the bottom bar) opens 任务; its tab strip leads to 动态 · 目标 · 例行 (Soul UI spec §6.3).
    fireEvent.click(await screen.findByTestId("pa-place-tasks"));
    fireEvent.mouseDown(await screen.findByTestId("pa-work-tab-activity"), { button: 0 });
    const page = within(await screen.findByTestId("pa-activity-page"));
    expect(await page.findByText("Task accepted")).toBeTruthy();
    fireEvent.mouseDown(page.getByRole("tab", { name: "Goals" }), { button: 0 });
    expect(await page.findByText("Reading plan")).toBeTruthy();
    expect(page.getByText("1 of 1 tasks completed")).toBeTruthy();
    fireEvent.mouseDown(page.getByRole("tab", { name: "Routines" }), { button: 0 });
    expect(page.getByText("Daily review")).toBeTruthy();
    expect(page.getByText("Daily schedule off")).toBeTruthy();
  });
  it("selects the group conversation and submits project intent through the real API boundary", async () => {
    mount();
    await screen.findByTestId("pa-composer-input");
    fireEvent.click(screen.getByRole("button", { name: /Studio/ }));
    fireEvent.change(screen.getByTestId("pa-composer-input"), {
      target: { value: "Create a reading-club page" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create a project" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(paRequest).toHaveBeenCalledWith(
        "/tasks",
        "POST",
        expect.objectContaining({
          conversationId: "group-chat",
          kind: "project",
          goal: "Create a reading-club page",
          targetAgentIds: [],
        }),
      ),
    );
  });
  it("reuses the request identity after an uncertain network response and retains the draft", async () => {
    mount();
    await screen.findByTestId("pa-composer-input");
    vi.mocked(paRequest).mockImplementation(async (path = "") => {
      if (path === "/tasks") throw new Error("Response lost");
      return path === "/models"
        ? []
        : path === "/channels"
          ? { channels: [], inbox: [], outbox: [] }
          : path === "/control"
            ? controlRecord
            : (snapshot as never);
    });
    const input = screen.getByTestId("pa-composer-input");
    fireEvent.change(input, { target: { value: "Discuss a brand" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Response lost");
    expect((input as HTMLTextAreaElement).value).toBe("Discuss a brand");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(
        vi.mocked(paRequest).mock.calls.filter((call) => call[0] === "/tasks"),
      ).toHaveLength(2),
    );
    const calls = vi
      .mocked(paRequest)
      .mock.calls.filter((call) => call[0] === "/tasks");
    expect(calls[0]![2]).toEqual(calls[1]![2]);
  });
  it("creates an agent without changing the existing global model selection", async () => {
    mount();
    await screen.findByTestId("pa-composer-input");
    // 新建角色 lives in the roster's ＋ menu (Soul UI spec §3.3).
    fireEvent.pointerDown(screen.getByTestId("pa-roster-plus"), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "New character" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "Researcher" },
    });
    // The role lives in the profile editor's 工作 section (UI spec §7.1).
    fireEvent.click(within(dialog).getByTestId("pa-profile-nav-work"));
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Role" }),
      { target: { value: "Summarize source evidence" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(paRequest).toHaveBeenCalledWith(
        "/agents",
        "POST",
        expect.objectContaining({
          name: "Researcher",
          model: { runtime: "claude", modelId: "sonnet" },
        }),
      ),
    );
    expect(
      vi
        .mocked(paRequest)
        .mock.calls.some((call) => call[0]?.includes("config")),
    ).toBe(false);
  });
  it("prefers TokenToSea for new agents and lets the form choose a local model before saving", async () => {
    vi.mocked(paRequest).mockImplementation(async (path = "") => {
      if (path === "/models") return [
        { runtime: "claude", modelId: "sonnet", label: "Claude Code · Sonnet", available: true },
        { runtime: "tokentosea", modelId: "account-model", label: "TokenToSea · Account model", available: true },
        { runtime: "codex", modelId: "gpt-5", label: "Codex · GPT-5", available: true },
      ] as never;
      if (path === "/channels") return { channels: [], inbox: [], outbox: [] } as never;
      if (path === "/control") return controlRecord as never;
      return current as never;
    });
    mount();
    await screen.findByTestId("pa-composer-input");
    // 新建角色 lives in the roster's ＋ menu (Soul UI spec §3.3).
    fireEvent.pointerDown(screen.getByTestId("pa-roster-plus"), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "New character" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Local researcher" } });
    // The model lives in 文风与模型 and the role in 工作 (UI spec §7.1).
    fireEvent.click(within(dialog).getByTestId("pa-profile-nav-style"));
    const picker = within(dialog).getByTestId("pa-profile-model-picker");
    await waitFor(() => expect(picker.textContent).toContain("TokenToSea · Account model"));
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("button", { name: "Codex" }));
    fireEvent.click(await screen.findByRole("option", { name: /GPT-5/ }));
    expect(vi.mocked(paRequest).mock.calls.some((call) => call[1] === "PATCH")).toBe(false);
    fireEvent.click(within(dialog).getByTestId("pa-profile-nav-work"));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Role" }), { target: { value: "Research" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(paRequest).toHaveBeenCalledWith("/agents", "POST", expect.objectContaining({
      model: { runtime: "codex", modelId: "gpt-5" },
    })));
  });
  it("shows exactly one live mascot (the inspector hero) on an empty conversation", async () => {
    mount();
    const empty = await screen.findByTestId("pa-empty-chat");
    expect(screen.getAllByTestId("fantay-mascot")).toHaveLength(1);
    expect(within(empty).queryByTestId("fantay-mascot")).toBeNull();
  });
  it("lists a channel conversation as its own row, never under the agent's row", async () => {
    const channelChat: PaConversation = {
      ...stamp,
      id: "chan",
      title: "Product group",
      agentId: "a",
      groupId: null,
      channelId: "ch1",
    };
    serve({ ...snapshot, conversations: [...snapshot.conversations, channelChat] });
    mount();
    await screen.findByTestId("pa-roster");
    const rows = await waitFor(() => {
      const found = screen
        .getAllByTestId("pa-roster-row")
        .filter((row) => row.getAttribute("data-conversation-id") === "chan");
      expect(found).toHaveLength(1);
      return found;
    });
    expect(rows[0]!.getAttribute("data-kind")).toBe("channel");
    const agentRows = screen
      .getAllByTestId("pa-roster-row")
      .filter((row) => row.hasAttribute("data-agent-id"));
    expect(agentRows.some((row) => row.getAttribute("data-conversation-id") === "chan")).toBe(false);
  });
  it("never offers Resume for work whose last run is unconfirmed", async () => {
    serve({
      ...snapshot,
      tasks: [waitingTask("t-unknown", { stopConfirmation: "unknown", waitKind: "recovery", waitingReason: "Last run not confirmed" })],
      messages: [ownerMessage("t-unknown")],
    });
    mount();
    // The transcript tail carries the full card; the inspector shows a compact copy of it.
    const transcript = await screen.findByTestId("pa-transcript");
    const card = await within(transcript).findByTestId("pa-needs-card");
    expect(within(card).getByRole("button", { name: "Check interrupted execution" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Start again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Resume$/ })).toBeNull();
  });
  it("re-renders only the composer while the owner types", async () => {
    const reply: PaMessage = {
      ...ownerMessage("t-done"),
      id: "m-reply",
      senderId: "a",
      content: "Here is the summary.",
      createdAt: 2,
      updatedAt: 2,
    };
    serve({
      ...snapshot,
      tasks: [waitingTask("t-done", { status: "completed" })],
      messages: [ownerMessage("t-done"), reply],
    });
    mount();
    const transcript = await screen.findByTestId("pa-transcript");
    await within(transcript).findByText("Here is the summary.");
    await screen.findAllByTestId("pa-roster-row");
    const input = screen.getByTestId("pa-composer-input") as HTMLTextAreaElement;
    const before = { ...renders };
    expect(before.avatar).toBeGreaterThan(0);
    expect(before.message).toBeGreaterThan(0);
    // Synchronous: no poll or fetch can land between the two reads.
    for (const value of ["H", "He", "Hello"]) fireEvent.change(input, { target: { value } });
    expect(input.value).toBe("Hello");
    expect(renders.avatar).toBe(before.avatar);
    expect(renders.message).toBe(before.message);
  });
  it("creates one conversation when an agent without a chat is clicked twice", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const created: PaConversation = { ...stamp, id: "direct-b", title: "Reviewer", agentId: "b", groupId: null };
    vi.mocked(paRequest).mockImplementation(async (path = "", method) => {
      if (path === "/conversations" && method === "POST") {
        await held;
        current = { ...current, conversations: [...current.conversations, created] };
        return created as never;
      }
      return path === "/models"
        ? []
        : path === "/channels"
          ? { channels: [], inbox: [], outbox: [] }
          : path === "/control"
            ? controlRecord
            : (current as never);
    });
    mount();
    const row = await waitFor(() => {
      const found = screen.getAllByTestId("pa-roster-row").find((item) => item.getAttribute("data-agent-id") === "b");
      expect(found).toBeTruthy();
      return found!;
    });
    const open = within(row).getByRole("button", { name: /Reviewer/ });
    fireEvent.click(open);
    fireEvent.click(open);
    release();
    await waitFor(() =>
      expect(
        screen.getAllByTestId("pa-roster-row").find((item) => item.getAttribute("data-agent-id") === "b")?.getAttribute("data-conversation-id"),
      ).toBe("direct-b"),
    );
    expect(vi.mocked(paRequest).mock.calls.filter((call) => call[0] === "/conversations")).toHaveLength(1);
  });
  it("renders waiting work that needs a sign-in as a needs-you card", async () => {
    serve({
      ...snapshot,
      tasks: [waitingTask("t-login", { waitKind: "login", waitingReason: "Model unavailable: sign in again" })],
      messages: [ownerMessage("t-login")],
    });
    mount();
    const transcript = await screen.findByTestId("pa-transcript");
    const card = await within(transcript).findByTestId("pa-needs-card");
    expect(within(card).getByText("Model unavailable")).toBeTruthy();
  });
  it("fills and submits the pending view in the real PA transcript", async () => {
    const task = waitingTask("t-view", {
      waitKind: "input", waitingReason: "Campaign details",
      pendingView: {
        attemptId: "view-attempt", title: "Campaign details", summary: "What is the audience?", interactive: true,
        view: { type: "form", id: "details", fields: [{ id: "audience", label: "Audience" }], submitLabel: "Submit brief" },
      },
    });
    serve({ ...snapshot, tasks: [task], messages: [ownerMessage(task.id)] });
    mount();
    const transcript = await screen.findByTestId("pa-transcript");
    const card = await within(transcript).findByTestId("pa-needs-card");
    fireEvent.change(within(card).getByRole("textbox", { name: "Audience" }), { target: { value: "New subscribers" } });
    fireEvent.click(within(card).getByRole("button", { name: "Submit brief" }));
    await waitFor(() => expect(paRequest).toHaveBeenCalledWith("/tasks/t-view/answer", "POST", {
      kind: "view", attemptId: "view-attempt", action: "details", values: { fields: { audience: "New subscribers" } },
    }));
  });
  it("toggles the right inspector panel when clicking the chat header subject", async () => {
    mount();
    expect(await screen.findByTestId("pa-inspector")).toBeTruthy();
    const headerSubject = screen.getByTestId("pa-header-subject");
    expect(headerSubject.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(headerSubject);
    await waitFor(() => expect(screen.queryByTestId("pa-inspector")).toBeNull());
    expect(headerSubject.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(headerSubject);
    expect(await screen.findByTestId("pa-inspector")).toBeTruthy();
  });
  it("inspects any clicked agent from group messages or group profile and navigates back", async () => {
    const groupOwner: PaMessage = {
      ...stamp,
      id: "gm-1",
      conversationId: "group-chat",
      taskId: "gt-1",
      senderId: "owner",
      content: "Review the release note",
      targetAgentIds: [],
      replyTo: null,
    };
    const groupReply: PaMessage = {
      ...stamp,
      id: "gm-2",
      conversationId: "group-chat",
      taskId: "gt-1",
      senderId: "b",
      content: "Looks solid.",
      targetAgentIds: [],
      replyTo: null,
      createdAt: 2,
      updatedAt: 2,
    };
    serve({
      ...snapshot,
      tasks: [waitingTask("gt-1", { conversationId: "group-chat", status: "completed", participantIds: ["a", "b"], nextParticipant: 2 })],
      messages: [groupOwner, groupReply],
    });
    mount();
    await screen.findByTestId("pa-composer-input");
    fireEvent.click(screen.getByRole("button", { name: /Studio/ }));
    const inspector = await screen.findByTestId("pa-inspector");
    await waitFor(() => expect(inspector.getAttribute("aria-label")).toBe("Studio"));

    const msgAgent = await screen.findByTestId("pa-message-agent");
    fireEvent.click(msgAgent);
    await waitFor(() => expect(screen.getByTestId("pa-inspector").getAttribute("aria-label")).toBe("Reviewer"));
    expect(screen.getByTestId("pa-inspector-message")).toBeTruthy();

    fireEvent.click(screen.getByTestId("pa-inspector-back"));
    await waitFor(() => expect(screen.getByTestId("pa-inspector").getAttribute("aria-label")).toBe("Studio"));

    const profileTab = within(screen.getByTestId("pa-inspector")).getByRole("tab", { name: "Profile" });
    fireEvent.mouseDown(profileTab, { button: 0 });
    fireEvent.click(profileTab);
    const memberRows = await within(screen.getByTestId("pa-inspector")).findAllByTestId("pa-group-member");
    fireEvent.click(memberRows[1]!);
    await waitFor(() => expect(screen.getByTestId("pa-inspector").getAttribute("aria-label")).toBe("Reviewer"));
  });
  it("toggles a scheduled routine directly from the inspector", async () => {
    serve({
      ...snapshot,
      routines: [
        {
          ...stamp,
          id: "rt-1",
          name: "Morning briefing",
          prompt: "Summarize tasks",
          conversationId: "direct",
          time: "09:00",
          timezone: "Asia/Shanghai",
          enabled: false,
          nextRunAt: null,
          lastError: null,
          lastTaskId: null,
        },
      ],
    });
    mount();
    const inspector = await screen.findByTestId("pa-inspector");
    const toggle = await within(inspector).findByRole("switch", { name: "Morning briefing" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(paRequest).toHaveBeenCalledWith(
        "/routines/rt-1",
        "PATCH",
        expect.objectContaining({
          name: "Morning briefing",
          enabled: true,
          revision: 1,
        }),
      ),
    );
  });
  it("auto-grows the composer input, caps height with internal scrolling, keeps the same textarea node, and resets on send", async () => {
    mount();
    const input = (await screen.findByTestId("pa-composer-input")) as HTMLTextAreaElement;
    const shell = screen.getByTestId("pa-composer").querySelector(".composer-shell") as HTMLElement;
    expect(shell.hasAttribute("data-stacked")).toBe(false);
    expect(input.style.height).toBe("36px");
    expect(input.style.overflowY).toBe("hidden");

    let mockScrollHeight = 36;
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: () => mockScrollHeight,
    });

    // Multi-line growth below max-height: promotes smoothly to full-width stacked card without remounting textarea
    mockScrollHeight = 94;
    fireEvent.change(input, { target: { value: "Line 1\nLine 2\nLine 3" } });
    expect(screen.getByTestId("pa-composer-input")).toBe(input);
    expect(shell.hasAttribute("data-stacked")).toBe(true);
    expect(input.style.height).toBe("94px");
    expect(input.style.overflowY).toBe("hidden");
    expect(input.hasAttribute("data-scrollable")).toBe(false);

    // Overflow past max-height cap (196px): stops growing and switches to internal vertical scroll
    mockScrollHeight = 420;
    fireEvent.change(input, {
      target: { value: Array.from({ length: 14 }, (_, i) => `Line ${i + 1}`).join("\n") },
    });
    expect(input.style.height).toBe("196px");
    expect(input.style.overflowY).toBe("auto");
    expect(input.hasAttribute("data-scrollable")).toBe(true);

    // Manual expand toggle raises the cap to 360px
    fireEvent.click(screen.getByTestId("pa-composer-expand"));
    expect(shell.hasAttribute("data-expanded")).toBe(true);
    expect(input.style.height).toBe("360px");

    // Sending resets the draft, height, scroll state, and returns to compact single-line capsule
    mockScrollHeight = 36;
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(input.value).toBe(""));
    expect(shell.hasAttribute("data-expanded")).toBe(false);
    expect(shell.hasAttribute("data-stacked")).toBe(false);
    expect(input.style.height).toBe("36px");
    expect(input.style.overflowY).toBe("hidden");
  });
  it("never flips between the capsule and the stacked card on its own (narrow chat column)", async () => {
    mount();
    const input = (await screen.findByTestId("pa-composer-input")) as HTMLTextAreaElement;
    const shell = screen.getByTestId("pa-composer").querySelector(".composer-shell") as HTMLElement;
    // A 92 px capsule beside a 350 px stacked card: 14 px a character, and a placeholder that needs 110 px.
    const stackedNow = () => shell.hasAttribute("data-stacked");
    const boxWidth = () => (stackedNow() ? 350 : 92);
    const textWidth = () => (input.value ? input.value.length * 14 + 8 : 110);
    Object.defineProperty(input, "clientWidth", { configurable: true, get: boxWidth });
    Object.defineProperty(input, "scrollWidth", {
      configurable: true,
      get: () => (input.style.width === "0px" ? textWidth() : Math.max(boxWidth(), textWidth())),
    });
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: () => (textWidth() > boxWidth() ? 58 : stackedNow() ? 28 : 36),
    });

    // Empty again: only the placeholder wraps in the capsule, which is not a reason to stack.
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.change(input, { target: { value: "" } });
    expect(stackedNow()).toBe(false);

    // Ten characters wrap in the capsule and fit the stacked card: it stacks once and stays.
    fireEvent.change(input, { target: { value: "0123456789" } });
    expect(stackedNow()).toBe(true);
    expect(input.style.width).toBe("");

    // Comfortably shorter than the capsule again: back to one line.
    fireEvent.change(input, { target: { value: "012" } });
    expect(stackedNow()).toBe(false);
  });
  it("opens the @ mention picker from the group composer toolbar button", async () => {
    mount();
    await screen.findByTestId("pa-composer-input");
    fireEvent.click(screen.getByRole("button", { name: /Studio/ }));
    const mentionBtn = await screen.findByTestId("pa-composer-mention");
    fireEvent.click(mentionBtn);
    const listbox = await screen.findByRole("listbox", { name: "Choose a member" });
    expect(within(listbox).getByText("@Writer")).toBeTruthy();
    expect(within(listbox).getByText("@Reviewer")).toBeTruthy();
  });
  it("switches the PersonalAgent model from the inspector and the composer, never from the header", async () => {
    const modelOptions = [
      { runtime: "claude" as const, modelId: "sonnet", label: "Claude Code · sonnet", available: true },
      { runtime: "claude" as const, modelId: "opus", label: "Claude Code · opus", available: true },
      { runtime: "tokentosea" as const, modelId: "deepseek-chat", label: "TokenToSea · DeepSeek Flash", available: true },
      { runtime: "codex", modelId: "gpt-5", label: "Codex · GPT-5", available: true },
    ];
    vi.mocked(paRequest).mockImplementation(async (path = "", method = "GET", body) => {
      if (path === "/models") return modelOptions as never;
      if (path === "/channels") return { channels: [], inbox: [], outbox: [] } as never;
      if (path === "/control") return controlRecord as never;
      if (path === "/agents/a" && method === "PATCH") {
        const patch = body as { model: { runtime: "claude" | "tokentosea" | "ollama"; modelId: string } };
        const updated = {
          ...current.agents[0]!,
          model: patch.model,
          revision: current.agents[0]!.revision + 1,
        };
        current = {
          ...current,
          agents: [updated, ...current.agents.slice(1)],
        };
        return updated as never;
      }
      return current as never;
    });

    mount();
    // The inspector keeps one model row, on its 档案 tab (Soul UI spec §4.7).
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Profile" }), { button: 0 });
    const inspectorPicker = await screen.findByTestId("pa-profile-model-picker");
    // The header carries no model picker in either mode (Soul UI spec §4.2).
    expect(screen.queryByTestId("pa-header-model-picker")).toBeNull();
    const composerPicker = screen.getByTestId("pa-composer-model-picker");
    vi.spyOn(inspectorPicker, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 200, 24));
    vi.spyOn(composerPicker, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 200, 24));

    await waitFor(() => expect(inspectorPicker.textContent).toContain("Claude Code · sonnet"));
    expect(composerPicker.textContent).toContain("sonnet");

    fireEvent.pointerDown(inspectorPicker, { button: 0 });
    fireEvent.click(inspectorPicker);
    const channels = await screen.findAllByRole("button", { pressed: false });
    expect(channels[0]!.textContent).toContain("TokenToSea");
    fireEvent.click(screen.getByRole("button", { name: "TokenToSea" }));
    const option = await screen.findByRole("option", { name: /DeepSeek Flash/ });
    fireEvent.click(option);

    await waitFor(() =>
      expect(paRequest).toHaveBeenCalledWith(
        "/agents/a",
        "PATCH",
        expect.objectContaining({
          name: "Writer",
          model: { runtime: "tokentosea", modelId: "deepseek-chat" },
          revision: 1,
        }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId("pa-profile-model-picker").textContent).toContain("TokenToSea · DeepSeek Flash"));
    expect(screen.getByTestId("pa-composer-model-picker").textContent).toContain("DeepSeek Flash");

    fireEvent.pointerDown(composerPicker, { button: 0 });
    fireEvent.click(composerPicker);
    fireEvent.change(await screen.findByPlaceholderText("Search models…"), { target: { value: "GPT-5" } });
    fireEvent.click(await screen.findByRole("option", { name: /GPT-5/ }));
    await waitFor(() => expect(paRequest).toHaveBeenCalledWith("/agents/a", "PATCH", expect.objectContaining({
      model: { runtime: "codex", modelId: "gpt-5" },
    })));
    await waitFor(() => expect(screen.getByTestId("pa-composer-model-picker").textContent).toContain("GPT-5"));
  });
});
