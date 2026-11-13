// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { FigmaImportModal } from '../../src/components/FigmaImportModal';
import { importProjectFigma } from '../../src/providers/registry';
import { workspaceContextFixture } from '../helpers/workspace-context';

vi.mock('../../src/providers/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/registry')>()),
  importProjectFigma: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('recovers when resolving the destination project fails', async () => {
  const resolveProjectId = vi.fn().mockRejectedValueOnce(new Error('Project creation failed')).mockResolvedValueOnce(null);
  render(<FigmaImportModal onClose={vi.fn()} resolveProjectId={resolveProjectId} onImported={vi.fn()} />);
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['fig'], 'design.fig')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Import & build' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Project creation failed');
  expect(screen.getByRole('button', { name: 'Import & build' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Import & build' }));
  await waitFor(() => expect(resolveProjectId).toHaveBeenCalledTimes(2));
});

it('clears an earlier selection when a capture JSON is dropped into the fig importer', async () => {
  render(<FigmaImportModal onClose={vi.fn()} resolveProjectId={vi.fn()} onImported={vi.fn()} />);
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['fig'], 'design.fig')] } });
  fireEvent.change(input, { target: { files: [new File(['{}'], 'page.od-figma.json')] } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Fantay Figma Import');
  expect(screen.getByRole('button', { name: 'Import & build' })).toBeDisabled();
});

it('keeps a failed URL request open for retry', async () => {
  const onClose = vi.fn();
  render(<FigmaImportModal onClose={onClose} resolveProjectId={vi.fn()} onImported={vi.fn()} onFigmaUrl={async () => { throw new Error('Try again'); }} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Figma URL' }));
  fireEvent.change(screen.getByPlaceholderText('https://figma.com/design/…'), { target: { value: 'https://figma.com/design/abc123/Example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import & build' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Try again');
  expect(onClose).not.toHaveBeenCalled();
});

it('imports into the project with its exact persisted Workspace context', async () => {
  const contextA = workspaceContextFixture({
    workspaceId: 'workspace-a',
    workspaceMemberId: 'member-a',
  });
  const result = {
    snapshotDir: 'figma',
    files: ['figma/DESIGN-context.md'],
    inventory: {
      decoded: true,
      source: 'fig-file' as const,
      nodeCount: 3,
      pageCount: 1,
      frameCount: 1,
      componentCount: 0,
      colors: [],
      fonts: [],
      assetCount: 0,
      hasThumbnail: false,
      warnings: [],
    },
    contextPath: 'figma/DESIGN-context.md',
    suggestedPrompt: 'Build it.',
    label: 'product.fig',
  };
  vi.mocked(importProjectFigma).mockResolvedValue({ ok: true, result });

  render(
    <FigmaImportModal
      onClose={vi.fn()}
      resolveProjectId={async () => 'project-a'}
      workspaceContext={contextA}
      onImported={vi.fn()}
    />,
  );

  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('expected .fig input');
  const file = new File(['fig'], 'product.fig', { type: 'application/octet-stream' });
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: 'Import & build' }));

  await waitFor(() => {
    expect(importProjectFigma).toHaveBeenCalledWith(
      'project-a',
      file,
      undefined,
      contextA,
    );
  });
});
