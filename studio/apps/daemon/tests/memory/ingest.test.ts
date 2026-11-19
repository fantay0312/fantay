// SPDX-License-Identifier: Apache-2.0
import type { PaDataClass } from "@open-design/contracts";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  buildWindows,
  ingestPaConversation,
  syncStudioConversation,
  syncStudioProject,
  type PaConversationReader,
} from "../../src/services/memory/ingest.js";
import { chunkScopeKeys } from "../../src/services/memory/policy.js";
import type { ChunkSink, ChunkWindow, IngestMessage } from "../../src/services/memory/types.js";

// ---- Fixtures ----------------------------------------------------------------------------------------------------

const BASE = new Date(2026, 10, 9, 14, 0, 0).getTime();
const MINUTE = 60_000;
const TRUNCATION_MARK = "…（已截断）";

function message(index: number, text: string, overrides: Partial<IngestMessage> = {}): IngestMessage {
  const fromBot = index % 2 === 1;
  return {
    id: `m${index}`,
    speaker: fromBot ? "小月" : "用户",
    agentId: fromBot ? "bot-moon" : null,
    text,
    at: BASE + index * MINUTE,
    dataClass: "standard",
    ...overrides,
  };
}

const plainText = (index: number): string => `第${index}条：这是一句长度适中的普通对话内容，用来撑满窗口。`;

function chat(count: number, textOf: (index: number) => string = plainText): IngestMessage[] {
  return Array.from({ length: count }, (_, index) => message(index, textOf(index)));
}

function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const lineOf = (m: IngestMessage): string => `[${clock(m.at)}] ${m.speaker}: ${m.text}`;
const linesOf = (window: ChunkWindow): string[] => window.content.split("\n");
const bodyOf = (line: string): string => line.replace(/^\[\d\d:\d\d\] [^:]+: /, "");
const full = (messages: readonly IngestMessage[]): ChunkWindow[] => buildWindows(messages, { fromSeq: 0 });

/** The leading lines of `next` that repeat the trailing lines of `previous`. */
function overlapLines(previous: ChunkWindow, next: ChunkWindow): string[] {
  const tail = linesOf(previous);
  const head = linesOf(next);
  for (let size = Math.min(tail.length, head.length); size > 0; size -= 1) {
    if (tail.slice(-size).join("\n") === head.slice(0, size).join("\n")) return head.slice(0, size);
  }
  return [];
}

type WriteCall = Parameters<ChunkSink["writeWindows"]>[0];

interface StoredWindow {
  window: ChunkWindow;
  dataClass: PaDataClass;
  scopeKeys: string[];
}

/** Applies writes the way the store does: windows with seq >= fromSeq are replaced, the cursor is kept. */
class FakeSink implements ChunkSink {
  calls: WriteCall[] = [];
  /** Throws on this call (1-based, counted since the last reset), before it is applied. */
  failAtCall: number | null = null;
  private readonly cursors = new Map<string, { messageCount: number; prefixHash: string }>();
  private readonly rows = new Map<string, StoredWindow[]>();

  cursor(source: "pa" | "studio", conversationId: string): { messageCount: number; prefixHash: string } | null {
    return this.cursors.get(`${source}:${conversationId}`) ?? null;
  }

  writeWindows(input: WriteCall): void {
    this.calls.push(input);
    if (this.failAtCall === this.calls.length) throw new Error("write interrupted");
    const key = `${input.source}:${input.conversationId}`;
    const kept = (this.rows.get(key) ?? []).filter((row) => row.window.seq < input.fromSeq);
    const written = input.windows.map((window) => ({
      window,
      dataClass: input.dataClass,
      scopeKeys: chunkScopeKeys({ ...input.scope, speakerAgentIds: window.speakerAgentIds }),
    }));
    this.rows.set(key, [...kept, ...written]);
    this.cursors.set(key, input.cursor);
  }

  stored(source: "pa" | "studio", conversationId: string): StoredWindow[] {
    return this.rows.get(`${source}:${conversationId}`) ?? [];
  }

  resetCalls(): void {
    this.calls = [];
    this.failAtCall = null;
  }
}

interface PaState {
  conversation: ReturnType<PaConversationReader["conversation"]>;
  messages: IngestMessage[];
}

function paState(messages: IngestMessage[], conversation: Partial<NonNullable<PaState["conversation"]>> = {}): PaState {
  return {
    conversation: {
      id: "c1",
      title: "配色讨论",
      agentId: "bot-moon",
      groupId: null,
      channel: false,
      principalId: "owner",
      ...conversation,
    },
    messages,
  };
}

const readerOf = (state: PaState): PaConversationReader => ({
  conversation: () => state.conversation,
  messages: () => state.messages,
});

function ingest(sink: FakeSink, state: PaState, conversationId = "c1"): void {
  ingestPaConversation(sink, readerOf(state), conversationId);
}

function expectMirrorsFullBuild(sink: FakeSink, source: "pa" | "studio", id: string, messages: readonly IngestMessage[]): void {
  expect(sink.stored(source, id).map((row) => row.window)).toEqual(full(messages));
}

// ---- buildWindows ------------------------------------------------------------------------------------------------

