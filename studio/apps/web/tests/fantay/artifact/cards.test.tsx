// @vitest-environment jsdom
// The chat's product cards in the product shell: layout, opening, the quiet actions, the pending
// row, the selected state, and the switch in FileOpsSummary that keeps the inherited cards when
// the shell is off.
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileOpsSummary } from '../../../src/components/FileOpsSummary';
import { ARTIFACT_ANCHOR_ATTR } from '../../../src/components/chat/AnchoredMenuShell';
import { ArtifactCards } from '../../../src/fantay/artifact/cards/ArtifactCards';
import { publishActiveArtifact, resetActiveArtifactsForTests } from '../../../src/fantay/artifact/cards/active-artifact';
import type { ArtifactProduct } from '../../../src/fantay/artifact/cards/card-model';
import type { FileOpEntry } from '../../../src/runtime/file-ops';
import type { ProjectFile } from '../../../src/types';

const PROJECT = 'project-1';

function file(name: string, size: number, extra: Partial<ProjectFile> = {}): ProjectFile {
  return { name, size, mtime: 1_700_000_000_000, kind: 'text', mime: '', ...extra };
}

/** A page with a frozen first screen: the card draws a picture and mounts no live frame. */
function page(name: string, extra: Partial<ArtifactProduct> = {}): ArtifactProduct {
  return { name, kind: 'html', coverUrl: `/covers/${name}.png`, ...extra };
}

function doc(name: string, extra: Partial<ArtifactProduct> = {}): ArtifactProduct {
  return { name, kind: 'doc', ...extra };
}

const card = (name: string): HTMLElement => screen.getByTestId(`artifact-card-${name}`);
const openButton = (name: string): HTMLElement => screen.getByTestId(`artifact-card-open-${name}`);

