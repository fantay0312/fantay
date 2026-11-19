// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/extendedDocumentPreview.ts @ c5e6b24f (MIT): the
// notebook reader (`openNotebook`, `notebookText`, `tracebackLines`, `record`): the tolerant walk over
// untrusted JSON, the order in which an output's MIME types are tried, and the idea of capping every
// field. Changed here: a cell or output over its cap is clipped and marked instead of failing the
// whole notebook; outputs keep their kind (stream, result, error, image, HTML, Markdown) so each can
// be drawn in its own way; stream text gets terminal semantics (carriage returns, colour codes);
// execution counts, attachments, SVG, LaTeX and JSON outputs and the image size hints are read;
// format version 3 notebooks are converted. Pure: no React, no DOM.
import { stripAnsi } from '../text/ansi';

/** Cells beyond this are not read: a notebook that long is generated, and nobody scrolls it. */
export const MAX_CELLS = 2000;
const MAX_OUTPUTS_PER_CELL = 200;
/** Source or text of one cell or output. */
const MAX_TEXT_CHARS = 400_000;
/** A `text/latex` value longer than this is not one formula. */
const MAX_FORMULA_CHARS = 20_000;
/** One base64 image: about 6 MB of picture. */
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;

export type NotebookOutput =
  /** What the code printed. `stderr` is drawn quieter, never as an error: libraries log there. */
  | { kind: 'stream'; name: 'stdout' | 'stderr'; text: string; clipped: boolean }
  /** A value or a display in plain text. `result` marks the cell's own value (`Out [n]`). */
  | { kind: 'text'; text: string; clipped: boolean; result: boolean }
  /** `src` is a `data:` address; `width` is the author's display size when the kernel recorded one. */
  | { kind: 'image'; src: string; width: number | null; result: boolean }
  /** Unsanitised markup; the viewer sanitises it and falls back to `fallback` when nothing is left. */
  | { kind: 'html'; html: string; fallback: string; result: boolean }
  | { kind: 'markdown'; source: string; result: boolean }
  /** A formula the kernel gave as TeX; the viewer typesets it and shows `fallback` (the plain form) when it cannot. */
  | { kind: 'latex'; source: string; fallback: string; result: boolean }
  | { kind: 'error'; name: string; message: string; traceback: string; clipped: boolean };

export interface NotebookCell {
  kind: 'markdown' | 'code' | 'raw';
  source: string;
  /** The source was longer than the cap. */
  clipped: boolean;
  /** `In [n]`. Null for a cell that was never run. */
  executionCount: number | null;
  outputs: NotebookOutput[];
  /** Pictures pasted into a Markdown cell: name → `data:` address. */
  attachments: Readonly<Record<string, string>>;
}

export interface Notebook {
  /** Lower-case language id for highlighting ("python", "r", "julia"); '' when unknown. */
  language: string;
  /** The language as a person writes it ("Python"); '' when unknown. */
  languageLabel: string;
  cells: NotebookCell[];
  /** How many cells the file has; larger than `cells.length` when the cap cut it. */
  totalCells: number;
}

export type NotebookResult = { ok: true; notebook: Notebook } | { ok: false; reason: 'invalid' | 'version' };

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

/** Notebook text is a string or a list of line strings. */
function joined(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((part): part is string => typeof part === 'string').join('');
  return '';
}

function clip(text: string, limit = MAX_TEXT_CHARS): { text: string; clipped: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), clipped: true } : { text, clipped: false };
}

/**
 * Printed text as a terminal would have left it: a carriage return goes back to the start of the
 * line (progress bars redraw themselves that way), and colour codes are dropped.
 */
export function terminalText(value: string): string {
  const text = stripAnsi(value);
  if (!text.includes('\r')) return text;
  return text
    .split('\n')
    .map((line) => {
      const body = line.endsWith('\r') ? line.slice(0, -1) : line;
      const last = body.lastIndexOf('\r');
      return last === -1 ? body : body.slice(last + 1);
    })
    .join('\n');
}

const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  python: 'Python',
  r: 'R',
  julia: 'Julia',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  scala: 'Scala',
  ruby: 'Ruby',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  kotlin: 'Kotlin',
  sql: 'SQL',
  bash: 'Bash',
  'c++': 'C++',
  'c#': 'C#',
};

