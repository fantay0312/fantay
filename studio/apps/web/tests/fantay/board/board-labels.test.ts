import { describe, expect, it } from 'vitest';
import {
  applyBoardOps,
  emptyBoardContent,
  type BoardGroupNode,
  type BoardNode,
  type BoardOp,
} from '@open-design/contracts';

import { en } from '../../../src/i18n/locales/en';
import { zhCN } from '../../../src/i18n/locales/zh-CN';
import type { Dict } from '../../../src/i18n/types';
import {
  boardGroupDisplayTitle,
  boardNodeDisplayLabel,
  boardPendingLabel,
  type BoardTranslate,
} from '../../../src/fantay/board/sync/labels';

function translator(dict: Dict): BoardTranslate {
  return (key, vars) => {
    const raw = dict[key] ?? key;
    return vars ? raw.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`)) : raw;
  };
}

const t = translator(en);
const tZh = translator(zhCN);

function nodesFrom(ops: BoardOp[]): Map<string, BoardNode> {
  const outcome = applyBoardOps(emptyBoardContent(), ops, {
    baseRevision: 0,
    nextRevision: 1,
    actor: { kind: 'user' },
    now: 1,
    newId: (prefix) => `${prefix}_x${Math.random().toString(16).slice(2, 10)}`,
    checkConflicts: false,
  });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  return new Map(outcome.content.nodes.map((node) => [node.id, node]));
}

describe('board labels', () => {
  const nodes = nodesFrom([
    { op: 'add', node: { id: 'n_title', kind: 'frame', ref: { path: 'pages/index.html' }, title: '  Landing  ' } },
    { op: 'add', node: { id: 'n_variant', kind: 'frame', ref: { path: 'pages/hero.variant-bold.html' }, variantLabel: 'bold' } },
    { op: 'add', node: { id: 'n_file', kind: 'image', ref: { path: 'assets/hero.png' } } },
    { op: 'add', node: { id: 'n_web', kind: 'web', url: 'https://example.com/pricing?x=1' } },
    { op: 'add', node: { id: 'n_note', kind: 'note', text: '\n  Make the CTA louder\nsecond line' } },
    { op: 'add', node: { id: 'n_empty', kind: 'note', text: '' } },
    { op: 'add', node: { id: 'n_gen', kind: 'generator', version: 1, surface: 'image', prompt: '@[node:n_file] as a poster', model: null, params: { aspect: '1:1', count: 1 }, runs: [] } },
    { op: 'add', node: { id: 'n_motion', kind: 'motion', source: { type: 'composition', ref: { path: 'motion-source/intro/index.html' } } } },
  ]);
  const node = (id: string) => nodes.get(id)!;

  it('prefers the title, then the variant label, then the file name, url host and text', () => {
    expect(boardNodeDisplayLabel(node('n_title'), t)).toBe('Landing');
    expect(boardNodeDisplayLabel(node('n_variant'), t)).toBe('hero · Bold');
    expect(boardNodeDisplayLabel(node('n_file'), t)).toBe('hero.png');
    expect(boardNodeDisplayLabel(node('n_web'), t)).toBe('example.com');
    expect(boardNodeDisplayLabel(node('n_note'), t)).toBe('Make the CTA louder');
    expect(boardNodeDisplayLabel(node('n_gen'), t)).toBe('as a poster');
    expect(boardNodeDisplayLabel(node('n_motion'), t)).toBe('index.html');
  });

  it('falls back to the localized untitled label', () => {
    expect(boardNodeDisplayLabel(node('n_empty'), t)).toBe(en['board.context.untitledNode']);
    expect(boardNodeDisplayLabel(node('n_empty'), tZh)).toBe('未命名节点');
  });

  it('titles groups by role', () => {
    const groups = nodesFrom([
      { op: 'add', node: { id: 'g_section', kind: 'group', role: 'section', sectionKind: 'image' } },
      { op: 'add', node: { id: 'g_turn', kind: 'group', role: 'turn' } },
      { op: 'add', node: { id: 'g_named', kind: 'group', role: 'turn', title: 'Pricing page' } },
      { op: 'add', node: { id: 'g_variants', kind: 'group', role: 'variants', variantKey: 'pages/hero#frame' } },
      { op: 'add', node: { id: 'g_batch', kind: 'group', role: 'variants', variantKey: 'batch:b1' } },
    ]);
    const group = (id: string) => groups.get(id) as BoardGroupNode;
    const images = [node('n_file'), node('n_file')];
    expect(boardGroupDisplayTitle(group('g_section'), [], tZh)).toBe('图片');
    expect(boardGroupDisplayTitle(group('g_turn'), [], tZh)).toBe('对话输出');
    expect(boardGroupDisplayTitle(group('g_named'), [], t)).toBe('Pricing page');
    expect(boardGroupDisplayTitle(group('g_variants'), [node('n_variant'), node('n_variant')], tZh)).toBe('hero · 2 个变体');
    expect(boardGroupDisplayTitle(group('g_batch'), images, tZh)).toBe('2 张图片');
    expect(boardGroupDisplayTitle(group('g_batch'), images, t)).toBe('2 images');
  });

  it('labels pending media by status', () => {
    expect(boardPendingLabel({ status: 'queued' }, tZh)).toBe('排队中');
    expect(boardPendingLabel({ status: 'running' }, tZh)).toBe('生成中…');
    expect(boardPendingLabel({ status: 'failed' }, t)).toBe(en['board.node.pending.failed']);
    expect(boardPendingLabel({ status: 'interrupted' }, t)).toBe(en['board.node.pending.interrupted']);
  });
});
