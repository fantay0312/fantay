// SPDX-License-Identifier: AGPL-3.0-only
// What the reader is told when a Mermaid file does not draw. The errors come from pele itself, so
// these tests follow the library: if a new pele release words its errors differently, the plain
// sentences here must still come out.
import { detectType, render } from 'pele';
import { describe, expect, it } from 'vitest';

import { diagramKindKey, NAMED_DIAGRAM_KINDS } from '../../../src/fantay/artifact/viewers/diagram/kinds';
import {
  describeDiagramError,
  lineExcerpt,
  precheckDiagram,
  sourceLine,
  type DiagramProblem,
} from '../../../src/fantay/artifact/viewers/diagram/problems';

function problemOf(source: string): DiagramProblem {
  const early = precheckDiagram(source);
  if (early) return early;
  try {
    render(source, { images: false });
  } catch (error) {
    return describeDiagramError(error, source);
  }
  throw new Error('expected the source not to draw');
}

function hintOf(source: string): { key: string; params?: Record<string, string>; line: number | null } {
  const problem = problemOf(source);
  if (problem.kind !== 'syntax' && problem.kind !== 'semantic') throw new Error(`not a parse problem: ${problem.kind}`);
  return { key: problem.hint.key, params: problem.hint.params, line: problem.line };
}

describe('precheckDiagram', () => {
  it('tells an empty file from one that holds only comments or settings', () => {
    expect(precheckDiagram('')).toEqual({ kind: 'empty' });
    expect(precheckDiagram('﻿ \n\t\n')).toEqual({ kind: 'empty' });
    expect(precheckDiagram('%% 只写了注释\n%% 还没有图')).toEqual({ kind: 'no-content' });
    expect(precheckDiagram('---\ntitle: 订阅\n---\n%%{init: {"theme": "dark"}}%%\n')).toEqual({ kind: 'no-content' });
    expect(precheckDiagram('flowchart LR\n  A --> B')).toBeNull();
  });
});

describe('describeDiagramError', () => {
  it('names the line of a syntax error and says what was expected, in words', () => {
    const source = 'flowchart TD\n  A[顾客下单] --> B{库存够吗?}\n  B -->|够| C[安排烘焙]\n  B -->|不够| D[联系生豆商]\n  D --> E[支付定金(30%)]\n  E --> C';
    const problem = problemOf(source);
    expect(problem).toMatchObject({ kind: 'syntax', type: 'flowchart', line: 5, lineText: '  D --> E[支付定金(30%)]' });
    expect(hintOf(source).key).toBe('artifact.diagram.hint.quoteLabel');
  });

  it('recognises the common ways AI-written Mermaid breaks', () => {
    expect(hintOf('flowchart TD\n  // 下单流程\n  A --> B').key).toBe('artifact.diagram.hint.comment');
    expect(hintOf('flowchart TD\n  A → B')).toMatchObject({ key: 'artifact.diagram.hint.arrow', params: { char: '→' }, line: 2 });
    expect(hintOf('sequenceDiagram\n  顾客->>小程序：续订')).toMatchObject({
      key: 'artifact.diagram.hint.fullWidth',
      params: { char: '：', ascii: ':' },
      line: 2,
    });
    expect(hintOf('sequenceDiagram\n  Alice->>Bob: hi\n  Bob-->Alice hello\n').key).toBe('artifact.diagram.hint.message');
    expect(hintOf('erDiagram\n  CUSTOMER ||--o{ ORDER places\n').key).toBe('artifact.diagram.hint.colon');
    expect(hintOf('classDiagram\n  class A {\n  +foo()\n')).toMatchObject({ key: 'artifact.diagram.hint.unclosed', params: { char: '}' } });
    expect(hintOf('flowchart LR\n  A --> B\n  B -->> C').key).toBe('artifact.diagram.hint.expectName');
    expect(hintOf('gitGraph\n  commit\n  branch 冬季拼配\n')).toMatchObject({ key: 'artifact.diagram.hint.quoteText', line: 3 });
    expect(hintOf('xychart-beta\n  x-axis [1月, 2月]\n  bar [1, 2]\n')).toMatchObject({ key: 'artifact.diagram.hint.quoteText', line: 2 });
  });

  it('never passes the parser message through', () => {
    const problem = problemOf('pie title 构成\n  "每周" : 多\n');
    expect(problem.kind).toBe('syntax');
    expect(JSON.stringify(problem)).not.toMatch(/Expecting|Lexical error|Parse error/);
  });

  it('counts lines from the top of the file, front matter included', () => {
    expect(hintOf('---\ntitle: 漏斗\n---\nflowchart LR\n  A --> B\n  B -->> C').line).toBe(6);
  });

  it('says when the first line names no kind of diagram', () => {
    expect(problemOf('%% 订阅\nfoodiagram\n  A --> B')).toEqual({ kind: 'unknown-type', first: 'foodiagram' });
    const long = `${'x'.repeat(60)}\nA --> B`;
    expect(problemOf(long)).toEqual({ kind: 'unknown-type', first: `${'x'.repeat(39)}…` });
  });

  it('reports pele limits as too large, with the limit', () => {
    const source = `flowchart TD\n${'  a --> b\n'.repeat(6000)}`;
    expect(problemOf(source)).toEqual({ kind: 'too-large', reason: 'source', limit: 50_000 });
  });

  it('puts a diagram that parses but cannot be drawn in words', () => {
    expect(hintOf('sankey-beta\nA,B,10\nB,A,5\n').key).toBe('artifact.diagram.hint.sankeyCycle');
    expect(hintOf('pie\n  "a" : -3\n').key).toBe('artifact.diagram.hint.negativeValue');
  });

  it('treats anything that is not a pele error as a fault of the renderer', () => {
    expect(describeDiagramError(new TypeError('x is undefined'), 'flowchart LR')).toEqual({ kind: 'failed' });
    expect(describeDiagramError('boom', 'flowchart LR')).toEqual({ kind: 'failed' });
  });
});

