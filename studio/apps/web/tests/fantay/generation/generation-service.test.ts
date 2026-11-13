// Spec 05 §4.6 / §11 with a fake daemon (`fetch`) and the real board port over an in-memory optimistic store
// (the contract engine applies every op, as 04's store does locally): run, stop, retry, missing references,
// resume after reload, imported-folder block, node removal, and reference proxies (§4.7).
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyBoardOps,
  paramSupportFor,
  type BoardDocument,
  type BoardEdge,
  type BoardNode,
  type BoardOp,
  type GenerationCandidate,
  type MediaGenerateRequest,
  type MediaNodeGeneration,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import type { BoardApplyOptions } from '../../../src/fantay/board/data/types';
import { createGenerationBoardPort, type BoardStoreLike } from '../../../src/fantay/generation/board-adapter';
import { GenerationService, type GenerationEvent } from '../../../src/fantay/generation/generation-service';
import type { GenerationModelOption } from '../../../src/fantay/generation/model-catalog';
import { prepareReferenceImages } from '../../../src/fantay/generation/references';

const actor = { kind: 'user' as const };
function stamped(node: Record<string, unknown>): BoardNode {
  return { createdAt: 1, updatedAt: 1, createdBy: actor, updatedBy: actor, rev: 1, ...node } as unknown as BoardNode;
}
function edge(id: string, from: string, to: string, createdAt: number): BoardEdge {
  return { id, kind: 'reference', from, to, createdAt, createdBy: actor, updatedBy: actor, rev: 1 };
}
function doc(nodes: BoardNode[], edges: BoardEdge[] = []): BoardDocument {
  return {
    schemaVersion: 1,
    projectId: 'p1',
    revision: 1,
    updatedAt: 1,
    updatedBy: null,
    viewport: null,
    settings: { background: 'dots', autoPlace: true },
    nodes,
    edges,
  };
}

