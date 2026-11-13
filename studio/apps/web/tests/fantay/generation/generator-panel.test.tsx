// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Spec 05 §11: generator panel — disabled reasons, next-step actions (open-settings → Settings ▸ media),
// params popover hides unsupported controls, surface switch re-picks the model; plus the 300 ms prompt
// patch and the panel shortcuts. The generation hooks (W2-gen-core) are mocked.
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GENERATION_SLOT_STATUSES,
  paramSupportFor,
  type CompiledGeneration,
  type GenerationCandidateError,
  type GenerationGraph,
  type GenerationGraphNode,
  type GeneratorNodeData,
  type GeneratorRunState,
} from '@open-design/contracts';

import type { GenerationModelGroup, GenerationModelOption } from '../../../src/fantay/generation/model-catalog';

const state = vi.hoisted(() => ({
  generation: null as unknown as Record<string, unknown>,
  view: null as unknown as Record<string, unknown>,
  groups: [] as unknown[],
  graph: { nodes: [], edges: [] } as unknown,
}));

vi.mock('../../../src/fantay/generation/hooks', () => ({
  useGeneration: () => state.generation,
  useGeneratorView: () => state.view,
  useGenerationCatalog: () => ({ groups: state.groups, loading: false }),
  useBoardGraph: () => state.graph,
  useCandidateProgress: () => undefined,
}));

import { GeneratorPanel, PROMPT_PATCH_DEBOUNCE_MS } from '../../../src/fantay/generation/components/GeneratorPanel';
import { resetGeneratorUiStoreForTests } from '../../../src/fantay/generation/components/generator-ui-store';
import { RunStatus } from '../../../src/fantay/generation/components/RunStatus';

function counts(partial: Partial<Record<(typeof GENERATION_SLOT_STATUSES)[number], number>> = {}): GeneratorRunState['counts'] {
  return Object.fromEntries(GENERATION_SLOT_STATUSES.map((status) => [status, partial[status] ?? 0])) as GeneratorRunState['counts'];
}

function option(id: string, provider: string, caps: string[]): GenerationModelOption {
  return {
    id,
    label: id,
    hint: `${provider} hint`,
    provider,
    providerLabel: provider,
    surface: 'image',
    caps,
    support: paramSupportFor({ id, provider, caps }, 'image'),
    readiness: 'ready',
    isDefault: true,
  };
}

const GPT = option('gpt-image-2', 'openai', ['t2i', 'i2i']);
const FAL = option('fal-ai/flux', 'fal', ['t2i']);

function generatorData(partial: Partial<GeneratorNodeData> = {}): GeneratorNodeData {
  return { version: 1, surface: 'image', prompt: '', model: null, params: { aspect: '1:1', count: 2, quality: 'high' }, runs: [], ...partial };
}

