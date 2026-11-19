// Editor offsets use LF. Disk offsets include the original UTF-8 BOM and exact line endings.
export function editorMarkdown(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export interface MarkdownChange { from: number; to: number; insert: string }

/** Splice only the edited ranges. New lines follow the file's convention, including in mixed-EOL files. */
export function applyMarkdownChanges(raw: string, changes: readonly MarkdownChange[]): string {
  const bom = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  const eol = raw.match(/\r\n|[\r\n]/)?.[0] ?? '\n';
  const crlf = /\r\n/g;
  let match = crlf.exec(raw);
  let extra = bom;
  const diskOffset = (pos: number) => {
    while (match && match.index - extra < pos) {
      extra++;
      match = crlf.exec(raw);
    }
    return pos + extra;
  };
  let start = 0;
  const parts: string[] = [];
  for (const change of changes) {
    parts.push(raw.slice(start, diskOffset(change.from)), change.insert.replace(/\n/g, eol));
    start = diskOffset(change.to);
  }
  parts.push(raw.slice(start));
  return parts.join('');
}

/** Textareas report a whole LF-normalized value, even when only one character changed. */
export function replaceEditorMarkdown(raw: string, next: string): string {
  const old = editorMarkdown(raw);
  let from = 0;
  while (from < old.length && from < next.length && old[from] === next[from]) from++;
  let end = old.length, nextEnd = next.length;
  while (end > from && nextEnd > from && old[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
  return applyMarkdownChanges(raw, [{ from, to: end, insert: next.slice(from, nextEnd) }]);
}

export function isMarkdownImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name);
}
