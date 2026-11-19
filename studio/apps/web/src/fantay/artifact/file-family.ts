// SPDX-License-Identifier: AGPL-3.0-only
// Which viewer shows a file. The daemon's `kind` only knows a dozen extensions and calls the rest
// `binary`; this table is the renderer's own, finer answer, keyed on the file name first and the
// MIME type second. Pure: no React, no DOM, so the viewer, the chat cards and tests share it.
// It decides presentation only. Never use it to grant access or to trust a file's content.

/** One viewer per id. Several extensions can share a viewer; a viewer can branch on `format`. */
export type ArtifactViewerId =
  | 'image'
  | 'pdf'
  | 'document'
  | 'sheet'
  | 'slides'
  | 'text'
  | 'notebook'
  | 'audio'
  | 'video'
  | 'model'
  | 'archive'
  | 'font'
  | 'ebook'
  | 'email'
  | 'database'
  | 'diagram'
  | 'whiteboard'
  | 'unknown';

/** What the file is to a person, for labels and grouping. Coarser than the viewer id. */
export type ArtifactFamily =
  | 'image'
  | 'document'
  | 'sheet'
  | 'slides'
  | 'code'
  | 'data'
  | 'text'
  | 'audio'
  | 'video'
  | 'model'
  | 'archive'
  | 'font'
  | 'other';

export interface ArtifactFileFamily {
  viewer: ArtifactViewerId;
  family: ArtifactFamily;
  /** Lower-case extension without the dot, or '' when the name has none. */
  extension: string;
  /**
   * How the viewer has to read the bytes. `native` means the browser decodes it; anything else
   * names the decoder the viewer loads on demand.
   */
  format: string;
}

interface Rule {
  viewer: ArtifactViewerId;
  family: ArtifactFamily;
  format: string;
  extensions: readonly string[];
}

