// @vitest-environment node
/**
 * 「思考中」从 daemon 说推理开始的那一刻就亮(Fantay 2026-11-08)。
 *
 * daemon 的 `thinking_start` 被 `providers/daemon.ts` 译成
 * `{ kind: 'status', label: 'thinking' }`。它比第一帧 `thinking_delta` 早到,而只计费不给字
 * 的那档推理根本没有 delta —— 原来这一帧被当成普通状态丢掉,「思考中」那一格要等第一帧
 * delta 才亮,快的推理模型整段都没亮过(owner:「思考过程经常没有」)。
 *
 * 这里钉的是纯函数层那半截:那一帧把**当前这张壳**标成在想;开口 / 动手照旧清掉;
 * 别的 status 一律不碰这只旗。
 */
import { describe, expect, it } from 'vitest';
import type { PersistedAgentEvent } from '@open-design/contracts';
import { buildTurnBlocks } from '../../../src/runtime/chat/build-turn-blocks';
import type { ExecutionShell } from '../../../src/runtime/chat/contract';

const shellOf = (events: PersistedAgentEvent[]): ExecutionShell => {
  const shell = buildTurnBlocks({ events, runStatus: 'running', nowMs: 1_000 })
    .find((b): b is ExecutionShell => b.kind === 'shell');
  if (!shell) throw new Error('没出壳');
  return shell;
};

const THINKING_START: PersistedAgentEvent = { kind: 'status', label: 'thinking' };

describe('status: thinking 让壳当场进入「在想」', () => {
  it('只到了 thinking_start、一帧 delta 都没有 → 壳已经在想', () => {
    expect(shellOf([THINKING_START]).thinking).toBe(true);
  });

  it('反向对照:别的 status 不碰这只旗', () => {
    expect(shellOf([{ kind: 'status', label: 'initializing' }]).thinking).toBe(false);
    expect(shellOf([{ kind: 'status', label: 'running' }]).thinking).toBe(false);
  });

  it('开口说话就不再是「在想」', () => {
    expect(shellOf([THINKING_START, { kind: 'text', text: '好的,' }]).thinking).toBe(false);
  });

  it('动手了也不再是「在想」', () => {
    expect(shellOf([
      THINKING_START,
      { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
    ]).thinking).toBe(false);
  });

  it('说完话又开始想(下一块推理)→ 重新在想', () => {
    expect(shellOf([
      THINKING_START,
      { kind: 'text', text: '先看一下。' },
      THINKING_START,
    ]).thinking).toBe(true);
  });

  it('只置位、不落行 —— 那一格由渲染层补,不是壳里的第 N 件事', () => {
    expect(shellOf([THINKING_START]).items).toHaveLength(0);
  });
});