function memoryStore(initial: BoardDocument) {
  let board: BoardDocument | null = initial;
  const listeners = new Set<() => void>();
  const applied: Array<{ ops: BoardOp[]; options: BoardApplyOptions | undefined }> = [];
  let now = 100;
  const store: BoardStoreLike & { applied: typeof applied; set(next: BoardDocument): void; current(): BoardDocument } = {
    applied,
    getState: () => ({ board }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async apply(ops, options) {
      applied.push({ ops, options });
      const current = board!;
      const outcome = applyBoardOps({ settings: current.settings, nodes: current.nodes, edges: current.edges }, ops, {
        baseRevision: current.revision,
        nextRevision: current.revision + 1,
        actor: { kind: 'user', clientId: 'tab' },
        now: (now += 1),
        newId: (prefix) => `${prefix}_srv${now}`,
        checkConflicts: false,
      });
      if (!outcome.ok) throw new Error(`invalid ops ${JSON.stringify(outcome)}`);
      board = { ...current, ...outcome.content };
      for (const listener of [...listeners]) listener();
      return { ok: true };
    },
    set(next) {
      board = next;
      for (const listener of [...listeners]) listener();
    },
    current: () => board!,
  };
  return store;
}

const WORKSPACE: WorkspaceCollabContext = {
  workspaceId: 'ws1',
  workspaceType: 'team',
  workspaceMemberId: 'm1',
  role: 'member',
  lifecycleState: 'active',
  memberStatus: 'active',
  permissions: { canShareProjects: true, canWriteSyncedFiles: true },
} as unknown as WorkspaceCollabContext;

const VELA: GenerationModelOption = {
  id: 'vela/gpt-image-2',
  label: 'gpt-image-2 (Cloud)',
  hint: 'Vela Cloud',
  provider: 'vela',
  providerLabel: 'Vela Cloud',
  surface: 'image',
  caps: ['t2i', 'i2i'],
  support: paramSupportFor({ id: 'vela/gpt-image-2', provider: 'vela', caps: ['t2i', 'i2i'] }, 'image'),
  readiness: 'cloud',
  isDefault: false,
};

function generatorBoard(): BoardDocument {
  return doc(
    [
      stamped({ id: 'n_a', kind: 'image', x: 0, y: 0, w: 320, h: 320, ref: { path: 'refs/a.png' } }),
      stamped({ id: 'n_b', kind: 'image', x: 0, y: 400, w: 320, h: 320, ref: { path: 'refs/b.jpg' } }),
      stamped({
        id: 'n_gen',
        kind: 'generator',
        x: 400,
        y: 0,
        w: 320,
        h: 272,
        version: 1,
        surface: 'image',
        prompt: 'mix @[node:n_a] with @[node:n_b]',
        model: 'vela/gpt-image-2',
        params: { aspect: '1:1', count: 2 },
        runs: [],
      }),
    ],
    [edge('e_a', 'n_a', 'n_gen', 1), edge('e_b', 'n_b', 'n_gen', 2)],
  );
}

interface FetchCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Never answers until aborted (an open long-poll). */
function hold(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
}

function fakeDaemon(overrides: {
  generate?: (body: MediaGenerateRequest, index: number) => Response | Promise<Response>;
  wait?: (taskId: string, call: FetchCall) => Response | Promise<Response>;
  tasks?: () => unknown[];
  files?: () => unknown[];
  raw?: (path: string) => Response;
  upload?: (form: FormData) => Response;
} = {}) {
  const calls: FetchCall[] = [];
  const generated: MediaGenerateRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body;
    const call: FetchCall = { method: init?.method ?? 'GET', url, headers, body, signal: init?.signal ?? undefined };
    calls.push(call);
    if (call.method === 'POST' && url === '/api/projects/p1/media/generate') {
      const request = body as MediaGenerateRequest;
      generated.push(request);
      return (overrides.generate ?? ((_b, index) => json(202, { taskId: `task-${index + 1}`, status: 'queued', startedAt: 1000 })))(
        request,
        generated.length - 1,
      );
    }
    const wait = /^\/api\/media\/tasks\/([^/]+)\/wait$/.exec(url);
    if (call.method === 'POST' && wait) {
      const taskId = decodeURIComponent(wait[1]!);
      if (overrides.wait) return overrides.wait(taskId, call);
      const index = Number(taskId.replace('task-', '')) - 1;
      return json(200, {
        taskId,
        status: 'done',
        startedAt: 1000,
        endedAt: 2000,
        progress: ['saving'],
        nextSince: 1,
        file: { name: generated[index]?.output ?? 'x.png', size: 4096, mtime: 2000, mime: 'image/png' },
      });
    }
    if (url === '/api/projects/p1/media/tasks?includeDone=1') return json(200, { tasks: overrides.tasks?.() ?? [] });
    if (call.method === 'GET' && url === '/api/projects/p1/files') return json(200, { files: overrides.files?.() ?? [] });
    if (call.method === 'POST' && url === '/api/projects/p1/files') {
      return overrides.upload ? overrides.upload(init?.body as FormData) : json(500, {});
    }
    if (url.startsWith('/api/projects/p1/raw/')) return overrides.raw ? overrides.raw(url) : json(404, {});
    return json(404, { error: { code: 'NOT_FOUND', message: `no route ${call.method} ${url}` } });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, generated };
}

function counterIds(prefix = 'id') {
  let n = 0;
  return { next: () => `${prefix}-${++n}` };
}

function setup(options: { board?: BoardDocument; daemon?: ReturnType<typeof fakeDaemon>; imported?: boolean; probe?: (url: string) => Promise<{ width: number; height: number } | null> } = {}) {
  const store = memoryStore(options.board ?? generatorBoard());
  const port = createGenerationBoardPort(store, { select: vi.fn(), focus: vi.fn() });
  const daemon = options.daemon ?? fakeDaemon();
  const probeImage = vi.fn(options.probe ?? (async (_url: string) => ({ width: 1600, height: 900 })));
  const service = new GenerationService({
    projectId: 'p1',
    workspaceContext: WORKSPACE,
    board: port,
    locale: 'en',
    isImportedFolderProject: options.imported ?? false,
    fetch: daemon.fetch,
    ids: counterIds(),
    now: () => 5_000,
    probeImage,
    probeVideo: vi.fn(async () => null),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  });
  const events: GenerationEvent[] = [];
  service.subscribe((event) => events.push(event));
  return { store, port, daemon, service, probeImage, events };
}

