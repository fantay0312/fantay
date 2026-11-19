// SPDX-License-Identifier: AGPL-3.0-only
// Reading .eml files into what the viewer shows: decoded headers and names, the body, attachments
// with their decoded names, inline parts, and what the message as a whole is (not mail, signed,
// encrypted, cut short).
import { describe, expect, it } from 'vitest';

import { findTruncation, mailSecurity, readMail, unwrapClearSigned } from '../../../src/fantay/artifact/viewers/email/read-mail';

const encoder = new TextEncoder();

function bytesOf(text: string): ArrayBuffer {
  return encoder.encode(text.replace(/\r?\n/g, '\r\n')).buffer as ArrayBuffer;
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function read(text: string | ArrayBuffer) {
  const result = await readMail(typeof text === 'string' ? bytesOf(text) : text);
  if (!result.ok) throw new Error(`expected a message, got ${result.code}`);
  return result.message;
}

const ATTACHMENTS = `From: =?utf-8?b?${b64('陈一鸣')}?= <chen@example.test>
To: lin@example.test
Subject: =?utf-8?b?${b64('报价单和设计稿')}?=
Date: Thu, 15 Oct 2026 16:48:00 +0800
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="mix"

--mix
Content-Type: text/plain; charset=utf-8

附件请查收。
--mix
Content-Type: application/pdf
Content-Transfer-Encoding: base64
Content-Disposition: attachment;
 filename*=utf-8''%E6%8A%A5%E4%BB%B7%E5%8D%95.pdf

JVBERi0xLjQK
--mix
Content-Type: application/zip; name="=?UTF-8?B?${b64('设计稿.zip')}?="
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="=?UTF-8?B?${b64('设计稿.zip')}?="

UEsDBBQAAAAIAA==
--mix
Content-Type: image/png
Content-Transfer-Encoding: base64
Content-Disposition: attachment;
 filename*0*=utf-8''%E7%9C%8B%E6%9D%BF;
 filename*1*=%2Epng

iVBORw0KGgo=
--mix--
`;

describe('readMail', () => {
  it('decodes an encoded subject and a UTF-8 body', async () => {
    const message = await read(`From: Lin Xia <lin@example.test>
To: Morning Coffee <hello@example.test>
Subject: =?UTF-8?B?5pqC5YGc6K6i6ZiF?=
Date: Wed, 14 Oct 2026 09:31:00 +0800
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8

你好，我想把订阅暂停两周，谢谢。
`);
    expect(message.subject).toBe('暂停订阅');
    expect(message.from).toEqual([{ name: 'Lin Xia', address: 'lin@example.test' }]);
    expect(message.to).toEqual([{ name: 'Morning Coffee', address: 'hello@example.test' }]);
    expect(message.date).toBe('2026-10-14T01:31:00.000Z');
    expect(message.text?.trim()).toBe('你好，我想把订阅暂停两周，谢谢。');
    expect(message.html).toBeNull();
    expect(message.security).toBe('none');
    expect(message.truncated).toBeNull();
  });

  it('reads a GBK subject, GBK names and a quoted-printable GBK body', async () => {
    const gbkB64 = (text: string): string => Buffer.from(new Uint8Array(gbk(text))).toString('base64');
    const message = await read(`From: =?GBK?B?${gbkB64('赵小琳')}?= <zhao@example.test>
To: li@example.test
Subject: =?GBK?B?${gbkB64('十月门店销售汇总')}?=
Date: Sat, 31 Oct 2026 17:05:00 +0800
MIME-Version: 1.0
Content-Type: text/plain; charset="gbk"
Content-Transfer-Encoding: quoted-printable

=C0=EE=BE=AD=C0=ED=C4=FA=BA=C3
`);
    expect(message.subject).toBe('十月门店销售汇总');
    expect(message.from[0]?.name).toBe('赵小琳');
    expect(message.text?.trim()).toBe('李经理您好');
  });

  it('decodes RFC 2231 (with continuations) and RFC 2047 attachment names', async () => {
    const message = await read(ATTACHMENTS);
    expect(message.attachments.map((attachment) => [attachment.filename, attachment.mimeType])).toEqual([
      ['报价单.pdf', 'application/pdf'],
      ['设计稿.zip', 'application/zip'],
      ['看板.png', 'image/png'],
    ]);
    expect(new Uint8Array(message.attachments[0]?.content ?? new ArrayBuffer(0)).slice(0, 4)).toEqual(encoder.encode('%PDF'));
    expect(message.attachments.every((attachment) => !attachment.incomplete && !attachment.related)).toBe(true);
  });

  it('keeps an inline cid part with its normalised Content-ID', async () => {
    const message = await read(`From: news@example.test
To: lin@example.test
Subject: News
MIME-Version: 1.0
Content-Type: multipart/related; boundary="rel"

--rel
Content-Type: text/html; charset=utf-8

<p>Hi <img src="cid:Logo@News.Example"></p>
--rel
Content-Type: image/png
Content-Transfer-Encoding: base64
Content-ID: <Logo@News.Example>
Content-Disposition: inline; filename=logo.png

iVBORw0KGgo=
--rel--
`);
    expect(message.html).toContain('cid:Logo@News.Example');
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({ contentId: 'logo@news.example', related: true, filename: 'logo.png' });
  });

  it('says when a file is not mail, is empty, or is binary', async () => {
    expect(await readMail(bytesOf('{\n  "name": "not mail"\n}\n'))).toEqual({ ok: false, code: 'not-mail' });
    expect(await readMail(bytesOf('# A note\n\nJust markdown.\n'))).toEqual({ ok: false, code: 'not-mail' });
    expect(await readMail(new ArrayBuffer(0))).toEqual({ ok: false, code: 'empty' });
    expect(await readMail(bytesOf('  \n\n \t'))).toEqual({ ok: false, code: 'empty' });
    expect(await readMail(new Uint8Array([0x46, 0x72, 0x6f, 0x6d, 0x3a, 0, 1, 2]).buffer)).toEqual({ ok: false, code: 'not-mail' });
  });

  it('reads a message with no subject and no body', async () => {
    const message = await read('From: Lin Xia <lin@example.test>\nTo: wang@example.test\nDate: Thu, 15 Oct 2026 11:02:00 +0800\n\n');
    expect(message.subject).toBeNull();
    expect(message.text).toBeNull();
    expect(message.html).toBeNull();
  });

  it('finds where a cut file stops and marks the attachment that was being written', async () => {
    const cut = ATTACHMENTS.slice(0, ATTACHMENTS.indexOf('UEsDB') + 6);
    const message = await read(cut);
    expect(message.truncated).toEqual({ part: 'attachment', filename: '设计稿.zip' });
    expect(message.attachments.map((attachment) => [attachment.filename, attachment.incomplete])).toEqual([
      ['报价单.pdf', false],
      ['设计稿.zip', true],
    ]);
    const body = ATTACHMENTS.slice(0, ATTACHMENTS.indexOf('附件请查收') + 3);
    expect((await read(body)).truncated).toEqual({ part: 'body' });
    expect(findTruncation(ATTACHMENTS)).toBeNull();
  });

  it('shows the content of a signed message and leaves the signature out of the attachments', async () => {
    const message = await read(`From: chen@example.test
To: lin@example.test
Subject: Signed
MIME-Version: 1.0
Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="sig"

--sig
Content-Type: text/plain; charset=utf-8

合同终稿已确认。
--sig
Content-Type: application/pkcs7-signature; name=smime.p7s
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename=smime.p7s

MIIBAA==
--sig--
`);
    expect(message.security).toBe('signed');
    expect(message.text?.trim()).toBe('合同终稿已确认。');
    expect(message.attachments).toEqual([]);
  });

  it('shows nothing of an encrypted message but its headers', async () => {
    const smime = await read(`From: chen@example.test
To: lin@example.test
Subject: Payslip
MIME-Version: 1.0
Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name=smime.p7m
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename=smime.p7m

MIIBAA==
`);
    expect(smime.security).toBe('encrypted');
    expect(smime.subject).toBe('Payslip');
    expect(smime.attachments).toEqual([]);
    const pgp = await read('From: a@example.test\nSubject: x\n\n-----BEGIN PGP MESSAGE-----\n\nhQEMA\n-----END PGP MESSAGE-----\n');
    expect(pgp.security).toBe('encrypted');
    expect(pgp.text).toBeNull();
  });

  it('classifies the wrapping of a message', () => {
    expect(mailSecurity('multipart/encrypted; protocol="application/pgp-encrypted"', undefined)).toBe('encrypted');
    expect(mailSecurity('application/pkcs7-mime; smime-type=signed-data', undefined)).toBe('sealed');
    expect(mailSecurity('multipart/signed; protocol="application/pgp-signature"', undefined)).toBe('signed');
    expect(mailSecurity('text/plain', 'Hello')).toBe('none');
  });

  it('unwraps inline PGP signed text', async () => {
    const text = 'Hi\n-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nThe signed words.\n- -- not a signature\n-----BEGIN PGP SIGNATURE-----\n\niQEz\n-----END PGP SIGNATURE-----\nAfter\n';
    expect(unwrapClearSigned(text)).toBe('Hi\nThe signed words.\n-- not a signature\nAfter\n');
    const message = await read(`From: a@example.test\nSubject: x\n\n${text}`);
    expect(message.security).toBe('signed');
    expect(message.text).toContain('The signed words.');
    expect(message.text).not.toContain('BEGIN PGP');
  });

  it('turns a message past the part limit into "too complex", not a frozen tab', async () => {
    const parts = Array.from({ length: 2100 }, (_, index) => `--b\nContent-Type: text/plain\n\n${index}\n`).join('');
    expect(await readMail(bytesOf(`From: a@example.test\nSubject: x\nContent-Type: multipart/mixed; boundary="b"\n\n${parts}--b--\n`))).toEqual({
      ok: false,
      code: 'too-complex',
    });
  });

  it('strips direction overrides and control characters from header text', async () => {
    const message = await read(`From: "Bank\u202eevil" <a@example.test>\nSubject: =?utf-8?b?${b64('Invoice\u202efdp.exe')}?=\n\nx\n`);
    expect(message.subject).toBe('Invoicefdp.exe');
    expect(message.from[0]?.name).toBe('Bankevil');
  });
});

/** GBK bytes of a few characters, without an encoder library: the table the test needs, by hand. */
function gbk(text: string): number[] {
  const table: Record<string, [number, number]> = {
    赵: [0xd5, 0xd4], 小: [0xd0, 0xa1], 琳: [0xc1, 0xd5], 十: [0xca, 0xae], 月: [0xd4, 0xc2], 门: [0xc3, 0xc5],
    店: [0xb5, 0xea], 销: [0xcf, 0xfa], 售: [0xca, 0xdb], 汇: [0xbb, 0xe3], 总: [0xd7, 0xdc],
  };
  return [...text].flatMap((character) => table[character] ?? []);
}
