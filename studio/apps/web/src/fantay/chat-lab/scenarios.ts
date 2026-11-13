/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay-original: scripted assistant turns for the /fantay-ui/chat-lab motion bench.
 * Each scenario is a list of timed steps that append real `PersistedAgentEvent`s, so the
 * page exercises the production pipeline (buildTurnBlocks → ExecutionShell → ProseBlock).
 * Sample copy is fixture text.
 */
import type { PersistedAgentEvent } from '@open-design/contracts';

export type LabStep =
  | { at: number; event: PersistedAgentEvent }
  | { at: number; end: 'succeeded' | 'failed' | 'canceled' };

export interface LabScenario {
  id: string;
  label: string;
  agentId: string;
  agentName: string;
  prompt: string;
  steps: LabStep[];
}

const THINKING = [
  '用户想让我把落地页的首屏打磨一下。先看看现有的结构：标题、副标题、主按钮和一张产品截图。',
  '问题主要在节奏：标题字号和副标题之间的落差不够，主按钮的对比度也偏弱。',
  '我打算先读一下 index.html 和 tokens，确认品牌色和字号阶梯，再决定改动范围。',
].join('\n\n');

const THINKING_2 = '读完了。品牌色是紫色 #7C5CFF，字号阶梯 12/14/16/20/28/40。首屏标题现在用的是 28，应该升到 40，副标题保持 16 但行高放宽到 1.6。';

const ANSWER = [
  '## 首屏已经打磨好了',
  '',
  '这次主要动了三处：',
  '',
  '1. **标题升到 40px**，和副标题拉开两级落差，第一眼先读到价值主张。',
  '2. **主按钮改成品牌紫实心**，悬停时轻微上浮 1px，次按钮退成描边。',
  '3. **产品截图加了细边和柔和阴影**，和页面底色分开层次。',
  '',
  '```css',
  '.hero-title { font-size: 40px; letter-spacing: -0.02em; }',
  '.hero-cta { background: var(--brand); transition: transform 160ms var(--ease-out); }',
  '```',
  '',
  '右侧预览已经刷新，你可以直接看效果。需要的话我再把移动端的断点也调一下。',
].join('\n');

const SHORT_ANSWER = 'TokenToSea 模型调用正常。';

/** Real runs carry a per-run done key; the model writes the marker right before its conclusion. */
const DONE_KEY = 'a7f3c91ed2b40561';
const DONE_MARK = `<od-done key="${DONE_KEY}"/>`;
const doneKey = (at: number): LabStep => ({ at, event: { kind: 'done_key', key: DONE_KEY } as PersistedAgentEvent });

