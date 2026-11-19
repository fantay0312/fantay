// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// The Mermaid viewer end to end in jsdom: the drawing goes into the page inline and inert, its kind
// and size are stated, a link copies instead of navigating, a broken file says which line and how,
// an agent's broken rewrite keeps the last good drawing with one quiet line, and the reader's view
// survives the viewer being unmounted.
import '../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { artifactFileFamily } from '../../../src/fantay/artifact/file-family';
import { resetArtifactViewState } from '../../../src/fantay/artifact/use-view-state';
import DiagramViewer from '../../../src/fantay/artifact/viewers/DiagramViewer';
import { forgetDrawings } from '../../../src/fantay/artifact/viewers/diagram/render';
import type { ProjectFile } from '../../../src/types';

let body = '';

const FLOW = 'flowchart LR\n  A[下单] --> B{已付款?}\n  B -- 是 --> C[烘焙]\n  B -- 否 --> D[提醒]\n  C --> E[周一寄出]';
const BROKEN = 'flowchart TD\n  A[顾客下单] --> B{库存够吗?}\n  B -->|够| C[安排烘焙]\n  B -->|不够| D[联系生豆商]\n  D --> E[支付定金(30%)]\n  E --> C';

function diagramFile(mtime = 1, name = 'notes/流程.mmd', size = 200): ProjectFile {
  return { name, size, mtime, kind: 'binary', mime: 'application/octet-stream' };
}

function view(target: ProjectFile): JSX.Element {
  return <DiagramViewer projectId="p1" file={target} family={artifactFileFamily(target.name, target.mime)} active />;
}

function stage(container: HTMLElement): SVGSVGElement | null {
  return container.querySelector('[data-artifact-viewer="diagram"] [role="img"] svg');
}

beforeEach(() => {
  resetArtifactViewState();
  forgetDrawings();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body)),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DiagramViewer', () => {
  it('draws the diagram inline, with its kind and size in the bar', async () => {
    body = FLOW;
    const { container } = render(view(diagramFile()));

    await waitFor(() => expect(stage(container)).not.toBeNull());
    const svg = stage(container)!;
    expect(svg.textContent).toContain('周一寄出');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[data-artifact-bar]')?.textContent).toContain('Flowchart · 200 B');
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Flowchart: notes/流程.mmd');
    expect(container.querySelector('script, foreignObject, image, [href]')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Diagram' }).getAttribute('aria-checked')).toBe('true');
  });

  it('copies a link address instead of following it', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    body = 'flowchart LR\n  A[官网] --> B[脚本]\n  click A href "https://example.com/coffee" _blank\n  click B href "javascript:alert(1)"';
    const { container } = render(view(diagramFile()));

    await waitFor(() => expect(stage(container)).not.toBeNull());
    const links = container.querySelectorAll('a[data-diagram-link]');
    expect(links).toHaveLength(1);
    expect(links[0]?.hasAttribute('href')).toBe(false);
    expect(links[0]?.querySelector('title')?.textContent).toContain('https://example.com/coffee');
    fireEvent.click(links[0]!.querySelector('text') ?? links[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://example.com/coffee'));
    await waitFor(() => expect(container.querySelector('[data-show][role="status"]')?.textContent).toBe('Link address copied'));
  });

  it('names the broken line, says what is wrong and opens the source there', async () => {
    body = BROKEN;
    const { container } = render(view(diagramFile()));

    const panel = await waitFor(() => {
      const found = container.querySelector('[data-diagram-problem="syntax"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(panel.textContent).toContain('Line 5 has a syntax error');
    expect(panel.textContent).toContain('put it in double quotes');
    expect(panel.querySelector('figure')?.textContent).toContain('D --> E[支付定金(30%)]');
    expect(panel.textContent).not.toMatch(/Expecting|Parse error/);

    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    await waitFor(() => expect(container.querySelector('.cm-content')?.textContent).toContain('支付定金(30%)'));
    expect(screen.getByRole('radio', { name: 'Source' }).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the last good drawing while a newer version does not parse, and says so once', async () => {
    body = FLOW;
    const { container, rerender } = render(view(diagramFile(1)));
    await waitFor(() => expect(stage(container)?.textContent).toContain('周一寄出'));
    const staleLine = (): Element | null => container.querySelector('[role="status"][data-show]');
    expect(staleLine()).toBeNull();

    body = BROKEN;
    rerender(view(diagramFile(2)));
    await waitFor(() => expect(staleLine()?.textContent).toContain('Line 5 of the newest version has an error. Showing the previous version.'));
    expect(stage(container)?.textContent).toContain('周一寄出');
    expect(container.querySelector('[data-diagram-problem]')).toBeNull();

    body = FLOW.replace('周一寄出', '周二寄出');
    rerender(view(diagramFile(3)));
    await waitFor(() => expect(stage(container)?.textContent).toContain('周二寄出'));
    expect(staleLine()).toBeNull();
  });

  it('says when the file is empty, holds no diagram, or names no known kind', async () => {
    body = '';
    const first = render(view(diagramFile(1, 'a.mmd', 0)));
    await waitFor(() => expect(first.container.querySelector('[data-artifact-state="notice"]')?.textContent).toContain('This file is empty'));
    first.unmount();

    body = '%% 还没画\n';
    const second = render(view(diagramFile(1, 'b.mmd')));
    await waitFor(() => expect(second.container.querySelector('[data-artifact-state="notice"]')?.textContent).toContain('There is no diagram in this file yet'));
    second.unmount();

    body = 'zenuml\n  A->B: hi';
    const third = render(view(diagramFile(1, 'c.mermaid')));
    await waitFor(() => expect(third.container.querySelector('[data-artifact-state="notice"]')?.textContent).toContain('The first line reads "zenuml"'));
  });

  it('does not fetch a file over 1 MB', async () => {
    const { container } = render(view(diagramFile(1, 'big.mmd', 2 * 1024 * 1024)));
    await waitFor(() => expect(container.querySelector('[data-artifact-state="notice"]')?.textContent).toContain('too large'));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('remembers the view across unmounts and draws again from what it kept', async () => {
    body = FLOW;
    const first = render(view(diagramFile()));
    await waitFor(() => expect(stage(first.container)).not.toBeNull());
    fireEvent.click(screen.getByRole('radio', { name: 'Source' }));
    await waitFor(() => expect(first.container.querySelector('.cm-content')?.textContent).toContain('flowchart LR'));
    first.unmount();

    const second = render(view(diagramFile()));
    await waitFor(() => expect(second.container.querySelector('.cm-content')?.textContent).toContain('flowchart LR'));
    fireEvent.click(screen.getByRole('radio', { name: 'Diagram' }));
    // The kept drawing is shown at once, before anything is fetched or drawn again.
    expect(stage(second.container)?.textContent).toContain('周一寄出');
  });
});
