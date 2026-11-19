// SPDX-License-Identifier: AGPL-3.0-only
// What selecting an entry shows: its text, its picture, or only its facts. Decided from the name
// first (so nothing is unpacked just to find out) and, for names that say nothing, from the bytes.
// Pure; no React, no DOM.
import { artifactFileFamily } from '../../file-family';
import { getFileVisualKind } from '../../../workspace/code/file-visual';
import { looksBinary } from '../../../workspace/code/text-preview';
import { ARCHIVE_IMAGE_PEEK_BYTES, ARCHIVE_TEXT_PEEK_BYTES, type ArchiveEntry } from './archive-reader';

/** Why an entry shows its facts instead of its content. */
export type PeekSkipReason = 'folder' | 'link' | 'encrypted' | 'too-large' | 'type';

export type PeekPlan =
  | { kind: 'text'; limit: number }
  | { kind: 'image'; limit: number; mime: string }
  /** The name says nothing: read it if it is small, then let the bytes decide. */
  | { kind: 'sniff'; limit: number }
  | { kind: 'facts'; reason: PeekSkipReason };

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  cur: 'image/x-icon',
  svg: 'image/svg+xml',
};

export function planPeek(entry: ArchiveEntry): PeekPlan {
  if (entry.kind === 'dir') return { kind: 'facts', reason: 'folder' };
  if (entry.kind === 'link') return { kind: 'facts', reason: 'link' };
  if (entry.encrypted) return { kind: 'facts', reason: 'encrypted' };

  const family = artifactFileFamily(entry.path);
  const mime = family.viewer === 'image' ? IMAGE_MIME[family.extension] : undefined;
  if (mime) {
    return entry.size <= ARCHIVE_IMAGE_PEEK_BYTES ? { kind: 'image', limit: ARCHIVE_IMAGE_PEEK_BYTES, mime } : { kind: 'facts', reason: 'too-large' };
  }
  const visual = getFileVisualKind(entry.path);
  const textual =
    family.viewer === 'text' ||
    family.viewer === 'notebook' ||
    family.viewer === 'diagram' ||
    family.viewer === 'whiteboard' ||
    family.viewer === 'email' ||
    family.format === 'csv' ||
    family.format === 'tsv' ||
    visual === 'code' ||
    visual === 'text';
  if (textual) {
    return entry.size <= ARCHIVE_TEXT_PEEK_BYTES ? { kind: 'text', limit: ARCHIVE_TEXT_PEEK_BYTES } : { kind: 'facts', reason: 'too-large' };
  }
  if (family.viewer === 'unknown' && visual === 'file') {
    return entry.size <= ARCHIVE_TEXT_PEEK_BYTES ? { kind: 'sniff', limit: ARCHIVE_TEXT_PEEK_BYTES } : { kind: 'facts', reason: 'type' };
  }
  return { kind: 'facts', reason: 'type' };
}

/**
 * Bytes as text, or null when they were never text. UTF-16 with a byte-order mark is read as such;
 * everything else as UTF-8, where a NUL or a head full of replacement characters means binary.
 */
export function decodePeekText(bytes: Uint8Array): string | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const text = new TextDecoder().decode(bytes);
  return looksBinary(text) ? null : text;
}
