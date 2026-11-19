// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import "../helpers/radix-jsdom";
import type {
  PaCharacterView,
  PaChatView,
  PaConversation,
  PaMessage,
  PaSnapshot,
  PaSoulLiveResponse,
  PaSoulLiveText,
  PaSoulSnapshot,
  PaSpeechItem,
  PaSpeechStatus,
  PaSpeechVoices,
  PaTask,
} from "@open-design/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../src/i18n";
import { PersonalAgentWorkspace } from "../../../src/fantay/pa/PersonalAgentWorkspace";
import { PaRequestError } from "../../../src/fantay/pa/pa-api";
import { buildIndex } from "../../../src/fantay/pa/pa-model";
import { PaTransportProvider } from "../../../src/fantay/pa/pa-transport";
import type { PaActions, PaIndex } from "../../../src/fantay/pa/pa-types";
import { usePaWorkspace } from "../../../src/fantay/pa/usePaWorkspace";
import { __resetSoulLiveForTests, soulLiveSeen, useSoulLive, useSoulLivePoll } from "../../../src/fantay/pa/soul/soul-live";
import { createFixtureTransport } from "../../../src/fantay/pa/lab/fixture-transport";
import { buildFixture, PA_SCENARIO_IDS, type PaScenarioId } from "../../../src/fantay/pa/lab/fixtures";
import { withLabAppearance, withoutSpeech } from "../../../src/fantay/pa/lab/soul-fixtures";

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  __resetSoulLiveForTests();
});
afterEach(cleanup);

function mount(id: PaScenarioId) {
  const fixture = buildFixture(id);
  return render(
    <I18nProvider initial="en">
      <PaTransportProvider transport={createFixtureTransport(fixture, { latency: 0 })}>
        <PersonalAgentWorkspace active onOpenProject={vi.fn()} projects={fixture.projects} initialState={fixture.ui} />
      </PaTransportProvider>
    </I18nProvider>,
  );
}

