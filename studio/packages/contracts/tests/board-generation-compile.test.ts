import { describe, expect, it } from 'vitest';

import {
  GENERATION_TOKEN_PATTERN,
  REFERENCE_LABELS,
  collectGeneratorInputs,
  compileGeneration,
  referenceLabelSetFor,
  type CompileOptions,
  type GenerationEdgeRole,
  type GenerationGraph,
  type GenerationGraphEdge,
  type GenerationGraphNode,
} from '../src/api/board-generation';

// Spec 05 §3.2.3 compiler cases (§11 "board-generation-compile").

const ZH = REFERENCE_LABELS['zh-CN'];
const EN = REFERENCE_LABELS.en;
const ZH_PREFIX_2 = '参考图片编号：图片1、图片2。请按这些编号理解提示词中的图片引用。';

function generator(id: string, prompt: string): GenerationGraphNode {
  return {
    id,
    kind: 'generator',
    x: 0,
    y: 0,
    w: 320,
    h: 272,
    generator: {
      version: 1,
      surface: 'image',
      prompt,
      model: null,
      params: { aspect: '1:1', count: 1 },
      runs: [],
    },
  };
}

function image(id: string, opts: { title?: string; ready?: boolean; path?: string } = {}): GenerationGraphNode {
  const node: GenerationGraphNode = {
    id,
    kind: 'image',
    x: 0,
    y: 0,
    w: 320,
    h: 320,
    image: { path: opts.path ?? `${id}.png`, daemonReady: opts.ready ?? true },
  };
  if (opts.title !== undefined) node.title = opts.title;
  return node;
}

function note(id: string, text: string): GenerationGraphNode {
  return { id, kind: 'note', x: 0, y: 0, w: 280, h: 220, text };
}

function video(id: string): GenerationGraphNode {
  return { id, kind: 'video', x: 0, y: 0, w: 384, h: 216, media: { file: { path: `${id}.mp4` } } };
}

function group(id: string, memberIds: string[]): GenerationGraphNode {
  return { id, kind: 'group', x: 0, y: 0, w: 800, h: 600, memberIds };
}

let edgeSeq = 0;
function edge(from: string, to: string, order: number, role: GenerationEdgeRole = 'reference'): GenerationGraphEdge {
  edgeSeq += 1;
  return { id: `e${edgeSeq}`, from, to, role, order };
}

function graphOf(nodes: GenerationGraphNode[], edges: GenerationGraphEdge[]): GenerationGraph {
  return { nodes, edges };
}

function opts(partial: Partial<CompileOptions> = {}): CompileOptions {
  return { maxReferences: 5, requiresReference: false, labels: ZH, ...partial };
}

