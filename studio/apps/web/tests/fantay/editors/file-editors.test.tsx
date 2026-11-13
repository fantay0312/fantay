// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectFile, WorkspaceContextItem } from '@open-design/contracts';

import { getEditorContext, resetEditorContextsForTests } from '../../../src/fantay/editors/editor-context-store';
import {
  FANTAY_FILE_EDITORS,
  registerEditorFlush,
  renderFantayFileEditor,
  renderFileEditorFrom,
  resetEditorFlushesForTests,
  useRetainedFantayEditors,
  type FantayFileEditor,
  type FantayFileEditorContext,
} from '../../../src/fantay/editors/file-editors';

function projectFile(name: string): ProjectFile {
  return { name, size: 1, mtime: 1, kind: 'text', mime: 'application/json' };
}

function context(name: string, overrides: Partial<FantayFileEditorContext> = {}): FantayFileEditorContext {
  return { projectId: 'p1', file: projectFile(name), active: true, runInFlight: false, viewerOnly: false, ...overrides };
}

const SELECTION: WorkspaceContextItem = { id: 'design:frame-1', kind: 'file', label: 'Frame 1', path: 'designs/home.fig' };

describe('fantay file editor registry', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    resetEditorContextsForTests();
    resetEditorFlushesForTests();
  });

  it('registers the motion and design editors (R10) while non-matching files fall back to FileViewer', () => {
    expect(FANTAY_FILE_EDITORS.map((editor) => editor.id)).toEqual(['motion', 'design']);
    expect(renderFantayFileEditor(context('movie-studio.json'))).not.toBeNull();
    expect(renderFantayFileEditor(context('designs/home.fig'))).not.toBeNull();
    expect(renderFantayFileEditor(context('designs/home.op'))).not.toBeNull();
    expect(renderFantayFileEditor(context('index.html'))).toBeNull();
  });

  it('renders the first matching editor with the FileWorkspace context', () => {
    const motion: FantayFileEditor = {
      id: 'motion',
      matches: (file) => file.name === 'movie-studio.json',
      render: (ctx) => <div data-testid="motion-editor">{`${ctx.projectId}:${ctx.file.name}:${String(ctx.active)}`}</div>,
    };
    const fallbackJson: FantayFileEditor = {
      id: 'json',
      matches: (file) => file.name.endsWith('.json'),
      render: () => <div data-testid="json-editor" />,
    };

    render(<>{renderFileEditorFrom([motion, fallbackJson], context('movie-studio.json', { active: false }))}</>);
    expect(screen.getByTestId('motion-editor').textContent).toBe('p1:movie-studio.json:false');
    expect(screen.queryByTestId('json-editor')).toBeNull();
    expect(renderFileEditorFrom([motion], context('index.html'))).toBeNull();
  });

  it('records the editor selection as chat context and forwards it to the caller (C2)', () => {
    const forward = vi.fn();
    const captured: { ctx: FantayFileEditorContext | null } = { ctx: null };
    const design: FantayFileEditor = {
      id: 'design',
      matches: (file) => file.name.endsWith('.fig'),
      render: (ctx) => {
        captured.ctx = ctx;
        return null;
      },
    };

    renderFileEditorFrom([design], context('designs/home.fig', { onActiveContextChange: forward }));
    const received = captured.ctx;
    expect(received).not.toBeNull();
    received?.onActiveContextChange?.(SELECTION);
    expect(getEditorContext('p1', 'designs/home.fig')).toBe(SELECTION);
    expect(forward).toHaveBeenCalledWith(SELECTION);

    received?.onActiveContextChange?.(null);
    expect(getEditorContext('p1', 'designs/home.fig')).toBeNull();
    expect(forward).toHaveBeenLastCalledWith(null);
  });

  it('gives editors a context callback even when FileWorkspace passes none, with a stable identity', () => {
    const seen: Array<FantayFileEditorContext['onActiveContextChange']> = [];
    const design: FantayFileEditor = {
      id: 'design',
      matches: () => true,
      render: (ctx) => {
        seen.push(ctx.onActiveContextChange);
        return null;
      },
    };

    renderFileEditorFrom([design], context('designs/home.fig'));
    renderFileEditorFrom([design], context('designs/home.fig'));
    expect(seen[0]).toBeTypeOf('function');
    expect(seen[1]).toBe(seen[0]);

    seen[0]?.(SELECTION);
    expect(getEditorContext('p1', 'designs/home.fig')).toBe(SELECTION);

    renderFileEditorFrom([design], context('designs/home.fig', { projectId: 'p2' }));
    expect(seen[2]).not.toBe(seen[0]);
  });

  it('keeps open .fig/.op editors mounted across tab switches and flushes before unmounting on close (B19)', async () => {
    vi.useFakeTimers();
    const files = [projectFile('designs/home.fig'), projectFile('notes.md')];
    let resolveFlush!: () => void;
    const flushSpy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFlush = resolve;
        }),
    );
    registerEditorFlush('p1', 'designs/home.fig', flushSpy);

    const { result, rerender } = renderHook(
      ({ activeTab, persistedTabs }: { activeTab: string; persistedTabs: string[] }) =>
        useRetainedFantayEditors({
          enabled: true,
          projectId: 'p1',
          activeTab,
          persistedTabs,
          files,
          closeFlushMs: 500,
        }),
      {
        initialProps: {
          activeTab: 'designs/home.fig',
          persistedTabs: ['designs/home.fig', 'notes.md'],
        },
      },
    );

    expect(result.current.map((f) => f.name)).toEqual(['designs/home.fig']);

    // Switch to another non-HTML tab (`notes.md`) and then to `__board__`: `.fig` remains mounted.
    rerender({ activeTab: 'notes.md', persistedTabs: ['designs/home.fig', 'notes.md'] });
    expect(result.current.map((f) => f.name)).toEqual(['designs/home.fig']);

    rerender({ activeTab: '__board__', persistedTabs: ['designs/home.fig', 'notes.md'] });
    expect(result.current.map((f) => f.name)).toEqual(['designs/home.fig']);
    expect(flushSpy).not.toHaveBeenCalled();

    // Closing the `.fig` tab keeps it mounted on the same frame and runs the registered flush handler.
    rerender({ activeTab: 'notes.md', persistedTabs: ['notes.md'] });
    expect(result.current.map((f) => f.name)).toEqual(['designs/home.fig']);
    expect(flushSpy).toHaveBeenCalledWith('close');

    await act(async () => {
      resolveFlush();
      await Promise.resolve();
    });
    expect(result.current).toEqual([]);
  });
});