function outputNode(store: ReturnType<typeof memoryStore>, nodeId: string) {
  return store.current().nodes.find((node) => node.id === nodeId) as unknown as {
    x: number;
    y: number;
    w: number;
    h: number;
    ref: { path: string } | null;
    naturalWidth?: number;
    generation: MediaNodeGeneration;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GenerationService.run', () => {
  it('plans the run, posts one request per candidate and writes the results back', async () => {
    const { store, daemon, service, probeImage, events } = setup();
    const outcome = await service.run('n_gen', VELA);
    expect(outcome).toMatchObject({ started: true });
    if (!outcome.started) return;

    // The run ops come first, as one non-undoable, silent write.
    expect(store.applied[0]!.options).toEqual({ undoable: false, silentConflict: true, label: 'generation.run' });
    expect(store.applied[0]!.ops.map((op) => op.op)).toEqual(['add', 'connect', 'update']);

    // Two requests: distinct flat outputs, references split into image + images, workspace identity attached.
    expect(daemon.generated).toHaveLength(2);
    const outputs = daemon.generated.map((body) => body.output);
    expect(new Set(outputs).size).toBe(2);
    for (const body of daemon.generated) {
      expect(body).toMatchObject({ surface: 'image', model: 'vela/gpt-image-2', aspect: '1:1', image: 'refs/a.png', images: ['refs/b.jpg'] });
      expect(body.prompt).toBe(
        'Reference image labels: Image 1, Image 2. Use these labels to interpret image references in the prompt.\n\nmix Image 1 with Image 2',
      );
    }
    const posts = daemon.calls.filter((call) => call.url.endsWith('/media/generate'));
    expect(posts[0]!.headers['x-od-workspace-id']).toBe('ws1');
    expect(posts[0]!.headers['x-od-workspace-member-id']).toBe('m1');

    await vi.waitFor(() => expect(outputNode(store, outcome.outputNodeId).generation.candidates.every((c) => c.status === 'done')).toBe(true));
    const node = outputNode(store, outcome.outputNodeId);
    // 202 → task ids; done → files; the first done candidate is primary and mirrored into the node.
    expect(node.generation.candidates.map((candidate) => candidate.taskId)).toEqual(['task-1', 'task-2']);
    expect(node.generation.primaryCandidateId).toBe(node.generation.candidates[0]!.id);
    expect(node.ref?.path).toBe(outputs[0]);
    await vi.waitFor(() => expect(outputNode(store, outcome.outputNodeId).generation.sizedToMedia).toBe(true));
    // Probed once (first result) and fitted once to 16:9, keeping the long edge and the centre.
    expect(probeImage).toHaveBeenCalledTimes(1);
    expect(probeImage.mock.calls[0]![0]).toContain(`/api/projects/p1/raw/${outputs[0]}`);
    const fitted = outputNode(store, outcome.outputNodeId);
    expect([fitted.w, fitted.h]).toEqual([320, 180]);
    expect(fitted.naturalWidth).toBe(1600);
    const fits = store.applied.filter((entry) => entry.options?.label === 'generation.fit');
    expect(fits).toHaveLength(1);
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'run-finished', done: 2, failed: 0, total: 2 })));
    // The generator records the run and the model it used.
    const generator = store.current().nodes.find((entry) => entry.id === 'n_gen') as unknown as { runs: Array<{ runId: string }>; model: string };
    expect(generator.runs[0]?.runId).toBe(outcome.runId);
    expect(generator.model).toBe('vela/gpt-image-2');
  });

  it('maps a 403 policy denial to switch-model', async () => {
    const daemon = fakeDaemon({
      generate: () => json(403, { error: { code: 'MEDIA_MODEL_DENIED', message: 'media model "vela/gpt-image-2" is not allowed for this run' } }),
    });
    const { store, service, events } = setup({ daemon });
    const outcome = await service.run('n_gen', VELA);
    if (!outcome.started) throw new Error('not started');
    const candidates = outputNode(store, outcome.outputNodeId).generation.candidates;
    expect(candidates.map((candidate) => [candidate.status, candidate.error?.nextStep, candidate.error?.code])).toEqual([
      ['failed', 'switch-model', 'MEDIA_MODEL_DENIED'],
      ['failed', 'switch-model', 'MEDIA_MODEL_DENIED'],
    ]);
    expect(daemon.calls.some((call) => call.url.endsWith('/wait'))).toBe(false);
    expect(events).toContainEqual({ type: 'run-finished', generatorId: 'n_gen', runId: outcome.runId, done: 0, failed: 2, total: 2 });
  });

  it('maps the sandbox 401 (browser lane refused) to the sandbox copy', async () => {
    const daemon = fakeDaemon({
      generate: () => json(401, { error: { code: 'TOOL_TOKEN_MISSING', message: 'tool token is required for media generation in sandbox mode' } }),
    });
    const { store, service } = setup({ daemon });
    const outcome = await service.run('n_gen', VELA);
    if (!outcome.started) throw new Error('not started');
    const [first] = outputNode(store, outcome.outputNodeId).generation.candidates;
    expect(first).toMatchObject({
      status: 'failed',
      error: { nextStep: 'unsupported', messageKey: 'fantay.gen.sandbox', code: 'TOOL_TOKEN_MISSING', status: 401 },
    });
  });

  it('blocks imported-folder projects, a missing model, an empty prompt and a second concurrent run', async () => {
    const imported = setup({ imported: true });
    expect(await imported.service.run('n_gen', VELA)).toEqual({ started: false, reason: 'imported-folder' });
    expect(imported.daemon.calls).toHaveLength(0);

    const { service, store, daemon } = setup({ daemon: fakeDaemon({ wait: (_taskId, call) => hold(call.signal) }) });
    expect(await service.run('n_gen', null)).toEqual({ started: false, reason: 'no-model' });
    const first = await service.run('n_gen', VELA);
    expect(first.started).toBe(true);
    expect(await service.run('n_gen', VELA)).toEqual({ started: false, reason: 'already-running' });
    service.dispose();

    const empty = generatorBoard();
    const emptyBoard = doc(
      empty.nodes.map((node) => (node.id === 'n_gen' ? ({ ...node, prompt: '' } as BoardNode) : node)),
      [],
    );
    const blank = setup({ board: emptyBoard });
    expect(await blank.service.run('n_gen', VELA)).toEqual({ started: false, reason: 'empty-prompt' });
    expect(store.applied.filter((entry) => entry.options?.label === 'generation.run')).toHaveLength(1);
    expect(daemon.generated).toHaveLength(2);
  });

  it('refuses a model that cannot take the connected references', async () => {
    const gpt: GenerationModelOption = {
      ...VELA,
      id: 'gpt-image-2',
      provider: 'openai',
      readiness: 'ready',
      support: paramSupportFor({ id: 'gpt-image-2', provider: 'openai', caps: ['t2i', 'i2i'] }, 'image'),
    };
    const { service, daemon } = setup();
    expect(await service.run('n_gen', gpt)).toEqual({ started: false, reason: 'model-unavailable' });
    expect(daemon.calls).toHaveLength(0);
  });

  it('reports needs-reference for an image-to-X-only model without a connected reference', async () => {
    const editOnly: GenerationModelOption = {
      ...VELA,
      id: 'vela/edit-only',
      caps: ['i2i'],
      support: paramSupportFor({ id: 'vela/edit-only', provider: 'vela', caps: ['i2i'] }, 'image'),
    };
    const alone = doc(generatorBoard().nodes.filter((node) => node.kind === 'generator'));
    const { service, daemon } = setup({ board: alone });
    expect(await service.run('n_gen', editOnly)).toEqual({ started: false, reason: 'needs-reference' });
    expect(daemon.calls).toHaveLength(0);
  });
});