/** Split text into token-ish chunks (1–6 chars, CJK-aware) so deltas look like a real stream. */
function chunk(text: string, seed: number): string[] {
  const out: string[] = [];
  let i = 0;
  let n = seed;
  while (i < text.length) {
    n = (n * 9301 + 49297) % 233280;
    const size = 1 + (n % 5);
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

function stream(
  kind: 'thinking' | 'text',
  text: string,
  start: number,
  perChunkMs: number,
  seed: number,
): { steps: LabStep[]; end: number } {
  const steps: LabStep[] = [];
  let at = start;
  for (const piece of chunk(text, seed)) {
    steps.push({ at, event: { kind, text: piece } as PersistedAgentEvent });
    at += perChunkMs;
  }
  return { steps, end: at };
}

/**
 * The read / edit calls in a lab turn, in each runtime's native shape. `claude` is the
 * PascalCase `file_path` + `old_string` form; `pi` is what the built-in TokenToSea / BYOK
 * agent emits: lowercase names, `path`, and every replacement of one edit in `edits[]`.
 */
const LAB_TOOL_SHAPES = {
  claude: {
    read: { name: 'Read', input: { file_path: 'index.html' } },
    edit: { name: 'Edit', input: { file_path: 'index.html', old_string: 'a', new_string: 'b' } },
  },
  pi: {
    read: { name: 'read', input: { path: 'index.html' } },
    edit: {
      name: 'edit',
      input: {
        path: 'index.html',
        edits: [
          { oldText: 'font-size: 28px;', newText: 'font-size: 40px;' },
          { oldText: '.hero-cta {\n  background: #ddd;\n}', newText: '.hero-cta {\n  background: var(--brand);\n  transition: transform 160ms;\n}' },
        ],
      },
    },
  },
} as const;

function fullTurn(shape: keyof typeof LAB_TOOL_SHAPES = 'claude'): LabStep[] {
  const tools = LAB_TOOL_SHAPES[shape];
  const steps: LabStep[] = [doneKey(100), { at: 300, event: { kind: 'status', label: 'thinking' } as PersistedAgentEvent }];
  const t1 = stream('thinking', THINKING, 900, 28, 7);
  steps.push(...t1.steps);
  const readAt = t1.end + 200;
  steps.push({
    at: readAt,
    event: { kind: 'tool_use', id: 'lab-read', name: tools.read.name, input: tools.read.input, startedAt: 0 } as PersistedAgentEvent,
  });
  steps.push({
    at: readAt + 900,
    event: { kind: 'tool_result', toolUseId: 'lab-read', content: '<!doctype html>…', isError: false } as PersistedAgentEvent,
  });
  const t2 = stream('thinking', THINKING_2, readAt + 1100, 30, 11);
  steps.push(...t2.steps);
  const writeAt = t2.end + 200;
  steps.push({
    at: writeAt,
    event: { kind: 'tool_use', id: 'lab-edit', name: tools.edit.name, input: tools.edit.input, startedAt: 0 } as PersistedAgentEvent,
  });
  steps.push({
    at: writeAt + 1300,
    event: { kind: 'tool_result', toolUseId: 'lab-edit', content: 'ok', isError: false } as PersistedAgentEvent,
  });
  const ans = stream('text', DONE_MARK + ANSWER, writeAt + 1600, 22, 3);
  steps.push(...ans.steps);
  steps.push({ at: ans.end + 300, end: 'succeeded' });
  return steps;
}

function thinkThenAnswer(): LabStep[] {
  const steps: LabStep[] = [doneKey(100), { at: 250, event: { kind: 'status', label: 'thinking' } as PersistedAgentEvent }];
  const t1 = stream('thinking', THINKING, 700, 26, 5);
  steps.push(...t1.steps);
  const ans = stream('text', DONE_MARK + ANSWER, t1.end + 250, 22, 9);
  steps.push(...ans.steps);
  steps.push({ at: ans.end + 300, end: 'succeeded' });
  return steps;
}

function answerOnly(): LabStep[] {
  const ans = stream('text', SHORT_ANSWER, 1400, 60, 2);
  return [...ans.steps, { at: ans.end + 300, end: 'succeeded' }];
}

/** A fast reasoner (DeepSeek Flash via TokenToSea) whose output arrives without live deltas: one reasoning part, then one text part. */
function batchedFastReasoner(): LabStep[] {
  return [
    doneKey(100),
    { at: 200, event: { kind: 'status', label: 'thinking' } as PersistedAgentEvent },
    { at: 1400, event: { kind: 'thinking', text: 'The user asks: reply with exactly one sentence: "TokenToSea 模型调用正常。" Don\'t create/modify files, don\'t call tools.\n\nComply. No marker.' } as PersistedAgentEvent },
    { at: 1450, event: { kind: 'text', text: SHORT_ANSWER } as PersistedAgentEvent },
    { at: 1700, end: 'succeeded' },
  ];
}

function failedTurn(): LabStep[] {
  const t1 = stream('thinking', THINKING.slice(0, 60), 600, 30, 4);
  return [
    { at: 250, event: { kind: 'status', label: 'thinking' } as PersistedAgentEvent },
    ...t1.steps,
    {
      at: t1.end + 400,
      event: {
        kind: 'status',
        label: 'error',
        detail: 'Upstream provider returned 502 Bad Gateway',
        code: 'UPSTREAM_UNAVAILABLE',
        retryable: true,
      } as PersistedAgentEvent,
    },
    { at: t1.end + 500, end: 'failed' },
  ];
}

function hiddenReasoning(): LabStep[] {
  const steps: LabStep[] = [{ at: 250, event: { kind: 'status', label: 'thinking' } as PersistedAgentEvent }];
  let tokens = 0;
  for (let at = 600; at < 4200; at += 300) {
    tokens += 37 + (at % 23);
    steps.push({ at, event: { kind: 'thinking', text: '' } as PersistedAgentEvent });
    steps.push({ at: at + 1, event: { kind: 'thinking_tokens', tokens, at: 0 } as PersistedAgentEvent });
  }
  const ans = stream('text', ANSWER, 4500, 22, 13);
  steps.push(...ans.steps);
  steps.push({ at: ans.end + 300, end: 'succeeded' });
  return steps;
}

export const LAB_SCENARIOS: LabScenario[] = [
  { id: 'full', label: '思考 + 工具 + 正文', agentId: 'tokentosea', agentName: 'DeepSeek V4', prompt: '请把这个落地页的首屏打磨一下', steps: fullTurn() },
  { id: 'pi-tools', label: '思考 + 工具 + 正文（pi 入参）', agentId: 'tokentosea', agentName: 'TokenToSea · official:deepseek-flash', prompt: '请把这个落地页的首屏打磨一下', steps: fullTurn('pi') },
  { id: 'think', label: '思考 + 正文', agentId: 'tokentosea', agentName: 'DeepSeek Flash', prompt: '首屏的层级怎么调更好？', steps: thinkThenAnswer() },
  { id: 'answer', label: '仅正文', agentId: 'tokentosea', agentName: 'TokenToSea', prompt: '请只回复一句：TokenToSea 模型调用正常。', steps: answerOnly() },
  { id: 'batched', label: '快速推理（整段到达）', agentId: 'tokentosea', agentName: 'TokenToSea · official:deepseek-flash', prompt: '请只回复一句：TokenToSea 模型调用正常。', steps: batchedFastReasoner() },
  { id: 'hidden', label: '隐藏推理（只有 token 数）', agentId: 'claude', agentName: 'Claude', prompt: '帮我梳理首屏的信息层级', steps: hiddenReasoning() },
  { id: 'failed', label: '运行失败', agentId: 'tokentosea', agentName: 'DeepSeek Flash', prompt: '继续优化移动端', steps: failedTurn() },
];