function setup({
  data = generatorData(),
  model = GPT,
  runDisabledReason = null,
  runState = { active: false, outputMissing: false, total: 0, counts: counts() },
}: {
  data?: GeneratorNodeData;
  model?: GenerationModelOption | null;
  runDisabledReason?: string | null;
  runState?: GeneratorRunState;
} = {}) {
  const node: GenerationGraphNode = { id: 'gen1', kind: 'generator', x: 0, y: 0, w: 320, h: 272, generator: data };
  const graph: GenerationGraph = { nodes: [node], edges: [] };
  const board = {
    getGraph: () => graph,
    getNode: (id: string) => graph.nodes.find((entry) => entry.id === id) ?? null,
    apply: vi.fn(),
    subscribe: () => () => undefined,
    onNodesRemoved: () => () => undefined,
    select: vi.fn(),
    focus: vi.fn(),
  };
  const service = {
    run: vi.fn(async () => ({ started: true, runId: 'run1', outputNodeId: 'out1' })),
    stop: vi.fn(),
    retryFailed: vi.fn(async () => undefined),
    retryCandidate: vi.fn(async () => undefined),
    subscribe: () => () => undefined,
    subscribeProgress: () => () => undefined,
    progressOf: () => undefined,
    isPreparing: () => false,
    setPrimary: vi.fn(),
    promote: vi.fn(() => null),
  };
  const onOpenSettings = vi.fn();
  const notify = vi.fn();
  const setLastActiveGenerator = vi.fn();
  state.graph = graph;
  state.groups = [
    { providerId: model?.provider ?? 'openai', label: model?.providerLabel ?? 'OpenAI', readiness: 'ready', options: model ? [model] : [] },
  ] satisfies GenerationModelGroup[];
  state.generation = {
    service,
    projectId: 'p1',
    workspaceContext: null,
    board,
    onOpenSettings,
    notify,
    lastActiveGeneratorId: null,
    setLastActiveGenerator,
    openToolDialog: vi.fn(),
    registerVideoElement: vi.fn(),
    videoElementOf: () => null,
    projectMetadata: null,
    mediaProviders: undefined,
    isImportedFolderProject: false,
    locale: 'en',
    toolDialog: null,
    closeToolDialog: vi.fn(),
  };
  const compiled: CompiledGeneration = { ok: true, prompt: data.prompt, references: [], texts: [], inputs: [], warnings: [] };
  state.view = {
    node,
    data,
    model,
    support: model?.support ?? null,
    compiled,
    runState,
    runDisabledReason,
    preparing: false,
  };
  const onClose = vi.fn();
  render(<GeneratorPanel nodeId="gen1" onClose={onClose} />);
  return { board, service, onOpenSettings, notify, onClose, setLastActiveGenerator };
}

