// @vitest-environment jsdom
import '../../fantay/helpers/radix-jsdom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createMovieDocument } from '@open-design/contracts';
import { MovieTimeline } from '../../../src/components/movie/MovieTimeline';
import { I18nProvider } from '../../../src/i18n';

vi.mock('../../../src/providers/movie', () => ({ getMovieVideoSources: vi.fn(async () => [{
  assetId: 'source', path: 'clip.mp4', label: 'Source video', duration: 45, width: 64, height: 64, fps: 30, hasAudio: false, frames: [],
}]) }));
afterEach(cleanup);
function setup(disabled = false) {
  const d = createMovieDocument('Cuts', 'blank');
  d.shots = [{ id: 'one', title: 'One', duration: 4, body: '', layout: 'split', clip: { assetId: 'source', in: 1, rate: 2, volume: 1, fit: 'contain' } }];
  const onEdit = vi.fn(async () => true), onAi = vi.fn(async () => true), onGenerate = vi.fn(), onSeek = vi.fn();
  render(<I18nProvider initial="zh-CN"><MovieTimeline document={d} projectId="cuts" time={1} selectedShotId="one" disabled={disabled}
    onEdit={onEdit} onAi={onAi} onGenerate={onGenerate} onImport={vi.fn()} onSeek={onSeek} onSelect={vi.fn()} /></I18nProvider>);
  return { onEdit, onAi, onGenerate, onSeek };
}
it('sends exact playhead cuts and trim ranges to the atomic edit endpoint', () => {
  const { onEdit } = setup();
  fireEvent.click(screen.getByRole('button', { name: '在播放头切分' }));
  expect(onEdit).toHaveBeenLastCalledWith('在播放头切分', [{ op: 'split-clip', shotId: 'one', at: 1 }]);
  fireEvent.click(screen.getByRole('button', { name: '从这里开始' }));
  expect(onEdit).toHaveBeenLastCalledWith('从这里开始', [{ op: 'trim-clip', shotId: 'one', start: 1, end: 4 }]);
});
it('adds the whole long source as consecutive clips rather than truncating it', async () => {
  const { onEdit } = setup();
  fireEvent.click(await screen.findByRole('button', { name: /Source video/ }));
  expect(onEdit).toHaveBeenCalledWith('添加视频片段', [
    { op: 'insert-clip', assetId: 'source', index: 1, in: 0, duration: 22.5 },
    { op: 'insert-clip', assetId: 'source', index: 2, in: 22.5, duration: 22.5 },
  ]);
});
it('opens video generation and forwards the user edit request', () => {
  const { onGenerate, onAi } = setup();
  fireEvent.click(screen.getByRole('button', { name: '生成视频素材' }));
  expect(onGenerate).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByRole('textbox', { name: '用 AI 剪辑' }), { target: { value: '删除第一段后半段' } });
  fireEvent.click(screen.getByRole('button', { name: '用 AI 剪辑' }));
  expect(onAi).toHaveBeenCalledWith('删除第一段后半段');
});
it('prevents edits and generation while content is locked', async () => {
  const { onEdit } = setup(true);
  expect(screen.getByRole('button', { name: '在播放头切分' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '生成视频素材' })).toBeDisabled();
  fireEvent.click(await screen.findByRole('button', { name: /Source video/ }));
  expect(onEdit).not.toHaveBeenCalled();
});