describe("buildWindows", () => {
  it("renders one [HH:mm] Speaker: text line per message in local time", () => {
    const windows = buildWindows([message(0, "你好"), message(1, "你好，我是小月")], { fromSeq: 0 });
    expect(windows).toEqual([
      {
        seq: 0,
        content: "[14:00] 用户: 你好\n[14:01] 小月: 你好，我是小月",
        speakers: ["用户", "小月"],
        speakerAgentIds: ["bot-moon"],
        messageIds: ["m0", "m1"],
        startAt: BASE,
        endAt: BASE + MINUTE,
        open: true,
      },
    ]);
  });

  it("returns no windows for no messages", () => {
    expect(buildWindows([], { fromSeq: 0 })).toEqual([]);
  });

  it("puts a message on one line, collapses whitespace and skips messages with nothing left", () => {
    const windows = buildWindows(
      [message(0, "第一行\n\n  第二行\t结尾"), message(1, "  \n\t "), message(2, "\u0007 \u00a0"), message(3, "最后")],
      { fromSeq: 0 },
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.content).toBe("[14:00] 用户: 第一行 第二行 结尾\n[14:03] 小月: 最后");
    expect(windows[0]?.messageIds).toEqual(["m0", "m3"]);
  });

  it("cuts a message over 1200 characters and marks the cut", () => {
    const text = Array.from({ length: 600 }, (_, index) => `w${index}`).join(" ");
    const windows = buildWindows([message(0, text)], { fromSeq: 0 });
    const lines = [...new Set(windows.flatMap(linesOf))];
    expect(lines.every((line) => line.length <= 500)).toBe(true);
    const body = lines.map(bodyOf).join(" ");
    expect(body).toBe(text.slice(0, 1200).trimEnd() + TRUNCATION_MARK);
    expect(body.endsWith(TRUNCATION_MARK)).toBe(true);
  });

  it("keeps a message of exactly 1200 characters whole", () => {
    const text = Array.from({ length: 300 }, (_, index) => String(1000 + index).padStart(4, "字")).join("").slice(0, 1200);
    expect(text).toHaveLength(1200);
    const body = [...new Set(buildWindows([message(0, text)], { fromSeq: 0 }).flatMap(linesOf))].map(bodyOf).join("");
    expect(body).toBe(text);
  });

  it("ends windows at message boundaries and keeps each window within its size", () => {
    const messages = chat(30);
    const windows = buildWindows(messages, { fromSeq: 0, windowChars: 200, overlapChars: 0 });
    const expected = new Set(messages.map(lineOf));
    expect(windows.length).toBeGreaterThan(3);
    for (const window of windows) {
      expect(window.content.length).toBeLessThanOrEqual(200);
      for (const line of linesOf(window)) expect(expected.has(line)).toBe(true);
    }
    // Without overlap every message lands in exactly one window.
    expect(windows.flatMap((window) => window.messageIds)).toEqual(messages.map((m) => m.id));
  });

  it("repeats the trailing lines of the previous window within the overlap budget", () => {
    const windows = buildWindows(chat(40), { fromSeq: 0, windowChars: 200, overlapChars: 80 });
    expect(windows.length).toBeGreaterThan(3);
    for (let index = 1; index < windows.length; index += 1) {
      const shared = overlapLines(windows[index - 1] as ChunkWindow, windows[index] as ChunkWindow);
      expect(shared.length).toBeGreaterThanOrEqual(1);
      expect(shared.reduce((total, line) => total + line.length + 1, 0)).toBeLessThanOrEqual(80);
    }
  });

  it("counts the speakers and messages of overlap lines in the window that repeats them", () => {
    const [first, second] = buildWindows(chat(40), { fromSeq: 0, windowChars: 200, overlapChars: 80 });
    const repeatedId = first?.messageIds.at(-1) as string;
    expect(second?.messageIds).toContain(repeatedId);
    expect(second?.startAt).toBeLessThanOrEqual(first?.endAt as number);
  });

  it("splits a message longer than a window at sentence ends, in a window of its own start", () => {
    const sentence = (index: number): string => `这是第${index}句话，它的长度固定，所以几句加起来会超过一个窗口的容量。`;
    const long = Array.from({ length: 24 }, (_, index) => sentence(index)).join("");
    const messages = [message(0, "开头一句"), message(1, long), message(2, "收尾一句")];
    const windows = full(messages);

    expect(windows[0]?.content).toBe(lineOf(messages[0] as IngestMessage));
    expect(windows[0]?.open).toBe(false);
    const pieces = [...new Set(windows.flatMap(linesOf))].filter((line) => line.includes("小月: "));
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(500);
      expect(piece.startsWith("[14:01] 小月: ")).toBe(true);
      expect(piece.endsWith("。")).toBe(true);
    }
    expect(pieces.map(bodyOf).join("")).toBe(long);
    expect(windows.at(-1)?.messageIds).toContain("m2");
  });

  it("splits one endless sentence at a comma near the end of the budget", () => {
    const text = Array.from({ length: 150 }, (_, index) => `词${index}，`).join("");
    const lines = [...new Set(full([message(0, text)]).flatMap(linesOf))];
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 500)).toBe(true);
    expect(lines.map(bodyOf).join("")).toBe(text);
    expect(lines.slice(0, -1).every((line) => line.endsWith("，"))).toBe(true);
  });

  it("is deterministic and only the last window is open", () => {
    const messages = chat(45);
    const windows = full(messages);
    expect(full(messages)).toEqual(windows);
    expect(windows.map((window) => window.open)).toEqual(windows.map((_, index) => index === windows.length - 1));
    expect(windows.map((window) => window.seq)).toEqual(windows.map((_, index) => index));
  });

  it("changes only the open window and adds new ones when messages are appended", () => {
    for (let count = 25; count < 60; count += 1) {
      const before = full(chat(count));
      const after = full(chat(count + 1));
      expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
      expect(after.length).toBeGreaterThanOrEqual(before.length);
    }
  });

  it("returns only the windows from fromSeq on", () => {
    const messages = chat(50);
    expect(buildWindows(messages, { fromSeq: 2 })).toEqual(full(messages).slice(2));
    expect(buildWindows(messages, { fromSeq: 999 })).toEqual([]);
  });
});

