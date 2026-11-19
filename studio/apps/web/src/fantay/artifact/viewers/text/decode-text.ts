// SPDX-License-Identifier: AGPL-3.0-only
// Bytes → text. Most files are UTF-8; the ones that are not are, for this product's readers, usually
// GBK text saved by an older Windows program (subtitles, exported notes, logs) or UTF-16 from a
// Windows tool. The order is: a byte-order mark decides; strict UTF-8 next; GB18030 (which contains
// GBK and GB2312) when UTF-8 does not fit; Windows-1252 for Western text; otherwise the bytes are not
// text. Pure: no React, no DOM beyond `TextDecoder`.
import { looksBinary } from '../../../workspace/code/text-preview';

export interface DecodedText {
  text: string;
  /** Label for the bar. Null for UTF-8: the default is not worth a word. */
  encoding: string | null;
  /** The bytes are not text in any encoding tried here. */
  binary: boolean;
}

/** Only the head is inspected: enough to tell, and free on a large file. */
const SNIFF_BYTES = 8192;

function decode(bytes: Uint8Array, label: string, fatal: boolean): string | null {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    // Either the bytes do not fit the encoding, or this runtime does not ship it.
    return null;
  }
}

/** A NUL never appears in 8-bit text. */
function hasNul(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, SNIFF_BYTES);
  for (let index = 0; index < end; index += 1) if (bytes[index] === 0) return true;
  return false;
}

/** Share of control bytes text does not use (everything below space except tab, line breaks, form feed, escape). */
function controlShare(bytes: Uint8Array): number {
  const end = Math.min(bytes.length, SNIFF_BYTES);
  if (end === 0) return 0;
  let controls = 0;
  for (let index = 0; index < end; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c && byte !== 0x1b) controls += 1;
  }
  return controls / end;
}

export function decodeTextBytes(buffer: ArrayBuffer): DecodedText {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) return { text: '', encoding: null, binary: false };

  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decode(bytes, 'utf-16le', false) ?? '', encoding: 'UTF-16 LE', binary: false };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decode(bytes, 'utf-16be', false) ?? '', encoding: 'UTF-16 BE', binary: false };
  }
  if (hasNul(bytes)) return { text: '', encoding: null, binary: true };

  // `TextDecoder` drops a UTF-8 byte-order mark by itself.
  const utf8 = decode(bytes, 'utf-8', true);
  if (utf8 !== null) return { text: utf8, encoding: null, binary: false };

  const plausible = controlShare(bytes) < 0.02;
  if (plausible) {
    const gb = decode(bytes, 'gb18030', true);
    if (gb !== null) return { text: gb, encoding: 'GB18030', binary: false };
    const western = decode(bytes, 'windows-1252', true);
    if (western !== null) return { text: western, encoding: 'Windows-1252', binary: false };
  }

  // Mostly UTF-8 with a few damaged bytes still reads; anything worse was never text.
  const lossy = decode(bytes, 'utf-8', false) ?? '';
  return { text: lossy, encoding: null, binary: !plausible || looksBinary(lossy) };
}