beforeEach(() => {
  resetGeneratorUiStoreForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('GeneratorPanel', () => {
  it('marks itself board-interactive, records the last active generator and focuses the prompt', () => {
    const { setLastActiveGenerator } = setup();
    const panel = screen.getByTestId('fx-gen-panel');
    expect(panel).toHaveAttribute('data-board-interactive');
    expect(setLastActiveGenerator).toHaveBeenCalledWith('gen1');
    expect(document.activeElement).toBe(screen.getByTestId('fx-gen-prompt'));
  });

  it('keeps Run disabled with the reason and never runs', () => {
    const { service } = setup({ runDisabledReason: 'fantay.gen.run.disabledNoPrompt' });
    const run = screen.getByTestId('fx-gen-run');
    expect(run).toHaveAttribute('aria-disabled', 'true');
    expect(run).toHaveAttribute('data-disabled');
    fireEvent.click(run);
    fireEvent.keyDown(screen.getByTestId('fx-gen-prompt'), { key: 'Enter', metaKey: true });
    expect(service.run).not.toHaveBeenCalled();
  });

  it('explains a missing model as the disabled reason', () => {
    const { service } = setup({ model: null });
    expect(screen.getByTestId('fx-gen-run')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByTestId('fx-gen-run'));
    expect(service.run).not.toHaveBeenCalled();
  });

  it('runs with the resolved model, from the button and from ⌘/Ctrl+Enter', async () => {
    const { service } = setup({ data: generatorData({ prompt: 'a red fox' }) });
    const run = screen.getByTestId('fx-gen-run');
    expect(run).toHaveAccessibleName('Generate 2');
    await act(async () => {
      fireEvent.click(run);
    });
    expect(service.run).toHaveBeenCalledWith('gen1', GPT);
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('fx-gen-prompt'), { key: 'Enter', ctrlKey: true });
    });
    expect(service.run).toHaveBeenCalledTimes(2);
  });

  it('runs the next-step action: open-settings → Settings ▸ media, sign-in → execution', () => {
    const error: GenerationCandidateError = { message: 'missing key', nextStep: 'open-settings', code: 'MEDIA_KEY_MISSING' };
    const { onOpenSettings } = setup({
      runState: { active: false, outputMissing: false, total: 2, counts: counts({ failed: 2 }), firstError: error, runId: 'r', outputNodeId: 'o' },
    });
    const action = screen.getByTestId('fx-gen-error-action');
    expect(action).toHaveAttribute('data-next-step', 'open-settings');
    expect(action).toHaveTextContent('Open media settings');
    fireEvent.click(action);
    expect(onOpenSettings).toHaveBeenCalledWith('media');
    cleanup();

    const signIn = setup({
      runState: {
        active: false,
        outputMissing: false,
        total: 1,
        counts: counts({ failed: 1 }),
        firstError: { message: 'session', nextStep: 'sign-in' },
      },
    });
    fireEvent.click(screen.getByTestId('fx-gen-error-action'));
    expect(signIn.onOpenSettings).toHaveBeenCalledWith('execution');
  });

  it('switch-model opens the model picker', () => {
    setup({
      runState: { active: false, outputMissing: false, total: 1, counts: counts({ failed: 1 }), firstError: { message: 'denied', nextStep: 'switch-model' } },
    });
    fireEvent.click(screen.getByTestId('fx-gen-error-action'));
    expect(screen.getByTestId('fx-gen-model-popover')).toBeInTheDocument();
    expect(screen.getByTestId(`fx-gen-model-option-${GPT.id}`)).toBeInTheDocument();
  });

  it('shows only the supported parameters', () => {
    setup({ model: FAL, data: generatorData({ params: { aspect: '1:1', count: 1 } }) });
    fireEvent.click(screen.getByTestId('fx-gen-params-trigger'));
    const popover = screen.getByTestId('fx-gen-params-popover');
    expect(within(popover).queryByTestId('fx-gen-param-quality')).toBeNull();
    expect(within(popover).queryByTestId('fx-gen-param-resolution')).toBeNull();
    expect(within(popover).queryByTestId('fx-gen-param-duration')).toBeNull();
    expect(within(popover).getByTestId('fx-gen-param-count')).toBeInTheDocument();
    cleanup();

    setup({ model: GPT });
    fireEvent.click(screen.getByTestId('fx-gen-params-trigger'));
    expect(within(screen.getByTestId('fx-gen-params-popover')).getByTestId('fx-gen-param-quality')).toBeInTheDocument();
  });

  it('writes parameter changes as undoable patches', () => {
    const { board } = setup();
    fireEvent.click(screen.getByTestId('fx-gen-params-trigger'));
    fireEvent.click(screen.getByTestId('fx-gen-param-aspect-16:9'));
    expect(board.apply).toHaveBeenLastCalledWith(
      [
        { type: 'node.patchData', id: 'gen1', patch: { params: { aspect: '16:9', count: 2, quality: 'high' } } },
        { type: 'node.setFrame', id: 'gen1', x: 0, y: 0, w: 320, h: 180 },
      ],
      expect.objectContaining({ undoable: true }),
    );
    fireEvent.click(screen.getByTestId('fx-gen-param-count-4'));
    expect(board.apply).toHaveBeenLastCalledWith(
      [{ type: 'node.patchData', id: 'gen1', patch: { params: expect.objectContaining({ count: 4 }) } }],
      expect.objectContaining({ undoable: true }),
    );
  });

  it('switching the surface keeps the prompt, re-picks the model and clamps the params', () => {
    const { board } = setup({ data: generatorData({ prompt: 'keep me', model: 'gpt-image-2' }) });
    fireEvent.click(screen.getByTestId('fx-gen-surface-video'));
    expect(board.apply).toHaveBeenCalledWith(
      [
        { type: 'node.patchData', id: 'gen1', patch: { surface: 'video', model: null, params: { aspect: '1:1', count: 2, length: 5 } } },
        { type: 'node.setFrame', id: 'gen1', x: -32, y: 0, w: 384, h: 384 },
      ],
      expect.objectContaining({ undoable: true, flush: true }),
    );
    const patch = board.apply.mock.calls.at(-1)?.[0]?.[0]?.patch as Record<string, unknown>;
    expect(patch).not.toHaveProperty('prompt');
  });

  it('only offers image and video (no audio generator, amendment C8)', () => {
    setup();
    const surface = screen.getByTestId('fx-gen-surface');
    expect(within(surface).getAllByRole('radio').map((item) => item.getAttribute('aria-label'))).toEqual(['Image', 'Video']);
  });

  it('writes prompt edits after 300 ms as one coalesced undo step, and flushes before a run', async () => {
    vi.useFakeTimers();
    const { board, service } = setup({ data: generatorData({ prompt: '' }) });
    const editor = screen.getByTestId('fx-gen-prompt');
    act(() => {
      editor.textContent = 'a cat';
      fireEvent.input(editor);
    });
    expect(board.apply).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(PROMPT_PATCH_DEBOUNCE_MS - 1);
    });
    expect(board.apply).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(board.apply).toHaveBeenCalledWith(
      [{ type: 'node.patchData', id: 'gen1', patch: { prompt: 'a cat' } }],
      { label: 'generation.prompt', undoable: true, flush: false, coalesceKey: 'prompt:gen1' },
    );

    act(() => {
      editor.textContent = 'a cat in snow';
      fireEvent.input(editor);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('fx-gen-run'));
    });
    const promptWrite = board.apply.mock.invocationCallOrder.at(-1) ?? 0;
    expect(board.apply).toHaveBeenLastCalledWith(
      [{ type: 'node.patchData', id: 'gen1', patch: { prompt: 'a cat in snow' } }],
      expect.objectContaining({ coalesceKey: 'prompt:gen1' }),
    );
    expect(service.run.mock.invocationCallOrder[0] ?? 0).toBeGreaterThan(promptWrite);
  });

  it('announces the run politely but keeps the per-second elapsed timer out of the announcements', () => {
    vi.useFakeTimers();
    const startedAt = Date.parse('2026-10-29T08:00:00Z');
    vi.setSystemTime(startedAt + 30_000);
    const generator: GenerationGraphNode = {
      id: 'gen1',
      kind: 'generator',
      x: 0,
      y: 0,
      w: 320,
      h: 272,
      generator: generatorData({ runs: [{ runId: 'r1', outputNodeId: 'out1', surface: 'image', model: 'gpt-image-2', count: 2, startedAt }] }),
    };
    const output: GenerationGraphNode = {
      id: 'out1',
      kind: 'image',
      x: 400,
      y: 0,
      w: 320,
      h: 320,
      media: {
        generation: {
          candidates: [
            { id: 'c1', runId: 'r1', index: 0, attempt: 0, status: 'running', outputStem: 'gen-a-b-1', startedAt },
            { id: 'c2', runId: 'r1', index: 1, attempt: 0, status: 'done', outputStem: 'gen-a-b-2', file: { path: 'gen-a-b-2.png' } },
          ],
          request: {
            surface: 'image',
            model: 'gpt-image-2',
            modelBase: 'gpt-image-2',
            provider: 'openai',
            prompt: 'fox',
            promptSource: 'fox',
            references: [],
            generatorId: 'gen1',
            runId: 'r1',
            createdAt: startedAt,
          },
        },
      },
    };
    state.graph = { nodes: [generator, output], edges: [] } satisfies GenerationGraph;
    state.generation = {
      service: { subscribeProgress: () => () => undefined, progressOf: () => undefined, isPreparing: () => false, retryFailed: vi.fn() },
    };
    render(<RunStatus generatorId="gen1" />);
    const status = screen.getByTestId('fx-gen-run-status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('1/2');
    const timer = within(status).getByRole('timer');
    expect(timer).toHaveAttribute('aria-live', 'off');
    expect(timer).toHaveTextContent('0:30');
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(timer).toHaveTextContent('0:31');
  });

  it('closes on Escape from the panel and leaves keys of portaled popovers alone', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByTestId('fx-gen-params-trigger'));
    fireEvent.keyDown(screen.getByTestId('fx-gen-param-count-1'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId('fx-gen-prompt'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