// ---- Personal agent conversations --------------------------------------------------------------------------------

describe("ingestPaConversation", () => {
  it("writes a 1:1 conversation with its facts and the principal passed through", () => {
    const sink = new FakeSink();
    const state = paState(chat(30), { principalId: "member-7" });
    ingest(sink, state);

    expect(sink.calls).toHaveLength(1);
    const [call] = sink.calls as [WriteCall];
    expect(call).toMatchObject({
      source: "pa",
      conversationId: "c1",
      fromSeq: 0,
      dataClass: "standard",
      principalId: "member-7",
      scope: { source: "pa", conversationId: "c1", agentId: "bot-moon", groupId: null, channel: false },
    });
    expect(call.windows).toEqual(full(state.messages));
    expect(call.cursor.prefixHash).not.toBe("");
    expect(sink.stored("pa", "c1").every((row) => row.scopeKeys.join() === "conversation:c1,bot:bot-moon")).toBe(true);
  });

  it("writes a group conversation with the bots that spoke in each window", () => {
    const messages = [
      ...chat(20).map((m, index) => (index % 2 === 1 ? { ...m, speaker: "甲", agentId: "bot-a" } : m)),
      ...chat(20).map((m, index) =>
        index % 2 === 1
          ? { ...m, id: `n${index}`, speaker: "乙", agentId: "bot-b", at: m.at + 30 * MINUTE }
          : { ...m, id: `n${index}`, at: m.at + 30 * MINUTE },
      ),
    ];
    const sink = new FakeSink();
    ingest(sink, paState(messages, { id: "g1", agentId: null, groupId: "grp" }), "g1");

    const [call] = sink.calls as [WriteCall];
    expect(call.scope).toEqual({ source: "pa", conversationId: "g1", agentId: null, groupId: "grp", channel: false });
    const rows = sink.stored("pa", "g1");
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      expect(row.scopeKeys).toEqual([
        "conversation:g1",
        "group:grp",
        ...row.window.speakerAgentIds.map((id) => `bot:${id}`),
      ]);
    }
    expect(rows[0]?.window.speakerAgentIds).toEqual(["bot-a"]);
    expect(rows.at(-1)?.window.speakerAgentIds).toEqual(["bot-b"]);
    expect(new Set(rows.flatMap((row) => row.window.speakerAgentIds))).toEqual(new Set(["bot-a", "bot-b"]));
    expect(rows.some((row) => row.window.speakerAgentIds.length === 2)).toBe(true);
  });

  it("keeps channel conversations to their own conversation scope", () => {
    const sink = new FakeSink();
    ingest(sink, paState(chat(20), { id: "ch1", agentId: null, groupId: "grp", channel: true }), "ch1");
    const [call] = sink.calls as [WriteCall];
    expect(call.scope).toMatchObject({ source: "pa", conversationId: "ch1", channel: true });
    const rows = sink.stored("pa", "ch1");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.scopeKeys.join() === "conversation:ch1")).toBe(true);
  });

  it("writes nothing when synced twice without new messages", () => {
    const sink = new FakeSink();
    const state = paState(chat(30));
    ingest(sink, state);
    sink.resetCalls();
    ingest(sink, state);
    ingest(sink, { ...state, messages: [...state.messages] });
    expect(sink.calls).toEqual([]);
  });

  it("writes nothing for a conversation without messages", () => {
    const sink = new FakeSink();
    ingest(sink, paState([message(0, "  ")]));
    expect(sink.calls).toEqual([]);
  });

  it("rebuilds only the open window when messages are appended", () => {
    const sink = new FakeSink();
    const state = paState(chat(30));
    ingest(sink, state);

    for (let count = 31; count <= 70; count += 1) {
      const windowsBefore = sink.stored("pa", "c1").length;
      state.messages = chat(count);
      sink.resetCalls();
      ingest(sink, state);

      expect(sink.calls).toHaveLength(1);
      const [call] = sink.calls as [WriteCall];
      expect(call.fromSeq).toBe(windowsBefore - 1);
      expect(call.windows).toEqual(buildWindows(state.messages, { fromSeq: call.fromSeq }));
      expectMirrorsFullBuild(sink, "pa", "c1", state.messages);
    }
  });

  it("rebuilds only the open window when the last message is edited", () => {
    const sink = new FakeSink();
    const state = paState(chat(30));
    ingest(sink, state);
    const windowsBefore = sink.stored("pa", "c1");
    expect(windowsBefore.at(-1)?.window.messageIds.length).toBeGreaterThanOrEqual(3);

    state.messages = [...state.messages.slice(0, -1), { ...(state.messages.at(-1) as IngestMessage), text: "改过的最后一条" }];
    sink.resetCalls();
    ingest(sink, state);

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.fromSeq).toBe(windowsBefore.length - 1);
    expectMirrorsFullBuild(sink, "pa", "c1", state.messages);
  });

  it("rebuilds the conversation when an old message is edited, even to the same length", () => {
    const sink = new FakeSink();
    const state = paState(chat(30));
    ingest(sink, state);

    const edited = state.messages.map((m) => (m.id === "m2" ? { ...m, text: m.text.replace("普通", "特殊") } : m));
    expect(edited[2]?.text.length).toBe(state.messages[2]?.text.length);
    state.messages = edited;
    sink.resetCalls();
    ingest(sink, state);

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.fromSeq).toBe(0);
    expectMirrorsFullBuild(sink, "pa", "c1", state.messages);
  });

  it("rebuilds the conversation when an old message is deleted", () => {
    const sink = new FakeSink();
    const state = paState(chat(30));
    ingest(sink, state);

    state.messages = state.messages.filter((m) => m.id !== "m3");
    sink.resetCalls();
    ingest(sink, state);

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.fromSeq).toBe(0);
    expectMirrorsFullBuild(sink, "pa", "c1", state.messages);
  });

  it("follows the last messages being deleted", () => {
    const sink = new FakeSink();
    const state = paState(chat(40));
    ingest(sink, state);

    for (const keep of [39, 25, 12, 3]) {
      state.messages = chat(keep);
      ingest(sink, state);
      expectMirrorsFullBuild(sink, "pa", "c1", state.messages);
    }
  });

  it("clears the windows when every message is gone, and then stays quiet", () => {
    const sink = new FakeSink();
    const state = paState(chat(30));
    ingest(sink, state);

    state.messages = [];
    sink.resetCalls();
    ingest(sink, state);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toMatchObject({ fromSeq: 0, windows: [] });
    expect(sink.stored("pa", "c1")).toEqual([]);

    sink.resetCalls();
    ingest(sink, state);
    expect(sink.calls).toEqual([]);
  });

  it("clears the windows of a conversation that no longer exists, once", () => {
    const sink = new FakeSink();
    const state = paState(chat(30));
    ingest(sink, state);

    state.conversation = null;
    sink.resetCalls();
    ingest(sink, state);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toMatchObject({ fromSeq: 0, windows: [] });
    expect(sink.stored("pa", "c1")).toEqual([]);

    sink.resetCalls();
    ingest(sink, state);
    expect(sink.calls).toEqual([]);
    ingest(new FakeSink(), paState(chat(3)), "unknown");
  });

  it("rebuilds everything when the conversation's facts change", () => {
    const sink = new FakeSink();
    const state = paState(chat(30));
    ingest(sink, state);

    state.conversation = { ...(state.conversation as NonNullable<PaState["conversation"]>), agentId: "bot-sun" };
    sink.resetCalls();
    ingest(sink, state);

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toMatchObject({ fromSeq: 0, scope: { agentId: "bot-sun" } });
    expect(sink.stored("pa", "c1").every((row) => row.scopeKeys.join() === "conversation:c1,bot:bot-sun")).toBe(true);
  });

  describe("data class", () => {
    const expectedClass = (messages: readonly IngestMessage[], window: ChunkWindow): PaDataClass => {
      const local = new Set(messages.filter((m) => m.dataClass === "local_only").map((m) => m.id));
      return window.messageIds.some((id) => local.has(id)) ? "local_only" : "standard";
    };

    it("marks a window local_only when any of its messages is, overlap lines included", () => {
      const clean = chat(60);
      const [first, second] = full(clean);
      const repeatedId = first?.messageIds.find((id) => second?.messageIds.includes(id)) as string;
      const messages = clean.map((m) => (m.id === repeatedId ? { ...m, dataClass: "local_only" as const } : m));

      const sink = new FakeSink();
      ingest(sink, paState(messages, { principalId: "member-7" }));

      const rows = sink.stored("pa", "c1");
      expect(rows.map((row) => row.dataClass)).toEqual(rows.map((row) => expectedClass(messages, row.window)));
      expect(rows.slice(0, 2).map((row) => row.dataClass)).toEqual(["local_only", "local_only"]);
      expect(rows.slice(2).every((row) => row.dataClass === "standard")).toBe(true);
      expect(sink.calls.map((call) => [call.dataClass, call.fromSeq])).toEqual([
        ["local_only", 0],
        ["standard", 2],
      ]);
      expect(sink.calls.every((call) => call.principalId === "member-7")).toBe(true);
    });

    it("writes each class run in order and stores the real cursor only with the last call", () => {
      const clean = chat(60);
      const middle = full(clean)[3]?.messageIds[4] as string;
      const messages = clean.map((m) => (m.id === middle ? { ...m, dataClass: "local_only" as const } : m));

      const sink = new FakeSink();
      ingest(sink, paState(messages));

      expect(sink.calls.map((call) => call.dataClass)).toEqual(["standard", "local_only", "standard"]);
      expect(sink.calls.map((call) => call.fromSeq)).toEqual([0, 3, 4]);
      expect(sink.calls[0]?.cursor).toEqual({ messageCount: 0, prefixHash: "" });
      expect(sink.calls[1]?.cursor).toEqual({ messageCount: 0, prefixHash: "" });
      expect(sink.calls[2]?.cursor.prefixHash).not.toBe("");
      const rows = sink.stored("pa", "c1");
      expectMirrorsFullBuild(sink, "pa", "c1", messages);
      expect(rows.map((row) => row.dataClass)).toEqual(rows.map((row) => expectedClass(messages, row.window)));

      sink.resetCalls();
      ingest(sink, paState(messages));
      expect(sink.calls).toEqual([]);
    });

    it("rebuilds from the start after a write that was interrupted between calls", () => {
      const clean = chat(60);
      const middle = full(clean)[3]?.messageIds[4] as string;
      const messages = clean.map((m) => (m.id === middle ? { ...m, dataClass: "local_only" as const } : m));
      const sink = new FakeSink();
      sink.failAtCall = 2;

      expect(() => ingest(sink, paState(messages))).toThrow("write interrupted");
      expect(sink.stored("pa", "c1")).toHaveLength(3);

      sink.resetCalls();
      ingest(sink, paState(messages));
      expect(sink.calls[0]?.fromSeq).toBe(0);
      expectMirrorsFullBuild(sink, "pa", "c1", messages);
      const rows = sink.stored("pa", "c1");
      expect(rows.map((row) => row.dataClass)).toEqual(rows.map((row) => expectedClass(messages, row.window)));
    });

    it("rewrites windows when a message becomes local_only without any text change", () => {
      const sink = new FakeSink();
      const state = paState(chat(30));
      ingest(sink, state);
      expect(sink.stored("pa", "c1").every((row) => row.dataClass === "standard")).toBe(true);

      state.messages = state.messages.map((m) => (m.id === "m1" ? { ...m, dataClass: "local_only" as const } : m));
      ingest(sink, state);
      const rows = sink.stored("pa", "c1");
      expect(rows.map((row) => row.dataClass)).toEqual(rows.map((row) => expectedClass(state.messages, row.window)));
      expect(rows[0]?.dataClass).toBe("local_only");
    });
  });

  it("always ends up with exactly the windows of a full rebuild, whatever changed in between", () => {
    const sentence = (index: number): string => `这是第${index}句话，它的长度固定，所以几句加起来会超过一个窗口的容量。`;
    const long = Array.from({ length: 30 }, (_, index) => sentence(index)).join("");
    let seed = 20261116;
    const random = (limit: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    };
    const sink = new FakeSink();
    const state = paState(chat(5));
    let next = 100;
    let resumedWrites = 0;
    for (let step = 0; step < 400; step += 1) {
      const action = random(10);
      const at = random(Math.max(1, state.messages.length));
      if (action < 5 || state.messages.length < 3) {
        const text = random(8) === 0 ? long : random(4) === 0 ? "短" : plainText(next);
        state.messages = [...state.messages, message(next, text, { dataClass: random(12) === 0 ? "local_only" : "standard" })];
        next += 1;
      } else if (action < 7) {
        state.messages = state.messages.map((m, index) => (index === at ? { ...m, text: `${m.text}改` } : m));
      } else if (action < 8) {
        state.messages = state.messages.filter((_, index) => index !== at);
      } else if (action < 9) {
        state.messages = state.messages.slice(0, Math.max(1, state.messages.length - 1 - random(3)));
      } else {
        state.messages = state.messages.map((m, index) =>
          index === at ? { ...m, dataClass: m.dataClass === "standard" ? "local_only" : "standard" } : m,
        );
      }
      ingest(sink, state);
      if (sink.calls.some((call) => call.fromSeq > 0)) resumedWrites += 1;
      expectMirrorsFullBuild(sink, "pa", "c1", state.messages);
      const rows = sink.stored("pa", "c1");
      const local = new Set(state.messages.filter((m) => m.dataClass === "local_only").map((m) => m.id));
      expect(rows.map((row) => row.dataClass)).toEqual(
        rows.map((row) => (row.window.messageIds.some((id) => local.has(id)) ? "local_only" : "standard")),
      );
      sink.resetCalls();
      ingest(sink, state);
      expect(sink.calls).toEqual([]);
    }
    // The run must have exercised the resume path, not just full rebuilds.
    expect(resumedWrites).toBeGreaterThan(100);
  });

  it("keeps a split message and the open window consistent as messages arrive", () => {
    const sentence = (index: number): string => `这是第${index}句话，它的长度固定，所以几句加起来会超过一个窗口的容量。`;
    const long = Array.from({ length: 24 }, (_, index) => sentence(index)).join("");
    const sink = new FakeSink();
    const state = paState([message(0, "开头一句"), message(1, long)]);
    ingest(sink, state);
    expectMirrorsFullBuild(sink, "pa", "c1", state.messages);

    for (let index = 2; index < 40; index += 1) {
      state.messages = [...state.messages, message(index, index === 20 ? long : plainText(index))];
      sink.resetCalls();
      ingest(sink, state);
      expect(sink.calls.length).toBeGreaterThan(0);
      expectMirrorsFullBuild(sink, "pa", "c1", state.messages);
      sink.resetCalls();
      ingest(sink, state);
      expect(sink.calls).toEqual([]);
    }
  });
});

