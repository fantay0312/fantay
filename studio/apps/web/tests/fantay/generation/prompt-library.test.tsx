// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Spec 05 §11: prompt library — surface filter, search, argument form fill, replace vs append, aspect applied
// by the panel, fetch failure + retry. The registry fetchers and the generation hooks are mocked.
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERATION_SLOT_STATUSES, paramSupportFor, type GeneratorRunState } from '@open-design/contracts';

import type { PromptTemplateDetail, PromptTemplateSummary } from '../../../src/types';

const registry = vi.hoisted(() => ({
  fetchPromptTemplates: vi.fn(),
  fetchPromptTemplate: vi.fn(),
}));

vi.mock('../../../src/providers/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/registry')>()),
  fetchPromptTemplates: registry.fetchPromptTemplates,
  fetchPromptTemplate: registry.fetchPromptTemplate,
}));

const hooks = vi.hoisted(() => ({
  generation: null as unknown as Record<string, unknown>,
  view: null as unknown as Record<string, unknown>,
}));

vi.mock('../../../src/fantay/generation/hooks', () => ({
  useGeneration: () => hooks.generation,
  useGeneratorView: () => hooks.view,
  useGenerationCatalog: () => ({ groups: [], loading: false }),
  useBoardGraph: () => ({ nodes: [], edges: [] }),
  useCandidateProgress: () => undefined,
}));

import { GeneratorPanel } from '../../../src/fantay/generation/components/GeneratorPanel';
import { PromptLibraryPopover } from '../../../src/fantay/generation/components/PromptLibraryPopover';
import { resetPromptTemplatesForTests } from '../../../src/fantay/generation/components/prompt-library-data';

function summary(id: string, surface: 'image' | 'video', title: string, category: string, extra: Partial<PromptTemplateSummary> = {}): PromptTemplateSummary {
  return {
    id,
    surface,
    title,
    summary: `${title} summary`,
    category,
    source: { repo: 'awesome-prompts', license: 'CC-BY-4.0', author: 'Ada' },
    ...extra,
  };
}

const POSTER = summary('poster', 'image', 'Neon poster', 'Poster');
const PORTRAIT = summary('portrait', 'image', 'Studio portrait', 'Photo', { aspect: '16:9' });
const DOLLY = summary('dolly', 'video', 'Dolly zoom', 'Camera');
const TEMPLATES = [POSTER, PORTRAIT, DOLLY];

const DETAILS: Record<string, PromptTemplateDetail> = {
  poster: { ...POSTER, prompt: 'A {argument name="subject" default="cat"} on {argument name="place" default="mars"}' },
  portrait: { ...PORTRAIT, prompt: 'Soft studio light portrait' },
};

function serveTemplates(): void {
  registry.fetchPromptTemplates.mockImplementation(async (options?: { onReadResult?: (ok: boolean) => void }) => {
    options?.onReadResult?.(true);
    return TEMPLATES;
  });
  registry.fetchPromptTemplate.mockImplementation(async (_surface: string, id: string) => DETAILS[id] ?? null);
}

async function openLibrary(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId('fx-gen-library-trigger'));
  const library = await screen.findByTestId('fx-gen-library');
  await waitFor(() => expect(within(library).queryByRole('status')).toBeNull());
  return library;
}

