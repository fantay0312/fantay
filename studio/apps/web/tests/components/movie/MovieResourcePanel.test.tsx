// @vitest-environment jsdom
import '../../fantay/helpers/radix-jsdom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createMovieDocument, type MovieDocument, type MovieVideoSource } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { MovieResourcePanel, type MovieResourceCategory } from '../../../src/components/movie/MovieResourcePanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const garden: MovieVideoSource = { assetId: 'source', path: 'source.mp4', label: 'Garden', kind: 'video', duration: 6, width: 1920, height: 1080, fps: 30, hasAudio: true, frames: [] };
const song: MovieVideoSource = { assetId: 'song', path: 'song.mp3', label: 'Song', kind: 'audio', duration: 90, width: 0, height: 0, fps: 0, hasAudio: true, audioPeaks: [0.1, 0.8, 0.4], frames: [] };

function film(): MovieDocument {
  const d = createMovieDocument('Panel');
  d.shots = [
    { id: 'clip', title: 'Garden', body: '', layout: 'split', duration: 6, clip: { assetId: 'source', in: 0, rate: 1, volume: 1, fit: 'contain' }, captions: [{ id: 'c1', start: 1, end: 2, text: 'Speech' }] },
    { id: 'next', title: 'Next', body: '', layout: 'split', duration: 4, clip: { assetId: 'source', in: 0, rate: 1, volume: 1, fit: 'contain' } },
  ];
  return d;
}

interface SetupOptions {
  selectedShotId?: string;
  category?: MovieResourceCategory;
  time?: number;
  sources?: MovieVideoSource[];
  edit?(d: MovieDocument): void;
}

function setup(overrides: SetupOptions = {}) {
  const d = film();
  overrides.edit?.(d);
  const handlers = {
    onImport: vi.fn(),
    onGenerate: vi.fn(),
    onInspectSource: vi.fn(),
    onAddSource: vi.fn(),
    onApply: vi.fn(async (_label: string, _operations: unknown[]) => true),
    onSeek: vi.fn(),
    onSelect: vi.fn(),
  };
  function Harness() {
    const [category, setCategory] = useState<MovieResourceCategory>(overrides.category ?? 'media');
    return (
      <I18nProvider initial="zh-CN">
        <MovieResourcePanel
          document={d}
          sources={overrides.sources ?? [garden, song]}
          selectedShotId={overrides.selectedShotId}
          time={overrides.time ?? 4}
          disabled={false}
          url={path => `/raw/${path}`}
          category={category}
          onCategoryChange={setCategory}
          {...handlers}
        />
      </I18nProvider>
    );
  }
  render(<Harness />);
  return handlers;
}

it('previews media on click, appends on double-click and drags as a timeline source', () => {
  const handlers = setup();
  const card = screen.getByRole('button', { name: '素材 Garden' });
  fireEvent.click(card);
  expect(handlers.onInspectSource).toHaveBeenCalledWith(garden);
  fireEvent.doubleClick(card);
  expect(handlers.onAddSource).toHaveBeenCalledWith(garden, 'append');
  const setData = vi.fn();
  const dataTransfer = { setData, effectAllowed: 'all' };
  fireEvent.dragStart(card, { dataTransfer });
  expect(setData).toHaveBeenCalledWith('application/x-fantay-source', 'source');
  expect(dataTransfer.effectAllowed).toBe('copy');
  fireEvent.click(screen.getByRole('button', { name: '添加到时间线 Garden' }));
  expect(handlers.onAddSource).toHaveBeenLastCalledWith(garden, 'append');
  fireEvent.click(screen.getByRole('radio', { name: '图片' }));
  expect(screen.queryByRole('button', { name: '素材 Garden' })).toBeNull();
});

it('offers import and generate in the title row, or in the empty state when there is no media', () => {
  const handlers = setup();
  fireEvent.click(screen.getByRole('button', { name: '导入' }));
  expect(handlers.onImport).toHaveBeenCalledTimes(1);
  cleanup();
  const empty = setup({ sources: [] });
  expect(screen.getByText('还没有素材')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '生成素材' }));
  expect(empty.onGenerate).toHaveBeenCalledTimes(1);
});

