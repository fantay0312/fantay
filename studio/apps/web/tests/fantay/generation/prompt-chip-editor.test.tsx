// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Spec 05 §11: chip editor — `@` menu + Enter inserts a chip and emits `@[node:id] `, tokens render chips,
// Backspace removes a chip whole, nothing is emitted during an IME composition, ⌘/Ctrl+Enter submits while
// plain Enter does not, and a token whose node is no longer an input renders a broken chip.
import '../helpers/radix-jsdom';

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompiledInput } from '@open-design/contracts';

import { PromptChipEditor } from '../../../src/fantay/generation/components/PromptChipEditor';
import { serializePromptEditor } from '../../../src/fantay/generation/components/prompt-editor-dom';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const INPUTS: CompiledInput[] = [
  { nodeId: 'img1', kind: 'image', label: 'Image 1', title: 'Hero shot', mentioned: false, sent: true, image: { path: 'hero.png' } },
  { nodeId: 'note1', kind: 'text', label: 'Text 1', title: 'Brief', mentioned: false, sent: true, text: 'Warm light, film grain' },
];

function Harness({
  initial = '',
  inputs = INPUTS,
  onChange,
  onSubmit,
}: {
  initial?: string;
  inputs?: CompiledInput[];
  onChange?: (value: string) => void;
  onSubmit?: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <PromptChipEditor
      value={value}
      inputs={inputs}
      previews={{}}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
      {...(onSubmit ? { onSubmit } : {})}
      placeholder="Describe the image"
      ariaLabel="Prompt"
    />
  );
}

function editor(): HTMLElement {
  return screen.getByTestId('fx-gen-prompt');
}

/** Puts the caret at `offset` inside `node` (a text node or an element). */
function placeCaret(node: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Types `text` as the browser would: replaces the editor text, caret at the end, then `input`. */
function typeText(text: string): void {
  const target = editor();
  target.focus();
  target.textContent = text;
  const node = target.firstChild ?? target;
  placeCaret(node, node.nodeType === Node.TEXT_NODE ? text.length : 0);
  fireEvent.input(target);
}

function chips(): HTMLElement[] {
  return Array.from(editor().querySelectorAll<HTMLElement>('[data-ref-node-id]'));
}

describe('PromptChipEditor', () => {
  it('opens the mention menu on @ and inserts the active input as a chip with Enter', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    act(() => typeText('Hello @'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([expect.stringContaining('Image 1'), expect.stringContaining('Text 1')]);
    expect(editor()).toHaveAttribute('aria-expanded', 'true');
    expect(editor()).toHaveAttribute('aria-activedescendant', options[0]?.id);

    fireEvent.keyDown(editor(), { key: 'Enter' });

    expect(onChange).toHaveBeenLastCalledWith('Hello @[node:img1] ');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(chips().map((chip) => chip.getAttribute('data-ref-node-id'))).toEqual(['img1']);
  });

  it('moves through the mention options with the arrow keys and filters by the query', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    act(() => typeText('Look @'));
    fireEvent.keyDown(editor(), { key: 'ArrowDown' });
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('Look @[node:note1] ');

    act(() => typeText('again @bri'));
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveTextContent('Text 1');
  });

  it('shows the empty mention state when nothing is connected', () => {
    render(<Harness inputs={[]} />);
    act(() => typeText('@'));
    expect(screen.getByRole('listbox')).toHaveTextContent('Nothing to reference yet. Connect an image or note to this node first.');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('renders stored tokens as chips and serializes them back', () => {
    render(<Harness initial={'Use @[node:img1] with @[node:note1]\nand more'} />);
    const rendered = chips();
    expect(rendered.map((chip) => chip.getAttribute('data-ref-node-id'))).toEqual(['img1', 'note1']);
    expect(rendered.every((chip) => chip.getAttribute('contenteditable') === 'false')).toBe(true);
    expect(rendered[0]).toHaveTextContent('Image 1');
    expect(rendered[1]).toHaveAttribute('title', 'Warm light, film grain');
    expect(serializePromptEditor(editor())).toBe('Use @[node:img1] with @[node:note1]\nand more');
  });

  it('removes a chip as a whole with Backspace', () => {
    const onChange = vi.fn();
    render(<Harness initial="a @[node:img1]" onChange={onChange} />);
    const target = editor();
    expect(chips()).toHaveLength(1);
    placeCaret(target, target.childNodes.length);
    fireEvent.keyDown(target, { key: 'Backspace' });
    expect(chips()).toHaveLength(0);
    expect(onChange).toHaveBeenLastCalledWith('a ');
  });

  it('does not emit while an IME composition is in progress', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const target = editor();
    fireEvent.compositionStart(target);
    act(() => typeText('ni'));
    act(() => typeText('你好'));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(target, { key: 'Enter', keyCode: 229 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.compositionEnd(target);
    expect(onChange).toHaveBeenLastCalledWith('你好');
  });

  it('hides the placeholder as soon as an IME composition starts in an empty prompt', () => {
    render(<Harness />);
    const target = editor();
    const placeholder = () => screen.queryByText('Describe the image');
    expect(placeholder()).toBeInTheDocument();
    fireEvent.compositionStart(target);
    // The composing text (e.g. pinyin "ni") is in the DOM before `value` changes: no placeholder over it.
    expect(placeholder()).toBeNull();
    fireEvent.compositionEnd(target);
    // Cancelled composition: still empty, the placeholder returns.
    expect(placeholder()).toBeInTheDocument();
    fireEvent.compositionStart(target);
    act(() => typeText('你好'));
    fireEvent.compositionEnd(target);
    expect(placeholder()).toBeNull();
  });

  it('submits on ⌘/Ctrl+Enter only; plain Enter inserts a newline', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness initial="first" onChange={onChange} onSubmit={onSubmit} />);
    const target = editor();
    const text = target.firstChild as Text;
    placeCaret(text, text.length);

    fireEvent.keyDown(target, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith('first\n');

    fireEvent.keyDown(target, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(target, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('keeps every keydown from the board shortcuts', () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Harness initial="x" />
      </div>,
    );
    fireEvent.keyDown(editor(), { key: 'n' });
    fireEvent.keyDown(editor(), { key: 'Delete' });
    expect(outer).not.toHaveBeenCalled();
  });

  it('renders a broken chip for a token whose node is no longer an input', () => {
    render(<Harness initial="see @[node:gone] now" />);
    const [chip] = chips();
    expect(chip).toHaveAttribute('data-ref-node-id', 'gone');
    expect(chip).toHaveAttribute('data-broken');
    expect(chip).toHaveTextContent('Disconnected reference');
    expect(serializePromptEditor(editor())).toBe('see @[node:gone] now');
  });

  it('pastes plain text only', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const target = editor();
    placeCaret(target, 0);
    fireEvent.paste(target, {
      clipboardData: { getData: (type: string) => (type === 'text/plain' ? 'line one\r\nline two' : '<b>bold</b>') },
    });
    expect(onChange).toHaveBeenLastCalledWith('line one\nline two');
    expect(target.querySelector('b')).toBeNull();
  });
});
