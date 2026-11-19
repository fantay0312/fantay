// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from cindy packages/maker-shared/src/filePresentation.ts and
// apps/desktop/src/renderer/components/ui/file-type-icon.tsx @ 88941ba7 (Apache-2.0): a file's
// identity for presentation (which small glyph a tree row wears). Never use it to grant access or to
// pick a decoder. Pure apart from the lucide glyph references.
import {
  Database,
  File,
  FileArchive,
  FileAudio,
  FileChartColumn,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
} from 'lucide-react';

export type FileVisualKind =
  | 'code'
  | 'text'
  | 'pdf'
  | 'document'
  | 'sheet'
  | 'slide'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'database'
  | 'file';

const EXTENSIONS: Record<FileVisualKind, readonly string[]> = {
  code: [
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift',
    'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs', 'php', 'dart', 'lua', 'scala', 'sc', 'groovy', 'gradle',
    'pl', 'pm', 'r', 'hs', 'proto', 'sh', 'bash', 'zsh', 'ps1', 'yaml', 'yml', 'toml', 'ini', 'json',
    'jsonc', 'xml', 'html', 'htm', 'xhtml', 'vue', 'svelte', 'css', 'scss', 'sass', 'less', 'sql',
    'graphql', 'gql', 'diff', 'patch', 'csproj', 'sln', 'shader', 'unityproj', 'asmdef', 'dockerfile',
    'makefile', 'mk',
  ],
  text: ['md', 'mdx', 'markdown', 'mdown', 'mkdn', 'mkd', 'txt', 'text', 'log', 'rst'],
  pdf: ['pdf'],
  document: ['doc', 'docx', 'rtf', 'odt', 'pages'],
  sheet: ['xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'ods', 'numbers'],
  slide: ['ppt', 'pptx', 'odp', 'key'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tga', 'tif', 'tiff', 'svg', 'avif', 'heic', 'heif'],
  audio: ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'aac', 'aiff', 'opus'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpeg', 'mpg'],
  archive: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'],
  database: ['db', 'sqlite', 'sqlite3', 'realm'],
  file: [],
};

const EXTENSION_KIND = new Map<string, FileVisualKind>(
  (Object.entries(EXTENSIONS) as Array<[FileVisualKind, readonly string[]]>).flatMap(([kind, extensions]) =>
    extensions.map((extension) => [extension, kind] as const),
  ),
);

const CODE_NAMES = new Set([
  'dockerfile', 'makefile', 'gemfile', 'rakefile', 'procfile', 'vagrantfile', 'jenkinsfile',
  'cmakelists.txt', '.gitignore', '.gitattributes', '.npmrc', '.editorconfig', '.env',
]);
const TEXT_NAMES = new Set(['readme', 'license', 'licence', 'changelog', 'notice']);

/** Known names and extensions win over broad MIME hints (code served as text/plain is still code). */
export function getFileVisualKind(name: string, mimeType = ''): FileVisualKind {
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (CODE_NAMES.has(base) || base.startsWith('.env.')) return 'code';
  if (TEXT_NAMES.has(base)) return 'text';
  const dot = base.lastIndexOf('.');
  const known = dot >= 0 ? EXTENSION_KIND.get(base.slice(dot + 1)) : undefined;
  if (known) return known;
  const mime = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  if (/spreadsheet|excel/.test(mime) || mime === 'text/csv' || mime === 'text/tab-separated-values') return 'sheet';
  if (/presentation|powerpoint/.test(mime)) return 'slide';
  if (/wordprocessing|msword|opendocument\.text/.test(mime) || mime === 'application/rtf') return 'document';
  if (
    ['application/json', 'application/xml', 'application/javascript', 'text/javascript', 'text/html', 'text/css'].includes(
      mime,
    )
  ) {
    return 'code';
  }
  if (/^application\/(zip|gzip|x-tar|x-7z-compressed|vnd\.rar|x-rar-compressed)$/.test(mime)) return 'archive';
  if (mime === 'application/vnd.sqlite3' || mime === 'application/x-sqlite3') return 'database';
  if (mime.startsWith('text/')) return 'text';
  return 'file';
}

const GLYPHS: Record<FileVisualKind, LucideIcon> = {
  code: FileCode,
  text: FileText,
  pdf: FileText,
  document: FileText,
  sheet: FileSpreadsheet,
  slide: FileChartColumn,
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  archive: FileArchive,
  database: Database,
  file: File,
};

/** The compact glyph a file wears in a list. */
export function pickFileIcon(name: string, mimeType?: string): LucideIcon {
  return GLYPHS[getFileVisualKind(name, mimeType)];
}