it('switches categories from the tab strip, by click and arrow keys, and adds audio at the playhead', () => {
  const handlers = setup();
  expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'horizontal');
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['媒体', '音频', '文本', '字幕', '转场', '滤镜', '动画']);
  fireEvent.click(screen.getByRole('tab', { name: '音频' }));
  expect(screen.getByRole('tab', { name: '音频' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('button', { name: '添加到播放头 Song' }));
  expect(handlers.onAddSource).toHaveBeenCalledWith(song, 'overlay');
  fireEvent.keyDown(screen.getByRole('tab', { name: '音频' }), { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: '文本' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(screen.getByRole('tab', { name: '文本' }), { key: 'End' });
  expect(screen.getByRole('tab', { name: '动画' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(screen.getByRole('tab', { name: '动画' }), { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: '媒体' })).toHaveAttribute('aria-selected', 'true');
});

it('inserts a styled text clip at the playhead in one batch and selects it', async () => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
  const handlers = setup({ category: 'text' });
  fireEvent.click(screen.getByRole('button', { name: '添加文字 大标题' }));
  await waitFor(() => expect(handlers.onSelect).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001'));
  const [label, operations] = handlers.onApply.mock.calls[0]!;
  expect(label).toBe('添加文字');
  expect(operations).toEqual([
    expect.objectContaining({ op: 'insert-text', text: '大标题', at: 4, track: 1, newShotId: '00000000-0000-4000-8000-000000000001' }),
    expect.objectContaining({ op: 'update-shot', shotId: '00000000-0000-4000-8000-000000000001', changes: expect.objectContaining({ textAnimation: 'rise' }) }),
  ]);
});

it('seeks to a caption and selects its clip, marking the cue under the playhead', () => {
  const handlers = setup({ category: 'captions', time: 1.5 });
  const row = screen.getByRole('button', { name: /Speech/ });
  expect(row).toHaveAttribute('aria-current', 'true');
  fireEvent.click(row);
  expect(handlers.onSelect).toHaveBeenCalledWith('clip', 'video');
  expect(handlers.onSeek).toHaveBeenCalledWith(1);
});

it('edits a caption inline on double-click as one update-caption', () => {
  const handlers = setup({ category: 'captions' });
  fireEvent.doubleClick(screen.getByRole('button', { name: /Speech/ }));
  const input = screen.getByRole('textbox', { name: '编辑字幕' });
  fireEvent.change(input, { target: { value: 'Hello there ' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(handlers.onApply).toHaveBeenCalledWith('修改字幕', [
    { op: 'update-caption', shotId: 'clip', captionId: 'c1', changes: { text: 'Hello there' } },
  ]);
  expect(screen.queryByRole('textbox', { name: '编辑字幕' })).toBeNull();
});

it('applies a filter to the selected clip and marks it as current', () => {
  const handlers = setup({ selectedShotId: 'clip', category: 'filters' });
  const original = screen.getByRole('button', { name: '原色' });
  expect(original).toHaveAttribute('aria-pressed', 'true');
  expect(original).toHaveAttribute('aria-current', 'true');
  fireEvent.click(original);
  expect(handlers.onApply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '黑白' }));
  expect(handlers.onApply).toHaveBeenCalledWith('应用滤镜', [
    { op: 'update-clip', shotId: 'clip', changes: { color: { exposure: 0, contrast: 1.12, saturation: 1, blur: 0, grayscale: 1 } } },
  ]);
});

it('marks the filter a hand-tuned look is close to', () => {
  setup({
    selectedShotId: 'clip',
    category: 'filters',
    edit: d => { d.shots[0]!.clip!.color = { exposure: 0, contrast: 1, saturation: 0, blur: 2, grayscale: 1 }; },
  });
  expect(screen.getByRole('button', { name: '黑白' })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('button', { name: '黑白' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText(/当前效果接近「黑白」/)).toBeTruthy();
});

it('applies the chosen transition to the selected clip', () => {
  const handlers = setup({ selectedShotId: 'clip', category: 'transitions' });
  fireEvent.click(screen.getByRole('button', { name: '擦除' }));
  fireEvent.click(screen.getByRole('button', { name: '应用到所选' }));
  expect(handlers.onApply).toHaveBeenCalledWith('设置转场', [
    expect.objectContaining({ op: 'update-shot', shotId: 'clip', changes: { visual: expect.objectContaining({ transition: 'wipe', transitionDuration: 0.45 }) } }),
  ]);
});

it('disables every apply-to-all past the edit limit instead of splitting it', () => {
  const handlers = setup({
    edit: d => {
      d.shots = Array.from({ length: 102 }, (_, i) => ({
        id: `s${i}`, title: `s${i}`, body: '', layout: 'split' as const, duration: 1,
        clip: { assetId: 'source', in: 0, rate: 1, volume: 1, fit: 'contain' as const },
        captions: [{ id: `c${i}`, start: 0, end: 1, text: 'Line' }],
      }));
    },
  });
  for (const [category, name] of [['字幕', /^全部应用「.+」· 102$/], ['转场', /^应用到全部 · 101$/], ['滤镜', /^全部应用「.+」· 102$/]] as const) {
    fireEvent.click(screen.getByRole('tab', { name: category }));
    const button = screen.getByRole('button', { name });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);
  }
  expect(handlers.onApply).not.toHaveBeenCalled();
});

it('applies a filter to every picture clip in one batch within the edit limit', () => {
  const handlers = setup({ category: 'filters' });
  fireEvent.click(screen.getByRole('button', { name: '黑白' }));
  fireEvent.click(screen.getByRole('button', { name: /^全部应用「黑白」· 2$/ }));
  expect(handlers.onApply).toHaveBeenCalledWith('统一画面滤镜', [
    expect.objectContaining({ op: 'update-clip', shotId: 'clip' }),
    expect.objectContaining({ op: 'update-clip', shotId: 'next' }),
  ]);
});

it('explains the animation panel when nothing is selected', () => {
  setup({ category: 'animation' });
  expect(screen.getByText('选择要添加动画的片段')).toBeTruthy();
});
