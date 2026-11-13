// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@open-design/host', () => ({
  isOpenDesignHostAvailable: () => true,
  pickHostWorkingDir: vi.fn(),
}));

import { pickHostWorkingDir } from '@open-design/host';
import { NewProjectModal } from '../../src/components/NewProjectModal';
import type { DesignSystemSummary, ProjectTemplate } from '../../src/types';

const designSystems: DesignSystemSummary[] = [
  {
    id: 'clay',
    title: 'Clay',
    summary: 'Friendly tactile product UI.',
    category: 'Product',
    swatches: ['#f4efe7', '#25211d'],
  },
];

const templates: ProjectTemplate[] = [
  {
    id: 'tpl-landing',
    name: 'Landing starter',
    files: [{ name: 'index.html', content: '<main></main>' }],
    createdAt: 1,
  },
];

const originalResizeObserver = globalThis.ResizeObserver;

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  vi.mocked(pickHostWorkingDir).mockReset();
});

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = originalResizeObserver;
});

function renderModal(overrides: Partial<Parameters<typeof NewProjectModal>[0]> = {}) {
  const onCreate = vi.fn(() => true);
  const onClose = vi.fn();
  render(
    <NewProjectModal
      open
      designSystems={designSystems}
      defaultDesignSystemId="clay"
      templates={[]}
      onCreate={onCreate}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onCreate: (overrides.onCreate as typeof onCreate | undefined) ?? onCreate, onClose };
}

describe('NewProjectModal (free-form)', () => {
  it('asks for a name and a starting point, never a project type', () => {
    renderModal();
    expect(screen.getByTestId('new-project-panel')).toBeTruthy();
    expect(screen.getByTestId('new-project-name')).toBeTruthy();
    expect(screen.getByTestId('new-project-source-folder')).toBeTruthy();
    expect(screen.getByTestId('create-project')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(document.querySelector('[data-testid^="new-project-tab-"]')).toBeNull();
  });

  it('creates a neutral project on the default router with the default design system', async () => {
    const { onCreate, onClose } = renderModal();
    fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: 'Brand refresh' } });
    fireEvent.click(screen.getByTestId('create-project'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Brand refresh',
      skillId: null,
      designSystemId: 'clay',
      pluginId: 'od-default',
      metadata: { kind: 'other', nameSource: 'user' },
    }));
  });

  it('submits on Enter and marks an empty name as generated', async () => {
    const { onCreate } = renderModal({ defaultDesignSystemId: null });
    fireEvent.keyDown(screen.getByTestId('new-project-name'), { key: 'Enter' });

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      designSystemId: null,
      metadata: expect.objectContaining({ kind: 'other', nameSource: 'generated' }),
    }));
  });

  it('works in the folder picked through the desktop host', async () => {
    vi.mocked(pickHostWorkingDir).mockResolvedValue({ ok: true, baseDir: '/Users/me/site', token: 'grant-1' } as never);
    const { onCreate } = renderModal();

    fireEvent.click(screen.getByTestId('new-project-source-folder-pick'));
    expect((await screen.findByTestId('new-project-source-folder-path')).textContent).toBe('/Users/me/site');
    fireEvent.click(screen.getByTestId('create-project'));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      userWorkingDirToken: 'grant-1',
      metadata: expect.objectContaining({ kind: 'other', userWorkingDir: '/Users/me/site' }),
    }));
  });

  it('opens on the first saved template from the 从模板 entry and creates from it', async () => {
    const { onCreate } = renderModal({ templates, start: 'template' });
    expect(screen.getByTestId('new-project-template').textContent).toContain('Landing starter');
    fireEvent.click(screen.getByTestId('create-project'));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Landing starter',
      pluginId: 'od-default',
      metadata: expect.objectContaining({ kind: 'template', templateId: 'tpl-landing', nameSource: 'generated' }),
    }));
  });

  it('stays open with a waiting state until creation finishes, and keeps a failure visible', async () => {
    let resolveCreate!: (value: boolean) => void;
    const onCreate = vi.fn(() => new Promise<boolean>((resolve) => { resolveCreate = resolve; }));
    const { onClose } = renderModal({ onCreate });

    fireEvent.click(screen.getByTestId('create-project'));
    expect(screen.getByRole('status').textContent).toContain('Creating project…');
    expect(screen.getByTestId('create-project').getAttribute('aria-busy')).toBe('true');

    resolveCreate(false);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
