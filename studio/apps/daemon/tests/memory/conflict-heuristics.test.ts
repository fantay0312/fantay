// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { comparePair } from "../../src/services/memory/conflict-heuristics.js";

function expectConflict(incoming: string, existing: string) {
  const verdict = comparePair(incoming, existing);
  expect(verdict.relation, `${incoming} | ${existing}`).toBe("conflict");
  expect(verdict.confidence).toBeGreaterThanOrEqual(0.6);
  expect(verdict.confidence).toBeLessThanOrEqual(0.85);
  return verdict;
}

describe("comparePair — duplicates", () => {
  it("marks identical text as a duplicate with confidence 0.9", () => {
    const verdict = comparePair("用户喜欢喝美式咖啡", "用户喜欢喝美式咖啡。");
    expect(verdict).toMatchObject({ relation: "duplicate", confidence: 0.9 });
    expect(verdict.similarity).toBe(1);
    expect(verdict.reason).toMatch(/同一件事/u);
  });

  it("marks text contained in the other as a duplicate", () => {
    expect(comparePair("用户住在台北市大安区", "用户住在台北市").relation).toBe("duplicate");
    expect(comparePair("The owner uses Neovim", "Every day the owner uses Neovim for writing").relation).toBe(
      "duplicate",
    );
  });

  it("does not treat a word inside another word as containment", () => {
    expect(comparePair("use vim daily", "because vim daily users exist").relation).not.toBe("duplicate");
  });

  it("answers in English for English memories", () => {
    const verdict = comparePair("The owner prefers dark mode in every editor", "The owner prefers dark mode in every editor.");
    expect(verdict.relation).toBe("duplicate");
    expect(verdict.reason).toBe("The two memories say almost the same thing.");
  });
});

describe("comparePair — contradictions", () => {
  it("finds opposite polarity in Chinese", () => {
    const verdict = expectConflict("我不喜欢喝咖啡", "我喜欢喝咖啡");
    expect(verdict.reason).toMatch(/否定/u);
  });

  it("does not call a negated text a duplicate even though it contains the other", () => {
    expectConflict("不再住在台北", "住在台北");
  });

  it("finds opposite polarity in English", () => {
    const verdict = expectConflict("The owner never drinks coffee in the morning", "The owner drinks coffee in the morning");
    expect(verdict.reason).toMatch(/opposite/u);
    expectConflict("The build no longer uses webpack", "The build uses webpack");
  });

  it("finds a different number, date or colour in the same slot", () => {
    expect(expectConflict("项目预算是 8000 元", "项目预算是 5000 元").reason).toMatch(/数字/u);
    expectConflict("发布日期定在 2026-12-01", "发布日期定在 2026-11-20");
    expectConflict("发布日期定在2026年12月1日", "发布日期定在2026年11月20日");
    expectConflict("首页主色用青绿 #FF7A00", "首页主色用青绿 #0FB5AE");
    expectConflict("The weekly sync is at 4pm", "The weekly sync is at 3pm");
  });

  it("finds a different day of the week or time of day, however the change is worded", () => {
    expect(expectConflict("周会改到周四上午十点。", "周会在周三下午三点。").reason).toMatch(/时间/u);
    expectConflict("周会在周四", "周会在周三");
    expectConflict("例会时间改为每周五", "例会时间是每周一");
    expectConflict("评审会定在星期二", "评审会安排在礼拜四");
    expectConflict("下午三点开评审会", "上午十点开评审会");
    expectConflict("The standup is on Tuesday", "The standup is on Monday");
    expect(comparePair("周会改到周四上午十点。", "周会在周三下午三点。").confidence).toBe(0.85);
  });

  it("reads counts written in Chinese numerals", () => {
    expectConflict("每天跑两次步", "每天跑一次步");
    expectConflict("团队现在有十二个人", "团队现在有 8 个人");
    expectConflict("发布会预算是十万元", "发布会预算是 8 万元");
    expectConflict("合同期限三年", "合同期限两年");
  });

  it("finds opposite stances", () => {
    expect(expectConflict("用户讨厌深色主题", "用户喜欢深色主题").reason).toMatch(/态度/u);
    expectConflict("I avoid tabs for indentation", "I prefer tabs for indentation");
  });

  it("rates a closer subject higher", () => {
    const close = comparePair("用户不住在台北", "用户住在台北");
    const loose = comparePair("用户不住在台北了，已经搬到高雄好几年", "用户住在台北");
    expect(close.relation).toBe("conflict");
    expect(close.confidence).toBe(0.85);
    if (loose.relation === "conflict") expect(loose.confidence).toBeLessThan(close.confidence);
  });
});

