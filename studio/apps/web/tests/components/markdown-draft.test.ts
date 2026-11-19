import { history, undo, redo } from '@codemirror/commands';
import { ChangeSet, EditorState, type Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { MarkdownDraft, draftField, markdownDraftState } from '../../src/components/markdown-draft';

describe('live Markdown disk snapshots', () => {
  it('preserves untouched mixed line endings and BOM through disjoint edits and empty lines', () => {
    const original = '\uFEFFone\r\ntwo\n\nthree\rfour\r\n';
    const first = MarkdownDraft.open(original);
    const changes = ChangeSet.of([
      { from: 1, to: 1, insert: '\n+' },
      { from: 7, to: 9, insert: '!' },
      { from: first.doc.length, insert: '末尾' },
    ], first.doc.length);
    const second = first.edit(changes.apply(first.doc), changes);
    expect(second.toString()).toBe('\uFEFFo\r\n+ne\r\ntwo!three\rfour\r\n末尾');
    expect(first.toString()).toBe(original);
  });

  it('undo and redo restore exact mixed line endings, including grouped deletions', () => {
    const file = 'one\r\ntwo\nthree\rfour';
    const draft = MarkdownDraft.open(file);
    let state = EditorState.create({ doc: draft.doc, extensions: [history(), markdownDraftState(draft)] });
    const target = { get state() { return state; }, dispatch(tr: Transaction) { state = tr.state; } };
    state = state.update({ changes: { from: 7, to: 8 }, userEvent: 'delete.backward' }).state;
    state = state.update({ changes: { from: 6, to: 7 }, userEvent: 'delete.backward' }).state;
    const edited = state.field(draftField).toString();
    expect(undo(target)).toBe(true);
    expect(state.field(draftField).toString()).toBe(file);
    expect(redo(target)).toBe(true);
    expect(state.field(draftField).toString()).toBe(edited);
  });

  it('an outstanding large save retains its own version while the user types', async () => {
    const original = '\uFEFF' + '标题\r\nabc\n'.repeat(50_000);
    const first = MarkdownDraft.open(original);
    const insert = (draft: MarkdownDraft, value: string) => {
      const changes = ChangeSet.of({ from: draft.doc.length, insert: value }, draft.doc.length);
      return draft.edit(changes.apply(draft.doc), changes);
    };
    const second = insert(first, 'a');
    const writing = second.diskText();
    const third = insert(second, '\nb');
    expect(await writing).toBe(original + 'a');
    expect(await third.diskText()).toBe(original + 'a\r\nb');
  });
});