describe('compileGeneration — labels', () => {
  it('labels mentioned inputs in token order, not edge order', () => {
    const graph = graphOf(
      [generator('G', 'Put @[node:B] next to @[node:A]'), image('A'), image('B')],
      [edge('A', 'G', 0), edge('B', 'G', 1)],
    );
    const compiled = compileGeneration(graph, 'G', opts());
    expect(compiled.inputs.map((input) => [input.nodeId, input.label, input.mentioned])).toEqual([
      ['B', '图片1', true],
      ['A', '图片2', true],
    ]);
    expect(compiled.references).toEqual([
      { nodeId: 'B', path: 'B.png', label: '图片1' },
      { nodeId: 'A', path: 'A.png', label: '图片2' },
    ]);
    expect(compiled.prompt).toBe(`${ZH_PREFIX_2}\n\nPut 图片1 next to 图片2`);
    expect(compiled.ok).toBe(true);
    expect(compiled.blockReason).toBeUndefined();
    expect(compiled.warnings).toEqual([]);
  });

  it('labels unmentioned inputs after the mentioned ones, in input order (connected = used)', () => {
    const graph = graphOf(
      [generator('G', 'Make @[node:C] pop'), image('A'), image('B'), image('C')],
      [edge('A', 'G', 0), edge('B', 'G', 1), edge('C', 'G', 2)],
    );
    const compiled = compileGeneration(graph, 'G', opts());
    expect(compiled.inputs.map((input) => [input.nodeId, input.label, input.mentioned])).toEqual([
      ['C', '图片1', true],
      ['A', '图片2', false],
      ['B', '图片3', false],
    ]);
    expect(compiled.references.map((ref) => ref.nodeId)).toEqual(['C', 'A', 'B']);
    expect(compiled.prompt).toBe(
      '参考图片编号：图片1、图片2、图片3。请按这些编号理解提示词中的图片引用。\n\nMake 图片1 pop',
    );
  });

  it('orders reference edges by order, then id', () => {
    const graph = graphOf(
      [generator('G', ''), image('A'), image('B')],
      [
        { id: 'e-b', from: 'B', to: 'G', role: 'reference', order: 3 },
        { id: 'e-a', from: 'A', to: 'G', role: 'reference', order: 3 },
      ],
    );
    expect(compileGeneration(graph, 'G', opts()).references.map((ref) => ref.nodeId)).toEqual(['A', 'B']);
  });

  it('rewrites a text mention and appends every connected note as a text block in label order', () => {
    const graph = graphOf(
      [
        generator('G', 'Use @[node:N] for @[node:A]'),
        note('N', 'red background'),
        image('A'),
        note('N2', '  soft light  '),
      ],
      [edge('N', 'G', 0), edge('A', 'G', 1), edge('N2', 'G', 2)],
    );
    const compiled = compileGeneration(graph, 'G', opts());
    expect(compiled.prompt).toBe('Use 【文本1】 for 图片1\n\n【文本1】\nred background\n\n【文本2】\nsoft light');
    expect(compiled.texts).toEqual([
      { nodeId: 'N', label: '文本1', text: 'red background' },
      { nodeId: 'N2', label: '文本2', text: 'soft light' },
    ]);
    const n2 = compiled.inputs.find((input) => input.nodeId === 'N2');
    expect(n2).toMatchObject({ kind: 'text', label: '文本2', mentioned: false, sent: true });
  });
});

describe('compileGeneration — groups (imported data; groups are not connectable in phase 1)', () => {
  it('expands a group source to its eligible members and rewrites a group token', () => {
    const graph = graphOf(
      [
        generator('G', 'Style of @[node:Gr]'),
        group('Gr', ['A', 'N', 'V']),
        image('A'),
        note('N', 'pastel'),
        video('V'),
      ],
      [edge('Gr', 'G', 0)],
    );
    const compiled = compileGeneration(graph, 'G', opts());
    expect(compiled.prompt).toBe('Style of 图片1、【文本1】\n\n【文本1】\npastel');
    expect(compiled.inputs.map((input) => [input.nodeId, input.label, input.mentioned])).toEqual([
      ['A', '图片1', true],
      ['N', '文本1', true],
    ]);
    // Ineligible members are skipped silently; the group itself has eligible members.
    expect(compiled.warnings).toEqual([]);
    expect(collectGeneratorInputs(graph, 'G').inputs.map((input) => [input.nodeId, input.viaGroupId])).toEqual([
      ['A', 'Gr'],
      ['N', 'Gr'],
    ]);
  });

  it('warns about a group without eligible members and drops its token', () => {
    const graph = graphOf(
      [generator('G', 'Use @[node:Gr] here'), group('Gr', ['V']), video('V')],
      [edge('Gr', 'G', 0)],
    );
    const compiled = compileGeneration(graph, 'G', opts());
    expect(compiled.warnings).toEqual([{ kind: 'ineligible-input', nodeId: 'Gr' }]);
    expect(compiled.prompt).toBe('Use here');
  });

  it('dedupes an input reachable through a group and a direct edge; the first occurrence wins', () => {
    const nodes = [generator('G', ''), group('Gr', ['A', 'B']), image('A'), image('B')];
    const directFirst = collectGeneratorInputs(graphOf(nodes, [edge('A', 'G', 0), edge('Gr', 'G', 1)]), 'G');
    expect(directFirst.inputs.map((input) => [input.nodeId, input.viaGroupId])).toEqual([
      ['A', undefined],
      ['B', 'Gr'],
    ]);
    const groupFirst = collectGeneratorInputs(graphOf(nodes, [edge('Gr', 'G', 0), edge('A', 'G', 1)]), 'G');
    expect(groupFirst.inputs.map((input) => [input.nodeId, input.viaGroupId])).toEqual([
      ['A', 'Gr'],
      ['B', 'Gr'],
    ]);
    const compiled = compileGeneration(graphOf(nodes, [edge('A', 'G', 0), edge('Gr', 'G', 1)]), 'G', opts());
    expect(compiled.references.map((ref) => [ref.nodeId, ref.label])).toEqual([
      ['A', '图片1'],
      ['B', '图片2'],
    ]);
  });
});

