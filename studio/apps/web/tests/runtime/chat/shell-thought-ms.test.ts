// @vitest-environment node
/**
 * 壳头小结里的「已思考 2s」从哪来(Fantay 2026-11-08,`shellThoughtMs`)。
 *
 * 纪律和「思考过程」那一格的耗时同一条:**有一段算不出来就整体不给**,只加算得出的
 * 那几段会得到一个偏小的假数;一段推理都没有也不给 —— 不写「已思考 0s」。
 */
import { describe, expect, it } from 'vitest';
import { shellThoughtMs } from '../../../src/runtime/chat/group-thinking';
import type { ShellItem } from '../../../src/runtime/chat/contract';

const think = (text: string, elapsedMs?: number): ShellItem => ({
  kind: 'text', text, thinking: true, ...(elapsedMs != null ? { elapsedMs } : {}),
});
const say = (text: string): ShellItem => ({ kind: 'text', text });
const todo = (items: ShellItem[]): ShellItem => ({
  kind: 'todo',
  segment: {
    content: '一步', status: 'completed', recalled: false, abandoned: false, implicit: false,
    items, elapsedMs: null,
  },
});

describe('shellThoughtMs', () => {
  it('顶层几段推理相加', () => {
    expect(shellThoughtMs([think('a', 1_200), say('中间一句'), think('b', 800)])).toBe(2_000);
  });

  it('钻进 todo 抽屉一起算 —— 有清单时推理落在抽屉里', () => {
    expect(shellThoughtMs([think('a', 1_000), todo([think('b', 2_500)])])).toBe(3_500);
  });

  it('有一段算不出来 → 整体不给,不报偏小的假数', () => {
    expect(shellThoughtMs([think('a', 1_000), think('b')])).toBeNull();
    expect(shellThoughtMs([think('a', 1_000), todo([think('b')])])).toBeNull();
  });

  it('一段推理都没有 → 不给(不写「已思考 0s」)', () => {
    expect(shellThoughtMs([say('只有叙述')])).toBeNull();
    expect(shellThoughtMs([])).toBeNull();
  });

  it('空串推理不算一段(claude 的 thinking 全是空串)', () => {
    expect(shellThoughtMs([think('   ')])).toBeNull();
    expect(shellThoughtMs([think('   '), think('真的在想', 900)])).toBe(900);
  });
});
