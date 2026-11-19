// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/extendedDocumentPreview.ts (`openRtf`) @ c5e6b24f
// (MIT): the bounded RTF tokenizer — group stack, `\'hh` bytes decoded with the font's code page,
// `\u` with its fallback count, `\bin` skipping, skipped destinations and the character table.
// Changed here: it collects paragraphs, runs with their point size, alignment, tables (`\cell`,
// `\row`), strike-through and super/subscript instead of one `<p>` of `<br>` lines per page, so the
// reading page can set headings and body text; list marker text is kept; an unknown code page falls
// back instead of failing; failures are `ReadError` codes.
//
// The file is untrusted: input size, nesting, block count and output size are capped, and nothing in
// it is executed (objects, pictures, fields and scripts are skipped). No DOM: worker and tests.
import { renderBlocks, type Align, type Block, type ParagraphBlock, type ReadingDocument, type Run, type TableCell } from './blocks';
import { ReadError, escapeHtml } from './xml';

export const MAX_RTF_BYTES = 24 * 1024 * 1024;
const MAX_DEPTH = 200;
const MAX_BLOCKS = 100_000;
const MAX_TEXT_CHARS = 6 * 1024 * 1024;

/** Characters RTF writes as control symbols (`\~`) and control words (`\emspace`). */
const CHARACTERS = new Map<string, string>([
  ['~', ' '],
  ['_', '‑'],
  ['-', '­'],
  ['endash', '–'],
  ['emdash', '—'],
  ['bullet', '•'],
  ['lquote', '‘'],
  ['rquote', '’'],
  ['ldblquote', '“'],
  ['rdblquote', '”'],
  ['enspace', ' '],
  ['emspace', ' '],
  ['qmspace', ' '],
  ['zwbo', '​'],
  ['zwnj', '‌'],
  ['zwj', '‍'],
  ['ltrmark', '‎'],
  ['rtlmark', '‏'],
  ['nestcell', ' '],
]);

/** Groups whose content is not body text. */
const SKIPPED_DESTINATIONS = new Set([
  'colortbl', 'stylesheet', 'info', 'pict', 'object', 'fldinst', 'header', 'headerl', 'headerr', 'headerf', 'footer',
  'footerl', 'footerr', 'footerf', 'filetbl', 'datastore', 'themedata', 'colorschememapping', 'listtable',
  'listoverridetable', 'generator', 'rsidtbl', 'footnote', 'annotation', 'atnid', 'atnauthor', 'xmlnstbl', 'shpinst',
  'nonshppict', 'template', 'latentstyles', 'pgdsctbl', 'mmathPr',
]);

/** `\fcharset` of a font → the code page its `\'hh` bytes are in. 0 is ANSI: Western, whatever the file's own code page. */
const CHARSET_LABELS: Record<number, string> = {
  0: 'windows-1252',
  77: 'macintosh',
  128: 'shift_jis',
  129: 'euc-kr',
  134: 'gbk',
  136: 'big5',
  161: 'windows-1253',
  162: 'windows-1254',
  163: 'windows-1258',
  177: 'windows-1255',
  178: 'windows-1256',
  186: 'windows-1257',
  204: 'windows-1251',
  222: 'windows-874',
  238: 'windows-1250',
  255: 'ibm866',
};

const CODE_PAGE_LABELS: Record<number, string> = { 65001: 'utf-8', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 874: 'windows-874', 10000: 'macintosh' };

interface State {
  skip: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  script: -1 | 0 | 1;
  /** Half points, as RTF counts them. */
  size: number;
  uc: number;
  font: number;
  fontTable: boolean;
  decoder: TextDecoder;
}

function decoderFor(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
}