describe('stop, retry, more', () => {
  it('stop marks active candidates stopped, keeps their task ids and sends no further requests', async () => {
    const daemon = fakeDaemon({ wait: (_taskId, call) => hold(call.signal) });
    const { store, service } = setup({ daemon });
    const outcome = await service.run('n_gen', VELA);
    if (!outcome.started) throw new Error('not started');
    await vi.waitFor(() => expect(daemon.calls.filter((call) => call.url.endsWith('/wait'))).toHaveLength(2));
    const waits = daemon.calls.filter((call) => call.url.endsWith('/wait'));
    service.stop('n_gen');
    expect(waits.every((call) => call.signal?.aborted)).toBe(true);
    const candidates = outputNode(store, outcome.outputNodeId).generation.candidates;
    expect(candidates.map((candidate) => [candidate.status, candidate.taskId])).toEqual([
      ['stopped', 'task-1'],
      ['stopped', 'task-2'],
    ]);
    const before = daemon.calls.length;
    // Let the aborted watch loops unwind (a macrotask turn, not a timed sleep): none asks again.
    await new Promise((resolve) => setImmediate(resolve));
    expect(daemon.calls.length).toBe(before);
    expect(service.activeWatchCount()).toBe(0);
  });

  it('check result after stop watches a task that is still running until its result lands', async () => {
    let stopped = false;
    const daemon = fakeDaemon({
      wait: (taskId, call) => {
        if (!stopped) return hold(call.signal);
        const body = call.body as { timeoutMs?: number };
        if (body.timeoutMs === 0) {
          return json(200, { taskId, status: 'running', startedAt: 1000, endedAt: null, progress: ['rendering'], nextSince: 1 });
        }
        return json(200, {
          taskId,
          status: 'done',
          startedAt: 1000,
          endedAt: 2000,
          progress: [],
          nextSince: 2,
          file: { name: 'gen-late-1.png', size: 4096, mtime: 2000, mime: 'image/png' },
        });
      },
    });
    const { store, service } = setup({ daemon });
    const outcome = await service.run('n_gen', VELA);
    if (!outcome.started) throw new Error('not started');
    await vi.waitFor(() => expect(service.activeWatchCount()).toBe(2));
    service.stop('n_gen');
    stopped = true;
    const target = outputNode(store, outcome.outputNodeId).generation.candidates[0]!;
    expect(target.status).toBe('stopped');

    await service.checkCandidate(outcome.outputNodeId, target.id);
    // The task still runs: the candidate is active again and watched (not left "running" with no watcher).
    expect(service.activeWatchCount()).toBe(1);
    await vi.waitFor(() =>
      expect(outputNode(store, outcome.outputNodeId).generation.candidates[0]).toMatchObject({
        status: 'done',
        taskId: 'task-1',
        file: { path: 'gen-late-1.png' },
      }),
    );
    expect(outputNode(store, outcome.outputNodeId).generation.candidates[1]!.status).toBe('stopped');
  });

  it('retry reuses the candidate id with the next attempt name (r1)', async () => {
    let first = true;
    const daemon = fakeDaemon({
      generate: (_body, index) => {
        if (first) {
          if (index === 1) first = false;
          throw new TypeError('fetch failed');
        }
        return json(202, { taskId: `task-${index + 1}`, status: 'queued', startedAt: 1 });
      },
      files: () => [
        { name: 'refs/a.png', size: 1, mtime: 1, kind: 'image', mime: 'image/png' },
        { name: 'refs/b.jpg', size: 1, mtime: 1, kind: 'image', mime: 'image/jpeg' },
      ],
    });
    const { store, service } = setup({ daemon });
    const outcome = await service.run('n_gen', VELA);
    if (!outcome.started) throw new Error('not started');
    const failed = outputNode(store, outcome.outputNodeId).generation.candidates[0]!;
    expect(failed).toMatchObject({ status: 'failed', attempt: 0, error: { nextStep: 'retry-later' } });
    const firstName = daemon.generated[0]!.output!;

    await service.retryCandidate(outcome.outputNodeId, failed.id);
    const retried = daemon.generated[2]!;
    expect(retried.output).toBe(firstName.replace(/-1\.png$/, '-1r1.png'));
    await vi.waitFor(() =>
      expect(outputNode(store, outcome.outputNodeId).generation.candidates.find((c) => c.id === failed.id)?.status).toBe('done'),
    );
    const candidate = outputNode(store, outcome.outputNodeId).generation.candidates.find((c) => c.id === failed.id)!;
    expect(candidate).toMatchObject({ attempt: 1, taskId: 'task-3', outputStem: firstName.replace(/\.png$/, 'r1') });
  });

  it('a retry whose reference file is gone fails with revise-request and the missing-reference copy', async () => {
    const daemon = fakeDaemon({
      generate: () => json(500, { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'try later' } }),
      files: () => [{ name: 'refs/a.png', size: 1, mtime: 1, kind: 'image', mime: 'image/png' }],
    });
    const { store, service } = setup({ daemon });
    const outcome = await service.run('n_gen', VELA);
    if (!outcome.started) throw new Error('not started');
    const target = outputNode(store, outcome.outputNodeId).generation.candidates[0]!;
    await service.retryCandidate(outcome.outputNodeId, target.id);
    expect(daemon.generated).toHaveLength(2); // no new POST
    const after = outputNode(store, outcome.outputNodeId).generation.candidates[0]!;
    expect(after).toMatchObject({
      status: 'failed',
      error: { nextStep: 'revise-request', messageKey: 'fantay.gen.refs.missing', messageVars: { name: 'b.jpg' } },
    });
  });

  it('more like this adds a candidate with its own run id and dispatches it', async () => {
    const { store, service, daemon } = setup({
      daemon: fakeDaemon({
        files: () => [
          { name: 'refs/a.png', size: 1, mtime: 1, kind: 'image', mime: 'image/png' },
          { name: 'refs/b.jpg', size: 1, mtime: 1, kind: 'image', mime: 'image/jpeg' },
        ],
      }),
    });
    const outcome = await service.run('n_gen', VELA);
    if (!outcome.started) throw new Error('not started');
    await vi.waitFor(() => expect(outputNode(store, outcome.outputNodeId).generation.candidates.every((c) => c.status === 'done')).toBe(true));
    await service.moreLikeThis(outcome.outputNodeId);
    const candidates = outputNode(store, outcome.outputNodeId).generation.candidates;
    expect(candidates).toHaveLength(3);
    expect(candidates[2]!.runId).not.toBe(outcome.runId);
    expect(daemon.generated).toHaveLength(3);
    await vi.waitFor(() => expect(outputNode(store, outcome.outputNodeId).generation.candidates[2]!.status).toBe('done'));
  });
});

