// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyBoardOps,
  emptyBoardContent,
  type BoardNode,
  type BoardOp,
} from '@open-design/contracts';

import { STAGE_ATTACHMENT_EVENT, type StageAttachmentEventDetail } from '../../../src/components/ChatComposer';
import { ANNOTATION_EVENT, type AnnotationEventDetail } from '../../../src/components/PreviewDrawOverlay';
import {
  boardCaptureFileName,
  dispatchBoardCaptureToChat,
  stageBoardNodesInChat,
} from '../../../src/fantay/board/sync/capture';

function nodesFrom(ops: BoardOp[]): Record<string, BoardNode> {
  const outcome = applyBoardOps(emptyBoardContent(), ops, {
    baseRevision: 0,
    nextRevision: 1,
    actor: { kind: 'user' },
    now: 1,
    newId: (prefix) => `${prefix}_gen1`,
    checkConflicts: false,
  });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  return Object.fromEntries(outcome.content.nodes.map((node) => [node.id, node]));
}

const nodes = nodesFrom([
  { op: 'add', node: { id: 'n_frame', kind: 'frame', ref: { path: 'pages/Landing Page.html' }, title: 'Hero — Ünïcode Landing!' } },
  { op: 'add', node: { id: 'n_image', kind: 'image', ref: { path: 'assets/hero.png' } } },
  { op: 'add', node: { id: 'n_video', kind: 'video', ref: { path: 'clips/intro.mp4' } } },
  { op: 'add', node: { id: 'n_pending', kind: 'image', ref: null, pending: { mediaTaskId: 't1', status: 'running' } } },
  { op: 'add', node: { id: 'n_design', kind: 'design', ref: { path: 'designs/app.fig' }, format: 'fig' } },
  { op: 'add', node: { id: 'n_note', kind: 'note', text: 'hello' } },
  { op: 'add', node: { id: 'n_web', kind: 'web', url: 'https://example.com' } },
]);

const NOW = new Date(2026, 9, 29, 8, 5, 9);

afterEach(() => {
  vi.useRealTimers();
});

describe('board capture', () => {
  it('names captures board-capture-<slug>-<YYYYMMDD-HHmmss>.png', () => {
    expect(boardCaptureFileName(nodes.n_frame, NOW)).toBe('board-capture-hero-unicode-landing-20261029-080509.png');
    expect(boardCaptureFileName(nodes.n_image, NOW)).toBe('board-capture-hero-20261029-080509.png');
    expect(boardCaptureFileName(nodes.n_web, NOW)).toBe('board-capture-example-com-20261029-080509.png');
    expect(boardCaptureFileName(null, NOW)).toBe('board-capture-board-20261029-080509.png');
    const long = { ...nodes.n_note!, title: 'a'.repeat(80) } as BoardNode;
    expect(boardCaptureFileName(long, NOW)).toBe(`board-capture-${'a'.repeat(40)}-20261029-080509.png`);
    const cjk = { ...nodes.n_note!, title: '首页' } as BoardNode;
    expect(boardCaptureFileName(cjk, NOW)).toBe('board-capture-board-20261029-080509.png');
  });

  it('dispatches ANNOTATION_EVENT with a PNG file, the node path and a stroke mark for a region', async () => {
    const seen: AnnotationEventDetail[] = [];
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<AnnotationEventDetail>).detail;
      seen.push(detail);
      detail.ack?.({ ok: true });
    };
    window.addEventListener(ANNOTATION_EVENT, onEvent);
    const image = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    const result = await dispatchBoardCaptureToChat({
      image,
      node: nodes.n_frame,
      region: { x: 10, y: 20, width: 300, height: 200 },
      note: 'tighten this',
      now: NOW,
    });
    window.removeEventListener(ANNOTATION_EVENT, onEvent);
    expect(result).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    const detail = seen[0]!;
    expect(detail.file).toBeInstanceOf(File);
    expect(detail.file?.name).toBe('board-capture-hero-unicode-landing-20261029-080509.png');
    expect(detail.file?.type).toBe('image/png');
    expect(detail).toMatchObject({
      note: 'tighten this',
      action: 'draft',
      filePath: 'pages/Landing Page.html',
      target: null,
      markKind: 'stroke',
      bounds: { x: 10, y: 20, width: 300, height: 200 },
    });
  });

  it('omits filePath and the mark for a region capture without a node', async () => {
    const seen: AnnotationEventDetail[] = [];
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<AnnotationEventDetail>).detail;
      seen.push(detail);
      detail.ack?.({ ok: false, message: 'composer busy' });
    };
    window.addEventListener(ANNOTATION_EVENT, onEvent);
    const result = await dispatchBoardCaptureToChat({
      image: new Blob([], { type: 'image/png' }),
      region: { x: 0, y: 0, width: 10, height: 10 },
      action: 'queue',
      now: NOW,
    });
    window.removeEventListener(ANNOTATION_EVENT, onEvent);
    expect(result).toEqual({ ok: false, message: 'composer busy' });
    expect(seen[0]).toMatchObject({ note: '', action: 'queue', target: null });
    expect(seen[0]).not.toHaveProperty('filePath');
    expect(seen[0]).not.toHaveProperty('markKind');
  });

  it('gives up after 10 s without an ack', async () => {
    vi.useFakeTimers();
    const pending = dispatchBoardCaptureToChat({ image: new Blob([], { type: 'image/png' }), node: nodes.n_image, now: NOW });
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false });
  });

  it('stages file-backed nodes through STAGE_ATTACHMENT_EVENT without uploading', () => {
    const seen: StageAttachmentEventDetail[] = [];
    const onStage = (event: Event) => seen.push((event as CustomEvent<StageAttachmentEventDetail>).detail);
    window.addEventListener(STAGE_ATTACHMENT_EVENT, onStage);
    const count = stageBoardNodesInChat([
      nodes.n_image!, nodes.n_video!, nodes.n_pending!, nodes.n_design!, nodes.n_note!, nodes.n_frame!, nodes.n_image!,
    ]);
    expect(stageBoardNodesInChat([nodes.n_note!, nodes.n_pending!])).toBe(0);
    window.removeEventListener(STAGE_ATTACHMENT_EVENT, onStage);
    expect(count).toBe(4);
    expect(seen).toEqual([{
      attachments: [
        { path: 'assets/hero.png', name: 'hero.png', kind: 'image' },
        { path: 'clips/intro.mp4', name: 'intro.mp4', kind: 'file' },
        { path: 'designs/app.fig', name: 'app.fig', kind: 'file' },
        { path: 'pages/Landing Page.html', name: 'Landing Page.html', kind: 'file' },
      ],
    }]);
  });
});
