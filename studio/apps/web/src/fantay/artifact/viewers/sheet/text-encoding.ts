// SPDX-License-Identifier: AGPL-3.0-only
// Which encoding delimited text is in. Most files are UTF-8; exports from older Chinese, Japanese
// and Korean software are not, and read as UTF-8 they turn into noise. A byte-order mark decides
// when there is one; otherwise strict UTF-8 is tried first and the legacy encodings after it, taking
// the first that decodes a sample without a single replacement character. Pure, so the worker (which
// parses) and the window (which shows the source) read the bytes the same way.

/** Tried in this order once UTF-8 has failed. The last one accepts any byte. */
const LEGACY_ENCODINGS = ['gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-1252'] as const;
const SAMPLE_BYTES = 128 * 1024;

export interface DecodedText {
  text: string;
  /** A TextDecoder label: 'utf-8', 'utf-16le', 'gb18030', … */
  encoding: string;
}

function bomEncoding(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

/** UTF-16 without a mark: plain text in it has a zero in every other byte. */
function unmarkedUtf16(bytes: Uint8Array): string | null {
  const length = Math.min(bytes.length, 2048) & ~1;
  if (length < 8) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index < length; index += 2) {
    if (bytes[index] === 0) evenZeros += 1;
    if (bytes[index + 1] === 0) oddZeros += 1;
  }
  const pairs = length / 2;
  if (oddZeros > pairs * 0.4 && evenZeros < pairs * 0.1) return 'utf-16le';
  if (evenZeros > pairs * 0.4 && oddZeros < pairs * 0.1) return 'utf-16be';
  return null;
}

/** The encoding to read these bytes in. */
export function detectEncoding(bytes: Uint8Array): string {
  const marked = bomEncoding(bytes) ?? unmarkedUtf16(bytes);
  if (marked) return marked;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    /* Not UTF-8: try the legacy encodings on a sample. */
  }
  // Cut the sample at a line break so a two-byte character is not split at its end.
  let end = Math.min(bytes.length, SAMPLE_BYTES);
  if (end < bytes.length) {
    const lineBreak = bytes.lastIndexOf(0x0a, end);
    if (lineBreak > 0) end = lineBreak;
  }
  const sample = bytes.subarray(0, end);
  for (const encoding of LEGACY_ENCODINGS) {
    try {
      if (!new TextDecoder(encoding).decode(sample).includes('�')) return encoding;
    } catch {
      /* This runtime does not know the label: try the next one. */
    }
  }
  return 'utf-8';
}

/** Decodes with a known encoding; the byte-order mark is dropped. */
export function decodeWith(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function decodeText(bytes: Uint8Array): DecodedText {
  const encoding = detectEncoding(bytes);
  return { text: decodeWith(bytes, encoding), encoding };
}
