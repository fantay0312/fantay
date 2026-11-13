// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// The localized shot editor (spec 07 §6.3): only changed fields become operations, one apply is one
// edit, cues keep stable identities, the actions exist only while there is something to apply, and a
// held editor says why.
import '../../fantay/helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createMovieDocument, type MovieEditOperation } from '@open-design/contracts';

import { MovieSelectionEditor } from '../../../src/components/movie/MovieSelectionEditor';
import { I18nProvider } from '../../../src/i18n';

afterEach(cleanup);

function fixture() {
  const d = createMovieDocument('Test', 'blank');
  d.shots = [
    {
      id: 's',
      title: 'Scene',
      body: '',
      duration: 3,
      layout: 'title',
      captions: [{ id: 'c', start: 0, end: 2, text: 'Original' }],
    },
  ];
  return d;
}

function editor(props: Partial<Parameters<typeof MovieSelectionEditor>[0]> = {}) {
  return (
    <I18nProvider initial="zh-CN">
      <MovieSelectionEditor
        document={fixture()}
        selectedShotId="s"
        busy={false}
        onSelect={() => {}}
        onApply={vi.fn(async () => true)}
        onDirtyChange={() => {}}
        {...props}
      />
    </I18nProvider>
  );
}

it('edits a caption without a video clip and submits only changed fields', async () => {
  const d = fixture();
  const apply = vi.fn(async (_label: string, _ops: MovieEditOperation[]) => true);
  const dirty = vi.fn();
  render(editor({ document: d, onApply: apply, onDirtyChange: dirty }));
  fireEvent.change(screen.getByLabelText('字幕内容 1'), { target: { value: 'Edited' } });
  fireEvent.change(screen.getByLabelText('结束（秒） 1'), { target: { value: '2.5' } });
  fireEvent.click(screen.getByRole('button', { name: '应用修改' }));
  expect(apply).toHaveBeenCalledWith(expect.any(String), [
    { op: 'update-caption', shotId: 's', captionId: 'c', changes: { text: 'Edited', end: 2.5 } },
  ]);
  expect(d.shots[0]!.captions![0]!.text).toBe('Original');
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
  expect(screen.getByLabelText('字幕内容 1')).toHaveValue('Original');
});

it('groups clip changes into one edit and preserves captions', () => {
  const d = fixture();
  d.shots[0]!.clip = { assetId: 'v', in: 0, rate: 1, volume: 1, fit: 'cover' };
  const apply = vi.fn(async (_label: string, _ops: MovieEditOperation[]) => true);
  render(editor({ document: d, onApply: apply }));
  fireEvent.change(screen.getByLabelText('源片入点（秒）'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('原声音量'), { target: { value: '0.6' } });
  fireEvent.click(screen.getByRole('button', { name: '应用修改' }));
  expect(apply).toHaveBeenCalledWith(expect.any(String), [{ op: 'update-clip', shotId: 's', changes: { in: 1, volume: 0.6 } }]);
});

it('removes and adds cues using separate stable identities', () => {
  const apply = vi.fn(async (_label: string, _ops: MovieEditOperation[]) => true);
  render(editor({ onApply: apply }));
  fireEvent.click(screen.getByRole('button', { name: '删除字幕 1' }));
  fireEvent.click(screen.getByRole('button', { name: '添加字幕' }));
  fireEvent.change(screen.getByLabelText('字幕内容 1'), { target: { value: 'New cue' } });
  fireEvent.click(screen.getByRole('button', { name: '应用修改' }));
  const ops = apply.mock.calls[0]![1];
  expect(ops[0]).toMatchObject({ op: 'remove-caption', captionId: 'c' });
  expect(ops[1]).toMatchObject({ op: 'add-caption', caption: { text: 'New cue', start: 0, end: 3 } });
});

it('shows apply and discard only while there is something to apply', () => {
  render(editor());
  expect(screen.getByText('已保存')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '应用修改' })).toBeNull();
  expect(screen.queryByRole('button', { name: '放弃修改' })).toBeNull();
  fireEvent.change(screen.getByLabelText('镜头标题'), { target: { value: 'Renamed' } });
  expect(screen.getByText('1 项待应用')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '应用修改' })).toBeEnabled();
});

it('says why the caption actions wait: the shot is full, or the editor is read-only', async () => {
  const view = render(editor());
  // The cue ends at 2 s of a 3 s shot: one more cue fills it.
  fireEvent.click(screen.getByRole('button', { name: '添加字幕' }));
  const add = screen.getByRole('button', { name: '添加字幕' });
  expect(add).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(add);
  expect(screen.getAllByLabelText(/^字幕内容/)).toHaveLength(2);
  act(() => add.focus());
  expect((await screen.findByRole('tooltip')).textContent).toContain('字幕已铺满这个镜头');
  view.unmount();

  render(editor({ readOnly: true }));
  const remove = screen.getByRole('button', { name: '删除字幕 1' });
  expect(remove).toHaveAttribute('aria-disabled', 'true');
  act(() => remove.focus());
  expect((await screen.findByRole('tooltip')).textContent).toContain('只读');
});

it('says why the apply action is held instead of showing it as applying', async () => {
  const apply = vi.fn(async () => true);
  const view = render(editor({ onApply: apply }));
  fireEvent.change(screen.getByLabelText('镜头标题'), { target: { value: 'Renamed' } });
  view.rerender(editor({ onApply: apply, busy: true, busyReason: 'AI 正在处理上一条请求' }));
  const applyButton = screen.getByRole('button', { name: '应用修改' });
  expect(applyButton).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(applyButton);
  expect(apply).not.toHaveBeenCalled();
  act(() => applyButton.focus());
  expect((await screen.findByRole('tooltip')).textContent).toContain('AI 正在处理上一条请求');

  view.rerender(editor({ onApply: apply, busy: true }));
  expect(screen.getByRole('button', { name: '应用中…' })).toBeDisabled();
});