describe('user edits', () => {
  it('set primary, promote and delete are undoable writes', async () => {
    const { store, service, port } = setup();
    const outcome = await service.run('n_gen', VELA);
    if (!outcome.started) throw new Error('not started');
    await vi.waitFor(() => expect(outputNode(store, outcome.outputNodeId).generation.candidates.every((c) => c.status === 'done')).toBe(true));
    const [first, second] = outputNode(store, outcome.outputNodeId).generation.candidates as [GenerationCandidate, GenerationCandidate];

    service.setPrimary(outcome.outputNodeId, second.id);
    expect(outputNode(store, outcome.outputNodeId).generation.primaryCandidateId).toBe(second.id);
    expect(outputNode(store, outcome.outputNodeId).ref?.path).toBe(second.file!.path);

    const promoted = service.promote(outcome.outputNodeId, first.id);
    expect(promoted).toBeTruthy();
    const copy = store.current().nodes.find((node) => node.id === promoted) as unknown as { kind: string; ref: { path: string } };
    expect(copy).toMatchObject({ kind: 'image', ref: { path: first.file!.path } });
    expect(store.current().edges.some((entry) => entry.from === 'n_gen' && entry.to === promoted && entry.kind === 'output')).toBe(true);
    expect(port.getNode(promoted!)).toBeTruthy();

    service.deleteCandidate(outcome.outputNodeId, first.id);
    expect(outputNode(store, outcome.outputNodeId).generation.candidates.map((c) => c.id)).toEqual([second.id]);
    service.deleteCandidate(outcome.outputNodeId, second.id); // the last one stays
    expect(outputNode(store, outcome.outputNodeId).generation.candidates).toHaveLength(1);

    const labels = store.applied.filter((entry) => entry.options?.undoable).map((entry) => entry.options?.label);
    expect(labels).toEqual(['generation.setPrimary', 'generation.promote', 'generation.deleteCandidate']);
  });
});

