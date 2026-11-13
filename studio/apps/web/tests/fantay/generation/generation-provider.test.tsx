// @vitest-environment jsdom
// GenerationProvider + hooks (spec 05 §4.11): the generator view resolves the model that will run and the Run
// disabled reason, resume() runs once the board is ready (also under StrictMode remounts), run failures become
// toasts through the host's notify, and every external store has a server snapshot (amendment B2).
import { StrictMode, createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyBoardOps,
  type BoardDocument,
  type BoardEdge,
  type BoardNode,
} from '@open-design/contracts';

import { createGenerationBoardPort, type BoardStoreLike } from '../../../src/fantay/generation/board-adapter';
import { GenerationProvider, type GenerationProviderProps } from '../../../src/fantay/generation/GenerationProvider';
import type { GenerationService } from '../../../src/fantay/generation/generation-service';
import { useGeneration, useGeneratorView } from '../../../src/fantay/generation/hooks';
import type { MediaProviderCredentials } from '../../../src/types';

const actor = { kind: 'user' as const };
function stamped(node: Record<string, unknown>): BoardNode {
  return { createdAt: 1, updatedAt: 1, createdBy: actor, updatedBy: actor, rev: 1, ...node } as unknown as BoardNode;
}
function board(nodes: BoardNode[], edges: BoardEdge[] = []): BoardDocument {
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

function memoryStore(initial: BoardDocument): BoardStoreLike {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => ({ board: current }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async apply(ops) {
      const outcome = applyBoardOps({ settings: current.settings, nodes: current.nodes, edges: current.edges }, ops, {
        baseRevision: current.revision,
        nextRevision: current.revision + 1,
        actor,
        now: 50,
        newId: (prefix) => `${prefix}_x`,
        checkConflicts: false,
      });
      if (!outcome.ok) throw new Error('invalid ops');
      current = { ...current, ...outcome.content };
      for (const listener of [...listeners]) listener();
      return { ok: true };
    },
  };
}

const generator = stamped({
  id: 'n_gen',
  kind: 'generator',
  x: 0,
  y: 0,
  w: 320,
  h: 272,
  version: 1,
  surface: 'image',
  prompt: 'a lighthouse at dusk',
  model: 'gpt-image-2',
  params: { aspect: '1:1', count: 1 },
  runs: [],
});

const OPENAI: Record<string, MediaProviderCredentials> = { openai: { apiKey: 'sk-test' } as MediaProviderCredentials };

function ViewProbe() {
  const view = useGeneratorView('n_gen');
  return createElement('output', { 'data-testid': 'view' }, `${view.model?.id ?? 'none'}|${view.runDisabledReason ?? 'ok'}|${view.compiled?.prompt ?? ''}`);
}

let captured: GenerationService | null = null;
function ServiceProbe() {
  captured = useGeneration().service;
  return null;
}

function providerProps(overrides: Partial<GenerationProviderProps> & { children: ReactNode }): GenerationProviderProps {
  return {
    projectId: 'p1',
    projectMetadata: null,
    mediaProviders: OPENAI,
    workspaceContext: null,
    board: createGenerationBoardPort(memoryStore(board([generator]))),
    boardReady: true,
    onOpenSettings: vi.fn(),
    notify: vi.fn(),
    ...overrides,
  };
}

let fetchCalls: string[] = [];
beforeEach(() => {
  fetchCalls = [];
  captured = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.startsWith('/api/media/providers/aihubmix/models')) return new Response(JSON.stringify({ models: [] }), { status: 200 });
      if (url === '/api/projects/p1/media/tasks?includeDone=1') return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      return new Response('{}', { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GenerationProvider', () => {
  it('resolves the model that will run and allows Run', () => {
    render(createElement(GenerationProvider, providerProps({ children: createElement(ViewProbe) })));
    expect(screen.getByTestId('view').textContent).toBe('gpt-image-2|ok|a lighthouse at dusk');
  });

  it('explains why Run is disabled (imported folder, no ready model)', () => {
    const { unmount } = render(
      createElement(
        GenerationProvider,
        providerProps({ projectMetadata: { baseDir: '/x' } as GenerationProviderProps['projectMetadata'], children: createElement(ViewProbe) }),
      ),
    );
    expect(screen.getByTestId('view').textContent).toBe('gpt-image-2|fantay.gen.run.disabledImported|a lighthouse at dusk');
    unmount();
    const nothingReady = {
      ...board([{ ...generator, model: null } as BoardNode]),
    };
    render(
      createElement(
        GenerationProvider,
        providerProps({
          mediaProviders: {},
          board: createGenerationBoardPort(memoryStore(nothingReady)),
          children: createElement(ViewProbe),
        }),
      ),
    );
    expect(screen.getByTestId('view').textContent).toBe('none|fantay.gen.run.disabledNoModel|a lighthouse at dusk');
  });

  it('resumes once the board is ready, and keeps exactly one watch across a StrictMode remount', async () => {
    const output = stamped({
      id: 'n_out',
      kind: 'image',
      x: 400,
      y: 0,
      w: 320,
      h: 320,
      ref: null,
      generation: {
        candidates: [{ id: 'c1', runId: 'run-1', index: 0, attempt: 0, status: 'running', outputStem: 'gen-aaaaaa-bbbbbb-1', taskId: 't1' }],
        request: {
          surface: 'image', model: 'gpt-image-2', modelBase: 'gpt-image-2', provider: 'openai', prompt: 'x', promptSource: 'x',
          references: [], generatorId: 'n_gen', runId: 'run-1', createdAt: 1,
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push(url);
        if (url === '/api/projects/p1/media/tasks?includeDone=1') {
          return Promise.resolve(
            new Response(JSON.stringify({ tasks: [{ taskId: 't1', status: 'running', startedAt: 1, endedAt: null, elapsed: 1, progress: [], progressCount: 0 }] })),
          );
        }
        if (url === '/api/media/tasks/t1/wait') {
          // An open long-poll until the watch is aborted.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
          });
        }
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    );
    const props = providerProps({
      boardReady: false,
      board: createGenerationBoardPort(memoryStore(board([generator, output]))),
      children: createElement(ServiceProbe),
    });
    const { rerender } = render(createElement(StrictMode, null, createElement(GenerationProvider, props)));
    expect(fetchCalls.filter((url) => url.includes('/media/tasks'))).toHaveLength(0);
    await act(async () => {
      rerender(createElement(StrictMode, null, createElement(GenerationProvider, { ...props, boardReady: true })));
    });
    await vi.waitFor(() => expect(captured?.activeWatchCount()).toBe(1));
    expect(captured!.isDisposed()).toBe(false);
  });

  it('turns failed runs into one toast through the host notify', async () => {
    const notify = vi.fn();
    render(createElement(GenerationProvider, providerProps({ notify, children: createElement(ServiceProbe) })));
    const service = captured!;
    const emit = (service as unknown as { emit(event: unknown): void }).emit.bind(service);
    act(() => {
      emit({ type: 'run-finished', generatorId: 'n_gen', runId: 'r1', done: 1, failed: 1, total: 2 });
      emit({ type: 'run-finished', generatorId: 'n_gen', runId: 'r2', done: 0, failed: 2, total: 2 });
      emit({ type: 'run-finished', generatorId: 'n_gen', runId: 'r3', done: 2, failed: 0, total: 2 });
    });
    expect(notify.mock.calls.map(([n]) => n)).toEqual([
      { tone: 'error', message: '1 failed, 1 done' },
      { tone: 'error', message: 'All failed' },
    ]);
  });

  it('server-renders without touching browser stores (B2)', () => {
    const html = renderToString(createElement(GenerationProvider, providerProps({ children: createElement(ViewProbe) })));
    expect(html).toContain('gpt-image-2|ok');
  });
});
