// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import { Panel, PanelBody, PanelClose, PanelHeader, Section } from '../../../src/fantay/ui/panel';

afterEach(cleanup);

function ResizablePanel({ edge, onResize }: { edge: 'start' | 'end'; onResize: (width: number) => void }) {
  return (
    <Panel surface="docked" resize={{ edge, width: 300, min: 220, max: 480, onResize }}>
      <PanelHeader>
        Inspector
        <PanelClose />
      </PanelHeader>
      <PanelBody>Body</PanelBody>
    </Panel>
  );
}

describe('Panel', () => {
  it('renders surfaces and a labelled, keyboard-resizable separator', () => {
    const onResize = vi.fn();
    render(<ResizablePanel edge="end" onResize={onResize} />);
    const separator = screen.getByRole('separator', { name: 'Resize panel' });
    expect(separator).toHaveAttribute('aria-valuenow', '300');
    expect(separator).toHaveAttribute('aria-valuemin', '220');
    expect(separator).toHaveAttribute('aria-valuemax', '480');
    expect(separator.className).toContain('end-0');

    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(310);
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(290);
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(onResize).toHaveBeenLastCalledWith(220);
    fireEvent.keyDown(separator, { key: 'End' });
    expect(onResize).toHaveBeenLastCalledWith(480);
  });

  it('mirrors the arrow keys when the handle sits on the left (start edge, or end edge in RTL)', () => {
    const onStart = vi.fn();
    render(<ResizablePanel edge="start" onResize={onStart} />);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    expect(onStart).toHaveBeenLastCalledWith(310);
    cleanup();

    const onRtl = vi.fn();
    render(
      <div dir="rtl">
        <ResizablePanel edge="end" onResize={onRtl} />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    expect(onRtl).toHaveBeenLastCalledWith(310);
  });

  it('resizes by pointer drag, clamped', () => {
    const onResize = vi.fn();
    render(<ResizablePanel edge="end" onResize={onResize} />);
    const separator = screen.getByRole('separator');
    fireEvent.pointerDown(separator, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 150, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(350);
    fireEvent.pointerMove(separator, { clientX: 900, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(480);
    fireEvent.pointerUp(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 120, pointerId: 1 });
    expect(onResize).toHaveBeenCalledTimes(2);
  });

  it('has no handle for the inline surface and an i18n close label', () => {
    render(
      <I18nProvider initial="zh-CN">
        <Panel surface="inline" resize={{ edge: 'end', width: 300, min: 200, max: 400, onResize: () => undefined }}>
          <PanelHeader>
            检查器
            <PanelClose />
          </PanelHeader>
        </Panel>
      </I18nProvider>,
    );
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
  });
});

describe('Section', () => {
  it('labels a static section by its title', () => {
    render(<Section title="Layout">Rows</Section>);
    expect(screen.getByRole('region', { name: 'Layout' })).toHaveTextContent('Rows');
  });

  it('collapses with an Expand/Collapse toggle', () => {
    const onOpenChange = vi.fn();
    render(
      <Section title="Fill" collapsible onOpenChange={onOpenChange}>
        <p>Fill body</p>
      </Section>,
    );
    const toggle = screen.getByRole('button', { name: 'Collapse' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Fill body')).toBeVisible();
    fireEvent.click(toggle);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    const expand = screen.getByRole('button', { name: 'Expand' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Fill body')).toBeNull();
  });

  it('respects a controlled closed state', () => {
    render(
      <Section title="Stroke" collapsible open={false}>
        <p>Stroke body</p>
      </Section>,
    );
    expect(screen.getByRole('button', { name: 'Expand' })).toBeInTheDocument();
    expect(screen.queryByText('Stroke body')).toBeNull();
  });
});