// ---- Studio conversations ----------------------------------------------------------------------------------------

// The two tables as db.ts creates them (plus the columns its migrations add). `projects` is a stub for the foreign key.
const STUDIO_DDL = `
  CREATE TABLE projects (id TEXT PRIMARY KEY);

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT,
    session_mode TEXT NOT NULL DEFAULT 'design',
    execution_permission TEXT,
    intent_signals_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_conv_project ON conversations(project_id, updated_at DESC);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    agent_id TEXT,
    agent_name TEXT,
    result_delivery_state TEXT,
    events_json TEXT,
    attachments_json TEXT,
    produced_files_json TEXT,
    trace_object_files_json TEXT,
    feedback_json TEXT,
    pre_turn_file_names_json TEXT,
    session_mode TEXT,
    run_context_json TEXT,
    task_analytics_json TEXT,
    applied_plugin_snapshot_json TEXT,
    telemetry_finalized_at INTEGER,
    started_at INTEGER,
    ended_at INTEGER,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_messages_conv ON messages(conversation_id, position);

  ALTER TABLE messages ADD COLUMN branch_parent_id TEXT;
  ALTER TABLE messages ADD COLUMN branch_selected INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE messages ADD COLUMN branch_visible INTEGER NOT NULL DEFAULT 1;
`;

function studioDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(STUDIO_DDL);
  return db;
}

let tick = 1_000;

function addConversation(db: Database.Database, id: string, projectId: string): void {
  db.prepare("INSERT OR IGNORE INTO projects(id) VALUES (?)").run(projectId);
  db.prepare("INSERT INTO conversations(id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    projectId,
    `对话 ${id}`,
    BASE,
    BASE,
  );
}

interface StudioMessage {
  id: string;
  role?: "user" | "assistant";
  content: string;
  agentName?: string | null;
  position: number;
  visible?: 0 | 1;
}

/** Inserts the way the daemon does: the message row, then the conversation's activity time. */
function addStudioMessage(db: Database.Database, conversationId: string, m: StudioMessage): void {
  db.prepare(
    `INSERT INTO messages(id, conversation_id, role, content, agent_name, position, created_at, branch_visible)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(m.id, conversationId, m.role ?? "user", m.content, m.agentName ?? null, m.position, BASE + m.position * MINUTE, m.visible ?? 1);
  touch(db, conversationId);
}

function touch(db: Database.Database, conversationId: string): void {
  tick += 1;
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(tick, conversationId);
}

function fillStudioConversation(db: Database.Database, conversationId: string, count: number): void {
  for (let position = 0; position < count; position += 1) {
    addStudioMessage(db, conversationId, {
      id: `${conversationId}-m${position}`,
      role: position % 2 === 0 ? "user" : "assistant",
      agentName: position % 2 === 0 ? null : "设计师",
      content: plainText(position),
      position,
    });
  }
}

function studioMessagesOf(db: Database.Database, conversationId: string): IngestMessage[] {
  const rows = db
    .prepare(
      `SELECT id, role, content, agent_name AS agentName, created_at AS createdAt FROM messages
        WHERE conversation_id = ? AND branch_visible = 1 ORDER BY position`,
    )
    .all(conversationId) as Array<{ id: string; role: string; content: string; agentName: string | null; createdAt: number }>;
  return rows.map((row) => ({
    id: row.id,
    speaker: row.role === "user" ? "用户" : (row.agentName ?? "助手"),
    agentId: null,
    text: row.content,
    at: row.createdAt,
    dataClass: "standard",
  }));
}

describe("Studio conversations", () => {
  it("reads visible messages in position order with the speaker taken from the role", () => {
    const db = studioDb();
    addConversation(db, "s1", "p1");
    addStudioMessage(db, "s1", { id: "b", role: "assistant", agentName: "设计师", content: "好的，我来改。", position: 1 });
    addStudioMessage(db, "s1", { id: "a", role: "user", content: "把主色改成青绿", position: 0 });
    addStudioMessage(db, "s1", { id: "c", role: "assistant", content: "没有名字的回复", position: 2 });
    addStudioMessage(db, "s1", { id: "hidden", role: "assistant", content: "另一条分支上的回复", position: 3, visible: 0 });

    const sink = new FakeSink();
    syncStudioConversation(sink, db, "s1");

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toMatchObject({
      source: "studio",
      conversationId: "s1",
      fromSeq: 0,
      dataClass: "standard",
      principalId: "owner",
      scope: { source: "studio", conversationId: "s1", projectId: "p1" },
    });
    const [window] = sink.calls[0]?.windows ?? [];
    expect(window?.content).toBe(
      "[14:00] 用户: 把主色改成青绿\n[14:01] 设计师: 好的，我来改。\n[14:02] 助手: 没有名字的回复",
    );
    expect(window?.messageIds).toEqual(["a", "b", "c"]);
    expect(sink.stored("studio", "s1")[0]?.scopeKeys).toEqual(["conversation:s1", "project:p1"]);
  });

  it("ignores messages that are neither from the user nor the assistant", () => {
    const db = studioDb();
    addConversation(db, "s1", "p1");
    addStudioMessage(db, "s1", { id: "a", content: "你好", position: 0 });
    db.prepare(
      "INSERT INTO messages(id, conversation_id, role, content, position, created_at) VALUES ('sys', 's1', 'system', '内部提示', 1, ?)",
    ).run(BASE);
    const sink = new FakeSink();
    syncStudioConversation(sink, db, "s1");
    expect(sink.calls[0]?.windows[0]?.messageIds).toEqual(["a"]);
  });

  it("replaces artifacts, forms and long code blocks with short placeholders", () => {
    const db = studioDb();
    addConversation(db, "s1", "p1");
    const html = `<!doctype html><html>${"<p>很长很长的页面内容</p>".repeat(200)}</html>`;
    const code = "const value = 1;\n".repeat(60);
    addStudioMessage(db, "s1", {
      id: "a1",
      role: "assistant",
      agentName: "设计师",
      position: 0,
      content: `首页做好了。<artifact identifier="home" type="text/html" title="首页">${html}</artifact>请看看。`,
    });
    addStudioMessage(db, "s1", {
      id: "a2",
      role: "assistant",
      agentName: "设计师",
      position: 1,
      content: `先确认几个问题<question-form id="brief">{"questions":[{"id":"q1","label":"主色？"}]}</question-form>`,
    });
    addStudioMessage(db, "s1", {
      id: "a3",
      role: "assistant",
      agentName: "设计师",
      position: 2,
      content: `脚本如下\n\`\`\`ts\n${code}\`\`\`\n短的保留 \`\`\`ts\nlet a = 1;\n\`\`\``,
    });
    addStudioMessage(db, "s1", {
      id: "a4",
      role: "assistant",
      agentName: "设计师",
      position: 3,
      content: `写到一半<artifact identifier="late" type="text/html">${html}`,
    });
    addStudioMessage(db, "s1", {
      id: "u1",
      position: 4,
      content: "标签 <artifact> 和 <artifactual> 只是文字",
    });

    const sink = new FakeSink();
    syncStudioConversation(sink, db, "s1");
    const lines = (sink.calls[0]?.windows ?? []).flatMap(linesOf);
    const bodies = new Map(lines.map((line) => [line.slice(0, 7) + line.slice(7, 20), bodyOf(line)]));
    const text = [...bodies.values()].join("\n");

    expect(text).toContain("首页做好了。[产物：首页]请看看。");
    expect(text).toContain("先确认几个问题[问题表单]");
    expect(text).toContain("脚本如下 [代码块，60 行]");
    expect(text).toContain("短的保留 ```ts let a = 1; ```");
    expect(text).toContain("写到一半[产物：late]");
    expect(text).toContain("标签 <artifact> 和 <artifactual> 只是文字");
    expect(text).not.toContain("很长很长");
    expect(text).not.toContain("const value");
    expect(text).not.toContain("questions");
  });

  it("skips comment-anchor conversations", () => {
    const db = studioDb();
    addConversation(db, "comment-anchor-1", "p1");
    addStudioMessage(db, "comment-anchor-1", { id: "x", content: "批注", position: 0 });
    addConversation(db, "s1", "p1");
    addStudioMessage(db, "s1", { id: "y", content: "正文", position: 0 });

    const sink = new FakeSink();
    syncStudioConversation(sink, db, "comment-anchor-1");
    syncStudioProject(sink, db, "p1");
    expect(sink.calls.map((call) => call.conversationId)).toEqual(["s1"]);
  });

  it("writes nothing when synced again, and only the open window when a message is appended", () => {
    const db = studioDb();
    addConversation(db, "s1", "p1");
    fillStudioConversation(db, "s1", 30);
    const sink = new FakeSink();
    syncStudioConversation(sink, db, "s1");
    syncStudioConversation(sink, db, "s1");
    expect(sink.calls).toHaveLength(1);
    expectMirrorsFullBuild(sink, "studio", "s1", studioMessagesOf(db, "s1"));

    const windowsBefore = sink.stored("studio", "s1").length;
    addStudioMessage(db, "s1", { id: "s1-m30", role: "assistant", agentName: "设计师", content: "再补一条", position: 30 });
    sink.resetCalls();
    syncStudioConversation(sink, db, "s1");
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.fromSeq).toBe(windowsBefore - 1);
    expectMirrorsFullBuild(sink, "studio", "s1", studioMessagesOf(db, "s1"));
  });

  it("rebuilds from the start when an old message is edited or hidden", () => {
    const db = studioDb();
    addConversation(db, "s1", "p1");
    fillStudioConversation(db, "s1", 30);
    const sink = new FakeSink();
    syncStudioConversation(sink, db, "s1");

    db.prepare("UPDATE messages SET content = ? WHERE id = 's1-m2'").run("改过的第三条");
    touch(db, "s1");
    sink.resetCalls();
    syncStudioConversation(sink, db, "s1");
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.fromSeq).toBe(0);
    expectMirrorsFullBuild(sink, "studio", "s1", studioMessagesOf(db, "s1"));

    db.prepare("UPDATE messages SET branch_visible = 0 WHERE id = 's1-m4'").run();
    touch(db, "s1");
    sink.resetCalls();
    syncStudioConversation(sink, db, "s1");
    expect(sink.calls[0]?.fromSeq).toBe(0);
    expectMirrorsFullBuild(sink, "studio", "s1", studioMessagesOf(db, "s1"));
  });

  it("only records a new change marker when nothing visible changed", () => {
    const db = studioDb();
    addConversation(db, "s1", "p1");
    fillStudioConversation(db, "s1", 30);
    const sink = new FakeSink();
    syncStudioConversation(sink, db, "s1");
    const before = sink.stored("studio", "s1");

    touch(db, "s1");
    sink.resetCalls();
    syncStudioConversation(sink, db, "s1");
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toMatchObject({ fromSeq: before.length, windows: [] });
    expect(sink.stored("studio", "s1")).toEqual(before);

    sink.resetCalls();
    syncStudioConversation(sink, db, "s1");
    syncStudioProject(sink, db, "p1");
    expect(sink.calls).toEqual([]);
  });

  it("clears the windows of a conversation that was deleted", () => {
    const db = studioDb();
    addConversation(db, "s1", "p1");
    fillStudioConversation(db, "s1", 10);
    const sink = new FakeSink();
    syncStudioConversation(sink, db, "s1");
    expect(sink.stored("studio", "s1").length).toBeGreaterThan(0);

    db.prepare("DELETE FROM messages WHERE conversation_id = 's1'").run();
    db.prepare("DELETE FROM conversations WHERE id = 's1'").run();
    sink.resetCalls();
    syncStudioConversation(sink, db, "s1");
    expect(sink.stored("studio", "s1")).toEqual([]);
    expect(sink.calls).toHaveLength(1);
    sink.resetCalls();
    syncStudioConversation(sink, db, "s1");
    expect(sink.calls).toEqual([]);
  });

  describe("syncStudioProject", () => {
    it("visits only the project's conversations that changed since their cursor", () => {
      const db = studioDb();
      for (const id of ["s1", "s2", "s3"]) {
        addConversation(db, id, "p1");
        fillStudioConversation(db, id, 12);
      }
      addConversation(db, "other", "p2");
      fillStudioConversation(db, "other", 4);

      const sink = new FakeSink();
      syncStudioProject(sink, db, "p1");
      expect(new Set(sink.calls.map((call) => call.conversationId))).toEqual(new Set(["s1", "s2", "s3"]));

      sink.resetCalls();
      syncStudioProject(sink, db, "p1");
      expect(sink.calls).toEqual([]);

      addStudioMessage(db, "s2", { id: "s2-new", role: "assistant", content: "新的一条", position: 12 });
      syncStudioProject(sink, db, "p1");
      expect(sink.calls.map((call) => call.conversationId)).toEqual(["s2"]);
      expectMirrorsFullBuild(sink, "studio", "s2", studioMessagesOf(db, "s2"));

      sink.resetCalls();
      syncStudioProject(sink, db, "p1");
      expect(sink.calls).toEqual([]);
    });

    it("does not read a conversation whose activity time and message count are unchanged", () => {
      const db = studioDb();
      addConversation(db, "s1", "p1");
      fillStudioConversation(db, "s1", 12);
      const sink = new FakeSink();
      syncStudioProject(sink, db, "p1");
      sink.resetCalls();

      // Rewritten behind the daemon's back: the project pass trusts the activity time, a direct sync reads the text.
      db.prepare("UPDATE messages SET content = '悄悄改过' WHERE id = 's1-m0'").run();
      syncStudioProject(sink, db, "p1");
      expect(sink.calls).toEqual([]);

      syncStudioConversation(sink, db, "s1");
      expect(sink.calls).toHaveLength(1);
      expectMirrorsFullBuild(sink, "studio", "s1", studioMessagesOf(db, "s1"));
    });

    it("picks up a message that became visible again", () => {
      const db = studioDb();
      addConversation(db, "s1", "p1");
      fillStudioConversation(db, "s1", 6);
      db.prepare("UPDATE messages SET branch_visible = 0 WHERE id = 's1-m5'").run();
      const sink = new FakeSink();
      syncStudioProject(sink, db, "p1");
      const hidden = sink.stored("studio", "s1")[0]?.window.messageIds ?? [];
      expect(hidden).not.toContain("s1-m5");

      db.prepare("UPDATE messages SET branch_visible = 1 WHERE id = 's1-m5'").run();
      touch(db, "s1");
      sink.resetCalls();
      syncStudioProject(sink, db, "p1");
      expect(sink.calls).toHaveLength(1);
      expect(sink.stored("studio", "s1")[0]?.window.messageIds).toContain("s1-m5");
    });
  });
});
