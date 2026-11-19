// SPDX-License-Identifier: AGPL-3.0-only
import { invertedEffects } from '@codemirror/commands';
import { StateEffect, StateField, Text, type ChangeSet } from '@codemirror/state';

// A marker per line break is needed only for mixed-EOL files. Storing the markers in another
// persistent Text lets edits insert/delete a run of markers without copying the rest of the file.
const markerFor = (eol: string) => eol === '\r\n' ? 'W' : eol === '\r' ? 'R' : 'L';
const eolFor = (marker: string) => marker === 'W' ? '\r\n' : marker === 'R' ? '\r' : '\n';

export class MarkdownDraft {
  private constructor(
    readonly doc: Text,
    private readonly bom: string,
    private readonly eol: string,
    readonly markers: Text | null,
    private raw?: string,
  ) {}

  matches(value: string | MarkdownDraft): boolean {
    return this === value || this.raw === value;
  }

  static open(raw: string): MarkdownDraft {
    const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
    const pieces = raw.slice(bom.length).split(/(\r\n?|\n)/);
    const eol = pieces[1] ?? '\n';
    const lines: string[] = [];
    let markers: string[] | null = null;
    for (let i = 0; i < pieces.length; i += 2) {
      const separator = pieces[i + 1];
      if (!markers && separator && separator !== eol) {
        markers = Array<string>(lines.length).fill(markerFor(eol));
      }
      lines.push(pieces[i]!);
      if (markers) markers.push(separator ? markerFor(separator) : '');
    }
    return new MarkdownDraft(Text.of(lines), bom, eol, markers && Text.of(markers), raw);
  }

  edit(doc: Text, changes: ChangeSet, restored?: Text): MarkdownDraft {
    if (restored) return new MarkdownDraft(doc, this.bom, this.eol, restored);
    let markers = this.markers;
    if (markers) {
      changes.iterChanges((from, to, newFrom, _newTo, inserted) => {
        if (!markers || (from === to && inserted.lines === 1)) return;
        const removed = from === to ? 0 : this.doc.lineAt(to).number - this.doc.lineAt(from).number;
        if (!removed && inserted.lines === 1) return;
        // Markers before this change already include any earlier changes in this transaction.
        const offset = 2 * (doc.lineAt(newFrom).number - 1);
        const added = Array<string>(inserted.lines - 1).fill(markerFor(this.eol));
        added.push('');
        markers = markers.replace(offset, offset + 2 * removed, Text.of(added));
      });
    }
    return new MarkdownDraft(doc, this.bom, this.eol, markers);
  }

  /** Yield between chunks when autosave and fresh input overlap. Each immutable snapshot
   * owns its own iterator, so a newer edit cannot change the version being written. */
  async diskText(): Promise<string> {
    if (this.raw !== undefined || this.doc.length < 256 * 1024) return this.toString();
    const chunks = [this.bom];
    const markers = this.markers?.iterLines();
    let parts: string[] = [];
    let n = 0;
    let deadline = performance.now() + 3;
    for (const line of this.doc.iterLines()) {
      parts.push(line);
      const marker = markers?.next().value;
      if (++n < this.doc.lines) parts.push(marker ? eolFor(marker) : this.eol);
      if (n % 256 === 0 && performance.now() >= deadline) {
        chunks.push(parts.join(''));
        parts = [];
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        deadline = performance.now() + 3;
      }
    }
    chunks.push(parts.join(''));
    return this.raw ??= chunks.join('');
  }

  /** Serialize once per snapshot, only when a consumer actually needs the raw file. */
  toString(): string {
    if (this.raw !== undefined) return this.raw;
    if (!this.markers) {
      this.raw = this.bom + this.doc.sliceString(0, this.doc.length, this.eol);
    } else {
      const parts = [this.bom];
      const markers = this.markers.iterLines();
      for (const line of this.doc.iterLines()) {
        parts.push(line);
        const marker = markers.next().value;
        if (marker) parts.push(eolFor(marker));
      }
      this.raw = parts.join('');
    }
    return this.raw;
  }
}

// A normalized CodeMirror undo transaction cannot distinguish LF from CRLF. Carry the
// original persistent marker tree with history for edits that actually changed line breaks.
const restoreEndings = StateEffect.define<Text>();
export const draftField = StateField.define<MarkdownDraft>({
  create() { throw new Error('The Markdown draft must be initialized with the opened file.'); },
  update(value, tr) {
    if (!tr.docChanged) return value;
    let restored: Text | undefined;
    for (const effect of tr.effects) if (effect.is(restoreEndings)) restored = effect.value;
    return value.edit(tr.newDoc, tr.changes, restored);
  },
});

export function markdownDraftState(initial: MarkdownDraft) {
  return [draftField.init(() => initial), invertedEffects.of(tr => {
    if (!tr.docChanged) return [];
    const before = tr.startState.field(draftField).markers;
    return before && before !== tr.state.field(draftField).markers ? [restoreEndings.of(before)] : [];
  })];
}
