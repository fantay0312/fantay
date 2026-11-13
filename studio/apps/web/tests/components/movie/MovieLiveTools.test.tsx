// @vitest-environment jsdom
import '../../fantay/helpers/radix-jsdom';
import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMovieDocument } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { MovieLiveTools, type MovieLiveToolsHandle } from '../../../src/components/movie/MovieLiveTools';

vi.mock('../../../src/providers/registry', () => ({ fetchDesignSystems: vi.fn(async () => []) }));
afterEach(cleanup);

function setup(readOnly = false, aiBusy = false) {
  const document = createMovieDocument('Live film');
  const ref = createRef<MovieLiveToolsHandle>();
  const props = { document, projectId: 'p', time: 2, busy: false, readOnly, aiBusy, blocked: false, onPause: vi.fn(), onSeek: vi.fn(), onPreview: vi.fn(), onApply: vi.fn(async () => true), onStyle: vi.fn(async () => true), onLinkStyle: vi.fn(async () => true), onAddNote: vi.fn(async () => true), onSubmitNotes: vi.fn(async () => true), onResolveNote: vi.fn() };
  render(<I18nProvider initial="zh-CN"><MovieLiveTools ref={ref} {...props} /></I18nProvider>);
  return { ref, props };
}
describe('live tools', () => {
  it('keeps human text editing available while an agent works', async () => {
    const { ref, props } = setup(false, true);
    act(() => ref.current!.editText({ shotId: props.document.shots[0]!.id, field: 'title' }));
    expect(await screen.findByLabelText('画面文字内容')).toBeEnabled();
  });
  it('previews typing, cancels without writing, and saves a localized edit', async () => {
    const { ref, props } = setup();
    const target = { shotId: props.document.shots[0]!.id, field: 'title' as const };
    act(() => ref.current!.editText(target));
    fireEvent.change(await screen.findByLabelText('画面文字内容'), { target: { value: 'New title' } });
    expect(props.onPreview.mock.lastCall?.[0]?.shots[0].title).toBe('New title');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onPreview.mock.lastCall?.[0]).toBeNull();
    act(() => ref.current!.editText(target));
    fireEvent.change(await screen.findByLabelText('画面文字内容'), { target: { value: 'Saved title' } });
    fireEvent.click(screen.getByRole('button', { name: '保存文字' }));
    await waitFor(() => expect(props.onApply).toHaveBeenCalledWith('修改画面文字', [{ op: 'update-shot', shotId: target.shotId, changes: { title: 'Saved title' } }]));
  });
  it('captures a live timestamp without requiring a rendered video', async () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: '时间批注' }));
    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Let the title settle' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(props.onAddNote).toHaveBeenCalledWith(expect.objectContaining({ scope: 'time', time: 2, contentRevision: props.document.contentRevision }), 'Let the title settle'));
  });
  it('does not open a mutation from the preview for a viewer', () => {
    const { ref, props } = setup(true);
    act(() => ref.current!.editText({ shotId: props.document.shots[0]!.id, field: 'title' }));
    expect(screen.queryByLabelText('画面文字内容')).toBeNull();
    expect(props.onPreview).not.toHaveBeenCalled();
  });
});