describe('sourceLine and lineExcerpt', () => {
  it('reads a line by number whatever the line breaks', () => {
    expect(sourceLine('a\r\nb\rc\nd', 3)).toBe('c');
    expect(sourceLine('a', 2)).toBeNull();
    expect(sourceLine('a', null)).toBeNull();
  });

  it('puts the caret under the column, past dropped indentation', () => {
    expect(lineExcerpt('  B -->> C', 8)).toEqual({ text: '  B -->> C', caret: 7 });
    expect(lineExcerpt('        deep', 9)).toEqual({ text: '  deep', caret: 2 });
    expect(lineExcerpt('\tA → B', 4)).toEqual({ text: '  A → B', caret: 4 });
  });

  it('cuts a long line around the column and marks the cuts', () => {
    const line = `${'a'.repeat(100)}X${'b'.repeat(100)}`;
    const excerpt = lineExcerpt(line, 101, 40);
    expect(excerpt.text.startsWith('…')).toBe(true);
    expect(excerpt.text.endsWith('…')).toBe(true);
    expect(excerpt.text[excerpt.caret ?? -1]).toBe('X');
  });
});

describe('diagramKindKey', () => {
  it('names every kind pele detects in the samples, and falls back quietly', () => {
    const firstLines = [
      'flowchart LR', 'graph TD', 'sequenceDiagram', 'classDiagram', 'stateDiagram-v2', 'erDiagram', 'pie', 'gantt',
      'gitGraph', 'mindmap', 'timeline', 'journey', 'xychart-beta', 'quadrantChart', 'requirementDiagram', 'C4Context',
      'sankey-beta', 'block-beta', 'packet-beta', 'kanban', 'architecture-beta', 'radar-beta', 'treemap-beta', 'info',
    ];
    for (const line of firstLines) {
      const type = detectType(`${line}\n`);
      expect(type, line).not.toBeNull();
      expect(diagramKindKey(type), line).not.toBe('artifact.diagram.kind.other');
    }
    expect(NAMED_DIAGRAM_KINDS.length).toBeGreaterThanOrEqual(33);
    expect(diagramKindKey(null)).toBe('artifact.diagram.kind.other');
    expect(diagramKindKey('somethingNew')).toBe('artifact.diagram.kind.other');
    expect(diagramKindKey('toString')).toBe('artifact.diagram.kind.other');
  });
});
