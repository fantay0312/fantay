// SPDX-License-Identifier: AGPL-3.0-only
// What the 参考 panel lists, derived from what already exists: the project's `references/` folder (panel uploads,
// applied materials and assets), the files attached in chat, and the files uploaded onto the canvas. Links have no
// file of their own, so they live in `references/links.json`, a plain project file agents can read too.
import { boardKindForPath, type BoardNode, type ChatMessage, type ProjectFile } from '@open-design/contracts';

export const REFERENCES_DIR = 'references';
export const REFERENCE_LINKS_FILE = `${REFERENCES_DIR}/links.json`;

export type ReferenceKind = 'image' | 'video' | 'file' | 'link';
export type ReferenceFilter = 'all' | ReferenceKind;

export interface ReferenceLink {
  url: string;
  title?: string;
  addedAt: number;
}

export type ReferenceItem =
  | { key: string; kind: 'link'; url: string; title: string; at: number }
  | { key: string; kind: Exclude<ReferenceKind, 'link'>; path: string; title: string; at: number; placeable: boolean };

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function isHelperFile(path: string): boolean {
  const name = baseName(path);
  return name.startsWith('.') || name.endsWith('.json') || name === 'brief.md';
}

function kindOf(file: ProjectFile): Exclude<ReferenceKind, 'link'> {
  if (file.kind === 'image') return 'image';
  if (file.kind === 'video') return 'video';
  return 'file';
}

function uploadedOnCanvas(node: BoardNode): string | null {
  if (node.kind !== 'image' && node.kind !== 'video' && node.kind !== 'audio') return null;
  if (!node.ref || node.pending || ('generation' in node && node.generation)) return null;
  return !node.origin || node.origin.source === 'user' ? node.ref.path : null;
}

export function parseReferenceLinks(text: string | null): ReferenceLink[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { links?: unknown };
    if (!Array.isArray(parsed.links)) return [];
    return parsed.links.flatMap((entry): ReferenceLink[] => {
      const link = entry as Partial<ReferenceLink> | null;
      if (typeof link?.url !== 'string') return [];
      return [{
        url: link.url,
        ...(typeof link.title === 'string' ? { title: link.title } : {}),
        addedAt: typeof link.addedAt === 'number' ? link.addedAt : 0,
      }];
    });
  } catch {
    return [];
  }
}

export function serializeReferenceLinks(links: readonly ReferenceLink[]): string {
  return `${JSON.stringify({ links }, null, 2)}\n`;
}

/** Newest first, one entry per path. */
export function deriveReferences(input: {
  files: readonly ProjectFile[];
  nodes: readonly BoardNode[];
  messages: readonly ChatMessage[];
  links: readonly ReferenceLink[];
}): ReferenceItem[] {
  const wanted = new Set<string>();
  for (const file of input.files) {
    if (file.type !== 'dir' && file.name.startsWith(`${REFERENCES_DIR}/`) && !isHelperFile(file.name)) wanted.add(file.name);
  }
  for (const message of input.messages) {
    for (const attachment of message.attachments ?? []) wanted.add(attachment.path);
  }
  for (const node of input.nodes) {
    const path = uploadedOnCanvas(node);
    if (path) wanted.add(path);
  }
  const items: ReferenceItem[] = [];
  for (const file of input.files) {
    if (!wanted.has(file.name) || file.type === 'dir') continue;
    items.push({
      key: `file:${file.name}`,
      kind: kindOf(file),
      path: file.name,
      title: baseName(file.name),
      at: file.mtime,
      placeable: boardKindForPath(file.name) !== null,
    });
  }
  for (const link of input.links) {
    items.push({ key: `link:${link.url}`, kind: 'link', url: link.url, title: link.title ?? link.url, at: link.addedAt });
  }
  return items.sort((a, b) => b.at - a.at);
}
