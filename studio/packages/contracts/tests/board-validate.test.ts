import { describe, expect, it } from 'vitest';

import { BOARD_LIMITS, type BoardActor, type BoardContent, type BoardEdge, type BoardNode } from '../src/api/board.js';
import {
  BOARD_PATCH_KEYS_BY_KIND,
  applyBoardOps,
  checkBoardContentLimits,
  defaultBoardSettings,
  isBoardColor,
  isSafeBoardPath,
  isSafeBoardUrl,
  normalizeBoardContent,
  validateBoardContent,
  validateBoardImportRequest,
  validateBoardPatchRequest,
  validateBoardPutRequest,
  validateBoardSyncRequest,
  validateBoardViewport,
  type BoardApplyContext,
} from '../src/board/index.js';

const SEED: BoardActor = { kind: 'user' };
const stamps = { createdAt: 100, updatedAt: 100, createdBy: SEED, updatedBy: SEED, rev: 1 };

function ctx(overrides: Partial<BoardApplyContext> = {}): BoardApplyContext {
  let counter = 0;
  return {
    baseRevision: 1, nextRevision: 2, actor: { kind: 'user', clientId: 'tab' }, now: 500,
    newId: (prefix) => `${prefix}_id${(counter += 1)}`, checkConflicts: true, ...overrides,
  };
}

function content(nodes: BoardNode[], edges: BoardEdge[] = []): BoardContent {
  return { settings: defaultBoardSettings(), nodes, edges };
}

function edge(id: string, kind: BoardEdge['kind'], from: string, to: string): BoardEdge {
  return { id, kind, from, to, createdAt: 100, createdBy: SEED, updatedBy: SEED, rev: 1 };
}

const generation = {
  candidates: [{ id: 'c1', runId: 'r1', index: 0, attempt: 0, status: 'running', outputStem: 'gen-a-b-1' }],
  request: { surface: 'image', model: 'm', modelBase: 'm', provider: 'p', prompt: 'x', promptSource: 'x', references: [], generatorId: 'gen1', runId: 'r1', createdAt: 1 },
};

const NODES = {
  frame: { id: 'fr1', kind: 'frame', x: 0, y: 0, w: 400, h: 300, ref: { path: 'index.html' }, device: 'desktop', ...stamps },
  web: { id: 'wb1', kind: 'web', x: 0, y: 400, w: 400, h: 300, url: 'https://example.com', ...stamps },
  image: { id: 'im1', kind: 'image', x: 500, y: 0, w: 200, h: 200, ref: { path: 'a.png' }, ...stamps },
  video: { id: 'vd1', kind: 'video', x: 800, y: 0, w: 320, h: 180, ref: { path: 'a.mp4' }, ...stamps },
  audio: { id: 'au1', kind: 'audio', x: 800, y: 300, w: 360, h: 120, ref: { path: 'a.mp3' }, ...stamps },
  note: { id: 'no1', kind: 'note', x: 0, y: 800, w: 280, h: 220, text: 'hi', color: 'yellow', ...stamps },
  shape: { id: 'sh1', kind: 'shape', x: 400, y: 800, w: 100, h: 100, shape: 'rect', ...stamps },
  group: { id: 'gr1', kind: 'group', x: 2000, y: 0, w: 400, h: 400, role: 'section', layout: 'free', ...stamps },
  generator: {
    id: 'gen1', kind: 'generator', x: 1200, y: 0, w: 320, h: 272, version: 1, surface: 'image', prompt: 'cat', model: null,
    params: { aspect: '1:1', count: 2 }, runs: [], ...stamps,
  },
  design: { id: 'de1', kind: 'design', x: 0, y: 1200, w: 960, h: 600, ref: { path: 'designs/a.fig' }, format: 'fig', ...stamps },
  motion: { id: 'mo1', kind: 'motion', x: 1000, y: 1200, w: 960, h: 540, source: { type: 'movie', projectId: 'p1' }, ...stamps },
} satisfies Record<string, BoardNode>;