beforeEach(() => {
  resetActiveArtifactsForTests();
  // Nothing in these tests may reach the network: a cover's text is whatever each test serves.
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in tests'))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ArtifactCards layout', () => {
  it('presents one finished product on a cover with its name, type and size', () => {
    const onOpen = vi.fn();
    render(<ArtifactCards items={[page('site/landing.html')]} projectId={PROJECT} files={[file('site/landing.html', 12_288)]} onOpen={onOpen} />);

    expect(screen.getByTestId('artifact-cards').getAttribute('data-layout')).toBe('cover');
    const only = card('site/landing.html');
    expect(only.getAttribute('data-variant')).toBe('cover');
    expect(only.textContent).toContain('landing.html');
    expect(only.textContent).toContain('Web page · 12 KB');

    const open = openButton('site/landing.html');
    expect(open.getAttribute('aria-label')).toBe('Open landing.html in a tab');
    fireEvent.click(open);
    // Only the name is handed over: the tab shows the workspace's latest version.
    expect(onOpen).toHaveBeenCalledWith('site/landing.html');
  });

  it('lists several products as rows inside one group', () => {
    render(<ArtifactCards items={[page('landing.html'), doc('report.md'), doc('数据.xlsx')]} projectId={PROJECT} onOpen={vi.fn()} />);

    expect(screen.getByTestId('artifact-cards').getAttribute('data-layout')).toBe('rows');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(card('report.md').textContent).toContain('Document');
    expect(card('数据.xlsx').textContent).toContain('Spreadsheet');
    // A size is stated only when the file is in the project list.
    expect(card('report.md').textContent).not.toMatch(/\d\s?(B|KB|MB)/);
  });

  it('shows six rows and reveals the rest on request', () => {
    const items = Array.from({ length: 9 }, (_, index) => doc(`notes/第${index + 1}份.md`));
    render(<ArtifactCards items={items} projectId={PROJECT} onOpen={vi.fn()} />);

    expect(document.querySelectorAll('[data-artifact-card]')).toHaveLength(6);
    const more = screen.getByTestId('artifact-cards-more');
    expect(more.textContent).toContain('+3 more');
    expect(more.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(more);
    expect(document.querySelectorAll('[data-artifact-card]')).toHaveLength(9);
    expect(more.textContent).toContain('Show less');
    expect(more.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(more);
    expect(document.querySelectorAll('[data-artifact-card]')).toHaveLength(6);
  });

  it('has no "more" control at six or fewer', () => {
    const items = Array.from({ length: 6 }, (_, index) => doc(`f${index}.md`));
    render(<ArtifactCards items={items} projectId={PROJECT} />);
    expect(screen.queryByTestId('artifact-cards-more')).toBeNull();
  });

  it('renders nothing without products', () => {
    const { container } = render(<ArtifactCards items={[]} projectId={PROJECT} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('a file that is still being written', () => {
  it('is a row with a status and nothing to press', () => {
    const onOpen = vi.fn();
    render(
      <ArtifactCards
        items={[{ name: 'landing.html', kind: 'html', pending: true, sharePending: true }]}
        projectId={PROJECT}
        onOpen={onOpen}
        onPublish={vi.fn()}
        onExport={vi.fn()}
      />,
    );

    expect(screen.getByTestId('artifact-cards').getAttribute('data-layout')).toBe('rows');
    expect(screen.getByRole('status').textContent).toBe('Generating…');
    expect(screen.queryByTestId('artifact-card-open-landing.html')).toBeNull();
    expect(screen.queryByTestId('artifact-card-publish-landing.html')).toBeNull();
    expect(screen.queryByTestId('artifact-card-export-landing.html')).toBeNull();
    expect(screen.getByTestId('artifact-card-sheen')).toBeTruthy();
  });

  it('stays a row while the turn runs and becomes a cover once it has ended', () => {
    const { rerender } = render(<ArtifactCards items={[page('landing.html', { sharePending: true })]} projectId={PROJECT} onOpen={vi.fn()} />);
    expect(card('landing.html').getAttribute('data-variant')).toBe('row');
    // The file itself is finished, so it can already be opened.
    expect(openButton('landing.html')).toBeTruthy();

    rerender(<ArtifactCards items={[page('landing.html')]} projectId={PROJECT} onOpen={vi.fn()} />);
    expect(card('landing.html').getAttribute('data-variant')).toBe('cover');
  });
});

describe('a file the project no longer has', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps its card, says so, and offers nothing to open or export', () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const items = [doc('gone.md'), doc('kept.md')];
    const { rerender } = render(<ArtifactCards items={items} projectId={PROJECT} files={[file('kept.md', 10)]} onOpen={onOpen} onExport={vi.fn()} />);

    // The list can trail a write by a moment, so the verdict waits.
    expect(screen.queryByTestId('artifact-card-open-gone.md')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1300);
    });

    expect(card('gone.md').textContent).toContain('Not in the project');
    expect(screen.queryByTestId('artifact-card-open-gone.md')).toBeNull();
    expect(screen.queryByTestId('artifact-card-export-gone.md')).toBeNull();
    expect(openButton('kept.md')).toBeTruthy();

    // The file turns up in the list: the card is whole again at once.
    rerender(<ArtifactCards items={items} projectId={PROJECT} files={[file('kept.md', 10), file('gone.md', 20)]} onOpen={onOpen} onExport={vi.fn()} />);
    expect(openButton('gone.md')).toBeTruthy();
    expect(card('gone.md').textContent).toContain('Document · 20 B');
  });

  it('never doubts a file while its turn is running or while the list is empty', () => {
    vi.useFakeTimers();
    render(
      <>
        <ArtifactCards items={[doc('a.md', { sharePending: true }), doc('b.md', { sharePending: true })]} projectId={PROJECT} files={[file('other.md', 1)]} onOpen={vi.fn()} />
        <ArtifactCards items={[doc('c.md'), doc('d.md')]} projectId={PROJECT} files={[]} onOpen={vi.fn()} />
      </>,
    );
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) expect(openButton(name)).toBeTruthy();
  });
});

describe('share and export', () => {
  it('offers share on pages only and hands over its own button as the anchor', () => {
    const onPublish = vi.fn();
    render(<ArtifactCards items={[page('landing.html'), doc('report.md')]} projectId={PROJECT} onOpen={vi.fn()} onPublish={onPublish} onExport={vi.fn()} />);

    expect(screen.queryByTestId('artifact-card-publish-report.md')).toBeNull();
    const share = screen.getByTestId('artifact-card-publish-landing.html');
    expect(share.getAttribute('aria-label')).toBe('Share');
    const anchor = share.getAttribute(ARTIFACT_ANCHOR_ATTR);
    expect(anchor).toMatch(/^publish:.+:landing\.html$/);

    fireEvent.click(share);
    expect(onPublish).toHaveBeenCalledWith('landing.html', anchor);
  });

  it('keeps share reachable but inert until the turn has ended', () => {
    const onPublish = vi.fn();
    render(
      <ArtifactCards items={[page('landing.html', { sharePending: true }), doc('report.md', { sharePending: true })]} projectId={PROJECT} onPublish={onPublish} />,
    );

    const share = screen.getByTestId('artifact-card-publish-landing.html');
    expect(share.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(share);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('opens the workspace export menu for a page, anchored to the button', () => {
    const onExport = vi.fn();
    render(<ArtifactCards items={[page('landing.html')]} projectId={PROJECT} onExport={onExport} />);

    const button = screen.getByTestId('artifact-card-export-landing.html');
    expect(button.getAttribute('aria-label')).toBe('Export');
    fireEvent.click(button);
    expect(onExport).toHaveBeenCalledWith('landing.html', button.getAttribute(ARTIFACT_ANCHOR_ATTR));
  });

  it('downloads the original of a single-format file without asking the workspace', () => {
    const onExport = vi.fn();
    const clicked: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute('href') ?? '', download: this.download });
    });
    render(<ArtifactCards items={[doc('notes/report.md'), doc('b.md')]} projectId={PROJECT} onExport={onExport} />);

    const button = screen.getByTestId('artifact-card-export-notes/report.md');
    expect(button.getAttribute('aria-label')).toBe('Download');
    fireEvent.click(button);

    expect(onExport).not.toHaveBeenCalled();
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe('report.md');
    expect(clicked[0]?.href).toContain('report.md');
  });

  it('shows and exports the frozen copy of an image', () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
      clicked.push(this.getAttribute('href') ?? '');
    });
    render(<ArtifactCards items={[{ name: 'poster.png', kind: 'image', snapshotUrl: '/snapshots/poster-turn-3.png' }]} projectId={PROJECT} files={[file('poster.png', 48_000)]} />);

    const picture = card('poster.png').querySelector('img');
    expect(picture?.getAttribute('src')).toBe('/snapshots/poster-turn-3.png');
    // The snapshot is not the file on disk, so the file's size is not claimed for it.
    expect(card('poster.png').textContent).not.toContain('KB');

    fireEvent.click(screen.getByTestId('artifact-card-export-poster.png'));
    expect(clicked).toEqual(['/snapshots/poster-turn-3.png']);
  });

  it('repeats the actions in a context menu', () => {
    const onOpen = vi.fn();
    const onPublish = vi.fn();
    render(<ArtifactCards items={[page('landing.html')]} projectId={PROJECT} onOpen={onOpen} onPublish={onPublish} onExport={vi.fn()} />);

    fireEvent.contextMenu(card('landing.html'));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Open', 'Share', 'Export', 'Copy path']);

    fireEvent.click(within(menu).getByText('Share'));
    expect(onPublish).toHaveBeenCalledWith('landing.html', screen.getByTestId('artifact-card-publish-landing.html').getAttribute(ARTIFACT_ANCHOR_ATTR));
  });
});