const RULES: readonly Rule[] = [
  // Images the browser decodes itself.
  { viewer: 'image', family: 'image', format: 'native', extensions: ['png', 'apng', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'bmp', 'ico', 'cur'] },
  { viewer: 'image', family: 'image', format: 'svg', extensions: ['svg'] },
  // Images that need a decoder first.
  { viewer: 'image', family: 'image', format: 'heic', extensions: ['heic', 'heif'] },
  { viewer: 'image', family: 'image', format: 'tiff', extensions: ['tif', 'tiff'] },
  { viewer: 'image', family: 'image', format: 'psd', extensions: ['psd', 'psb'] },

  { viewer: 'pdf', family: 'document', format: 'pdf', extensions: ['pdf'] },
  { viewer: 'document', family: 'document', format: 'docx', extensions: ['docx', 'docm', 'dotx'] },
  { viewer: 'document', family: 'document', format: 'rtf', extensions: ['rtf'] },
  { viewer: 'document', family: 'document', format: 'odt', extensions: ['odt'] },
  { viewer: 'document', family: 'document', format: 'legacy', extensions: ['doc', 'dot', 'pages', 'wps'] },

  { viewer: 'sheet', family: 'sheet', format: 'workbook', extensions: ['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'numbers', 'et'] },
  { viewer: 'sheet', family: 'sheet', format: 'csv', extensions: ['csv'] },
  { viewer: 'sheet', family: 'sheet', format: 'tsv', extensions: ['tsv', 'tab'] },

  { viewer: 'slides', family: 'slides', format: 'pptx', extensions: ['pptx', 'pptm', 'ppsx', 'potx'] },
  { viewer: 'slides', family: 'slides', format: 'legacy', extensions: ['ppt', 'pps', 'odp', 'key', 'dps'] },

  { viewer: 'notebook', family: 'code', format: 'ipynb', extensions: ['ipynb'] },
  { viewer: 'diagram', family: 'code', format: 'mermaid', extensions: ['mmd', 'mermaid'] },
  // A hand-drawn scene saved by Excalidraw: JSON on disk, a drawing to a person.
  { viewer: 'whiteboard', family: 'image', format: 'excalidraw', extensions: ['excalidraw'] },

  { viewer: 'audio', family: 'audio', format: 'native', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'weba'] },
  { viewer: 'audio', family: 'audio', format: 'unsupported', extensions: ['aiff', 'aif', 'wma', 'amr', 'mid', 'midi'] },
  { viewer: 'video', family: 'video', format: 'native', extensions: ['mp4', 'm4v', 'webm', 'mov', 'ogv'] },
  // `.ts` and `.mts` are TypeScript here, never an MPEG transport stream.
  { viewer: 'video', family: 'video', format: 'unsupported', extensions: ['avi', 'mkv', 'wmv', 'flv', 'mpeg', 'mpg', '3gp', 'm2ts'] },

  { viewer: 'model', family: 'model', format: 'gltf', extensions: ['glb', 'gltf'] },
  { viewer: 'model', family: 'model', format: 'obj', extensions: ['obj'] },
  { viewer: 'model', family: 'model', format: 'stl', extensions: ['stl'] },
  { viewer: 'model', family: 'model', format: 'ply', extensions: ['ply'] },
  { viewer: 'model', family: 'model', format: 'fbx', extensions: ['fbx'] },
  { viewer: 'model', family: 'model', format: '3mf', extensions: ['3mf'] },

  { viewer: 'archive', family: 'archive', format: 'zip', extensions: ['zip', 'jar', 'war', 'apk', 'ipa', 'vsix', 'xpi', 'crx', 'nupkg', 'whl'] },
  { viewer: 'archive', family: 'archive', format: 'tar', extensions: ['tar'] },
  { viewer: 'archive', family: 'archive', format: 'tar.gz', extensions: ['tgz'] },
  { viewer: 'archive', family: 'archive', format: 'gz', extensions: ['gz'] },
  { viewer: 'archive', family: 'archive', format: 'unsupported', extensions: ['7z', 'rar', 'bz2', 'xz', 'zst', 'dmg', 'iso'] },

  { viewer: 'font', family: 'font', format: 'native', extensions: ['ttf', 'otf', 'woff', 'woff2'] },
  { viewer: 'ebook', family: 'document', format: 'epub', extensions: ['epub'] },
  { viewer: 'email', family: 'document', format: 'eml', extensions: ['eml'] },
  { viewer: 'database', family: 'data', format: 'sqlite', extensions: ['sqlite', 'sqlite3', 'db', 'db3'] },

  // Structured data shown as text with folding.
  { viewer: 'text', family: 'data', format: 'json', extensions: ['json', 'jsonc', 'json5', 'geojson', 'webmanifest', 'map'] },
  { viewer: 'text', family: 'data', format: 'jsonl', extensions: ['jsonl', 'ndjson'] },
  { viewer: 'text', family: 'data', format: 'yaml', extensions: ['yaml', 'yml'] },
  { viewer: 'text', family: 'data', format: 'toml', extensions: ['toml'] },
  { viewer: 'text', family: 'data', format: 'xml', extensions: ['xml', 'xsl', 'xslt', 'xsd', 'plist', 'rss', 'atom', 'opml', 'kml', 'gpx', 'drawio'] },
  { viewer: 'text', family: 'data', format: 'ini', extensions: ['ini', 'cfg', 'conf', 'properties', 'env', 'editorconfig'] },
  { viewer: 'text', family: 'text', format: 'log', extensions: ['log'] },
  { viewer: 'text', family: 'text', format: 'subtitle', extensions: ['srt', 'vtt', 'ass', 'ssa', 'lrc'] },
  { viewer: 'text', family: 'text', format: 'plain', extensions: ['txt', 'text', 'rst', 'adoc', 'asciidoc', 'org', 'tex', 'bib', 'nfo', 'csl'] },
  {
    viewer: 'text',
    family: 'code',
    format: 'code',
    extensions: [
      'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'm', 'mm',
      'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'vb', 'php', 'dart', 'lua', 'scala', 'sc', 'groovy', 'gradle', 'clj',
      'cljs', 'ex', 'exs', 'erl', 'hs', 'ml', 'nim', 'zig', 'jl', 'r', 'pl', 'pm', 'proto', 'thrift', 'sh', 'bash', 'zsh', 'fish',
      'ps1', 'bat', 'cmd', 'vue', 'svelte', 'astro', 'css', 'scss', 'sass', 'less', 'styl', 'sql', 'graphql', 'gql', 'prisma',
      'diff', 'patch', 'tf', 'hcl', 'nix', 'cmake', 'mk', 'dockerfile', 'wat', 'glsl', 'vert', 'frag', 'wgsl', 'asm', 's',
      'puml', 'plantuml', 'dot', 'gv', 'http', 'rest', 'lock',
    ],
  },
];

const BY_EXTENSION: ReadonlyMap<string, Rule> = (() => {
  const map = new Map<string, Rule>();
  // Earlier rules win, so 'dot' stays a Word template and never becomes Graphviz.
  for (const rule of RULES) for (const extension of rule.extensions) if (!map.has(extension)) map.set(extension, rule);
  return map;
})();

/** File names with no useful extension that are still plain text. */
const TEXT_NAMES: ReadonlyMap<string, { family: ArtifactFamily; format: string }> = new Map([
  ['dockerfile', { family: 'code', format: 'code' }],
  ['containerfile', { family: 'code', format: 'code' }],
  ['makefile', { family: 'code', format: 'code' }],
  ['gnumakefile', { family: 'code', format: 'code' }],
  ['cmakelists.txt', { family: 'code', format: 'code' }],
  ['gemfile', { family: 'code', format: 'code' }],
  ['rakefile', { family: 'code', format: 'code' }],
  ['procfile', { family: 'code', format: 'code' }],
  ['vagrantfile', { family: 'code', format: 'code' }],
  ['jenkinsfile', { family: 'code', format: 'code' }],
  ['justfile', { family: 'code', format: 'code' }],
  ['readme', { family: 'text', format: 'plain' }],
  ['license', { family: 'text', format: 'plain' }],
  ['licence', { family: 'text', format: 'plain' }],
  ['copying', { family: 'text', format: 'plain' }],
  ['notice', { family: 'text', format: 'plain' }],
  ['authors', { family: 'text', format: 'plain' }],
  ['changelog', { family: 'text', format: 'plain' }],
  ['codeowners', { family: 'text', format: 'plain' }],
]);

function baseName(name: string): string {
  return (name.split(/[\\/]/).pop() ?? '').toLowerCase();
}

/** `archive.tar.gz` → `tar.gz`; `photo.JPG` → `jpg`; `Makefile` → ''. A leading dot is not an extension. */
export function artifactExtension(name: string): string {
  const base = baseName(name);
  const compound = /\.(tar\.(?:gz|bz2|xz|zst))$/.exec(base);
  if (compound) return compound[1] ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : '';
}

function fromMime(mime: string, extension: string): ArtifactFileFamily | null {
  if (!mime) return null;
  if (mime === 'image/svg+xml') return { viewer: 'image', family: 'image', extension, format: 'svg' };
  if (mime.startsWith('image/')) return { viewer: 'image', family: 'image', extension, format: 'native' };
  if (mime.startsWith('audio/')) return { viewer: 'audio', family: 'audio', extension, format: 'native' };
  if (mime.startsWith('video/')) return { viewer: 'video', family: 'video', extension, format: 'native' };
  if (mime.startsWith('font/')) return { viewer: 'font', family: 'font', extension, format: 'native' };
  if (mime === 'application/pdf') return { viewer: 'pdf', family: 'document', extension, format: 'pdf' };
  if (mime === 'application/zip') return { viewer: 'archive', family: 'archive', extension, format: 'zip' };
  if (mime === 'application/json' || mime.endsWith('+json')) return { viewer: 'text', family: 'data', extension, format: 'json' };
  if (mime === 'application/xml' || mime.endsWith('+xml')) return { viewer: 'text', family: 'data', extension, format: 'xml' };
  if (mime.startsWith('text/')) return { viewer: 'text', family: 'text', extension, format: 'plain' };
  return null;
}

/**
 * The viewer for a file. The name decides when it can: a known extension is a stronger signal than
 * a server's MIME guess (code served as `text/plain` is still code, `application/octet-stream`
 * says nothing). The MIME type is the fallback, and `unknown` means "show the file card".
 */
export function artifactFileFamily(name: string, mimeType = ''): ArtifactFileFamily {
  const base = baseName(name);
  const extension = artifactExtension(name);

  if (extension === 'tar.gz' || extension === 'tar.bz2' || extension === 'tar.xz' || extension === 'tar.zst') {
    return { viewer: 'archive', family: 'archive', extension, format: extension === 'tar.gz' ? 'tar.gz' : 'unsupported' };
  }
  const named = TEXT_NAMES.get(base) ?? TEXT_NAMES.get(base.replace(/\.[^.]+$/, ''));
  if (named && (extension === '' || extension === 'txt' || extension === 'md')) {
    return { viewer: 'text', family: named.family, extension, format: named.format };
  }
  if (base.startsWith('.env')) return { viewer: 'text', family: 'data', extension, format: 'ini' };
  if (extension === '' && base.startsWith('.') && base.length > 1) {
    // Dotfiles (.gitignore, .npmrc, .prettierrc) are configuration text.
    return { viewer: 'text', family: 'data', extension, format: 'ini' };
  }

  const rule = BY_EXTENSION.get(extension);
  if (rule) return { viewer: rule.viewer, family: rule.family, extension, format: rule.format };

  const mime = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  return fromMime(mime, extension) ?? { viewer: 'unknown', family: 'other', extension, format: 'unknown' };
}

/** True when the file opens in a real viewer rather than the plain file card. */
export function isPreviewableArtifact(name: string, mimeType = ''): boolean {
  return artifactFileFamily(name, mimeType).viewer !== 'unknown';
}
