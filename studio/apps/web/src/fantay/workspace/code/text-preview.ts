// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from cindy apps/desktop/src/renderer/lib/textPreview.ts and
// packages/file-browser-core/src/textFileExts.ts @ 88941ba7 (Apache-2.0): which files read as text
// or code. The daemon's file kind is a coarse viewer bucket (`.jsx`, `.yaml`, `.go` and every dotfile
// are "binary" there), so the 代码 surface decides by name as well. Pure; no React, no DOM.
import type { ProjectFile } from '../../../types';
import { getFileVisualKind } from './file-visual';

/** Above this size the editor shows plain text: parsing a file this large buys nobody anything. */
export const LARGE_TEXT_BYTES = 2 * 1024 * 1024;
/** Above this size the text is not loaded at all; the whole file would sit in memory twice. */
export const MAX_TEXT_BYTES = 10 * 1024 * 1024;
/** A file nothing vouches for is only tried as text when it is small. */
export const MAX_UNKNOWN_TEXT_BYTES = 1024 * 1024;

/** Extensions that read as text, lower case, without the dot. */
const TEXT_EXTENSIONS = new Set<string>([
  // Mainstream languages
  'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java',
  'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hh', 'cs', 'rb', 'php',
  'swift', 'kt', 'kts', 'scala', 'groovy', 'coffee',
  // Less common but still readable as text
  'lua', 'dart', 'r', 'pl', 'pm', 'ex', 'exs', 'elm',
  'clj', 'cljs', 'cljc', 'fs', 'fsi', 'fsx', 'ml', 'mli',
  'hs', 'erl', 'hrl', 'zig', 'nim', 'vim', 'applescript',
  // Shells
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  // Web / markup
  'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'styl',
  'vue', 'svelte', 'astro', 'svg', 'razor', 'cshtml',
  // Data / config
  'json', 'json5', 'jsonc', 'jsonl', 'ndjson', 'geojson',
  'yaml', 'yml', 'xml', 'toml', 'ini', 'conf', 'cfg', 'properties',
  'plist', 'tf', 'tfvars', 'hcl', 'gradle', 'cmake', 'mk', 'mak',
  'lock', 'csv', 'tsv',
  // Docs
  'md', 'markdown', 'mdx', 'rst', 'tex', 'bib', 'cls', 'sty',
  'adoc', 'asciidoc', 'org', 'txt', 'text',
  // Logs / diffs
  'log', 'diff', 'patch',
  // Subtitles and translation
  'srt', 'vtt', 'po', 'pot',
  // Project / build files
  'sln', 'csproj', 'vbproj', 'fsproj', 'gemspec', 'podspec', 'cabal',
  'vbhtml', 'vb', 'csx', 'cake', 'linq', 'props',
  'targets', 'slnx', 'slnf', 'config', 'resx', 'settings',
  'manifest', 'nuspec', 'runsettings', 'globalconfig', 'http', 'rest',
  'xaml', 'axaml', 'resw', 'rdlc', 'rdl', 'pubxml',
  'ruleset', 'dotsettings', 'testsettings', 'filters', 'gql', 'graphqls',
  'psd1', 'ps1xml', 'psql', 'bicep', 'fbs', 'thrift', 'capnp', 'avsc',
  // DB / API
  'sql', 'graphql', 'proto', 'dockerfile',
  // Feeds
  'rss', 'atom',
]);

/** Dotfiles that are text ("." + name is the whole file name). */
const TEXT_DOTFILES = new Set<string>([
  'gitignore', 'gitattributes', 'gitconfig', 'gitmodules', 'gitkeep',
  'dockerignore', 'eslintignore', 'prettierignore', 'npmignore',
  'editorconfig', 'env', 'prettierrc', 'eslintrc', 'babelrc', 'npmrc', 'yarnrc',
  'stylelintrc', 'huskyrc', 'lintstagedrc', 'browserslistrc',
  'nvmrc', 'node-version', 'python-version', 'ruby-version', 'tool-versions',
]);

/** Extension-less names that are text by convention. */
const TEXT_FILENAMES = new Set<string>([
  'dockerfile', 'makefile', 'gemfile', 'rakefile', 'procfile', 'vagrantfile', 'jenkinsfile', 'cmakelists',
  'license', 'licence', 'copying', 'notice', 'readme', 'changelog', 'authors', 'contributors', 'todo',
]);

/** True when the name alone says the file reads as text. */
export function isTextFileName(path: string): boolean {
  const base = (path.split('/').pop() ?? '').trim().toLowerCase();
  if (!base) return false;
  if (base.startsWith('.')) {
    const rest = base.slice(1);
    if (TEXT_DOTFILES.has(rest) || rest.startsWith('env.')) return true;
  }
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return TEXT_FILENAMES.has(base);
  return TEXT_EXTENSIONS.has(base.slice(dot + 1));
}

function isTextMime(mime: string): boolean {
  return (
    /^text\//i.test(mime) ||
    /^application\/(json|javascript|typescript|xml|x-(?:yaml|toml|httpd-php|sh))\b/i.test(mime) ||
    /\+(?:json|xml)\b/i.test(mime)
  );
}

/** What the surface does with a file: read it as text, refuse it, or try and look at the bytes. */
export type TextVerdict = 'text' | 'binary' | 'unknown';

export function classifyProjectFile(file: Pick<ProjectFile, 'name' | 'kind' | 'mime' | 'size'>): TextVerdict {
  if (file.size > MAX_TEXT_BYTES) return 'binary';
  switch (file.kind) {
    case 'html':
    case 'text':
    case 'code':
      return 'text';
    case 'image':
    case 'video':
    case 'audio':
    case 'pdf':
    case 'document':
    case 'presentation':
    case 'spreadsheet':
      return 'binary';
    case 'sketch':
      // A sketch is a drawing to look at; only an SVG is also source someone reads.
      return /\.svg$/i.test(file.name) ? 'text' : 'binary';
    default:
      break;
  }
  if (isTextFileName(file.name) || isTextMime(file.mime)) return 'text';
  const visual = getFileVisualKind(file.name, file.mime);
  if (visual !== 'file' && visual !== 'code' && visual !== 'text') return 'binary';
  return file.size <= MAX_UNKNOWN_TEXT_BYTES ? 'unknown' : 'binary';
}

/**
 * Bytes decoded as text: a NUL, or a head full of replacement characters, means they were never
 * text. Only the head is read, which is enough to tell and costs nothing on a large file.
 */
export function looksBinary(text: string): boolean {
  const head = text.length > 8192 ? text.slice(0, 8192) : text;
  if (head.length === 0) return false;
  let replaced = 0;
  for (let index = 0; index < head.length; index += 1) {
    const code = head.charCodeAt(index);
    if (code === 0) return true;
    if (code === 0xfffd) replaced += 1;
  }
  return replaced / head.length > 0.1;
}