describe('the card of the tab in front', () => {
  it('is marked as current, and only while that tab is in front', () => {
    render(<ArtifactCards items={[page('landing.html'), doc('report.md')]} projectId={PROJECT} onOpen={vi.fn()} />);
    expect(openButton('report.md').getAttribute('aria-current')).toBeNull();

    act(() => publishActiveArtifact(PROJECT, 'report.md'));
    expect(openButton('report.md').getAttribute('aria-current')).toBe('true');
    expect(card('report.md').hasAttribute('data-selected')).toBe(true);
    expect(card('landing.html').hasAttribute('data-selected')).toBe(false);

    // Another project's front tab says nothing about this one.
    act(() => publishActiveArtifact('other-project', 'landing.html'));
    expect(card('landing.html').hasAttribute('data-selected')).toBe(false);

    act(() => publishActiveArtifact(PROJECT, null));
    expect(card('report.md').hasAttribute('data-selected')).toBe(false);
  });
});

describe('previews', () => {
  it('states an image’s pixel size once the picture has loaded', () => {
    render(<ArtifactCards items={[{ name: 'poster.png', kind: 'image' }]} projectId={PROJECT} files={[file('poster.png', 48_000)]} />);
    expect(card('poster.png').textContent).toContain('Image · 47 KB');

    const picture = card('poster.png').querySelector('img') as HTMLImageElement;
    Object.defineProperty(picture, 'naturalWidth', { value: 960 });
    Object.defineProperty(picture, 'naturalHeight', { value: 640 });
    fireEvent.load(picture);
    expect(card('poster.png').textContent).toContain('Image · 960 × 640');
  });

  it('falls back to the document cover when a picture cannot be drawn', () => {
    render(<ArtifactCards items={[{ name: 'poster.png', kind: 'image' }]} projectId={PROJECT} />);
    const picture = card('poster.png').querySelector('img') as HTMLImageElement;
    fireEvent.error(picture);

    expect(card('poster.png').querySelector('img')).toBeNull();
    expect(screen.getByTestId('artifact-card-sheet').textContent).toContain('poster');
  });

  it('sets a text document’s first lines on its cover', async () => {
    const markdown = '# 订阅业务第三季度复盘\n\n本季度订阅用户净增 **1,284** 人。\n\n## 关键数字\n';
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(markdown, { status: 200 }))));
    render(<ArtifactCards items={[doc('report.md')]} projectId={PROJECT} files={[file('report.md', 120)]} />);

    // The structure is there at once, titled by the file name; the lines arrive when they are read.
    const sheet = screen.getByTestId('artifact-card-sheet');
    expect(sheet.textContent).toContain('MD');
    expect(await within(sheet).findByText('订阅业务第三季度复盘')).toBeTruthy();
    expect(within(sheet).getByText('本季度订阅用户净增 1,284 人。')).toBeTruthy();
    expect(within(sheet).getByText('关键数字').hasAttribute('data-heading')).toBe(true);
  });

  it('gives a binary document a typographic cover and reads nothing', () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('must not be called')));
    vi.stubGlobal('fetch', fetchSpy);
    render(<ArtifactCards items={[doc('服务协议.docx')]} projectId={PROJECT} files={[file('服务协议.docx', 4_111)]} />);

    const sheet = screen.getByTestId('artifact-card-sheet');
    expect(sheet.textContent).toContain('DOCX');
    expect(sheet.textContent).toContain('服务协议');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('FileOpsSummary', () => {
  const entry = (path: string): FileOpEntry => ({
    path,
    fullPath: `/repo/${path}`,
    ops: ['write'],
    opCounts: { read: 0, write: 1, edit: 0, delete: 0 },
    total: 1,
    status: 'done',
  });

  it('draws the product cards when the product shell is on', () => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    const onOpen = vi.fn();
    render(<FileOpsSummary entries={[entry('report.md'), entry('notes.md')]} projectId={PROJECT} onRequestOpenFile={onOpen} />);

    expect(screen.getByTestId('artifact-cards').getAttribute('data-layout')).toBe('rows');
    // The turn's product panel keeps its one identity.
    expect(screen.getAllByTestId('file-ops-summary')).toHaveLength(1);
    fireEvent.click(openButton('report.md'));
    expect(onOpen).toHaveBeenCalledWith('report.md');
  });

  it('keeps the inherited cards when the shell is off', () => {
    render(<FileOpsSummary entries={[entry('report.md'), entry('notes.md')]} projectId={PROJECT} onRequestOpenFile={vi.fn()} />);

    const cards = screen.getByTestId('artifact-cards');
    expect(cards.hasAttribute('data-layout')).toBe(false);
    expect(cards.querySelectorAll('[data-artifact-card]')).toHaveLength(2);
  });
});
