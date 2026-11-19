// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  DISTILL_SYSTEM,
  formatLocalDay,
  MemoryDistiller,
  MERGE_SYSTEM,
  parseLocalDay,
  parseModelJson,
} from "../../src/services/memory/distill.js";
import type { DistillInput, DistillTarget, MemoryLlm } from "../../src/services/memory/types.js";

type CompleteInput = Parameters<MemoryLlm["complete"]>[0];

function fakeLlm(reply: string | null | Error | ((input: CompleteInput) => string | null)) {
  const calls: CompleteInput[] = [];
  const llm: MemoryLlm = {
    async complete(input) {
      calls.push(input);
      if (reply instanceof Error) throw reply;
      return typeof reply === "function" ? reply(input) : reply;
    },
  };
  return { llm, calls };
}

const NOW = new Date(2026, 10, 16, 10, 30).getTime(); // Monday 2026-11-16, local time
const noon = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12).getTime();

const TARGETS: DistillTarget[] = [
  { scope: { kind: "profile", id: "" }, hint: "稳定的个人事实和偏好" },
  { scope: { kind: "project", id: "p-fantay" }, hint: "Fantay 项目的决定和约定" },
  { scope: { kind: "bot", id: "xiaoyue" }, hint: "小月自己的经历" },
];

const TRANSCRIPT = [
  "用户: 以后回复都用中文，结论先行。",
  "小月: 好的，记住了。",
  "用户: 首页主色定了，用青绿 #0FB5AE，因为和 logo 搭。",
  "用户: 下周五之前我要把配色方案发给设计组。",
  "用户: Always run the tests with   pnpm\n  vitest before pushing.",
  "小月: 今天天气不错呢。",
].join("\n");

function input(patch: Partial<DistillInput> = {}): DistillInput {
  return { transcript: TRANSCRIPT, targets: TARGETS, ...patch };
}

function reply(memories: unknown[]): string {
  return JSON.stringify({ memories });
}

const distiller = new MemoryDistiller(() => NOW);