const RASTER_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const BASE64 = /^[a-z\d+/]*={0,2}$/i;

function imageSource(data: Json): string | null {
  for (const type of RASTER_TYPES) {
    const base64 = joined(data[type]).replace(/\s/g, '');
    if (base64 !== '' && base64.length <= MAX_IMAGE_CHARS && BASE64.test(base64)) return `data:${type};base64,${base64}`;
  }
  // SVG is shown through `<img>`, where its scripts cannot run and it cannot load anything.
  const svg = joined(data['image/svg+xml']);
  if (svg.trim() !== '' && svg.length <= MAX_TEXT_CHARS) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return null;
}

/** The display width a kernel recorded for a high-density figure. */
function imageWidth(metadata: Json): number | null {
  for (const type of RASTER_TYPES) {
    const width = record(metadata[type]).width;
    if (typeof width === 'number' && Number.isFinite(width) && width > 0) return Math.round(width);
  }
  return null;
}

function prettyJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
  } catch {
    return '';
  }
}

/** One display bundle → the richest form this viewer can show safely. */
function displayOutput(output: Json, result: boolean): NotebookOutput | null {
  const data = record(output.data);
  const plain = clip(joined(data['text/plain']));

  const src = imageSource(data);
  if (src !== null) return { kind: 'image', src, width: imageWidth(record(output.metadata)), result };

  const html = joined(data['text/html']);
  if (html.trim() !== '' && html.length <= MAX_TEXT_CHARS) return { kind: 'html', html, fallback: plain.text, result };

  const markdown = joined(data['text/markdown']);
  if (markdown.trim() !== '') return { kind: 'markdown', source: clip(markdown).text, result };

  const latex = joined(data['text/latex']);
  if (latex.trim() !== '') {
    // Short TeX is a formula to typeset; a long LaTeX document is text, and the plain form reads better.
    if (latex.length <= MAX_FORMULA_CHARS) return { kind: 'latex', source: latex, fallback: plain.text, result };
    if (plain.text.trim() === '') return { kind: 'text', ...clip(latex), result };
  }

  if (plain.text.trim() !== '') return { kind: 'text', ...plain, result };

  if (data['application/json'] !== undefined) {
    const json = clip(prettyJson(data['application/json']));
    if (json.text.trim() !== '') return { kind: 'text', ...json, result };
  }
  return null;
}

/**
 * The frames of a traceback as text. IPython frames carry colour codes and may lack a final line
 * break; it also draws a rule, a header and, last, the error's name and message again. Those three
 * are left out: the viewer states the error once, above the frames.
 */
function tracebackText(value: unknown, name: string, message: string): string {
  if (!Array.isArray(value)) return '';
  const title = `${name}: ${message}`.trim();
  return value
    .filter((frame): frame is string => typeof frame === 'string')
    .flatMap((frame) => stripAnsi(frame).replace(/\n+$/, '').split('\n'))
    .filter((line, index, lines) => {
      const text = line.trim();
      if (/^-{8,}$/.test(text)) return false;
      if (/^\S+\s+Traceback \(most recent call last\)$/.test(text)) return false;
      return !(index === lines.length - 1 && text === title);
    })
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

function readOutput(value: unknown): NotebookOutput | null {
  const output = record(value);
  switch (output.output_type) {
    case 'stream': {
      const body = clip(terminalText(joined(output.text)));
      if (body.text === '') return null;
      return { kind: 'stream', name: output.name === 'stderr' ? 'stderr' : 'stdout', ...body };
    }
    case 'error': {
      const name = typeof output.ename === 'string' ? output.ename : '';
      const message = typeof output.evalue === 'string' ? stripAnsi(output.evalue).slice(0, 2000) : '';
      const traceback = clip(tracebackText(output.traceback, name, message));
      if (name === '' && message === '' && traceback.text === '') return null;
      return { kind: 'error', name, message, traceback: traceback.text, clipped: traceback.clipped };
    }
    case 'execute_result':
      return displayOutput(output, true);
    case 'display_data':
    case 'update_display_data':
      return displayOutput(output, false);
    default:
      return null;
  }
}

function readOutputs(value: unknown): NotebookOutput[] {
  if (!Array.isArray(value)) return [];
  const outputs: NotebookOutput[] = [];
  for (const item of value.slice(0, MAX_OUTPUTS_PER_CELL)) {
    const output = readOutput(item);
    if (!output) continue;
    const last = outputs[outputs.length - 1];
    // A program prints in many small writes; they are one block of text to the reader.
    if (output.kind === 'stream' && last?.kind === 'stream' && last.name === output.name && !last.clipped) {
      const merged = clip(last.text + output.text);
      outputs[outputs.length - 1] = { ...last, ...merged };
    } else {
      outputs.push(output);
    }
  }
  return outputs;
}

function readAttachments(value: unknown): Record<string, string> {
  const attachments: Record<string, string> = {};
  for (const [name, bundle] of Object.entries(record(value))) {
    const src = imageSource(record(bundle));
    if (src !== null) attachments[name] = src;
  }
  return attachments;
}

function readCell(value: unknown): NotebookCell {
  const cell = record(value);
  const kind = cell.cell_type === 'markdown' ? 'markdown' : cell.cell_type === 'code' ? 'code' : 'raw';
  const source = clip(joined(cell.source));
  const count = cell.execution_count;
  return {
    kind,
    source: source.text,
    clipped: source.clipped,
    executionCount: typeof count === 'number' && Number.isFinite(count) ? count : null,
    outputs: kind === 'code' ? readOutputs(cell.outputs) : [],
    attachments: kind === 'markdown' ? readAttachments(cell.attachments) : {},
  };
}

const V3_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  html: 'text/html',
  latex: 'text/latex',
  json: 'application/json',
  text: 'text/plain',
};

