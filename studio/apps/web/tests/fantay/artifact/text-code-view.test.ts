// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// What the text viewer adds to the shared code pane from outside: the tints of a terminal log and
// the reader's place.
import '../helpers/radix-jsdom';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindCodeView, type CodeViewBinding } from '../../../src/fantay/artifact/viewers/text/code-view-runtime';
import {
  mountCodeEditor,
  type CodeEditorConfig,
  type CodeEditorHandle,
} from '../../../src/fantay/workspace/code/codemirror-runtime';

const BASE: CodeEditorConfig = {
  docKey: 'data/app.log:raw',
  text: 'INFO ok\nERROR failed\n',
  fileName: 'data/app.log',
  wrap: false,
  dark: false,
  original: null,
  plain: false,
  phrases: {},
};

let host: HTMLElement;
let handle: CodeEditorHandle | null = null;
let binding: CodeViewBinding | null = null;

function mount(config: CodeEditorConfig = BASE): void {
  host = document.createElement('div');
  document.body.append(host);
  handle = mountCodeEditor(host, config);
}

function tinted(name: string): string[] {
  return Array.from(host.querySelectorAll(`.cm-content .${name}`)).map((element) => element.textContent ?? '');
}

afterEach(() => {
  binding?.release();
  binding = null;
  handle?.destroy();
  handle = null;
  host?.remove();
});

describe('bindCodeView', () => {
  it('returns null while the pane has no editor yet', () => {
    host = document.createElement('div');
    document.body.append(host);
    expect(bindCodeView(host, { restore: null, onScroll: () => {} })).toBeNull();
  });

  it('tints the runs it is given and clears them again', () => {
    mount();
    binding = bindCodeView(host, { restore: null, onScroll: () => {} });
    expect(binding).not.toBeNull();
    binding?.setSpans([
      { from: 0, to: 4, tone: 'green', bold: false },
      { from: 8, to: 13, tone: 'red', bold: true },
    ]);
    expect(tinted('fx-ansi-green')).toEqual(['INFO']);
    expect(tinted('fx-ansi-red')).toEqual(['ERROR']);
    expect(tinted('fx-ansi-bold')).toEqual(['ERROR']);
    // The text itself is untouched.
    expect(host.querySelector('.cm-content')?.textContent).toContain('INFO okERROR failed');

    binding?.setSpans([]);
    expect(tinted('fx-ansi-green')).toEqual([]);
    expect(tinted('fx-ansi-red')).toEqual([]);
  });

  it('survives runs that reach past a shorter document', () => {
    mount({ ...BASE, text: 'short' });
    binding = bindCodeView(host, { restore: null, onScroll: () => {} });
    expect(() => binding?.setSpans([{ from: 2, to: 400, tone: 'blue', bold: false }, { from: 500, to: 600, tone: 'red', bold: false }])).not.toThrow();
    expect(tinted('fx-ansi-blue')).toEqual(['ort']);
  });

  it('tints again after the pane swapped in another document', () => {
    mount();
    binding = bindCodeView(host, { restore: null, onScroll: () => {} });
    binding?.setSpans([{ from: 0, to: 4, tone: 'green', bold: false }]);
    // A new document key makes the pane rebuild its state, which drops what was added to it.
    handle?.update({ ...BASE, docKey: 'data/other.log:raw', text: 'WARN slow\n' });
    expect(tinted('fx-ansi-green')).toEqual([]);
    binding?.setSpans([{ from: 0, to: 4, tone: 'yellow', bold: false }]);
    expect(tinted('fx-ansi-yellow')).toEqual(['WARN']);
  });

  it('reports the place while the reader scrolls, and takes it back without failing', () => {
    mount({ ...BASE, text: Array.from({ length: 400 }, (_, index) => `line ${index}`).join('\n') });
    const onScroll = vi.fn();
    binding = bindCodeView(host, { restore: null, onScroll });
    const scroller = host.querySelector<HTMLElement>('.cm-scroller')!;

    // Hidden (no height): nothing is recorded, so the last real place stays.
    scroller.dispatchEvent(new Event('scroll'));
    expect(onScroll).not.toHaveBeenCalled();

    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
    scroller.dispatchEvent(new Event('scroll'));
    expect(onScroll).toHaveBeenCalledTimes(1);
    const snapshot = onScroll.mock.calls[0]?.[0];

    binding?.release();
    scroller.dispatchEvent(new Event('scroll'));
    expect(onScroll).toHaveBeenCalledTimes(1);

    // The snapshot is handed to a later view of the same file, even one whose text got shorter.
    handle?.destroy();
    host.remove();
    mount({ ...BASE, text: 'two\nlines' });
    expect(() => {
      binding = bindCodeView(host, { restore: snapshot, onScroll: () => {} });
    }).not.toThrow();
    expect(binding).not.toBeNull();
  });
});