describe("MemoryDistiller.distill", () => {
  it("returns [] without asking when there is no model, no target or no transcript", async () => {
    const { llm, calls } = fakeLlm(reply([]));
    expect(await distiller.distill(input(), null)).toEqual([]);
    expect(await distiller.distill(input({ targets: [] }), llm)).toEqual([]);
    expect(await distiller.distill(input({ transcript: "  \n " }), llm)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("sends the rules, today's date, the offered scopes, what is known and the transcript", async () => {
    const { llm, calls } = fakeLlm(reply([]));
    const controller = new AbortController();
    await distiller.distill(
      input({ known: ["主人养了一只猫，叫团子"], dataClass: "local_only", signal: controller.signal }),
      llm,
    );
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.system).toBe(DISTILL_SYSTEM);
    for (const rule of [
      "worth remembering beyond it",
      "small talk",
      "re-read from files",
      "secrets",
      "instructions aimed at the assistant",
      "self-contained sentence in the language of the conversation",
      "copied exactly from the transcript",
      "exactly one scope key",
      "at most 6",
      '"eventDate":"YYYY-MM-DD"|null',
      "Keep only what the transcript itself supports",
      "CONFLICT: <who> says …; <who> says …",
      "never the correction of an earlier decision",
      "exact names, identifiers, commands, paths, numbers, dates and values",
      "plain statement of how things are now",
      "name it (\"the deploy token\") without its value",
      "counts only when the owner adopted it",
    ]) {
      expect(call.system).toContain(rule);
    }
    expect(call.user).toContain("Today: 2026-11-16 (Monday)");
    expect(call.user).toContain("- profile: — 稳定的个人事实和偏好");
    expect(call.user).toContain("- project:p-fantay — Fantay 项目的决定和约定");
    expect(call.user).toContain("- 主人养了一只猫，叫团子");
    expect(call.user).toContain(`<transcript>\n${TRANSCRIPT}\n</transcript>`);
    expect(call.dataClass).toBe("local_only");
    expect(call.signal).toBe(controller.signal);
    expect(call.maxTokens).toBeGreaterThan(0);
  });

  it("keeps memories whose quote is in the transcript and whose scope was offered", async () => {
    const { llm } = fakeLlm(
      reply([
        {
          scope: "profile:",
          kind: "preference",
          content: "主人希望回复用中文，结论先行。",
          // Half-width comma against the transcript's full-width one, plus wrapping quotation marks.
          quote: "“以后回复都用中文,结论先行”",
          eventDate: null,
          dueDate: null,
        },
        {
          scope: "project:p-fantay",
          kind: "decision",
          content: "Fantay 首页主色定为青绿 #0FB5AE，因为和 logo 搭配。",
          quote: "用青绿 #0FB5AE，因为和 logo 搭",
          eventDate: "2026-11-16",
          dueDate: null,
        },
        {
          scope: " project:p-fantay ",
          kind: "commitment",
          content: "主人要在 2026-11-20 之前把配色方案发给设计组。",
          quote: "下周五之前我要把配色方案发给设计组",
          eventDate: null,
          dueDate: "2026-11-20",
        },
        {
          scope: "profile:",
          kind: "procedure",
          content: "The owner runs the tests with pnpm vitest before pushing.",
          // Whitespace differs from the transcript, which breaks the line and repeats spaces.
          quote: "run the tests with pnpm vitest before pushing",
          eventDate: "2026-02-30",
          dueDate: "next friday",
        },
      ]),
    );
    const memories = await distiller.distill(input(), llm);
    expect(memories).toEqual([
      {
        scope: { kind: "profile", id: "" },
        kind: "preference",
        content: "主人希望回复用中文，结论先行。",
        quote: "以后回复都用中文,结论先行",
        eventAt: null,
        dueAt: null,
      },
      {
        scope: { kind: "project", id: "p-fantay" },
        kind: "decision",
        content: "Fantay 首页主色定为青绿 #0FB5AE，因为和 logo 搭配。",
        quote: "用青绿 #0FB5AE，因为和 logo 搭",
        eventAt: noon(2026, 11, 16),
        dueAt: null,
      },
      {
        scope: { kind: "project", id: "p-fantay" },
        kind: "promise",
        content: "主人要在 2026-11-20 之前把配色方案发给设计组。",
        quote: "下周五之前我要把配色方案发给设计组",
        eventAt: null,
        dueAt: noon(2026, 11, 20),
      },
      {
        scope: { kind: "profile", id: "" },
        kind: "procedure",
        content: "The owner runs the tests with pnpm vitest before pushing.",
        quote: "run the tests with pnpm vitest before pushing",
        eventAt: null,
        dueAt: null,
      },
    ]);
  });

  it("drops invented quotes, scopes that were not offered, repeats and known memories", async () => {
    const valid = { kind: "fact", eventDate: null, dueDate: null };
    const { llm } = fakeLlm(
      reply([
        { ...valid, scope: "profile:", content: "主人喜欢橙色。", quote: "我最喜欢橙色" },
        { ...valid, scope: "bot:someone-else", content: "小月记住了偏好。", quote: "好的，记住了" },
        { ...valid, scope: "group:g1", content: "群里定了主色。", quote: "首页主色定了" },
        { ...valid, scope: "profile:", content: "主人养了一只猫，叫团子", quote: "以后回复都用中文" },
        { ...valid, scope: "bot:xiaoyue", content: "小月说天气不错。", quote: "好" },
        { ...valid, scope: "bot:xiaoyue", content: "小月说今天天气不错。", quote: "今天天气不错" },
        { ...valid, scope: "bot:xiaoyue", content: "小月说今天天气不错。", quote: "天气不错呢" },
        { ...valid, scope: "bot:xiaoyue", content: "", quote: "今天天气不错" },
        "not an object",
      ]),
    );
    const memories = await distiller.distill(input({ known: ["主人养了一只猫，叫团子"] }), llm);
    expect(memories.map((m) => m.content)).toEqual(["小月说今天天气不错。"]);
    expect(memories[0]?.scope).toEqual({ kind: "bot", id: "xiaoyue" });
  });

  it("maps unknown kinds to fact and caps the result at 6", async () => {
    const quotes = ["以后回复都用中文", "好的，记住了", "首页主色定了", "用青绿 #0FB5AE", "因为和 logo 搭", "配色方案", "设计组", "天气不错"];
    const { llm } = fakeLlm(
      reply(quotes.map((quote, i) => ({ scope: "profile:", kind: i === 0 ? "whatever" : "fact", content: `第 ${i} 条`, quote }))),
    );
    const memories = await distiller.distill(input(), llm);
    expect(memories).toHaveLength(6);
    expect(memories[0]?.kind).toBe("fact");
    expect(memories.map((m) => m.content)).toEqual(["第 0 条", "第 1 条", "第 2 条", "第 3 条", "第 4 条", "第 5 条"]);
  });

  it("reads JSON wrapped in prose or a code fence, or a bare array", async () => {
    const memory = { scope: "profile:", kind: "preference", content: "主人要结论先行。", quote: "结论先行" };
    for (const text of [
      `Here you go:\n\`\`\`json\n${reply([memory])}\n\`\`\``,
      `我提取到的记忆：${reply([memory])} 以上。`,
      JSON.stringify([memory]),
    ]) {
      const { llm } = fakeLlm(text);
      expect((await distiller.distill(input(), llm)).map((m) => m.content)).toEqual(["主人要结论先行。"]);
    }
  });

  it("returns [] for an unreadable reply or a failed model call", async () => {
    for (const text of [null, "", "nothing worth keeping", '{"memories": "none"}', new Error("model down")]) {
      const { llm } = fakeLlm(text);
      expect(await distiller.distill(input(), llm)).toEqual([]);
    }
  });

  it("sends the newest part of a long transcript and checks quotes against what was sent", async () => {
    const transcript = [
      "用户: 开头说的口令是蓝鲸",
      ...Array.from({ length: 1_200 }, (_, i) => `用户: 第 ${i} 行闲聊内容，没有需要记住的东西。`),
      "用户: 我最近喜欢喝乌龙茶",
    ].join("\n");
    expect(transcript.length).toBeGreaterThan(24_000);
    const { llm, calls } = fakeLlm(
      reply([
        { scope: "profile:", kind: "fact", content: "主人的口令是蓝鲸。", quote: "口令是蓝鲸" },
        { scope: "profile:", kind: "preference", content: "主人最近喜欢喝乌龙茶。", quote: "喜欢喝乌龙茶" },
      ]),
    );
    const memories = await distiller.distill(input({ transcript }), llm);
    expect(calls[0]?.user).not.toContain("口令是蓝鲸");
    expect(calls[0]?.user).toContain("用户: 第 1199 行");
    expect(memories.map((m) => m.content)).toEqual(["主人最近喜欢喝乌龙茶。"]);
  });
});

describe("MemoryDistiller.mergeDraft", () => {
  const a = "首页主色用青绿 #0FB5AE";
  const b = "首页主色改成橙色 #FF7A00";

  it("joins the two texts when there is no model", async () => {
    expect(await distiller.mergeDraft(a, b, null)).toEqual({ content: `${a}\n${b}`, source: "joined" });
  });

  it("asks the model once for one text that keeps both and resolves nothing", async () => {
    const merged = "首页主色有两种说法：青绿 #0FB5AE 和橙色 #FF7A00，两者不一致。";
    const { llm, calls } = fakeLlm(`\n${merged}\n`);
    expect(await distiller.mergeDraft(a, b, llm)).toEqual({ content: merged, source: "model" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toBe(MERGE_SYSTEM);
    expect(calls[0]?.system).toContain("Keep every fact");
    expect(calls[0]?.system).toContain("do not mark anything as resolved");
    expect(calls[0]?.user).toContain(a);
    expect(calls[0]?.user).toContain(b);
  });

  it("strips a code fence from the model's text", async () => {
    const { llm } = fakeLlm("```\n合并后的记忆\n```");
    expect(await distiller.mergeDraft(a, b, llm)).toEqual({ content: "合并后的记忆", source: "model" });
  });

  it("falls back to joining when the model returns nothing or fails", async () => {
    for (const text of [null, "   ", new Error("timeout")]) {
      const { llm } = fakeLlm(text);
      expect(await distiller.mergeDraft(a, b, llm)).toEqual({ content: `${a}\n${b}`, source: "joined" });
    }
  });
});

describe("helpers", () => {
  it("parses YYYY-MM-DD at local noon and rejects dates that do not exist", () => {
    expect(parseLocalDay("2026-11-20")).toBe(noon(2026, 11, 20));
    expect(new Date(parseLocalDay("2026-01-01")!).getHours()).toBe(12);
    for (const value of ["2026-02-30", "2026-13-01", "20261120", "2026-11-20T00:00:00Z", 20261120, null]) {
      expect(parseLocalDay(value)).toBeNull();
    }
    expect(formatLocalDay(noon(2026, 1, 5))).toBe("2026-01-05");
  });

  it("finds the JSON value in a model reply", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseModelJson('Result: {"a":{"b":3}} done')).toEqual({ a: { b: 3 } });
    expect(parseModelJson("[1,2]")).toEqual([1, 2]);
    expect(parseModelJson("no json here")).toBeNull();
    expect(parseModelJson(null)).toBeNull();
  });
});
