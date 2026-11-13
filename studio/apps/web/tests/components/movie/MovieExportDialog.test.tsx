// @vitest-environment jsdom
import '../../fantay/helpers/radix-jsdom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createMovieDocument } from '@open-design/contracts';
import { getHostMovieExport } from '@open-design/host';
import { I18nProvider } from '../../../src/i18n';
import { MovieExportDialog } from '../../../src/components/movie/MovieExportDialog';
vi.mock('@open-design/host', async original => ({ ...await original<typeof import('@open-design/host')>(), getHostMovieExport: vi.fn() }));
vi.mock('../../../src/fantay/motion/MoviePreviewFrame', () => ({ MoviePreviewFrame: () => <div>Video preview</div> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  const host = { chooseDestination: vi.fn(async () => ({ ok: true as const, id: 'destination', path: '/Movies/中文影片.mp4' })), save: vi.fn(async () => ({ ok: true as const, id: 'destination', path: '/Movies/中文影片.mp4' })), open: vi.fn(async () => ({ ok: true as const })) };
  vi.mocked(getHostMovieExport).mockReturnValue(host);
  const onExport = vi.fn(async () => ({ id: 'render-1', status: 'running' as const, contentRevision: 1, createdAt: '', sourcePath: '' }));
  const film = createMovieDocument('中文影片');
  const view = render(<I18nProvider initial="zh-CN"><MovieExportDialog open onClose={vi.fn()} document={film} projectId="project-1" onExport={onExport} /></I18nProvider>);
  return { host, onExport, film, view, dialog: screen.getByRole('dialog') };
}
it('opens settings before rendering and saves directly with no download step', async () => {
  const { host, onExport, dialog } = setup();
  expect(screen.getByLabelText('文件名')).toHaveValue('中文影片'); expect(onExport).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: /下载/ })).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: '导出' }));
  await waitFor(() => expect(host.save).toHaveBeenCalledWith({ destinationId: 'destination', projectId: 'project-1', renderId: 'render-1', workspaceContext: undefined }));
  expect(onExport).toHaveBeenCalledWith({ format: 'mp4', width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 } });
  expect(await screen.findByText('导出完成 · 100%')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '在文件夹中显示' }));
  expect(host.open).toHaveBeenCalledWith({ destinationId: 'destination', reveal: true });
});
it('does not render when the native location picker is cancelled', async () => {
  const { host, onExport, dialog } = setup();
  host.chooseDestination.mockResolvedValueOnce({ ok: false, cancelled: true, reason: '' } as never);
  fireEvent.click(within(dialog).getByRole('button', { name: '导出' }));
  await waitFor(() => expect(host.chooseDestination).toHaveBeenCalled());
  expect(onExport).not.toHaveBeenCalled(); expect(host.save).not.toHaveBeenCalled();
});
it('passes the chosen format, resolution and frame rate to the render', async () => {
  const { host, onExport, dialog } = setup();
  for (const [label, option] of [['导出格式', 'MOV'], ['导出分辨率', '720P'], ['导出帧率', '24 fps']]) {
    fireEvent.keyDown(screen.getByRole('combobox', { name: label }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: option }));
  }
  fireEvent.click(within(dialog).getByRole('button', { name: '导出' }));
  await waitFor(() => expect(onExport).toHaveBeenCalledWith({ format: 'mov', width: 1280, height: 720, frameRate: { numerator: 24, denominator: 1 } }));
  expect(host.chooseDestination).toHaveBeenCalledWith({ filename: '中文影片', format: 'mov' });
});
it('keeps save errors visible and allows a new attempt', async () => {
  const { host, dialog } = setup(); host.save.mockResolvedValueOnce({ ok: false, reason: 'Disk is full' } as never);
  fireEvent.click(within(dialog).getByRole('button', { name: '导出' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Disk is full');
  expect(within(dialog).getByRole('button', { name: '导出' })).toBeEnabled();
});
it('starts a fresh export after the timeline changes instead of saving an older video', async () => {
  const { host, onExport, film, view, dialog } = setup();
  fireEvent.click(within(dialog).getByRole('button', { name: '导出' }));
  await screen.findByText('导出完成 · 100%');
  view.rerender(<I18nProvider initial="zh-CN"><MovieExportDialog open onClose={vi.fn()} document={{ ...film, contentRevision: film.contentRevision + 1 }} projectId="project-1" onExport={onExport} /></I18nProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '导出' }));
  await waitFor(() => expect(onExport).toHaveBeenCalledTimes(2));
  expect(host.chooseDestination).toHaveBeenCalledTimes(2);
});
