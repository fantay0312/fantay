// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// The text viewer end to end in jsdom: what it shows for code, minified JSON, a coloured log, a file
// in another encoding, bytes that are not text, an empty file, a failed load and a file too large to
// load whole; and that what the reader set survives the viewer being mounted again.
import '../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { artifactFileFamily } from '../../../src/fantay/artifact/file-family';
import { resetArtifactViewState } from '../../../src/fantay/artifact/use-view-state';
import TextViewer from '../../../src/fantay/artifact/viewers/TextViewer';
import type { ProjectFile } from '../../../src/types';

type Body = string | Uint8Array | { json: unknown } | { status: number };

/** What the daemon answers, by a fragment of the decoded request address. */
let answers: Array<[string, Body]> = [];
let requests: string[] = [];

function file(name: string, size: number, mtime = 1): ProjectFile {
  return { name, size, mtime, kind: 'binary', mime: 'application/octet-stream' };
}

function show(target: ProjectFile, active = true) {
  return render(<TextViewer projectId="p1" file={target} family={artifactFileFamily(target.name, target.mime)} active={active} />);
}

function editorText(container: HTMLElement): string {
  return container.querySelector('.cm-content')?.textContent ?? '';
}

function bar(container: HTMLElement): string {
  return container.querySelector('[data-artifact-bar]')?.textContent ?? '';
}