/** Format 3 kept cells in worksheets and named things differently; the content is the same. */
function cellsFromVersion3(notebook: Json): unknown[] {
  const worksheets = Array.isArray(notebook.worksheets) ? notebook.worksheets : [];
  return worksheets.flatMap((sheet) => {
    const cells = record(sheet).cells;
    return (Array.isArray(cells) ? cells : []).map((value): Json => {
      const cell = record(value);
      if (cell.cell_type === 'heading') {
        const level = typeof cell.level === 'number' ? Math.min(6, Math.max(1, cell.level)) : 1;
        return { cell_type: 'markdown', source: `${'#'.repeat(level)} ${joined(cell.source)}` };
      }
      if (cell.cell_type !== 'code') return cell;
      const outputs = (Array.isArray(cell.outputs) ? cell.outputs : []).map((item): Json => {
        const output = record(item);
        if (output.output_type === 'pyerr') return { ...output, output_type: 'error' };
        if (output.output_type === 'stream') return { ...output, name: output.stream };
        const data: Json = {};
        for (const [short, type] of Object.entries(V3_TYPES)) if (output[short] !== undefined) data[type] = output[short];
        return { output_type: output.output_type === 'pyout' ? 'execute_result' : 'display_data', data, metadata: output.metadata };
      });
      return { cell_type: 'code', source: cell.input, execution_count: cell.prompt_number, outputs };
    });
  });
}

/** Reads `.ipynb` text. Nothing in it is trusted, and nothing in it is ever run. */
export function parseNotebook(text: string): NotebookResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const notebook = record(parsed);
  const version = typeof notebook.nbformat === 'number' ? notebook.nbformat : null;
  let rawCells: unknown[];
  if (Array.isArray(notebook.cells)) rawCells = notebook.cells;
  else if (Array.isArray(notebook.worksheets)) rawCells = cellsFromVersion3(notebook);
  else return { ok: false, reason: version !== null && version !== 3 && version !== 4 ? 'version' : 'invalid' };

  const metadata = record(notebook.metadata);
  const kernel = record(metadata.kernelspec);
  const named = record(metadata.language_info).name ?? kernel.language;
  const language = (typeof named === 'string' ? named : '').toLowerCase().replace(/[^a-z\d+#-]/g, '').slice(0, 40);
  const display = typeof kernel.display_name === 'string' ? kernel.display_name.slice(0, 40) : '';

  return {
    ok: true,
    notebook: {
      language,
      languageLabel: LANGUAGE_LABELS[language] ?? (language !== '' ? language : display),
      cells: rawCells.slice(0, MAX_CELLS).map(readCell),
      totalCells: rawCells.length,
    },
  };
}
