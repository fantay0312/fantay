// SPDX-License-Identifier: AGPL-3.0-only
// Turns what the agent said (`<od-focus tool="…"/>`) and what the agent did (the turn's file changes)
// into surface intents, and proposes surfaces for the start page. It only decides; ProjectView and
// FileWorkspace carry an intent out, and the user's own choice outranks all of it. Pure; no React,
// no DOM.
import { normalizeArtifactFocusUrl } from '@open-design/contracts';

import { selectAutoOpenProducedArtifact } from '../../../components/auto-open-file';
import { isFantayEditorFileName } from '../open-request-routing';
import { WORKSPACE_SURFACE_IDS } from './surface-types';
import type { SurfaceIntent, TurnFileChange, WorkspaceSurfaceId } from './surface-types';

/** File kinds (`ProjectFileKind`) that have a viewer of their own and are never read as source. */
const NON_CODE_KINDS: ReadonlySet<string> = new Set([
  'html', 'image', 'video', 'audio', 'sketch', 'pdf', 'document', 'presentation', 'spreadsheet',
]);

/** Text that the preview renders instead: pages, markdown, and vectors (the daemon files `.svg` as a sketch). */
const PREVIEWED_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm', 'md', 'markdown', 'mdown', 'mkd', 'mkdn', 'svg']);

/**
 * Extensions that read as code or plain text in a source viewer. An allow-list on purpose: the
 * daemon's `kind` is `binary` for everything outside its short list (`.rs`, `.yaml`, `.sh` included),
 * so the name is the only evidence, and an unknown extension is more often a blob than source.
 */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  // web
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro', 'mdx',
  'css', 'scss', 'sass', 'less', 'styl', 'pcss',
  'ejs', 'hbs', 'njk', 'pug', 'liquid', 'twig', 'mustache', 'erb',
  // languages
  'py', 'pyi', 'rb', 'php', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle', 'go', 'rs',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'vb', 'swift', 'm', 'mm', 'dart', 'lua',
  'pl', 'pm', 'r', 'jl', 'ex', 'exs', 'erl', 'hs', 'clj', 'cljs', 'elm', 'ml', 'zig', 'nim', 'sol',
  'glsl', 'vert', 'frag', 'wgsl',
  // shells and build
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'mk', 'cmake', 'tf', 'hcl', 'nix',
  // data and config
  'json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'ipynb', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'properties', 'xml', 'xsd', 'xsl', 'plist', 'lock', 'sql', 'graphql', 'gql', 'proto',
  'prisma', 'csv', 'tsv',
  // plain text
  'txt', 'text', 'log', 'rst', 'adoc', 'tex', 'diff', 'patch',
]);

/**
 * True for source, config and plain-text files that read as code or text in a source viewer; false
 * for pages, markdown, media, sketches, PDFs, office documents and the design and motion documents.
 */
export function isCodeLikePath(path: string, kind?: string | null): boolean {
  const name = path.slice(path.replace(/\\/g, '/').lastIndexOf('/') + 1);
  if (!name) return false;
  if (isFantayEditorFileName(name)) return false;
  const base = name.toLowerCase();
  // The one extensionless name that is binary in every folder a Mac has opened.
  if (base === '.ds_store') return false;
  if (kind && NON_CODE_KINDS.has(kind)) return false;
  // A leading dot names a dotfile, not an extension.
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot + 1) : '';
  if (PREVIEWED_TEXT_EXTENSIONS.has(extension)) return false;
  // Bare names and dotfiles (Makefile, LICENSE, .gitignore) are text; `.env.local` is an env file.
  if (extension === '' || CODE_EXTENSIONS.has(extension) || base.startsWith('.env')) return true;
  return kind === 'code' || kind === 'text';
}

const isSurfaceId = (value: string): value is WorkspaceSurfaceId =>
  (WORKSPACE_SURFACE_IDS as readonly string[]).includes(value);

