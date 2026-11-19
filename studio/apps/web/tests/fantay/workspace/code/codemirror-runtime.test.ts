// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// The read-only CodeMirror view behind the 代码 surface: one view that is updated in place when the
// text, the wrapping, the theme or the changes layer changes.
import '../../helpers/radix-jsdom';

import { afterEach, describe, expect, it } from 'vitest';

import {
  mountCodeEditor,
  type CodeEditorConfig,
  type CodeEditorHandle,
} from '../../../../src/fantay/workspace/code/codemirror-runtime';

const BASE: CodeEditorConfig = {
  docKey: 'src/a.ts',
  text: 'const a = 1;\nconst b = 2;\n',
  fileName: 'src/a.ts',
  wrap: false,
  dark: false,
  original: null,
  plain: false,
  phrases: {},
};

let host: HTMLElement;
let handle: CodeEditorHandle | null = null;

function mount(config: CodeEditorConfig = BASE): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  handle = mountCodeEditor(host, config);
  return host;
}

function content(): HTMLElement {
  return host.querySelector<HTMLElement>('.cm-content')!;
}

afterEach(() => {
  handle?.destroy();
  handle = null;
  host?.remove();
});

describe('mountCodeEditor', () => {
  it('shows the text read-only, numbered, focusable and named after the file', () => {
    mount();
    expect(content().textContent).toContain('const a = 1;');
    expect(content().getAttribute('contenteditable')).toBe('false');
    expect(content().getAttribute('aria-readonly')).toBe('true');
    expect(content().getAttribute('tabindex')).toBe('0');
    expect(content().getAttribute('aria-label')).toBe('src/a.ts');
    expect(host.querySelector('.cm-lineNumbers')).not.toBeNull();
    // Line numbers live in the gutter, outside the text a copy takes.
    expect(content().querySelector('.cm-lineNumbers')).toBeNull();
  });

  it('switches wrapping without rebuilding the view', () => {
    mount();
    const editor = host.querySelector('.cm-editor');
    expect(content().classList.contains('cm-lineWrapping')).toBe(false);
    handle!.update({ ...BASE, wrap: true });
    expect(content().classList.contains('cm-lineWrapping')).toBe(true);
    handle!.update({ ...BASE, wrap: false });
    expect(content().classList.contains('cm-lineWrapping')).toBe(false);
    expect(host.querySelector('.cm-editor')).toBe(editor);
  });

  it('swaps CodeMirror’s light / dark flag in place', () => {
    mount();
    const editor = host.querySelector('.cm-editor')!;
    const lightClasses = editor.className;
    handle!.update({ ...BASE, dark: true });
    expect(host.querySelector('.cm-editor')).toBe(editor);
    expect(editor.className).not.toBe(lightClasses);
  });

  it('replaces a newer version of the same file in place', () => {
    mount();
    const editor = host.querySelector('.cm-editor');
    handle!.update({ ...BASE, text: 'const a = 1;\nconst b = 3;\nconst c = 4;\n' });
    expect(content().textContent).toContain('const b = 3;');
    expect(content().textContent).toContain('const c = 4;');
    expect(content().textContent).not.toContain('const b = 2;');
    expect(host.querySelector('.cm-editor')).toBe(editor);
  });

  it('starts over for another document', () => {
    mount();
    handle!.update({ ...BASE, docKey: 'README.md', fileName: 'README.md', text: '# Title\n' });
    expect(content().textContent).toContain('# Title');
    expect(content().textContent).not.toContain('const a');
    expect(content().getAttribute('aria-label')).toBe('README.md');
  });

  it('shows the changes against the original, without accept / reject controls', () => {
    mount({ ...BASE, original: 'const a = 1;\nconst b = 0;\n' });
    expect(host.querySelector('.cm-editor')?.classList.contains('cm-merge-b')).toBe(true);
    const deleted = host.querySelector('.cm-deletedChunk');
    expect(deleted?.textContent).toContain('const b = 0;');
    expect(host.querySelector('.cm-changedLine')?.textContent).toContain('const b = 2;');
    expect(host.querySelector('.cm-chunkButtons')).toBeNull();
  });

  it('turns the changes layer on, re-bases it on a new original, and off again', () => {
    mount();
    expect(host.querySelector('.cm-deletedChunk')).toBeNull();

    handle!.update({ ...BASE, original: 'const a = 1;\nconst b = 0;\n' });
    expect(host.querySelector('.cm-deletedChunk')?.textContent).toContain('const b = 0;');

    // A different original must replace the old comparison, not sit beside it.
    handle!.update({ ...BASE, original: 'const a = 9;\nconst b = 2;\n' });
    const deleted = [...host.querySelectorAll('.cm-deletedChunk')].map((node) => node.textContent);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain('const a = 9;');

    handle!.update({ ...BASE, original: null });
    expect(host.querySelector('.cm-deletedChunk')).toBeNull();
    expect(host.querySelector('.cm-changedLine')).toBeNull();
  });

  it('collapses long unchanged stretches behind a translated bar', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    const original = lines.join('\n');
    const changed = [...lines];
    changed[39] = 'line forty';
    mount({
      ...BASE,
      text: changed.join('\n'),
      original,
      phrases: { '$ unchanged lines': '$ 行未更改' },
    });
    const bar = host.querySelector('.cm-collapsedLines');
    expect(bar?.textContent).toMatch(/^\d+ 行未更改$/);
  });

  it('highlights a known language once its grammar has loaded', async () => {
    mount({ ...BASE, text: 'const answer = "forty-two";\n' });
    await expect
      .poll(() => content().querySelectorAll('.cm-line span[class]').length, { timeout: 4000 })
      .toBeGreaterThan(0);
  });

  it('leaves plain text unhighlighted', async () => {
    mount({ ...BASE, plain: true, text: 'const answer = "forty-two";\n' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(content().querySelectorAll('.cm-line span[class]')).toHaveLength(0);
  });
});
