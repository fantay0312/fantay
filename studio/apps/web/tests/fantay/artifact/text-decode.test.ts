// SPDX-License-Identifier: AGPL-3.0-only
// Bytes → text: which encoding a file is read in, and when its bytes are not text at all.
import { describe, expect, it } from 'vitest';

import { decodeTextBytes } from '../../../src/fantay/artifact/viewers/text/decode-text';

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

function utf8(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe('decodeTextBytes', () => {
  it('reads UTF-8 without naming it', () => {
    expect(decodeTextBytes(utf8('手冲咖啡 café'))).toEqual({ text: '手冲咖啡 café', encoding: null, binary: false });
    expect(decodeTextBytes(new ArrayBuffer(0))).toEqual({ text: '', encoding: null, binary: false });
  });

  it('drops a UTF-8 byte-order mark', () => {
    expect(decodeTextBytes(bytes(0xef, 0xbb, 0xbf, 0x68, 0x69))).toEqual({ text: 'hi', encoding: null, binary: false });
  });

  it('reads UTF-16 by its byte-order mark, although it is full of NUL bytes', () => {
    expect(decodeTextBytes(bytes(0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65))).toEqual({ text: '中文', encoding: 'UTF-16 LE', binary: false });
    expect(decodeTextBytes(bytes(0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87))).toEqual({ text: '中文', encoding: 'UTF-16 BE', binary: false });
  });

  it('reads GBK text as GB18030 and says so', () => {
    // "中文字幕\n" in GBK.
    const decoded = decodeTextBytes(bytes(0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xd6, 0xc4, 0xbb, 0x0a));
    expect(decoded).toEqual({ text: '中文字幕\n', encoding: 'GB18030', binary: false });
  });

  it('reads Western 8-bit text that is neither UTF-8 nor GB18030', () => {
    // "é\n": 0xE9 cannot be followed by a line break in GB18030.
    const decoded = decodeTextBytes(bytes(0x63, 0x61, 0x66, 0xe9, 0x0a));
    expect(decoded).toEqual({ text: 'café\n', encoding: 'Windows-1252', binary: false });
  });

  it('calls bytes with a NUL binary', () => {
    expect(decodeTextBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x00, 0x01)).binary).toBe(true);
  });

  it('calls bytes full of control characters binary', () => {
    const noise = Array.from({ length: 400 }, (_, index) => (index % 2 === 0 ? 0x01 + (index % 7) : 0xf0 + (index % 15)));
    expect(decodeTextBytes(bytes(...noise)).binary).toBe(true);
  });

  it('keeps terminal escape codes: they are text', () => {
    expect(decodeTextBytes(utf8('\u001b[31mred\u001b[0m')).binary).toBe(false);
  });
});