describe('resume and removal', () => {
  function candidate(id: string, status: GenerationCandidate['status'], extra: Partial<GenerationCandidate> = {}): GenerationCandidate {
    return { id, runId: 'run-1', index: Number(id.slice(1)) - 1, attempt: 0, status, outputStem: `gen-aaaaaa-bbbbbb-${id.slice(1)}`, ...extra };
  }
  function resumeBoard(): BoardDocument {
    return doc([
      stamped({
        id: 'n_out',
        kind: 'image',
        x: 0,
        y: 0,
        w: 320,
        h: 320,
        ref: null,
        generation: {
          candidates: [
            candidate('c1', 'running', { taskId: 't1' }),
            candidate('c2', 'queued', { taskId: 't2' }),
            candidate('c3', 'pending'),
            candidate('c4', 'stopped', { taskId: 't4' }),
          ],
          request: {
            surface: 'image',
            model: 'vela/gpt-image-2',
            modelBase: 'vela/gpt-image-2',
            provider: 'vela',
            prompt: 'x',
            promptSource: 'x',
            references: [],
            generatorId: 'n_gen',
            runId: 'run-1',
            createdAt: 1,
          },
        },
      }),
    ]);
  }

  it('re-attaches running tasks, recovers finished files by stem, marks the rest lost, leaves stopped alone', async () => {
    const daemon = fakeDaemon({
      tasks: () => [{ taskId: 't1', status: 'running', startedAt: 10, endedAt: null, elapsed: 1, progress: [], progressCount: 0 }],
      files: () => [{ name: 'gen-aaaaaa-bbbbbb-2.webp', size: 99, mtime: 777, kind: 'image', mime: 'image/webp' }],
      wait: (_taskId, call) => hold(call.signal),
    });
    const { store, service } = setup({ board: resumeBoard(), daemon });
    const result = await service.resume();
    expect(result).toEqual({ watched: 1, recovered: 1, lost: 1 });
    const candidates = outputNode(store, 'n_out').generation.candidates;
    expect(candidates.map((entry) => entry.status)).toEqual(['running', 'done', 'lost', 'stopped']);
    expect(candidates[1]!.file).toMatchObject({ path: 'gen-aaaaaa-bbbbbb-2.webp', size: 99 });
    expect(outputNode(store, 'n_out').generation.primaryCandidateId).toBe('c2');
    await vi.waitFor(() => expect(daemon.calls.filter((call) => call.url === '/api/media/tasks/t1/wait')).toHaveLength(1));
    // A second resume (StrictMode remount) does not watch twice.
    await service.resume();
    expect(service.activeWatchCount()).toBe(1);
    service.dispose();
  });

  it('aborts the watches of a node removed from the board', async () => {
    const daemon = fakeDaemon({ wait: (_taskId, call) => hold(call.signal) });
    const { store, service } = setup({ daemon });
    const outcome = await service.run('n_gen', VELA);
    if (!outcome.started) throw new Error('not started');
    await vi.waitFor(() => expect(service.activeWatchCount()).toBe(2));
    const waits = daemon.calls.filter((call) => call.url.endsWith('/wait'));
    store.set({ ...store.current(), nodes: store.current().nodes.filter((node) => node.id !== outcome.outputNodeId) });
    expect(waits.every((call) => call.signal?.aborted)).toBe(true);
    expect(service.activeWatchCount()).toBe(0);
  });
});