describe('compileGeneration — sendable references', () => {
  it('truncates to maxReferences with a warning and quotes the unsent mention', () => {
    const graph = graphOf(
      [
        generator('G', '@[node:A] @[node:B] @[node:C]'),
        image('A', { title: 'Alpha' }),
        image('B', { title: 'Beta' }),
        image('C', { title: 'Gamma' }),
      ],
      [edge('A', 'G', 0), edge('B', 'G', 1), edge('C', 'G', 2)],
    );
    const compiled = compileGeneration(graph, 'G', opts({ maxReferences: 2 }));
    expect(compiled.warnings).toEqual([{ kind: 'refs-truncated', kept: 2, total: 3 }]);
    expect(compiled.references.map((ref) => ref.nodeId)).toEqual(['A', 'B']);
    expect(compiled.inputs.find((input) => input.nodeId === 'C')?.sent).toBe(false);
    expect(compiled.prompt).toBe(`${ZH_PREFIX_2}\n\n图片1 图片2 「Gamma」`);
  });

  it('sends no references when maxReferences is 0 and quotes titles (label when untitled)', () => {
    const graph = graphOf(
      [
        generator('G', 'Draw @[node:A] and @[node:B]'),
        image('A', { title: 'Cat' }),
        image('B', { ready: false }),
      ],
      [edge('A', 'G', 0), edge('B', 'G', 1)],
    );
    const compiled = compileGeneration(graph, 'G', opts({ maxReferences: 0 }));
    expect(compiled.references).toEqual([]);
    // Nothing is sent, so per-image readiness is not reported.
    expect(compiled.warnings).toEqual([{ kind: 'refs-ignored-by-model', count: 2 }]);
    expect(compiled.prompt).toBe('Draw 「Cat」 and 「图片2」');
    expect(compiled.ok).toBe(true);
    expect(compiled.inputs.every((input) => input.sent === false)).toBe(true);
  });

  it('excludes a reference that is not daemon-ready', () => {
    const graph = graphOf(
      [
        generator('G', 'Combine @[node:A] with @[node:B]'),
        image('A'),
        image('B', { title: 'Sketch', ready: false }),
      ],
      [edge('A', 'G', 0), edge('B', 'G', 1)],
    );
    const compiled = compileGeneration(graph, 'G', opts());
    expect(compiled.warnings).toEqual([{ kind: 'reference-not-ready', nodeId: 'B' }]);
    expect(compiled.references).toEqual([{ nodeId: 'A', path: 'A.png', label: '图片1' }]);
    expect(compiled.prompt).toBe('Combine 图片1 with 「Sketch」');
    expect(compiled.inputs.map((input) => [input.nodeId, input.sent])).toEqual([
      ['A', true],
      ['B', false],
    ]);
    // CompiledInput carries the file without the graph-only daemonReady flag.
    expect(compiled.inputs[1]?.image).toEqual({ path: 'B.png' });
  });

  it('adds the label prefix only for two or more sent references', () => {
    const one = graphOf([generator('G', 'Edit @[node:A]'), image('A')], [edge('A', 'G', 0)]);
    expect(compileGeneration(one, 'G', opts()).prompt).toBe('Edit 图片1');
    const two = graphOf(
      [generator('G', 'Edit @[node:A]'), image('A'), image('B')],
      [edge('A', 'G', 0), edge('B', 'G', 1)],
    );
    expect(compileGeneration(two, 'G', opts()).prompt).toBe(`${ZH_PREFIX_2}\n\nEdit 图片1`);
    const twoButOneReady = graphOf(
      [generator('G', 'Edit @[node:A]'), image('A'), image('B', { ready: false })],
      [edge('A', 'G', 0), edge('B', 'G', 1)],
    );
    expect(compileGeneration(twoButOneReady, 'G', opts()).prompt).toBe('Edit 图片1');
  });
});