function allNodes(): BoardNode[] {
  return Object.values(NODES).map((node) => ({ ...node }) as BoardNode);
}

function codes(issues: Array<{ code?: string }>): Array<string | undefined> {
  return issues.map((issue) => issue.code);
}

describe('path, url and colour predicates', () => {
  it('accepts project-relative POSIX paths only', () => {
    for (const ok of ['index.html', 'pages/a.html', 'designs/x.fig', 'a b/c.png', 'x'.repeat(512)]) expect(isSafeBoardPath(ok)).toBe(true);
    for (const bad of ['', '../x', 'a/../b', '/abs/x.html', 'a\\b.html', 'a\0b', 'a//b', './a', 'a/.', 'x'.repeat(513), 42, null]) {
      expect(isSafeBoardPath(bad)).toBe(false);
    }
  });

  it('accepts http(s) URLs up to 2048 chars', () => {
    for (const ok of ['https://example.com', 'http://localhost:3000/x?y=1#z', `https://x.dev/${'a'.repeat(2000)}`]) {
      expect(isSafeBoardUrl(ok)).toBe(true);
    }
    for (const bad of [
      'ftp://x.dev', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'https://', 'not a url',
      'https://exa mple.com', `https://x.dev/${'a'.repeat(2048)}`, '',
    ]) {
      expect(isSafeBoardUrl(bad)).toBe(false);
    }
  });

  it('accepts palette tokens and #RRGGBB[AA]', () => {
    for (const ok of ['ink', 'gray', 'violet', '#aabbcc', '#AABBCC80']) expect(isBoardColor(ok)).toBe(true);
    for (const bad of ['purple', 'paper', '#abc', '#aabbccd', 'rgb(0,0,0)', 7]) expect(isBoardColor(bad)).toBe(false);
  });
});

describe('per-kind patch keys', () => {
  it('exposes the allowed keys and keeps server-managed keys out', () => {
    expect(BOARD_PATCH_KEYS_BY_KIND.note).toEqual(expect.arrayContaining(['text', 'color', 'size', 'title', 'x', 'provenance']));
    expect(BOARD_PATCH_KEYS_BY_KIND.note).not.toContain('url');
    expect(BOARD_PATCH_KEYS_BY_KIND.generator).toEqual(expect.arrayContaining(['surface', 'prompt', 'model', 'params', 'templateId', 'runs']));
    expect(BOARD_PATCH_KEYS_BY_KIND.generator).not.toContain('version');
    expect(BOARD_PATCH_KEYS_BY_KIND.image).toEqual(expect.arrayContaining(['ref', 'pending', 'generation', 'refProxy']));
    expect(BOARD_PATCH_KEYS_BY_KIND.video).toEqual(expect.arrayContaining(['generation', 'refProxy', 'cover']));
    expect(BOARD_PATCH_KEYS_BY_KIND.audio).not.toContain('generation');
    expect(BOARD_PATCH_KEYS_BY_KIND.design).not.toContain('migratedFrom');
    for (const keys of Object.values(BOARD_PATCH_KEYS_BY_KIND)) {
      for (const serverKey of ['id', 'kind', 'rev', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'missing', 'origin']) {
        expect(keys).not.toContain(serverKey);
      }
    }
  });
});