describe("comparePair — unrelated", () => {
  it("leaves different subjects alone", () => {
    expect(comparePair("用户喜欢喝咖啡", "项目使用 TypeScript 编写").relation).toBe("unrelated");
    expect(comparePair("The meeting is not on Friday", "The flight leaves on Friday").relation).toBe("unrelated");
    expect(comparePair("我不喝咖啡", "我喝茶").relation).toBe("unrelated");
  });

  it("ignores words that only look negative", () => {
    expect(comparePair("这个配色方案不错", "这个配色方案很好").relation).not.toBe("conflict");
    expect(comparePair("用户特别喜欢青绿色", "用户喜欢青绿色").relation).not.toBe("conflict");
  });

  it("does not see a contradiction in compatible numbers", () => {
    expect(comparePair("我有2只猫和3只狗", "我有2只猫").relation).not.toBe("conflict");
    expect(comparePair("跑了 5 公里", "跑了 30 分钟").relation).not.toBe("conflict");
  });

  it("does not mistake everyday wording for a changed time or count", () => {
    // Different meetings on different days.
    expect(comparePair("周三交设计稿", "周四交开发稿").relation).toBe("unrelated");
    expect(comparePair("周三开周会", "周四开评审会").relation).toBe("unrelated");
    // 一点 as "a little", 两点 as "two points", and ordinals are not clock times or counts.
    expect(comparePair("便宜一点更好", "贵一点也行").relation).toBe("unrelated");
    expect(comparePair("有三点意见要反馈", "有两点意见要反馈").relation).not.toBe("conflict");
    expect(comparePair("第一次评审通过了", "第二次评审通过了").relation).not.toBe("conflict");
    // The same day said two ways agrees.
    expect(comparePair("周会在星期三", "周会在周三").relation).not.toBe("conflict");
    expect(comparePair("周一到周五上班", "周一上班").relation).not.toBe("conflict");
    // A named value needs the model judge.
    expect(comparePair("我住在台北", "我住在上海").relation).toBe("unrelated");
  });

  it("treats differently labelled things as different things", () => {
    const apart: Array<[string, string]> = [
      ["会议室 B 在 5 楼", "会议室 A 在 3 楼"],
      ["方案 B 的预算是 8 万元", "方案 A 的预算是 5 万元"],
      ["项目 B 的截止日期是 2026-12-15", "项目 A 的截止日期是 2026-12-01"],
      ["2 号楼的会议室在 5 层", "1 号楼的会议室在 3 层"],
      ["第二期工程预算 30 万", "第一期工程预算 20 万"],
      ["Plan B costs 8000 dollars", "Plan A costs 5000 dollars"],
      ["这周的周报还没有发给王经理", "上周的周报已经发给王经理了"],
    ];
    for (const [a, b] of apart) expect(comparePair(a, b).relation, `${a} | ${b}`).toBe("unrelated");
    // The same label on both sides is still one thing, and its values can disagree.
    expectConflict("方案 A 的预算是 8 万元", "方案 A 的预算是 5 万元");
    expectConflict("会议室 A 在 5 楼", "会议室 A 在 3 楼");
  });

  it("does not read numbers inside identifiers as quantities", () => {
    expect(comparePair("默认模型是 gpt4", "默认模型是 gpt5").relation).not.toBe("conflict");
  });

  it("reports similarity in 0..1 and is deterministic", () => {
    const first = comparePair("周会改到周四下午", "周会在周三下午");
    const second = comparePair("周会改到周四下午", "周会在周三下午");
    expect(first).toEqual(second);
    expect(first.similarity).toBeGreaterThanOrEqual(0);
    expect(first.similarity).toBeLessThanOrEqual(1);
  });
});