describe('prepareReferenceImages', () => {
  it('converts a reference the daemon cannot read into a project proxy and records it on the node', async () => {
    const board = doc(
      [
        stamped({ id: 'n_svg', kind: 'image', x: 0, y: 0, w: 320, h: 320, ref: { path: 'refs/logo.svg' } }),
        stamped({
          id: 'n_gen',
          kind: 'generator',
          x: 400,
          y: 0,
          w: 320,
          h: 272,
          version: 1,
          surface: 'image',
          prompt: 'logo',
          model: null,
          params: { aspect: '1:1', count: 1 },
          runs: [],
        }),
      ],
      [edge('e1', 'n_svg', 'n_gen', 1)],
    );
    const store = memoryStore(board);
    const port = createGenerationBoardPort(store);
    let uploadedName: unknown;
    const daemon = fakeDaemon({
      raw: () => new Response(new Blob(['<svg/>'], { type: 'image/svg+xml' }), { status: 200 }),
      upload: (form) => {
        uploadedName = form.get('name');
        return json(200, { file: { name: String(form.get('name')), size: 1234, mtime: 9, kind: 'image', mime: 'image/png' } });
      },
    });
    const failed = vi.fn();
    const prepared = await prepareReferenceImages({
      graph: port.getGraph(),
      generatorId: 'n_gen',
      deps: { projectId: 'p1', workspaceContext: null, fetch: daemon.fetch },
      board: port,
      locale: 'en',
      onPrepareFailed: failed,
      convert: async () => ({ blob: new Blob(['png'], { type: 'image/png' }), ext: 'png', width: 512, height: 512 }),
    });
    expect(failed).not.toHaveBeenCalled();
    expect(uploadedName).toMatch(/^board-media\/refs\/ref-[0-9a-z]{6}\.png$/);
    expect(prepared.nodes.find((node) => node.id === 'n_svg')?.image).toMatchObject({ path: uploadedName, daemonReady: true });
    const node = store.current().nodes.find((entry) => entry.id === 'n_svg') as unknown as { refProxy: { path: string; sourceKey: string } };
    expect(node.refProxy).toEqual({ path: uploadedName, sourceKey: 'refs/logo.svg@0' });
    // The port now reads the proxy as the node's reference picture.
    expect(port.getNode('n_svg')?.image).toEqual({ path: uploadedName, daemonReady: true });
  });

  it('reports a reference that cannot be converted and leaves it not ready', async () => {
    const board = doc(
      [
        stamped({ id: 'n_svg', kind: 'image', x: 0, y: 0, w: 320, h: 320, ref: { path: 'refs/logo.svg' } }),
        stamped({ id: 'n_gen', kind: 'generator', x: 400, y: 0, w: 320, h: 272, version: 1, surface: 'image', prompt: 'logo', model: null, params: { aspect: '1:1', count: 1 }, runs: [] }),
      ],
      [edge('e1', 'n_svg', 'n_gen', 1)],
    );
    const port = createGenerationBoardPort(memoryStore(board));
    const failed = vi.fn();
    const graph = port.getGraph();
    const prepared = await prepareReferenceImages({
      graph,
      generatorId: 'n_gen',
      deps: { projectId: 'p1', workspaceContext: null, fetch: fakeDaemon().fetch },
      board: port,
      locale: 'en',
      onPrepareFailed: failed,
      convert: async () => ({ blob: new Blob(['png']), ext: 'png', width: 1, height: 1 }),
    });
    expect(failed).toHaveBeenCalledWith('n_svg');
    expect(prepared).toBe(graph);
  });
});