/**
 * The agent engine: the surface a turn's `<od-focus …/>` asked for. Null when the marker named no
 * tool (a bare `open` already has its own path through the preview) or one this build does not know.
 */
export function intentFromAgentFocus(selection: {
  tool?: string | null;
  open?: string | null;
  url?: string | null;
}): SurfaceIntent | null {
  const tool = selection.tool?.trim().toLowerCase();
  if (!tool || !isSurfaceId(tool)) return null;
  const open = selection.open?.trim() || undefined;
  switch (tool) {
    case 'preview':
      // A preview with nothing to show is not a request.
      return open ? { surface: 'preview', engine: 'agent', file: open } : null;
    case 'code':
      return { surface: 'code', engine: 'agent', ...(open ? { file: open } : {}), view: 'source' };
    case 'browser': {
      // The host navigates to this address, so it passes the marker contract's own boundary check
      // again here (http(s) with a host, no credentials, no control characters, bounded length): a
      // selection that did not come through the daemon meets the same rule. A refused address
      // opens the browser without one.
      const url = normalizeArtifactFocusUrl(selection.url);
      return { surface: 'browser', engine: 'agent', ...(url ? { url } : {}) };
    }
    default:
      return { surface: tool, engine: 'agent' };
  }
}

/** The changed files the 代码 surface is the right place for: still there, and read as code. */
function changedCodeFiles(changes: readonly TurnFileChange[]): TurnFileChange[] {
  return changes.filter((change) => change.status !== 'deleted' && isCodeLikePath(change.path));
}

function intentFromCodeFiles(files: readonly TurnFileChange[]): SurfaceIntent | null {
  let primary: TurnFileChange | null = null;
  for (const file of files) {
    // `>=` so that among equally changed files the one touched last wins.
    if (!primary || file.added + file.removed >= primary.added + primary.removed) primary = file;
  }
  return primary ? { surface: 'code', engine: 'activity', file: primary.path, view: 'changes' } : null;
}

/**
 * The activity engine, consulted at turn end only when the content engine found nothing to preview:
 * a turn that changed code opens 代码 on its changes, at the file with the most changed lines.
 */
export function intentFromTurnChanges(changes: readonly TurnFileChange[]): SurfaceIntent | null {
  return intentFromCodeFiles(changedCodeFiles(changes));
}

export type SurfaceSuggestion =
  | { kind: 'changes'; intent: SurfaceIntent; fileCount: number; added: number; removed: number }
  | { kind: 'latest'; intent: SurfaceIntent; fileName: string };

/**
 * What the start page offers, at most two, in this order: the latest turn's code changes, then the
 * newest previewable deliverable that is not already open in a tab.
 */
export function suggestSurfaces(input: {
  turnChanges: readonly TurnFileChange[];
  files: readonly { name: string; kind?: string; mtime?: number; type?: string }[];
  openTabNames: readonly string[];
}): SurfaceSuggestion[] {
  const suggestions: SurfaceSuggestion[] = [];

  const codeFiles = changedCodeFiles(input.turnChanges);
  const changesIntent = intentFromCodeFiles(codeFiles);
  if (changesIntent) {
    let added = 0;
    let removed = 0;
    for (const file of codeFiles) {
      added += file.added;
      removed += file.removed;
    }
    suggestions.push({ kind: 'changes', intent: changesIntent, fileCount: codeFiles.length, added, removed });
  }

  const open = new Set(input.openTabNames);
  // Folders and hidden files are not deliverables (the turn-end auto-open skips them the same way).
  const candidates = input.files.filter(
    (file) =>
      file.type !== 'dir' && !open.has(file.name) && !file.name.startsWith('.') && !file.name.includes('/.'),
  );
  // The turn-end ranking, unchanged: a page over markdown over media, then the newest.
  const latest = selectAutoOpenProducedArtifact(candidates);
  if (latest) {
    suggestions.push({
      kind: 'latest',
      intent: { surface: 'preview', engine: 'content', file: latest },
      fileName: latest,
    });
  }
  return suggestions;
}