describe('compileGeneration — blocks', () => {
  it('blocks with needs-reference when the model requires a reference and none is sent', () => {
    const noRefs = graphOf([generator('G', 'animate')], []);
    const compiled = compileGeneration(noRefs, 'G', opts({ requiresReference: true }));
    expect(compiled).toMatchObject({ ok: false, blockReason: 'needs-reference', prompt: 'animate' });

    const notReady = graphOf([generator('G', 'animate'), image('A', { ready: false })], [edge('A', 'G', 0)]);
    expect(compileGeneration(notReady, 'G', opts({ requiresReference: true })).blockReason).toBe('needs-reference');
  });

  it('blocks with empty-prompt when there is neither text nor a reference', () => {
    expect(compileGeneration(graphOf([generator('G', '')], []), 'G', opts())).toMatchObject({
      ok: false,
      blockReason: 'empty-prompt',
      prompt: '',
    });
    expect(compileGeneration(graphOf([generator('G', '   \n ')], []), 'G', opts()).blockReason).toBe('empty-prompt');
    expect(compileGeneration(graphOf([generator('G', '@[node:ghost]')], []), 'G', opts()).blockReason).toBe(
      'empty-prompt',
    );
    expect(compileGeneration(graphOf([], []), 'missing', opts()).blockReason).toBe('empty-prompt');
  });

  it('accepts an empty prompt with a reference (variations / i2v) and a note-only prompt', () => {
    const withRef = compileGeneration(
      graphOf([generator('G', ''), image('A')], [edge('A', 'G', 0)]),
      'G',
      opts({ requiresReference: true }),
    );
    expect(withRef).toMatchObject({ ok: true, prompt: '' });
    expect(withRef.references).toHaveLength(1);

    const noteOnly = compileGeneration(graphOf([generator('G', ''), note('N', 'a fox')], [edge('N', 'G', 0)]), 'G', opts());
    expect(noteOnly).toMatchObject({ ok: true, prompt: '【文本1】\na fox' });
  });
});

describe('compileGeneration — tokens and edges', () => {
  it('removes unresolved tokens (one warning per id) and collapses the spaces they leave', () => {
    const graph = graphOf([generator('G', 'Make @[node:ghost] brighter @[node:ghost]')], []);
    const compiled = compileGeneration(graph, 'G', opts());
    expect(compiled.prompt).toBe('Make brighter');
    expect(compiled.warnings).toEqual([{ kind: 'unresolved-token', nodeId: 'ghost' }]);
  });

  it('collapses spaces only around removals, never across lines', () => {
    const cases: Array<[string, string]> = [
      ['A @[node:ghost] B', 'A B'],
      ['A @[node:ghost]  @[node:other] B', 'A B'],
      ['A@[node:ghost]B', 'AB'],
      ['line one\n@[node:ghost] line two', 'line one\nline two'],
      ['end @[node:ghost]\nnext', 'end\nnext'],
      ['@[node:ghost] start', 'start'],
      ['把@[node:ghost]变红', '把变红'],
      ['x @[node:ghost]  @[node:A] y', 'x 图片1 y'],
      ['keep  two @[node:A]', 'keep  two 图片1'],
    ];
    for (const [prompt, expected] of cases) {
      const graph = graphOf([generator('G', prompt), image('A')], [edge('A', 'G', 0)]);
      expect(compileGeneration(graph, 'G', opts()).prompt, prompt).toBe(expected);
    }
  });

  it('ignores output/derived edges and treats generator/video sources as ineligible', () => {
    const graph = graphOf(
      [
        generator('G', 'Animate @[node:V] now'),
        generator('G2', 'other'),
        image('X'),
        image('Y'),
        video('V'),
        image('R'),
      ],
      [
        edge('X', 'G', 0, 'output'),
        edge('Y', 'G', 1, 'derived'),
        edge('G2', 'G', 2),
        edge('V', 'G', 3),
        edge('G', 'R', 4, 'output'),
      ],
    );
    const compiled = compileGeneration(graph, 'G', opts());
    expect(compiled.inputs).toEqual([]);
    expect(compiled.references).toEqual([]);
    expect(compiled.warnings).toEqual([
      { kind: 'ineligible-input', nodeId: 'G2' },
      { kind: 'ineligible-input', nodeId: 'V' },
      { kind: 'unresolved-token', nodeId: 'V' },
    ]);
    expect(compiled.prompt).toBe('Animate now');
  });

  it('treats empty notes and pictureless image nodes as ineligible', () => {
    const pending: GenerationGraphNode = { id: 'P', kind: 'image', x: 0, y: 0, w: 320, h: 320 };
    const graph = graphOf([generator('G', 'hi'), note('N', '  '), pending], [edge('N', 'G', 0), edge('P', 'G', 1)]);
    expect(compileGeneration(graph, 'G', opts()).warnings).toEqual([
      { kind: 'ineligible-input', nodeId: 'N' },
      { kind: 'ineligible-input', nodeId: 'P' },
    ]);
  });

  it('accepts other nodes (frame/web/design covers) with a picture as image inputs', () => {
    const frame: GenerationGraphNode = {
      id: 'F',
      kind: 'other',
      title: 'Landing',
      x: 0,
      y: 0,
      w: 1440,
      h: 900,
      image: { path: 'covers/landing.webp', daemonReady: true },
    };
    const compiled = compileGeneration(graphOf([generator('G', 'Like @[node:F]'), frame], [edge('F', 'G', 0)]), 'G', opts());
    expect(compiled.references).toEqual([{ nodeId: 'F', path: 'covers/landing.webp', label: '图片1' }]);
    expect(compiled.prompt).toBe('Like 图片1');
  });

  it('is not affected by a stale lastIndex on the shared token pattern', () => {
    const graph = graphOf([generator('G', 'Edit @[node:A] now')], [edge('A', 'G', 0)]);
    graph.nodes.push(image('A'));
    const before = compileGeneration(graph, 'G', opts());
    GENERATION_TOKEN_PATTERN.lastIndex = 7;
    try {
      expect(compileGeneration(graph, 'G', opts())).toEqual(before);
    } finally {
      GENERATION_TOKEN_PATTERN.lastIndex = 0;
    }
  });
});