export function readRtf(bytes: Uint8Array): ReadingDocument {
  if (bytes.byteLength > MAX_RTF_BYTES) throw new ReadError('too-large');
  // One character per byte keeps offsets intact for binary data and multi-byte code pages.
  let source = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) source += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  if (!source.startsWith('{\\rtf')) throw new ReadError('invalid');

  let state: State = {
    skip: false,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    script: 0,
    size: 24,
    uc: 1,
    font: 0,
    fontTable: false,
    decoder: new TextDecoder('windows-1252'),
  };
  const fonts = new Map<number, TextDecoder>();
  let defaultFont = 0;
  const stack: State[] = [];

  // Paragraph properties are reset by `\pard`, not by a closing brace.
  let align: Align | null = null;
  let inTable = false;

  const blocks: Block[] = [];
  let runs: Run[] = [];
  let cellParagraphs: ParagraphBlock[] = [];
  let rowCells: TableCell[] = [];
  let tableRows: TableCell[][] = [];
  let pageBreaks = 0;
  let totalChars = 0;

  let text = '';
  let textChars = 0;
  let fallback = 0;
  const encoded = new Uint8Array(Math.min(bytes.byteLength, 1 << 20));
  let encodedLength = 0;

  const decodeBytes = (): void => {
    if (encodedLength === 0) return;
    const decoded = (fonts.get(state.font) ?? state.decoder).decode(encoded.subarray(0, encodedLength));
    encodedLength = 0;
    text += escapeHtml(decoded);
    textChars += decoded.length;
  };

  const flush = (): void => {
    decodeBytes();
    if (text === '') return;
    totalChars += textChars;
    if (totalChars > MAX_TEXT_CHARS) throw new ReadError('too-large');
    let html = text;
    if (state.script !== 0) html = state.script > 0 ? `<sup>${html}</sup>` : `<sub>${html}</sub>`;
    if (state.strike) html = `<s>${html}</s>`;
    if (state.underline) html = `<u>${html}</u>`;
    if (state.italic) html = `<em>${html}</em>`;
    if (state.bold) html = `<strong>${html}</strong>`;
    runs.push({ html, chars: textChars, size: state.size / 2, bold: state.bold });
    text = '';
    textChars = 0;
  };

  const emit = (value: string): void => {
    if (fallback > 0) {
      fallback -= 1;
      return;
    }
    if (state.skip) return;
    decodeBytes();
    text += escapeHtml(value);
    textChars += value.length;
  };

  const emitByte = (value: number): void => {
    if (fallback > 0) {
      fallback -= 1;
      return;
    }
    if (state.skip) return;
    if (encodedLength === encoded.length) decodeBytes();
    encoded[encodedLength] = value;
    encodedLength += 1;
  };

  const push = (block: Block): void => {
    if (blocks.length >= MAX_BLOCKS) throw new ReadError('too-large');
    blocks.push(block);
  };

  const flushTable = (): void => {
    if (tableRows.length === 0) return;
    push({ type: 'table', rows: tableRows });
    tableRows = [];
  };

  const takeParagraph = (): ParagraphBlock | null => {
    flush();
    if (runs.length === 0) return null;
    const paragraph: ParagraphBlock = { type: 'paragraph', runs, align, heading: null };
    runs = [];
    return paragraph;
  };

  const endParagraph = (): void => {
    const paragraph = takeParagraph();
    if (inTable) {
      if (paragraph) cellParagraphs.push(paragraph);
      return;
    }
    flushTable();
    if (paragraph) push(paragraph);
  };

  const endCell = (): void => {
    const paragraph = takeParagraph();
    if (paragraph) cellParagraphs.push(paragraph);
    rowCells.push({ paragraphs: cellParagraphs, colSpan: 1, rowSpan: 1 });
    cellParagraphs = [];
  };

  const endRow = (): void => {
    if (runs.length > 0 || text !== '' || encodedLength > 0 || cellParagraphs.length > 0) endCell();
    if (rowCells.length > 0) {
      if (tableRows.length >= MAX_BLOCKS) throw new ReadError('too-large');
      tableRows.push(rowCells);
    }
    rowCells = [];
  };

  for (let i = 0; i < source.length; ) {
    const char = source[i];
    i += 1;
    if (char === '{') {
      flush();
      fallback = 0;
      if (stack.length > MAX_DEPTH) throw new ReadError('unsupported');
      stack.push({ ...state });
    } else if (char === '}') {
      flush();
      fallback = 0;
      const parent = stack.pop();
      if (!parent) throw new ReadError('invalid');
      state = parent;
    } else if (char === '\\') {
      const next = source[i];
      if (next === "'") {
        const hex = source.slice(i + 1, i + 3);
        if (!/^[\da-f]{2}$/i.test(hex)) throw new ReadError('invalid');
        i += 3;
        emitByte(Number.parseInt(hex, 16));
        continue;
      }
      if (next === '\\' || next === '{' || next === '}') {
        i += 1;
        emit(next);
        continue;
      }
      if (next === '*') {
        flush();
        state.skip = true;
        i += 1;
        continue;
      }
      const match = /^([a-z]+)(-?\d+)? ?/i.exec(source.slice(i, i + 48));
      if (!match) {
        const character = next === undefined ? undefined : CHARACTERS.get(next);
        if (character) emit(character);
        // A backslash before a line break is `\par`; TextEdit ends paragraphs this way.
        else if ((next === '\n' || next === '\r') && !state.skip) endParagraph();
        i += 1;
        continue;
      }
      i += match[0].length;
      const word = match[1] ?? '';
      const arg = match[2] === undefined ? 1 : Number(match[2]);

      // Words that change how the following text looks close the current run first.
      if (word === 'fonttbl') {
        flush();
        state.fontTable = true;
        state.skip = true;
      } else if (word === 'deff') {
        state.font = defaultFont = arg;
      } else if (word === 'f') {
        flush();
        state.font = arg;
      } else if (word === 'fcharset') {
        if (state.fontTable) {
          const label = CHARSET_LABELS[arg];
          const decoder = label ? decoderFor(label) : null;
          if (decoder) fonts.set(state.font, decoder);
        }
      } else if (SKIPPED_DESTINATIONS.has(word)) {
        flush();
        state.skip = true;
      } else if (word === 'bin') {
        if (!Number.isSafeInteger(arg) || arg < 0 || arg > source.length - i) throw new ReadError('invalid');
        i += arg;
      } else if (word === 'ansicpg') {
        const decoder = decoderFor(CODE_PAGE_LABELS[arg] ?? `windows-${arg}`);
        if (decoder) {
          decodeBytes();
          state.decoder = decoder;
        }
      } else if (word === 'b') {
        flush();
        state.bold = arg !== 0;
      } else if (word === 'i') {
        flush();
        state.italic = arg !== 0;
      } else if (word === 'ul') {
        flush();
        state.underline = arg !== 0;
      } else if (word === 'ulnone') {
        flush();
        state.underline = false;
      } else if (word === 'strike') {
        flush();
        state.strike = arg !== 0;
      } else if (word === 'super' || word === 'sub' || word === 'nosupersub') {
        flush();
        state.script = word === 'super' ? 1 : word === 'sub' ? -1 : 0;
      } else if (word === 'fs') {
        flush();
        if (arg >= 2 && arg <= 1000) state.size = arg;
      } else if (word === 'plain') {
        flush();
        state = { ...state, bold: false, italic: false, underline: false, strike: false, script: 0, size: 24, font: defaultFont };
      } else if (word === 'uc') {
        state.uc = Math.max(0, Math.min(10, arg));
      } else if (word === 'u') {
        fallback = 0;
        emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg));
        fallback = state.uc;
      } else if (state.skip) {
        // Structure words inside a skipped destination (a page header, a footnote) do nothing.
      } else if (word === 'pard') {
        align = null;
        inTable = false;
      } else if (word === 'intbl') {
        inTable = true;
      } else if (word === 'ql' || word === 'qc' || word === 'qr' || word === 'qj') {
        align = word === 'qc' ? 'center' : word === 'qr' ? 'right' : word === 'qj' ? 'justify' : 'left';
      } else if (word === 'par' || word === 'sect') {
        endParagraph();
      } else if (word === 'line') {
        decodeBytes();
        text += '<br>';
      } else if (word === 'tab') {
        // A tab that opens a paragraph is a list marker's indent; elsewhere it separates columns.
        decodeBytes();
        emit(runs.length === 0 && text === '' ? ' ' : ' ');
      } else if (word === 'cell') {
        endCell();
      } else if (word === 'row' || word === 'nestrow') {
        endRow();
      } else if (word === 'page') {
        endParagraph();
        flushTable();
        push({ type: 'page' });
        pageBreaks += 1;
      } else {
        const character = CHARACTERS.get(word);
        if (character) emit(character);
      }
    } else if (char !== '\r' && char !== '\n' && char !== undefined) {
      emitByte(char.charCodeAt(0));
    }
  }
  if (stack.length > 0) throw new ReadError('invalid');
  endRow();
  inTable = false;
  endParagraph();
  flushTable();

  const html = renderBlocks(blocks);
  if (html === '') throw new ReadError('empty');
  return { html, pages: pageBreaks > 0 ? pageBreaks + 1 : null };
}