describe("pa-lab fixtures", () => {
  it("defines every scenario with the contract shape", () => {
    for (const id of PA_SCENARIO_IDS) {
      const f = buildFixture(id);
      expect(Array.isArray(f.snapshot.agents)).toBe(true);
      expect(Array.isArray(f.channels.channels)).toBe(true);
      expect(typeof f.control.paused).toBe("boolean");
      if (f.soul) expect(f.snapshot.soulVersion).toBe(f.soul.version);
    }
  });
  it("first-run shows the empty Fantay conversation", async () => {
    mount("first-run");
    expect(await screen.findByTestId("pa-empty-chat")).toBeTruthy();
  });
  it("fantay-chat shows the working line", async () => {
    mount("fantay-chat");
    expect(await screen.findByTestId("pa-work-line")).toBeTruthy();
  });
  it("needs-you shows at least three needs-you cards", async () => {
    mount("needs-you");
    await waitFor(() => expect(screen.getAllByTestId("pa-needs-card").length).toBeGreaterThanOrEqual(3));
  });
  it("project-done shows the result card", async () => {
    mount("project-done");
    expect(await screen.findByTestId("pa-result-card")).toBeTruthy();
  });
  it("connections shows the connections page", async () => {
    mount("connections");
    expect(await screen.findByTestId("pa-connections")).toBeTruthy();
  });
  it("offline says the local service is unreachable", async () => {
    mount("offline");
    expect(await screen.findByText(/Can't reach the local Fantay service/)).toBeTruthy();
  });
  it("first-run-soul shows Fantay's empty conversation", async () => {
    mount("first-run-soul");
    expect(await screen.findByTestId("pa-empty-chat")).toBeTruthy();
  });
  it("companion-chat shows 小月's chat with the selected variant", async () => {
    mount("companion-chat");
    expect((await screen.findAllByText(/排了四十分钟/)).length).toBeGreaterThan(0);
  });
  it("story-game shows the text game", async () => {
    mount("story-game");
    expect((await screen.findAllByText(/第七级台阶/)).length).toBeGreaterThan(0);
  });
  it("companion-group shows the room", async () => {
    mount("companion-group");
    expect((await screen.findAllByText(/雨夜茶话会/)).length).toBeGreaterThan(0);
  });
  it("library shows the library page", async () => {
    mount("library");
    expect(await screen.findByTestId("pa-library-page")).toBeTruthy();
  });
});

describe("pa-lab scenarios mount cleanly", () => {
  it.each(PA_SCENARIO_IDS)("%s mounts without console errors", async (id) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mount(id);
      // The Fantay entry appears once the first snapshot (and its paired soul snapshot) is applied, or offline.
      await screen.findByTestId("pa-roster-fantay");
      await waitFor(() => expect(document.querySelector('[data-testid="pa-roster"]')).toBeTruthy());
      expect(errors.mock.calls.map((call) => call.map(String).join(" "))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("pa-lab soul transport", () => {
  const fast = { latency: 0, chatDelays: { startMs: 5, replyMs: 5, liveMs: 5 } };
  const transportFor = (id: PaScenarioId) => createFixtureTransport(buildFixture(id), fast);

  it("a chat send keeps kind 'chat', replies through the parser and then leaves the snapshot", async () => {
    const t = transportFor("companion-chat");
    const task = await t<PaTask>("/tasks", "POST", { kind: "chat", conversationId: "conv-xiaoyue", goal: "今天好累", requestId: "req-lab-test-01" });
    expect(task.kind).toBe("chat");
    await waitFor(async () => {
      const snapshot = await t<PaSnapshot>("");
      expect(snapshot.tasks.some((item) => item.id === task.id)).toBe(false);
      const reply = snapshot.messages.find((m) => m.taskId === task.id && m.senderId === "ag-xiaoyue");
      expect(reply?.soul?.kind).toBe("chat");
      expect(reply?.soul?.mood).toBe("温柔");
      expect(reply?.content).not.toMatch(/turn_meta/);
    });
  });

  it("regenerate adds a variant to the newest slot and selects it", async () => {
    const t = transportFor("companion-chat");
    const task = await t<PaTask>("/soul/chat/regenerate", "POST", { conversationId: "conv-xiaoyue", messageId: "xy-13b", requestId: "req-lab-test-02" });
    await waitFor(async () => {
      const snapshot = await t<PaSnapshot>("");
      const fresh = snapshot.messages.find((m) => m.taskId === task.id);
      expect(fresh?.soul?.variantOf).toBe("xy-13");
      expect(snapshot.messages.find((m) => m.id === "xy-13")?.soul?.activeVariant).toBe(fresh?.id);
    });
  });

  it("a roll is a story item and an interlude draw moves the soul version", async () => {
    const t = transportFor("story-game");
    const before = await t<PaSnapshot>("");
    const rolled = await t<{ message: PaMessage; task: PaTask | null }>("/soul/chat/roll", "POST", {
      conversationId: "conv-storyteller",
      notation: "d20",
      label: "撬锁",
      dc: 12,
      respond: false,
      requestId: "req-lab-test-03",
    });
    expect(rolled.task).toBeNull();
    expect(rolled.message.soul?.kind).toBe("roll");
    expect(rolled.message.content).toMatch(/^掷骰 撬锁 d20 = \d+（目标 12，(成功|失败)）$/);
    const event = await t<{ chat: PaChatView }>("/soul/chat/event", "POST", { conversationId: "conv-storyteller", action: "draw", requestId: "req-lab-test-04" });
    expect(event.chat.candidateEvent).not.toBeNull();
    const after = await t<PaSnapshot>("");
    expect(after.soulVersion).not.toBe(before.soulVersion);
    expect((await t<PaSoulSnapshot>("/soul")).version).toBe(after.soulVersion);
  });

  it("installs a starter with its world book and greeting", async () => {
    const t = transportFor("first-run-soul");
    const result = await t<{ conversation: PaConversation; characters: PaCharacterView[] }>("/soul/starters/zhou/install", "POST", {});
    expect(result.characters[0]?.origin?.name).toBe("zhou");
    const snapshot = await t<PaSnapshot>("");
    expect(snapshot.messages.find((m) => m.conversationId === result.conversation.id)?.soul?.kind).toBe("greeting");
    expect((await t<PaSoulSnapshot>("/soul")).lorebooks.map((book) => book.name)).toContain("旧档室与钟楼");
  });

  it("retrying the failed turn produces the reply", async () => {
    const t = transportFor("companion-chat");
    await t("/tasks/tk-zh-03/resume", "POST", {});
    await waitFor(async () => {
      const snapshot = await t<PaSnapshot>("");
      expect(snapshot.tasks.some((item) => item.id === "tk-zh-03")).toBe(false);
      expect(snapshot.messages.some((m) => m.taskId === "tk-zh-03" && m.senderId === "ag-zhou")).toBe(true);
    });
  });
});

describe("pa-lab stage 2 scenarios", () => {
  it("live-chat, voice-chat, sprites-chat and journal-chat render 小月's chat", async () => {
    for (const [id, text] of [
      ["live-chat", /今天被领导夸了/],
      ["voice-chat", /排了四十分钟/],
      ["sprites-chat", /还剩最后一张图/],
      ["journal-chat", /排了四十分钟/],
    ] as const) {
      mount(id);
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
      cleanup();
    }
  });

  it("carries the stage 2 defaults on every character and chat row", () => {
    for (const id of PA_SCENARIO_IDS) {
      const soul = buildFixture(id).soul;
      for (const character of soul?.characters ?? []) {
        expect(character).toHaveProperty("sprites");
        expect(character).toHaveProperty("voice");
      }
      for (const chat of soul?.chats ?? []) expect(chat.voiceReplies).toMatch(/^(off|manual|auto)$/);
    }
    const sprites = buildFixture("sprites-chat").soul!;
    expect(Object.keys(sprites.characters.find((c) => c.id === "ag-xiaoyue")!.sprites)).toHaveLength(5);
    expect(sprites.chats.find((c) => c.id === "conv-xiaoyue")?.appearance.stage).toBe("side");
    expect(buildFixture("journal-chat").soul!.chats.find((c) => c.id === "conv-xiaoyue")?.appearance).toMatchObject({ layout: "journal", avatarFrame: "polaroid" });
  });

  it("applies the appearance knobs to the open conversation and ignores unknown values", () => {
    const query = new URLSearchParams("skin=rain&layout=journal&frame=polaroid&pattern=grid&accent=FFFF00&stage=side");
    const tuned = withLabAppearance(buildFixture("companion-chat"), "conv-xiaoyue", query);
    expect(tuned.soul!.chats.find((c) => c.id === "conv-xiaoyue")?.appearance).toEqual({
      theme: "rain",
      layout: "journal",
      avatarFrame: "polaroid",
      pattern: "grid",
      accent: "#ffff00",
      stage: "side",
    });
    const ignored = withLabAppearance(buildFixture("companion-chat"), "conv-xiaoyue", new URLSearchParams("skin=neon&accent=red"));
    expect(ignored.soul!.chats.find((c) => c.id === "conv-xiaoyue")?.appearance).toEqual({});
  });
});

describe("pa-lab live text", () => {
  const live = (t: ReturnType<typeof createFixtureTransport>, known = "") =>
    t<PaSoulLiveResponse>(`/soul/live?conversationId=conv-xiaoyue${known}`);

  it("streams the running reply through liveReplyText and stores it as the same text", async () => {
    const t = createFixtureTransport(buildFixture("live-chat"), { latency: 0, chatDelays: { liveMs: 600, streamStepMs: 20 } });
    expect((await live(t)).live).toBeNull(); // nothing streams before the first snapshot read
    await t<PaSnapshot>("");
    const seen: string[] = [];
    await waitFor(async () => {
      const answer = (await live(t)).live;
      if (answer?.text) seen.push(answer.text);
      expect(seen.length).toBeGreaterThan(1);
    });
    const latest = (await live(t)).live!;
    expect(latest.attemptId).toBe("xy-15");
    expect(latest.taskId).toBe("tk-xy-14");
    const unchanged: PaSoulLiveText = { attemptId: "xy-15", taskId: "tk-xy-14", agentId: "ag-xiaoyue", seq: latest.seq, unchanged: true };
    const again = (await live(t, `&attempt=${latest.attemptId}&seq=${latest.seq}`)).live;
    // the stream may have moved on between the two reads; then the answer carries the new text
    if (again?.seq === latest.seq) expect(again).toEqual(unchanged);
    else expect(again?.text?.startsWith(latest.text ?? "")).toBe(true);
    await waitFor(async () => expect((await t<PaSnapshot>("")).messages.some((m) => m.id === "xy-15")).toBe(true), { timeout: 3000 });
    const stored = (await t<PaSnapshot>("")).messages.find((m) => m.id === "xy-15")!;
    expect(stored.soul?.mood).toBe("开心");
    for (const text of seen) {
      expect(text).not.toMatch(/turn_meta|mood:/);
      expect(stored.content.startsWith(text)).toBe(true);
    }
    expect((await live(t)).live).toBeNull();
  });

  it("holds the stream with streamHoldAt and shows nothing with streamStepMs 0", async () => {
    const held = createFixtureTransport(buildFixture("live-chat"), { latency: 0, chatDelays: { liveMs: 200, streamStepMs: 10, streamHoldAt: 0.6 } });
    await held<PaSnapshot>("");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const first = (await live(held)).live!;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await live(held)).live).toEqual(first);
    expect(first.text).toBeTruthy();
    expect((await held<PaSnapshot>("")).tasks.find((task) => task.id === "tk-xy-14")?.status).toBe("running");

    const dots = createFixtureTransport(buildFixture("live-chat"), { latency: 0, chatDelays: { liveMs: 200, streamStepMs: 0 } });
    await dots<PaSnapshot>("");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await live(dots)).live).toBeNull();
  });

  it("the live store shows the text while the turn runs and drops it when the reply is stored", async () => {
    const fixture = buildFixture("live-chat");
    const transport = createFixtureTransport(fixture, { latency: 0, chatDelays: { liveMs: 900, streamStepMs: 30 } });
    function Probe() {
      const data = usePaWorkspace(true);
      const index = useMemo(() => (data.snapshot ? buildIndex(data.snapshot, data.channels, data.models, data.soul) : null), [data]);
      return index ? <LiveProbe index={index} actions={data.actions} /> : null;
    }
    function LiveProbe({ index, actions }: { index: PaIndex; actions: PaActions }) {
      useSoulLivePoll("conv-xiaoyue", index, actions);
      const entry = useSoulLive("conv-xiaoyue");
      return <div data-testid="probe" data-tone={entry?.tone ?? "none"} data-stored={String(index.messages.has("xy-15"))}>{entry?.text ?? ""}</div>;
    }
    render(
      <PaTransportProvider transport={transport}>
        <Probe />
      </PaTransportProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toMatch(/快说说/), { timeout: 3000 });
    expect(screen.getByTestId("probe").textContent).not.toMatch(/turn_meta/);
    await waitFor(() => expect(screen.getByTestId("probe").dataset.stored).toBe("true"), { timeout: 4000 });
    expect(screen.getByTestId("probe").dataset.tone).toBe("none");
    expect(soulLiveSeen("xy-15")).toBe(true);
  });
});

describe("pa-lab voice", () => {
  it("speaks a reply after the generation delay, then answers from the cache", async () => {
    const t = createFixtureTransport(buildFixture("voice-chat"), { latency: 0 });
    expect((await t<PaSpeechStatus>("/soul/speech/status")).available).toBe(true);
    expect((await t<PaSpeechVoices>("/soul/speech/voices?model=elevenlabs-v3")).voices.length).toBeGreaterThan(0);
    expect((await t<{ items: PaSpeechItem[] }>("/soul/speech?conversationId=conv-xiaoyue")).items.map((item) => item.messageId)).toEqual(["xy-11"]);
    const first = await t<PaSpeechItem>("/soul/speech", "POST", { messageId: "xy-13b" });
    expect(first).toMatchObject({ messageId: "xy-13b", mime: "audio/wav", cached: false });
    expect(first.id.startsWith("data:audio/wav;base64,")).toBe(true);
    expect(await t<PaSpeechItem>("/soul/speech", "POST", { messageId: "xy-13b" })).toEqual({ ...first, cached: true });
    expect((await t<{ items: PaSpeechItem[] }>("/soul/speech?conversationId=conv-xiaoyue")).items.map((item) => item.messageId)).toEqual(["xy-11", "xy-13b"]);
    // An edit drops it from the list until it is read aloud again.
    await t("/soul/messages/xy-13b", "PATCH", { content: "改过的一句话" });
    expect((await t<{ items: PaSpeechItem[] }>("/soul/speech?conversationId=conv-xiaoyue")).items.map((item) => item.messageId)).toEqual(["xy-11"]);
  });

  it("refuses with the daemon's reasons: no voice, no service, an owner line, 关", async () => {
    const code = (promise: Promise<unknown>) => promise.then(() => null, (error: PaRequestError) => error.code);
    expect(await code(createFixtureTransport(buildFixture("companion-chat"), { latency: 0 })("/soul/speech", "POST", { messageId: "xy-13b" }))).toBe("PA_SOUL_VOICE_UNSET");
    expect(await code(createFixtureTransport(withoutSpeech(buildFixture("voice-chat")), { latency: 0 })("/soul/speech", "POST", { messageId: "xy-13b" }))).toBe("PA_SOUL_SPEECH_UNAVAILABLE");
    const t = createFixtureTransport(buildFixture("voice-chat"), { latency: 0 });
    expect(await code(t("/soul/speech", "POST", { messageId: "xy-12" }))).toBe("PA_SOUL_SPEECH");
    await t("/soul/chats/conv-xiaoyue", "PUT", { voiceReplies: "off" });
    expect(await code(t("/soul/speech", "POST", { messageId: "xy-13b" }))).toBe("PA_SOUL_SPEECH_OFF");
    expect((await t<{ items: PaSpeechItem[] }>("/soul/speech?conversationId=conv-xiaoyue")).items).toEqual([]);
  });
});
