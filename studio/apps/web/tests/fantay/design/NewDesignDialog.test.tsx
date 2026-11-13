// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import { NewDesignDialog } from '../../../src/fantay/design/NewDesignDialog';

afterEach(cleanup);

type Props = ComponentProps<typeof NewDesignDialog>;

function renderDialog(overrides: Partial<Props> = {}) {
  const onCreate = vi.fn();
  const onOpenChange = vi.fn();
  const props: Props = {
    open: true,
    projectId: 'p1',
    htmlFiles: [
      { path: 'index.html', name: 'index.html' },
      { path: 'pages/pricing.html', name: 'pages/pricing.html' },
    ],
    existingDesignPaths: [],
    onCreate,
    onOpenChange,
    ...overrides,
  };
  const view = render(<NewDesignDialog {...props} />);
  return { onCreate, onOpenChange, view };
}

describe('NewDesignDialog', () => {
  it('creates a blank design at the suggested path, defaulting the name', () => {
    const { onCreate } = renderDialog({ existingDesignPaths: ['designs/Untitled-design.fig'] });
    expect(screen.getByRole('dialog', { name: 'New design' })).toHaveClass('fx');
    expect(screen.getByTestId('new-design-path')).toHaveTextContent('designs/Untitled-design-2.fig');
    fireEvent.click(screen.getByTestId('new-design-create'));
    expect(onCreate).toHaveBeenCalledWith(
      { kind: 'project', projectId: 'p1', path: 'designs/Untitled-design-2.fig', createIfMissing: true },
      { title: 'Untitled design' },
    );
  });

  it('keeps the typed title for the board and derives a canonical file name', () => {
    const { onCreate } = renderDialog();
    fireEvent.change(screen.getByTestId('new-design-name'), { target: { value: '首页 改版' } });
    expect(screen.getByTestId('new-design-path')).toHaveTextContent('designs/首页-改版.fig');
    fireEvent.submit(screen.getByTestId('new-design-name').closest('form') as HTMLFormElement);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ path: 'designs/首页-改版.fig' }), { title: '首页 改版' });
  });

  it('converts a chosen project page, naming the design after it', () => {
    const { onCreate } = renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: 'Convert a project web page' }));
    const create = screen.getByTestId('new-design-create');
    expect(create).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId('new-design-html-select'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: 'pages/pricing.html' }));
    expect(screen.getByTestId('new-design-name')).toHaveValue('pricing');
    fireEvent.click(create);
    expect(onCreate).toHaveBeenCalledWith(
      { kind: 'convert-html', projectId: 'p1', path: 'designs/pricing.fig', sourcePath: 'pages/pricing.html' },
      { title: 'pricing' },
    );
  });

  it('imports a local file; .op files keep their format', () => {
    const { onCreate } = renderDialog({ initialSource: 'file' });
    expect(screen.getByTestId('new-design-file-input')).toHaveAttribute('accept', '.fig,.op,.pen,.svg,.html,.htm,.json');
    expect(screen.getByText('Supports .fig, .op, .pen, .svg, .html and Doop canvas JSON')).toBeInTheDocument();
    const file = new File(['{}'], 'Moodboard.op', { type: 'application/json' });
    fireEvent.change(screen.getByTestId('new-design-file-input'), { target: { files: [file] } });
    expect(screen.getByTestId('new-design-file-button')).toHaveTextContent('Moodboard.op');
    expect(screen.getByTestId('new-design-path')).toHaveTextContent('designs/Moodboard.op');
    fireEvent.click(screen.getByTestId('new-design-create'));
    expect(onCreate).toHaveBeenCalledWith({ kind: 'import-file', projectId: 'p1', path: 'designs/Moodboard.op', file }, { title: 'Moodboard' });
  });

  it('stays open while busy and shows the failure', () => {
    const { onOpenChange } = renderDialog({ busy: true, error: 'The design engine failed to load. Try again.' });
    expect(screen.getByRole('alert')).toHaveTextContent('The design engine failed to load. Try again.');
    expect(screen.getByTestId('new-design-create')).toHaveAttribute('aria-busy', 'true');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('speaks zh-CN', () => {
    render(
      <I18nProvider initial="zh-CN">
        <NewDesignDialog open projectId="p1" htmlFiles={[]} existingDesignPaths={[]} onCreate={vi.fn()} onOpenChange={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByRole('dialog', { name: '新建设计' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '空白设计' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '由项目网页转换' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '从本地文件导入' })).toBeInTheDocument();
    expect(screen.getByTestId('new-design-path')).toHaveTextContent('designs/未命名设计.fig');
    expect(screen.getByRole('button', { name: '创建' })).toBeInTheDocument();
  });
});