describe('validateBoardPatchRequest', () => {
  it('accepts a well-formed request', () => {
    const result = validateBoardPatchRequest({
      baseRevision: 3,
      ops: [
        { op: 'add', node: { kind: 'note', text: 'x', rev: 9, createdAt: 1 }, placement: { mode: 'near', nodeId: 'fr1', side: 'below' } },
        { op: 'update', id: 'fr1', patch: { title: 'x' }, expectRev: 2 },
        { op: 'layout', target: { all: true }, mode: 'tidy' },
        { op: 'restore', nodes: [NODES.note], edges: [], removeNodeIds: [], removeEdgeIds: [] },
      ],
      actor: { kind: 'agent', runId: 'run-1' },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects malformed requests with issue paths', () => {
    const missing = validateBoardPatchRequest({ ops: [] });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues.map((issue) => [issue.path, issue.code])).toEqual([['baseRevision', 'required'], ['ops', 'out-of-range']]);

    const tooMany = validateBoardPatchRequest({ baseRevision: 0, ops: Array.from({ length: BOARD_LIMITS.maxOpsPerPatch + 1 }, () => ({ op: 'set-meta' })) });
    expect(tooMany).toMatchObject({ ok: false, issues: [{ path: 'ops', code: 'out-of-range' }] });

    const bad = validateBoardPatchRequest({
      baseRevision: 0,
      ops: [
        { op: 'explode' },
        { op: 'update', id: 'fr1', patch: { foo: 1 } },
        { op: 'add', node: { kind: 'note', text: 'x', url: 'https://x.dev' } },
        { op: 'add', node: { kind: 'widget' } },
        { op: 'move', moves: [{ id: 'fr1', x: Number.NaN, y: 0 }] },
        { op: 'reorder', id: 'fr1', to: 'top' },
        { op: 'add', node: { kind: 'web', url: 'javascript:alert(1)' } },
      ],
      actor: { kind: 'robot' },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.map((issue) => [issue.path, issue.code])).toEqual([
        ['ops[0].op', 'invalid-value'],
        ['ops[1].patch.foo', 'field-not-allowed'],
        ['ops[2].node.url', 'field-not-allowed'],
        ['ops[3].node.kind', 'invalid-value'],
        ['ops[4].moves[0].x', 'invalid-type'],
        ['ops[5].to', 'invalid-type'],
        ['ops[6].node.url', 'unsafe-url'],
        ['actor.kind', 'invalid-value'],
      ]);
    }
  });
});

describe('amended node validation (plan R3)', () => {
  it('accepts every kind in its stored form', () => {
    expect(validateBoardContent(content(allNodes()))).toEqual([]);
  });

  it('allows ref null only while pending or generating (image/video), pending (audio), liveArtifactId (frame)', () => {
    const issuesFor = (node: Record<string, unknown>) => validateBoardContent(content([node as unknown as BoardNode]));
    expect(codes(issuesFor({ ...NODES.image, ref: null }))).toEqual(['ref-required']);
    expect(issuesFor({ ...NODES.image, ref: null, pending: { mediaTaskId: 't1', status: 'queued' } })).toEqual([]);
    expect(issuesFor({ ...NODES.image, ref: null, generation })).toEqual([]);
    expect(issuesFor({ ...NODES.video, ref: null, generation })).toEqual([]);
    expect(codes(issuesFor({ ...NODES.video, ref: null }))).toEqual(['ref-required']);
    expect(codes(issuesFor({ ...NODES.audio, ref: null }))).toEqual(['ref-required']);
    expect(codes(issuesFor({ ...NODES.audio, ref: null, generation }))).toEqual(['field-not-allowed']);
    expect(codes(issuesFor({ ...NODES.frame, ref: null }))).toEqual(['ref-required']);
    expect(issuesFor({ ...NODES.frame, ref: null, liveArtifactId: 'la-1' })).toEqual([]);
    expect(codes(issuesFor({ ...NODES.design, ref: null }))).toEqual(['invalid-type']);
  });

  it('bounds generation candidates to 16 and checks refProxy', () => {
    const many = { ...generation, candidates: Array.from({ length: 17 }, (_, index) => ({ ...generation.candidates[0], id: `c${index}` })) };
    expect(codes(validateBoardContent(content([{ ...NODES.image, generation: many } as unknown as BoardNode])))).toEqual(['too-long']);
    expect(validateBoardContent(content([{ ...NODES.image, refProxy: { path: '.od/ref/a.png', sourceKey: 'a.png@1' } } as BoardNode]))).toEqual([]);
    expect(codes(validateBoardContent(content([{ ...NODES.image, refProxy: { path: '../a.png', sourceKey: 'k' } } as BoardNode])))).toEqual(['unsafe-path']);
  });

  it('validates the flattened generator model (phase-1 surfaces image|video, count 1..4)', () => {
    const check = (patch: Record<string, unknown>) => codes(validateBoardContent(content([{ ...NODES.generator, ...patch } as unknown as BoardNode])));
    expect(check({ model: 'gpt-image-1', templateId: 'tpl', surface: 'video', params: { aspect: '16:9', count: 4, length: 5, quality: 'high' } })).toEqual([]);
    expect(check({ surface: 'audio' })).toEqual(['invalid-value']);
    expect(check({ params: { aspect: '1:1', count: 5 } })).toEqual(['out-of-range']);
    expect(check({ params: { aspect: '2:1', count: 1 } })).toEqual(['invalid-value']);
    expect(check({ version: 2 })).toEqual(['invalid-value']);
    expect(check({ model: '' })).toEqual(['required']);
    expect(check({ prompt: 'x'.repeat(BOARD_LIMITS.maxPromptLength + 1) })).toEqual(['too-long']);
    const run = { runId: 'r1', outputNodeId: 'im1', surface: 'image', model: 'm', count: 2, startedAt: 1 };
    expect(check({ runs: [run] })).toEqual([]);
    expect(check({ runs: Array.from({ length: BOARD_LIMITS.maxGeneratorRuns + 1 }, () => run) })).toEqual(['too-long']);
    expect(check({ params: undefined })).toEqual(['required']);
  });

  it('applies generator patch keys (model null = auto-pick, templateId null clears)', () => {
    const base = content([{ ...NODES.generator, model: 'm1', templateId: 'tpl' } as BoardNode]);
    const out = applyBoardOps(base, [{
      op: 'update',
      id: 'gen1',
      patch: { surface: 'video', prompt: 'dog', model: null, templateId: null, params: { aspect: '9:16', count: 3, length: 5 }, runs: [] },
    }], ctx());
    expect(out.ok).toBe(true);
    if (out.ok) {
      const node = out.content.nodes[0]!;
      expect(node).toMatchObject({ surface: 'video', prompt: 'dog', model: null, params: { aspect: '9:16', count: 3, length: 5 } });
      expect(node).not.toHaveProperty('templateId');
    }
    const version = applyBoardOps(base, [{ op: 'update', id: 'gen1', patch: { version: 1 } as never }], ctx());
    expect(version).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('accepts note sizes sm|md|lg and clears them with null', () => {
    expect(validateBoardContent(content([{ ...NODES.note, size: 'lg' } as BoardNode]))).toEqual([]);
    expect(codes(validateBoardContent(content([{ ...NODES.note, size: 'xl' } as unknown as BoardNode])))).toEqual(['invalid-value']);
    const out = applyBoardOps(content([{ ...NODES.note, size: 'sm' } as BoardNode]), [{ op: 'update', id: 'no1', patch: { size: null } }], ctx());
    expect(out.ok && out.content.nodes[0]).not.toHaveProperty('size');
  });

  it('validates material provenance on any node kind', () => {
    const provenance = { source: 'material', materialId: 'mat-1', license: 'CC-BY-4.0', receiptPath: 'materials/receipts/mat-1.json', sourceUrl: 'https://example.com/a' };
    for (const node of allNodes()) {
      expect(validateBoardContent(content([{ ...node, parentId: undefined, provenance } as unknown as BoardNode]))).toEqual([]);
    }
    const check = (value: Record<string, unknown>) => codes(validateBoardContent(content([{ ...NODES.image, provenance: value } as unknown as BoardNode])));
    expect(check({ ...provenance, source: 'web' })).toEqual(['invalid-value']);
    expect(check({ ...provenance, receiptPath: '../r.json' })).toEqual(['unsafe-path']);
    expect(check({ ...provenance, sourceUrl: 'ftp://x' })).toEqual(['unsafe-url']);
    expect(check({ source: 'material', license: 'MIT' })).toEqual(['required']);
    const cleared = applyBoardOps(content([{ ...NODES.image, provenance } as BoardNode]), [{ op: 'update', id: 'im1', patch: { provenance: null } }], ctx());
    expect(cleared.ok && cleared.content.nodes[0]).not.toHaveProperty('provenance');
  });

  it('enforces the edge endpoint rules of plan R3e', () => {
    const nodes = allNodes();
    const check = (kind: BoardEdge['kind'], from: string, to: string) => codes(validateBoardContent(content(nodes, [edge('ed1', kind, from, to)])));
    for (const source of ['im1', 'no1', 'fr1', 'wb1', 'de1']) expect(check('reference', source, 'gen1')).toEqual([]);
    for (const source of ['vd1', 'au1', 'sh1', 'mo1']) expect(check('reference', source, 'gen1')).toEqual(['reference-source-invalid']);
    expect(check('reference', 'gr1', 'gen1')).toEqual(['group-endpoint']);
    expect(check('reference', 'im1', 'fr1')).toEqual(['reference-target-not-generator']);
    for (const target of ['im1', 'vd1', 'au1']) expect(check('output', 'gen1', target)).toEqual([]);
    expect(check('output', 'gen1', 'no1')).toEqual(['output-target-not-media']);
    expect(check('output', 'im1', 'vd1')).toEqual(['output-source-not-generator']);
    expect(check('lineage', 'fr1', 'im1')).toEqual([]);
    expect(check('lineage', 'fr1', 'gr1')).toEqual(['group-endpoint']);
    expect(check('lineage', 'fr1', 'fr1')).toEqual(['self-loop']);
    expect(check('lineage', 'fr1', 'gone1')).toEqual(['edge-endpoint-missing']);
  });
});

describe('validateBoardContent integrity', () => {
  it('reports duplicate ids, parent problems, depth and duplicate edges', () => {
    const issues = validateBoardContent(content([
      NODES.frame as BoardNode,
      { ...NODES.note, id: 'fr1' } as BoardNode,
    ]));
    expect(codes(issues)).toEqual(['duplicate-id']);

    const parents = validateBoardContent(content([
      { ...NODES.note, parentId: 'nope1' } as BoardNode,
      { ...NODES.image, parentId: 'fr1' } as BoardNode,
      NODES.frame as BoardNode,
    ]));
    expect(codes(parents)).toEqual(['unknown-parent', 'parent-not-group']);

    const cycle = validateBoardContent(content([
      { ...NODES.group, id: 'ga1', parentId: 'gb1' } as BoardNode,
      { ...NODES.group, id: 'gb1', parentId: 'ga1' } as BoardNode,
    ]));
    expect(codes(cycle)).toContain('parent-cycle');

    const deep = validateBoardContent(content([
      { ...NODES.group, id: 'g01' } as BoardNode,
      { ...NODES.group, id: 'g02', parentId: 'g01' } as BoardNode,
      { ...NODES.group, id: 'g03', parentId: 'g02' } as BoardNode,
      { ...NODES.note, parentId: 'g02' } as BoardNode,
    ]));
    expect(codes(deep)).toEqual(['group-depth']);

    const edges = validateBoardContent(content(allNodes(), [
      edge('ed1', 'lineage', 'fr1', 'im1'),
      edge('ed2', 'lineage', 'fr1', 'im1'),
      edge('fr1', 'lineage', 'im1', 'fr1'),
    ]));
    expect(codes(edges)).toEqual(['edge-duplicate', 'duplicate-id']);
  });

  it('reports the serialized-size limit as a limit issue', () => {
    const text = 'x'.repeat(BOARD_LIMITS.maxNoteTextLength);
    const big = content(Array.from({ length: 160 }, (_, index) => ({ ...NODES.note, id: `nt${index}`, text }) as BoardNode));
    expect(validateBoardContent(big)).toEqual([expect.objectContaining({ path: 'maxDocumentBytes', code: 'limit' })]);
    expect(checkBoardContentLimits(big)).toMatchObject({ kind: 'board-limit', limit: 'maxDocumentBytes', max: BOARD_LIMITS.maxDocumentBytes });
    expect(checkBoardContentLimits(content(allNodes()))).toBeNull();
    const manyEdges = { ...content([]), edges: Array.from({ length: BOARD_LIMITS.maxEdges + 1 }, (_, index) => edge(`e${index}x`, 'lineage', 'a', 'b')) };
    expect(checkBoardContentLimits(manyEdges)).toEqual({ kind: 'board-limit', limit: 'maxEdges', max: 4000, actual: 4001 });
  });
});

describe('normalizeBoardContent (PUT)', () => {
  const actor: BoardActor = { kind: 'cli' };

  it('fills defaults, drops unknown keys, stamps revs and keeps valid creation stamps', () => {
    const result = normalizeBoardContent({
      title: 'Board',
      settings: { autoPlace: false },
      nodes: [
        { id: 'fr1', kind: 'frame', x: 0, y: 0, w: 400, h: 300, ref: { path: 'index.html', junk: 1 }, extra: true, createdAt: 50, createdBy: { kind: 'agent' }, rev: 99 },
        { id: 'no1', kind: 'note', x: 0, y: 400, w: 280, h: 220, createdAt: -1, missing: { since: 3 } },
        { id: 'gr1', kind: 'group', x: 0, y: 0, w: 900, h: 900, role: 'turn' },
        { id: 'gen1', kind: 'generator', x: 0, y: 0, w: 320, h: 272, surface: 'image', params: { aspect: '1:1', count: 1 } },
        { id: 'de1', kind: 'design', x: 0, y: 0, w: 960, h: 600, ref: { path: 'designs/a.op' } },
      ],
      edges: [
        { id: 'ed2', kind: 'lineage', from: 'fr1', to: 'no1', createdAt: 20 },
        { id: 'ed1', kind: 'lineage', from: 'no1', to: 'fr1', createdAt: 10, foo: 'bar' },
      ],
    }, { now: 1_000, actor, revision: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [frame, note, group, generator, design] = result.value.nodes;
    expect(result.value.title).toBe('Board');
    expect(result.value.settings).toEqual({ background: 'dots', autoPlace: false });
    expect(frame).toEqual({
      id: 'fr1', kind: 'frame', x: 0, y: 0, w: 400, h: 300, createdAt: 50, updatedAt: 1_000, createdBy: { kind: 'agent' }, updatedBy: actor,
      rev: 7, ref: { path: 'index.html' }, device: 'desktop',
    });
    expect(Object.keys(frame!).slice(0, 6)).toEqual(['id', 'kind', 'x', 'y', 'w', 'h']);
    expect(note).toMatchObject({ text: '', color: 'yellow', createdAt: 1_000, createdBy: actor, missing: { since: 3 }, rev: 7 });
    expect(group).toMatchObject({ layout: 'free' });
    expect(generator).toMatchObject({ version: 1, prompt: '', model: null, runs: [] });
    expect(design).toMatchObject({ format: 'op' });
    expect(result.value.edges.map((entry) => entry.id)).toEqual(['ed1', 'ed2']);
    expect(result.value.edges[0]).toEqual({ id: 'ed1', kind: 'lineage', from: 'no1', to: 'fr1', createdAt: 10, createdBy: actor, updatedBy: actor, rev: 7 });
    expect(validateBoardContent(result.value)).toEqual([]);
  });

  it('reports structural problems', () => {
    const result = normalizeBoardContent({
      nodes: [{ kind: 'note', x: 0, y: 0, w: 10, h: 10 }, { id: 'xx1', kind: 'blob' }, 'nope'],
      edges: {},
    }, { now: 1, actor, revision: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => [issue.path, issue.code])).toEqual([
        ['nodes[0].id', 'required'],
        ['nodes[1].kind', 'invalid-value'],
        ['nodes[2]', 'invalid-type'],
        ['edges', 'invalid-type'],
      ]);
    }
  });
});

describe('other request validators', () => {
  it('validateBoardPutRequest', () => {
    expect(validateBoardPutRequest({ baseRevision: 2, board: { nodes: [], edges: [], settings: { background: 'blank' } } }).ok).toBe(true);
    expect(validateBoardPutRequest({ baseRevision: 2, board: { nodes: [] } })).toMatchObject({ ok: false, issues: [{ path: 'board.edges' }] });
    expect(validateBoardPutRequest({ baseRevision: 2, board: { nodes: [], edges: [], settings: { grid: true } } })).toMatchObject({
      ok: false, issues: [{ path: 'board.settings.grid', code: 'field-not-allowed' }],
    });
  });

  it('validateBoardSyncRequest', () => {
    expect(validateBoardSyncRequest({ reason: 'open' }).ok).toBe(true);
    expect(validateBoardSyncRequest({
      reason: 'focus',
      conversationId: 'c1',
      turn: { conversationId: 'c1', messageId: 'm1', status: 'running', paths: ['index.html'] },
      focus: { names: ['index.html', 'live:la1'], primary: 'index.html', near: { x: 1, y: 2 } },
      actor: { kind: 'user', clientId: 'tab' },
    }).ok).toBe(true);
    const bad = validateBoardSyncRequest({ reason: 'later', turn: { conversationId: 'c1', messageId: 'm1', status: 'done', paths: ['../x'] }, focus: { names: [] } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.map((issue) => issue.path)).toEqual(['reason', 'turn.status', 'turn.paths[0]', 'focus.names']);
    }
  });

  it('validateBoardViewport accepts a viewport or {viewport}', () => {
    expect(validateBoardViewport({ centerX: 1, centerY: 2, zoom: 0.5 })).toEqual({ ok: true, value: { centerX: 1, centerY: 2, zoom: 0.5 } });
    expect(validateBoardViewport({ viewport: { centerX: 1, centerY: 2, zoom: 8 } })).toEqual({ ok: true, value: { centerX: 1, centerY: 2, zoom: 8 } });
    expect(validateBoardViewport({ centerX: Number.NaN, centerY: 2, zoom: 0 })).toMatchObject({
      ok: false, issues: [{ path: 'centerX', code: 'invalid-type' }, { path: 'zoom', code: 'out-of-range' }],
    });
  });

  it('validateBoardImportRequest', () => {
    expect(validateBoardImportRequest({ documentIds: ['doc_1', 'doc-2'], placement: { mode: 'auto' } }).ok).toBe(true);
    expect(validateBoardImportRequest({ documentIds: [] })).toMatchObject({ ok: false, issues: [{ path: 'documentIds', code: 'out-of-range' }] });
    expect(validateBoardImportRequest({ documentIds: Array.from({ length: 21 }, (_, index) => `d${index}`) })).toMatchObject({ ok: false });
    expect(validateBoardImportRequest({ documentIds: ['a/b', 'ok', 'ok'], placement: { mode: 'at', x: 'x', y: 0 } })).toMatchObject({
      ok: false,
      issues: [
        { path: 'documentIds[0]', code: 'invalid-value' },
        { path: 'documentIds[2]', code: 'duplicate-id' },
        { path: 'placement.x', code: 'invalid-type' },
      ],
    });
  });
});