describe('reference label sets', () => {
  it('uses the en label set for non-Chinese locales', () => {
    const graph = graphOf(
      [
        generator('G', 'Blend @[node:A] with @[node:B] and @[node:Gr]'),
        image('A'),
        image('B'),
        group('Gr', ['A', 'B']),
        note('N', 'warm tones'),
      ],
      [edge('A', 'G', 0), edge('B', 'G', 1), edge('N', 'G', 2), edge('Gr', 'G', 3)],
    );
    const compiled = compileGeneration(graph, 'G', opts({ labels: referenceLabelSetFor('en-US') }));
    expect(compiled.prompt).toBe(
      'Reference image labels: Image 1, Image 2. Use these labels to interpret image references in the prompt.\n\n' +
        'Blend Image 1 with Image 2 and Image 1, Image 2\n\n[Text 1]\nwarm tones',
    );
    const ignored = compileGeneration(
      graphOf([generator('G', 'Draw @[node:A]'), image('A', { title: 'Cat' })], [edge('A', 'G', 0)]),
      'G',
      opts({ labels: EN, maxReferences: 0 }),
    );
    expect(ignored.prompt).toBe('Draw "Cat"');
  });

  it('maps zh* locales to zh-CN labels and everything else to en', () => {
    expect(referenceLabelSetFor('zh-CN')).toBe(ZH);
    expect(referenceLabelSetFor('zh-TW')).toBe(ZH);
    expect(referenceLabelSetFor('ZH')).toBe(ZH);
    expect(referenceLabelSetFor('en')).toBe(EN);
    expect(referenceLabelSetFor('fr')).toBe(EN);
    expect(referenceLabelSetFor('')).toBe(EN);
  });

  it('pins the label strings sent to models', () => {
    expect([ZH.image(3), ZH.text(2), ZH.textMention('文本2'), ZH.quote('猫'), ZH.separator]).toEqual([
      '图片3',
      '文本2',
      '【文本2】',
      '「猫」',
      '、',
    ]);
    expect(ZH.textBlock('文本1', '内容')).toBe('【文本1】\n内容');
    expect(ZH.prefix(['图片1', '图片2'])).toBe(ZH_PREFIX_2);
    expect([EN.image(3), EN.text(2), EN.textMention('Text 2'), EN.quote('cat'), EN.separator]).toEqual([
      'Image 3',
      'Text 2',
      '[Text 2]',
      '"cat"',
      ', ',
    ]);
    expect(EN.textBlock('Text 1', 'body')).toBe('[Text 1]\nbody');
  });
});
