// SPDX-License-Identifier: AGPL-3.0-only
// A plain-text body read the way a person reads it (reply, attribution, quotes by level, signature),
// addresses found in it, and the names, dates and source text the viewer shows.
import { describe, expect, it } from 'vitest';

import {
  attachmentName,
  cleanFileName,
  decodeMailSource,
  formatMailDate,
  pictureType,
  splitExtension,
} from '../../../src/fantay/artifact/viewers/email/mail-format';
import { findAddresses, readPlainText } from '../../../src/fantay/artifact/viewers/email/plain-text';
import type { MailAttachment } from '../../../src/fantay/artifact/viewers/email/mail-types';

describe('readPlainText', () => {
  it('reads a reply, its attribution, nested quotes and the signature', () => {
    const nodes = readPlainText(
      [
        '王老师好，',
        '',
        '收到，周四可以。',
        '',
        '在 2026年10月13日 周一 18:02，王敏 <wangmin@example.test> 写道：',
        '> 小林，',
        '>',
        '> 评审改到周四。',
        '>',
        '> 在 2026年10月12日，林夏 写道：',
        '>> 时间定了吗？',
        '',
        '-- ',
        '林夏 · 产品设计',
        'https://design.example.test',
      ].join('\n'),
    );
    expect(nodes).toEqual([
      { kind: 'lines', role: 'text', text: '王老师好，\n\n收到，周四可以。' },
      { kind: 'lines', role: 'attribution', text: '在 2026年10月13日 周一 18:02，王敏 <wangmin@example.test> 写道：' },
      {
        kind: 'quote',
        children: [
          { kind: 'lines', role: 'text', text: '小林，\n\n评审改到周四。' },
          { kind: 'lines', role: 'attribution', text: '在 2026年10月12日，林夏 写道：' },
          { kind: 'quote', children: [{ kind: 'lines', role: 'text', text: '时间定了吗？' }] },
        ],
      },
      { kind: 'lines', role: 'signature', text: '-- \n林夏 · 产品设计\nhttps://design.example.test' },
    ]);
  });

  it('treats everything under an "original message" rule as a quote', () => {
    const nodes = readPlainText('好的。\n\n------------------ 原始邮件 ------------------\n发件人: 王敏\n主题: 评审\n\n请确认时间。');
    expect(nodes[0]).toEqual({ kind: 'lines', role: 'text', text: '好的。' });
    expect(nodes[1]).toEqual({ kind: 'lines', role: 'attribution', text: '------------------ 原始邮件 ------------------' });
    expect(nodes[2]).toEqual({ kind: 'quote', children: [{ kind: 'lines', role: 'text', text: '发件人: 王敏\n主题: 评审\n\n请确认时间。' }] });
  });

  it('keeps line breaks and leading spaces as written', () => {
    expect(readPlainText('  a\n    b\n\n\nc')).toEqual([{ kind: 'lines', role: 'text', text: '  a\n    b\n\n\nc' }]);
  });
});

describe('findAddresses', () => {
  it('finds web and mail addresses, without the punctuation after them', () => {
    expect(findAddresses('地址是 https://docs.example.test/review/2026-10，或者发到 design@example.test。见 www.example.test.')).toEqual([
      { kind: 'text', text: '地址是 ' },
      { kind: 'url', text: 'https://docs.example.test/review/2026-10' },
      { kind: 'text', text: '，或者发到 ' },
      { kind: 'mail', text: 'design@example.test' },
      { kind: 'text', text: '。见 ' },
      { kind: 'url', text: 'www.example.test' },
      { kind: 'text', text: '.' },
    ]);
    expect(findAddresses('(see https://en.wikipedia.org/wiki/Mail_(protocol))')).toEqual([
      { kind: 'text', text: '(see ' },
      { kind: 'url', text: 'https://en.wikipedia.org/wiki/Mail_(protocol)' },
      { kind: 'text', text: ')' },
    ]);
  });
});

describe('mail-format', () => {
  it('writes the date in the reader\'s locale, with the time', () => {
    const date = formatMailDate('2026-10-14T01:31:00.000Z', 'zh-CN');
    expect(date?.iso).toBe('2026-10-14T01:31:00.000Z');
    expect(date?.text).toMatch(/^2026年10月14日 \d{2}:31$/);
    expect(formatMailDate('sometime last week', 'en')).toEqual({ text: 'sometime last week', full: 'sometime last week', iso: null });
    expect(formatMailDate(null, 'en')).toBeNull();
  });

  it('cleans file names: no path, no control or direction characters', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(cleanFileName('invoice\u202egpj.exe')).toBe('invoicegpj.exe');
    expect(cleanFileName('  报价单.pdf  ')).toBe('报价单.pdf');
    expect(cleanFileName('...')).toBeNull();
    expect(cleanFileName(null)).toBeNull();
  });

  it('names an attachment that has no name', () => {
    const part = (mimeType: string): MailAttachment => ({
      index: 0, filename: null, mimeType, disposition: null, contentId: null, related: false, content: new ArrayBuffer(0), incomplete: false,
    });
    expect(attachmentName(part('application/pdf'), 2, (n) => `附件 ${n}`, '转发的邮件')).toBe('附件 2.pdf');
    expect(attachmentName(part('message/rfc822'), 1, (n) => `附件 ${n}`, '转发的邮件')).toBe('转发的邮件.eml');
    expect(splitExtension('设计稿两张.zip')).toEqual(['设计稿两张', '.zip']);
  });

  it('tells pictures by type or by their first bytes', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
    expect(pictureType({ mimeType: 'application/octet-stream', content: png })).toBe('image/png');
    expect(pictureType({ mimeType: 'image/png', content: new ArrayBuffer(0) })).toBe('image/png');
    expect(pictureType({ mimeType: 'application/pdf', content: png })).toBeNull();
  });

  it('decodes the source as UTF-8, or in the charset the message names', () => {
    expect(decodeMailSource(new TextEncoder().encode('Subject: 你好\n').buffer)).toBe('Subject: 你好\n');
    // "李" in GBK, sent 8-bit.
    const gbk = new Uint8Array([...new TextEncoder().encode('Content-Type: text/plain; charset=gbk\n\n'), 0xc0, 0xee]);
    expect(decodeMailSource(gbk.buffer)).toBe('Content-Type: text/plain; charset=gbk\n\n李');
  });
});