function action(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-artifact-action="${id}"]`);
}

beforeEach(() => {
  answers = [];
  requests = [];
  resetArtifactViewState();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = decodeURIComponent(String(input));
      requests.push(url);
      const body = answers.find(([needle]) => url.includes(needle))?.[1];
      if (body === undefined) return new Response('', { status: 404 });
      if (typeof body === 'string' || body instanceof Uint8Array) return new Response(body as BodyInit);
      if ('json' in body) return new Response(JSON.stringify(body.json), { headers: { 'Content-Type': 'application/json' } });
      return new Response('', { status: body.status });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TextViewer', () => {
  it('shows source with its facts and the three actions', async () => {
    const source = 'package main\n\nfunc main() {\n\tprintln("你好")\n}\n';
    answers = [['src/main.go', source]];
    const { container } = show(file('src/main.go', 52));

    await waitFor(() => expect(editorText(container)).toContain('println("你好")'));
    expect(container.querySelector('[data-artifact-viewer="text"]')).not.toBeNull();
    expect(bar(container)).toContain('main.go');
    expect(bar(container)).toContain('5 lines · 52 B');
    // UTF-8 is not worth a word.
    expect(bar(container)).not.toContain('UTF');
    expect(action(container, 'wrap')?.getAttribute('aria-pressed')).toBe('false');
    expect(action(container, 'copy')).not.toBeNull();
    expect(action(container, 'download')).not.toBeNull();
    expect(container.querySelector('[data-artifact-modes]')).toBeNull();
    expect(container.querySelector('[role="note"]')).toBeNull();
  });

  it('does not load anything while its tab is hidden', async () => {
    answers = [['src/main.go', 'package main\n']];
    const { container, rerender } = show(file('src/main.go', 13), false);
    expect(requests).toEqual([]);
    expect(container.querySelector('[data-artifact-state="pending"]')).not.toBeNull();

    const target = file('src/main.go', 13);
    rerender(<TextViewer projectId="p1" file={target} family={artifactFileFamily(target.name, target.mime)} active />);
    await waitFor(() => expect(editorText(container)).toContain('package main'));
  });

  it('opens a minified JSON file formatted, switches to the original, and never changes a number', async () => {
    const records = Array.from({ length: 40 }, (_, index) => `{"id":${index},"name":"item ${index}"}`).join(',');
    const minified = `{"version":1.0,"snapshot":12345678901234567890,"rate":6.02e23,"items":[${records}]}`;
    answers = [['data/min.json', minified]];
    const { container } = show(file('data/min.json', minified.length));

    await waitFor(() => expect(editorText(container)).toContain('"snapshot": 12345678901234567890'));
    expect(editorText(container)).toContain('"version": 1.0');
    expect(editorText(container)).toContain('"rate": 6.02e23');
    expect(bar(container)).toContain('1 lines');
    const formatted = screen.getByRole('radio', { name: 'Formatted' });
    expect(formatted.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('radio', { name: 'Original' }));
    await waitFor(() => expect(editorText(container)).toContain('{"version":1.0,"snapshot":12345678901234567890,"rate":6.02e23,'));
    expect(screen.getByRole('radio', { name: 'Original' }).getAttribute('aria-checked')).toBe('true');
  });

  it('shows hand-written JSON as written and offers no switch for regular JSON', async () => {
    const irregular = '{\n  "files": ["dist", "README.md"],\n  "private": true\n}\n';
    const regular = '{\n  "name": "site",\n  "private": true\n}\n';
    answers = [
      ['irregular.json', irregular],
      ['regular.json', regular],
    ];
    const first = show(file('irregular.json', irregular.length));
    await waitFor(() => expect(editorText(first.container)).toContain('"files": ["dist", "README.md"],'));
    expect(screen.getByRole('radio', { name: 'Original' }).getAttribute('aria-checked')).toBe('true');
    first.unmount();

    const second = show(file('regular.json', regular.length));
    await waitFor(() => expect(editorText(second.container)).toContain('"name": "site"'));
    expect(second.container.querySelector('[data-artifact-modes]')).toBeNull();
  });

  it('takes colour codes out of a log and tints the same runs', async () => {
    const E = '\u001b[';
    answers = [['build.log', `${E}90m08:00${E}0m ${E}1;31mERROR${E}0m 构建失败\n${E}32mDone${E}0m in 4s\n`]];
    const { container } = show(file('build.log', 70));

    await waitFor(() => expect(container.querySelector('.cm-content .fx-ansi-red')?.textContent).toBe('ERROR'));
    expect(editorText(container)).toContain('08:00 ERROR 构建失败');
    expect(editorText(container)).not.toContain('\u001b');
    expect(container.querySelector('.cm-content .fx-ansi-bold')?.textContent).toBe('ERROR');
    expect(container.querySelector('.cm-content .fx-ansi-green')?.textContent).toBe('Done');
    expect(container.querySelector('.cm-content .fx-ansi-faint')?.textContent).toBe('08:00');
  });

  it('marks warnings and errors in a log that has no colours of its own', async () => {
    answers = [['app.log', '08:00:00 INFO ready\n08:00:01 WARN slow\n08:00:02 ERROR down\n']];
    const { container } = show(file('app.log', 60));

    await waitFor(() => expect(container.querySelector('.cm-content .fx-ansi-yellow')?.textContent).toBe('WARN'));
    expect(container.querySelector('.cm-content .fx-ansi-red')?.textContent).toBe('ERROR');
    expect(container.querySelectorAll('.cm-content [class*="fx-ansi-"]')).toHaveLength(2);
  });

  it('reads GBK text and names the encoding', async () => {
    // "中文字幕\n" in GBK.
    answers = [['字幕.srt', new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xd6, 0xc4, 0xbb, 0x0a])]];
    const { container } = show(file('notes/字幕.srt', 9));

    await waitFor(() => expect(editorText(container)).toContain('中文字幕'));
    expect(bar(container)).toContain('1 lines · 9 B · GB18030');
    // Prose wraps by default.
    expect(action(container, 'wrap')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the file card for bytes that are not text', async () => {
    answers = [['fake.txt', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02])]];
    const { container } = show(file('fake.txt', 8));

    await waitFor(() => expect(container.querySelector('[data-testid="artifact-file-card"]')).not.toBeNull());
    expect(container.textContent).toContain("This file's content is not text");
    expect(container.querySelector('.cm-content')).toBeNull();
  });

  it('says an empty file is empty', async () => {
    answers = [['empty.txt', '']];
    const { container } = show(file('empty.txt', 0));

    await waitFor(() => expect(container.querySelector('[data-artifact-state="notice"]')?.textContent).toContain('This file is empty'));
    expect(action(container, 'copy')?.getAttribute('aria-disabled') ?? action(container, 'copy')?.hasAttribute('disabled')).toBeTruthy();
  });

  it('offers one retry when the file cannot be loaded', async () => {
    answers = [['gone.yaml', { status: 500 }]];
    const { container } = show(file('gone.yaml', 10));

    await waitFor(() => expect(container.querySelector('[data-artifact-state="notice"]')).not.toBeNull());
    answers = [['gone.yaml', 'name: back\n']];
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(editorText(container)).toContain('name: back'));
  });

  it('shows only the head of a file too large to load, and says so', async () => {
    // Few lines, so the editor draws them all and the cut line would be on screen if it were kept.
    const head = `${Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n')}\nbroken li`;
    answers = [['text-preview/logs/huge.log', { json: { text: head, truncated: true, size: 12 * 1024 * 1024, limit: 524288 } }]];
    const { container } = show(file('logs/huge.log', 12 * 1024 * 1024));

    await waitFor(() => expect(editorText(container)).toContain('line 9'));
    // The line the byte limit cut through is not shown.
    expect(editorText(container)).not.toContain('broken li');
    expect(container.querySelector('[role="note"]')?.textContent).toMatch(/This file is 12 MB\. Only the first \d+ B is shown/);
    // The whole file was never requested.
    expect(requests.some((url) => url.includes('/raw/'))).toBe(false);
    expect(requests.some((url) => url.includes('limit=524288'))).toBe(true);
    // No line count for a part, and no "copy all" either.
    expect(bar(container)).not.toContain('lines');
    expect(action(container, 'copy')).toBeNull();
    expect(action(container, 'download')).not.toBeNull();
  });

  it('says highlighting is off for a large file that would have had it, and only for such a file', async () => {
    const large = `[\n${Array.from({ length: 140_000 }, (_, index) => `  "row ${index} of the list"`).join(',\n')}\n]\n`;
    expect(large.length).toBeGreaterThan(2 * 1024 * 1024);
    answers = [
      ['big.json', large],
      ['big.log', `08:00 INFO start\n${'y'.repeat(2 * 1024 * 1024 + 10)}\n`],
    ];
    const first = show(file('big.json', large.length));
    await waitFor(() => expect(first.container.querySelector('[role="note"]')?.textContent).toBe('Large file. Syntax highlighting is off.'));
    // Too large to format as well.
    expect(first.container.querySelector('[data-artifact-modes]')).toBeNull();
    first.unmount();

    const second = show(file('big.log', 2 * 1024 * 1024 + 40));
    await waitFor(() => expect(second.container.querySelector('.cm-content')).not.toBeNull());
    expect(second.container.querySelector('[role="note"]')).toBeNull();
  });

  it('keeps the wrap setting and the chosen view when the viewer is mounted again', async () => {
    const minified = `{"items":[${Array.from({ length: 40 }, (_, index) => `{"id":${index},"name":"item ${index}"}`).join(',')}]}`;
    answers = [['data/min.json', minified]];
    const target = file('data/min.json', minified.length);
    const first = show(target);
    await waitFor(() => expect(editorText(first.container)).toContain('"items": ['));

    fireEvent.click(action(first.container, 'wrap')!);
    fireEvent.click(screen.getByRole('radio', { name: 'Original' }));
    await waitFor(() => expect(editorText(first.container)).toContain('{"items":[{"id":0'));
    first.unmount();

    // Another tab came forward and this one came back: the viewer is a new instance.
    const second = show(target);
    await waitFor(() => expect(editorText(second.container)).toContain('{"items":[{"id":0'));
    expect(action(second.container, 'wrap')?.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Original' }).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the text on screen while a newer version of the file loads', async () => {
    answers = [['notes.txt', 'first version\n']];
    const view = show(file('notes.txt', 14, 1));
    await waitFor(() => expect(editorText(view.container)).toContain('first version'));

    let release: (response: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    const newer = file('notes.txt', 15, 2);
    view.rerender(<TextViewer projectId="p1" file={newer} family={artifactFileFamily(newer.name, newer.mime)} active />);
    // Nothing blinks: the old text stays, no loading state replaces it.
    expect(editorText(view.container)).toContain('first version');
    expect(view.container.querySelector('[data-artifact-state]')).toBeNull();

    release(new Response('second version\n'));
    await waitFor(() => expect(editorText(view.container)).toContain('second version'));
  });
});
