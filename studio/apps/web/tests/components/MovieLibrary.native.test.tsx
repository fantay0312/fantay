// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MovieLibrary } from '../../src/components/movie/MovieLibrary';
import { I18nProvider } from '../../src/i18n';
import type { Project } from '../../src/types';

afterEach(cleanup);
it('keeps a native project usable when it has no thumbnail yet', () => {
  const open = vi.fn();
  const view = render(<I18nProvider initial="zh-CN"><MovieLibrary projects={[]} documents={{}} loading={false}
    onNew={vi.fn()} onOpen={vi.fn()} nativeProjects={[{ id:'empty', name:'Empty film', updatedAt:0 }]}
    onOpenNative={open} /></I18nProvider>);
  fireEvent.error(view.container.querySelector('img')!);
  expect(screen.getByText('还没有预览画面')).toBeTruthy();
  expect(view.container.querySelector('img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name:'Empty film' }));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id:'empty' }));
});
it('merges native projects into the film library without duplicating linked host projects', () => {
  const open = vi.fn(), pick = vi.fn();
  render(<I18nProvider initial="zh-CN"><MovieLibrary
    projects={[{ id: 'host', name: 'Linked film' } as Project]} documents={{}} loading={false} onNew={vi.fn()} onOpen={vi.fn()}
    nativeProjects={[{ id: 'native-linked', projectId: 'host', name: 'Linked film', updatedAt: 0 }, { id: 'native-only', name: 'Garden', updatedAt: 0 }]}
    onOpenNative={open} onImportNative={pick}
  /></I18nProvider>);
  expect(screen.getAllByRole('button', { name: 'Linked film' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Garden' }));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'native-only' }));
  fireEvent.click(screen.getByRole('button', { name: '打开视频项目' }));
  expect(pick).toHaveBeenCalledOnce();
});