beforeEach(() => {
  resetPromptTemplatesForTests();
  registry.fetchPromptTemplates.mockReset();
  registry.fetchPromptTemplate.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('PromptLibraryPopover', () => {
  it('lists the templates of the surface with their source and licence, and filters by search and category', async () => {
    serveTemplates();
    render(<PromptLibraryPopover surface="image" currentPrompt="" onApply={vi.fn()} />);
    const library = await openLibrary();
    expect(within(library).getByTestId('fx-gen-library-item-poster')).toBeInTheDocument();
    expect(within(library).getByTestId('fx-gen-library-item-portrait')).toBeInTheDocument();
    expect(within(library).queryByTestId('fx-gen-library-item-dolly')).toBeNull();
    expect(within(library).getByTestId('fx-gen-library-item-poster')).toHaveTextContent('Source: awesome-prompts · CC-BY-4.0');
    expect(within(library).getByTestId('fx-gen-library-item-poster')).toHaveTextContent('By Ada');

    fireEvent.change(within(library).getByRole('textbox', { name: 'Search templates' }), { target: { value: 'portrait' } });
    expect(within(library).queryByTestId('fx-gen-library-item-poster')).toBeNull();
    expect(within(library).getByTestId('fx-gen-library-item-portrait')).toBeInTheDocument();

    fireEvent.change(within(library).getByRole('textbox', { name: 'Search templates' }), { target: { value: '' } });
    fireEvent.click(within(library).getByRole('button', { name: 'Poster' }));
    expect(within(library).getByTestId('fx-gen-library-item-poster')).toBeInTheDocument();
    expect(within(library).queryByTestId('fx-gen-library-item-portrait')).toBeNull();

    fireEvent.change(within(library).getByRole('textbox', { name: 'Search templates' }), { target: { value: 'nothing like this' } });
    expect(library).toHaveTextContent('No templates match your search.');
    expect(registry.fetchPromptTemplates).toHaveBeenCalledTimes(1);
  });

  it('fills template arguments before inserting (empty prompt → replace)', async () => {
    serveTemplates();
    const onApply = vi.fn();
    render(<PromptLibraryPopover surface="image" currentPrompt="" onApply={onApply} />);
    const library = await openLibrary();
    await act(async () => {
      fireEvent.click(within(library).getByTestId('fx-gen-library-item-poster'));
    });
    const form = await screen.findByTestId('fx-gen-library-arguments');
    expect(within(form).getByTestId('fx-gen-library-argument-subject')).toHaveValue('cat');
    expect(within(form).getByTestId('fx-gen-library-argument-place')).toHaveValue('mars');
    fireEvent.change(within(form).getByTestId('fx-gen-library-argument-subject'), { target: { value: 'dog' } });
    fireEvent.click(within(form).getByTestId('fx-gen-library-insert'));
    expect(onApply).toHaveBeenCalledWith({ prompt: 'A dog on mars', mode: 'replace', template: POSTER });
    expect(registry.fetchPromptTemplate).toHaveBeenCalledWith('image', 'poster');
  });

  it('asks replace or append when a prompt already exists', async () => {
    serveTemplates();
    const onApply = vi.fn();
    render(<PromptLibraryPopover surface="image" currentPrompt="my own words" onApply={onApply} />);
    let library = await openLibrary();
    await act(async () => {
      fireEvent.click(within(library).getByTestId('fx-gen-library-item-portrait'));
    });
    const confirm = await screen.findByTestId('fx-gen-library-confirm');
    expect(confirm).toHaveTextContent('Replace the current prompt?');
    fireEvent.click(within(confirm).getByTestId('fx-gen-library-append'));
    expect(onApply).toHaveBeenLastCalledWith({ prompt: 'my own words\n\nSoft studio light portrait', mode: 'append', template: PORTRAIT });

    library = await openLibrary();
    await act(async () => {
      fireEvent.click(within(library).getByTestId('fx-gen-library-item-portrait'));
    });
    fireEvent.click(within(await screen.findByTestId('fx-gen-library-confirm')).getByTestId('fx-gen-library-replace'));
    expect(onApply).toHaveBeenLastCalledWith({ prompt: 'Soft studio light portrait', mode: 'replace', template: PORTRAIT });
  });

  it('shows the fetch error with a retry that loads again', async () => {
    registry.fetchPromptTemplates.mockImplementationOnce(async (options?: { onReadResult?: (ok: boolean) => void }) => {
      options?.onReadResult?.(false);
      return [];
    });
    render(<PromptLibraryPopover surface="image" currentPrompt="" onApply={vi.fn()} />);
    fireEvent.click(screen.getByTestId('fx-gen-library-trigger'));
    const error = await screen.findByTestId('fx-gen-library-error');
    expect(error).toHaveTextContent('Could not load this template body.');
    serveTemplates();
    await act(async () => {
      fireEvent.click(within(error).getByRole('button', { name: 'Retry' }));
    });
    expect(await screen.findByTestId('fx-gen-library-item-poster')).toBeInTheDocument();
    expect(registry.fetchPromptTemplates).toHaveBeenCalledTimes(2);
  });
});

describe('GeneratorPanel template side effects', () => {
  function setupPanel() {
    const counts = Object.fromEntries(GENERATION_SLOT_STATUSES.map((status) => [status, 0])) as GeneratorRunState['counts'];
    const data = { version: 1 as const, surface: 'image' as const, prompt: '', model: null, params: { aspect: '1:1' as const, count: 1 as const }, runs: [] };
    const board = {
      getGraph: () => ({ nodes: [], edges: [] }),
      getNode: () => null,
      apply: vi.fn(),
      subscribe: () => () => undefined,
      onNodesRemoved: () => () => undefined,
      select: vi.fn(),
      focus: vi.fn(),
    };
    const notify = vi.fn();
    const support = paramSupportFor({ id: 'fal-ai/flux', provider: 'fal', caps: ['t2i'] }, 'image');
    hooks.generation = {
      service: {
        run: vi.fn(),
        stop: vi.fn(),
        retryFailed: vi.fn(),
        subscribe: () => () => undefined,
        subscribeProgress: () => () => undefined,
        progressOf: () => undefined,
        isPreparing: () => false,
      },
      projectId: 'p1',
      workspaceContext: null,
      board,
      onOpenSettings: vi.fn(),
      notify,
      lastActiveGeneratorId: null,
      setLastActiveGenerator: vi.fn(),
      openToolDialog: vi.fn(),
      registerVideoElement: vi.fn(),
      videoElementOf: () => null,
    };
    hooks.view = {
      node: { id: 'gen1', kind: 'generator', x: 0, y: 0, w: 320, h: 272, generator: data },
      data,
      model: null,
      support,
      compiled: { ok: false, blockReason: 'empty-prompt', prompt: '', references: [], texts: [], inputs: [], warnings: [] },
      runState: { active: false, outputMissing: false, total: 0, counts },
      runDisabledReason: 'fantay.gen.run.disabledNoPrompt',
      preparing: false,
    };
    render(<GeneratorPanel nodeId="gen1" onClose={vi.fn()} />);
    return { board, notify };
  }

  it('stores the template id and applies a supported template aspect with a toast', async () => {
    serveTemplates();
    const { board, notify } = setupPanel();
    const library = await openLibrary();
    await act(async () => {
      fireEvent.click(within(library).getByTestId('fx-gen-library-item-portrait'));
    });
    await waitFor(() => expect(board.apply).toHaveBeenCalled());
    expect(board.apply).toHaveBeenLastCalledWith(
      [
        {
          type: 'node.patchData',
          id: 'gen1',
          patch: { prompt: 'Soft studio light portrait', templateId: 'portrait', params: { aspect: '16:9', count: 1 } },
        },
        // The frame previews the output, so the new aspect reshapes it (top edge and centre kept).
        { type: 'node.setFrame', id: 'gen1', x: 0, y: 0, w: 320, h: 180 },
      ],
      expect.objectContaining({ undoable: true }),
    );
    expect(notify).toHaveBeenCalledWith({ tone: 'info', message: 'Aspect set to 16:9 from the template' });
    expect(screen.getByTestId('fx-gen-prompt')).toHaveTextContent('Soft studio light portrait');
  });
});
