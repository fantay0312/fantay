// SPDX-License-Identifier: AGPL-3.0-only
// Reads an .eml file into plain data for the viewer. postal-mime does the MIME work (headers in
// RFC 2047 and 2231, transfer encodings, character sets through `TextDecoder`, multipart trees,
// inline parts); this file adds what a reader needs to know about the message as a whole: is it mail
// at all, is it signed or encrypted, does the file end before the message does. It runs in a worker
// (`mail.worker.ts`), so everything it returns is structured-clone data: strings, numbers and the
// attachments' bytes. Nothing here is trusted: names and addresses are shown as text, the HTML body
// is sanitised on the other side (`sanitize-mail.ts`).
import PostalMime, { type Address, type Header } from 'postal-mime';

import {
  MAX_MAIL_BYTES,
  normalizeContentId,
  type MailAddress,
  type MailAttachment,
  type MailReadResult,
  type MailSecurity,
  type MailTruncation,
} from './mail-types';

/** Every address field is cut here: a header with thousands of names is not read to the end. */
const MAX_ADDRESSES = 2000;
const MAX_HEADER_TEXT = 2000;

/** Header fields that only mail carries; a file without any of them is not a message. */
const MAIL_FIELDS = new Set([
  'from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'mime-version', 'received', 'return-path', 'sender',
  'reply-to', 'delivered-to', 'in-reply-to', 'references', 'content-type', 'x-mailer', 'dkim-signature', 'thread-topic',
]);

/** Parts that belong to a signature or an encryption envelope, not to what was sent. */
const ENVELOPE_TYPES = new Set([
  'application/pkcs7-signature', 'application/x-pkcs7-signature', 'application/pgp-signature', 'application/pgp-encrypted',
  'application/pkcs7-mime', 'application/x-pkcs7-mime', 'application/pgp-keys',
]);

const LIMITS = { maxNestingDepth: 64, maxPartCount: 2000, maxRfc822NestingDepth: 5 } as const;

function isBlank(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return false;
  }
  return true;
}

/** A NUL byte near the start: a binary file, whatever its name says. */
function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let index = 0; index < end; index += 1) if (bytes[index] === 0) return true;
  return false;
}

export function looksLikeMail(headers: readonly Pick<Header, 'key'>[]): boolean {
  return headers.some((header) => MAIL_FIELDS.has(header.key));
}

/** Header text as it will be shown: no control characters, no direction overrides, bounded. */
function headerText(value: string | undefined): string | null {
  if (!value) return null;
  const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return clean ? clean.slice(0, MAX_HEADER_TEXT) : null;
}

function addressesOf(value: Address | Address[] | undefined): MailAddress[] {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const out: MailAddress[] = [];
  const push = (name: string | undefined, address: string | undefined): void => {
    const entry = { name: headerText(name) ?? '', address: headerText(address) ?? '' };
    if ((entry.name || entry.address) && out.length < MAX_ADDRESSES) out.push(entry);
  };
  for (const entry of list) {
    if (entry.group !== undefined) {
      // An empty group is still what the sender wrote in the field: show its name.
      if (entry.group.length === 0) push(entry.name, '');
      for (const member of entry.group) push(member.name, member.address);
    } else {
      push(entry.name, entry.address);
    }
  }
  return out;
}

function headerValue(headers: readonly Header[], key: string): string {
  return headers.find((header) => header.key === key)?.value ?? '';
}

/** The message's own wrapping, read from its top-level Content-Type and, for inline PGP, its text. */
export function mailSecurity(contentType: string, text: string | undefined): MailSecurity {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'multipart/encrypted') return 'encrypted';
  if (type === 'application/pkcs7-mime' || type === 'application/x-pkcs7-mime') {
    const kind = /smime-type\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
    return kind === 'signed-data' || kind === 'compressed-data' || kind === 'certs-only' ? 'sealed' : 'encrypted';
  }
  if (type === 'multipart/signed') return 'signed';
  if (text && /^-----BEGIN PGP MESSAGE-----\s*$/m.test(text)) return 'encrypted';
  if (text && /^-----BEGIN PGP SIGNED MESSAGE-----\s*$/m.test(text)) return 'signed';
  return 'none';
}

/**
 * Inline PGP signed text, as it was written: the armour line and hash header before it and the
 * signature block after it are taken away, and dash-escaped lines ("- --") are put back.
 */
export function unwrapClearSigned(text: string): string {
  const head = /^-----BEGIN PGP SIGNED MESSAGE-----[ \t]*\n(?:[A-Za-z-]+:[^\n]*\n)*[ \t]*\n/m.exec(text);
  if (!head) return text;
  const start = head.index + head[0].length;
  const signature = /^-----BEGIN PGP SIGNATURE-----[ \t]*$/m.exec(text.slice(start));
  const end = signature ? start + signature.index : text.length;
  const close = signature ? /^-----END PGP SIGNATURE-----[ \t]*\n?/m.exec(text.slice(end)) : null;
  const after = close ? text.slice(end + close.index + close[0].length) : '';
  const signed = text.slice(start, end).replace(/^- /gm, '').replace(/\n$/, '');
  return `${text.slice(0, head.index)}${signed}${after ? `\n${after}` : ''}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where the file stops before the message does. A multipart message closes every part list it opens
 * with `--boundary--`; when one is opened and never closed, the file was cut, and the part after the
 * last delimiter is the one that was being written. A single-part base64 body whose length is not a
 * whole number of quanta was cut too. `source` is the file read byte for byte (latin1).
 */
export function findTruncation(source: string): { attachment: boolean } | null {
  const boundaries = new Set<string>();
  for (const match of source.matchAll(/boundary\s*=\s*(?:"([^"\r\n]{1,200})"|([^\s;"]{1,200}))/gi)) {
    const boundary = match[1] ?? match[2];
    if (boundary) boundaries.add(boundary);
  }
  let open = false;
  let lastDelimiter = -1;
  let lastBoundary = '';
  for (const boundary of boundaries) {
    const delimiter = new RegExp(`(?:^|\\n)--${escapeRegExp(boundary)}(--)?[ \\t]*\\r?(?:\\n|$)`, 'g');
    let opened = false;
    let closed = false;
    for (const match of source.matchAll(delimiter)) {
      if (match[1]) closed = true;
      else opened = true;
      const at = (match.index ?? 0) + (match[0].startsWith('\n') ? 1 : 0);
      if (at > lastDelimiter) {
        lastDelimiter = at;
        lastBoundary = match[1] ? '' : boundary;
      }
    }
    if (opened && !closed) open = true;
  }

  if (open) {
    if (!lastBoundary) return { attachment: false };
    // The headers of the part that was cut: an attachment says so, or names a file.
    const partStart = source.indexOf('\n', lastDelimiter) + 1;
    const headerEnd = source.slice(partStart).search(/\r?\n\r?\n/);
    const headers = (headerEnd === -1 ? source.slice(partStart) : source.slice(partStart, partStart + headerEnd)).toLowerCase();
    const type = /content-type:\s*([^\s;]+)/.exec(headers)?.[1] ?? 'text/plain';
    const attachment =
      /content-disposition:\s*attachment/.test(headers) || /\b(?:file)?name\*?(?:\d+\*?)?\s*=/.test(headers) || !/^(?:text|multipart)\//.test(type);
    return { attachment };
  }

  // A single part in base64: the encoded text comes in groups of four characters.
  const bodyAt = source.search(/\r?\n\r?\n/);
  if (bodyAt === -1 || boundaries.size > 0) return null;
  const head = source.slice(0, bodyAt).toLowerCase();
  if (!/content-transfer-encoding:\s*base64/.test(head)) return null;
  const encoded = source.slice(bodyAt).replace(/[^A-Za-z0-9+/=]/g, '');
  return encoded.length % 4 === 0 ? null : { attachment: !/content-type:\s*text\//.test(head) };
}

function bufferOf(content: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (typeof content === 'string') return new TextEncoder().encode(content).buffer as ArrayBuffer;
  if (content instanceof Uint8Array) return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
  return content;
}

/** Never rejects. */
export async function readMail(bytes: ArrayBuffer): Promise<MailReadResult> {
  const view = new Uint8Array(bytes);
  if (view.length === 0 || isBlank(view)) return { ok: false, code: 'empty' };
  if (view.length > MAX_MAIL_BYTES) return { ok: false, code: 'too-large' };
  if (looksBinary(view)) return { ok: false, code: 'not-mail' };

  let email: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    email = await PostalMime.parse(bytes, { attachmentEncoding: 'arraybuffer', ...LIMITS });
  } catch (cause) {
    const code = (cause as { code?: unknown } | null)?.code;
    return { ok: false, code: typeof code === 'string' && code.startsWith('EMAX') ? 'too-complex' : 'failed' };
  }
  if (!looksLikeMail(email.headers)) return { ok: false, code: 'not-mail' };

  const security = mailSecurity(headerValue(email.headers, 'content-type'), email.text);
  let text = email.text ?? null;
  if (security === 'signed' && text && /^-----BEGIN PGP SIGNED MESSAGE-----/m.test(text)) text = unwrapClearSigned(text);
  const sealed = security === 'encrypted' || security === 'sealed';

  const attachments: MailAttachment[] = [];
  email.attachments.forEach((attachment, index) => {
    // An encrypted or packed message has no readable parts; a signature is not an attachment.
    if (sealed || ENVELOPE_TYPES.has(attachment.mimeType)) return;
    attachments.push({
      index,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      disposition: attachment.disposition,
      contentId: attachment.contentId ? normalizeContentId(attachment.contentId) : null,
      related: attachment.related === true,
      content: bufferOf(attachment.content),
      incomplete: false,
    });
  });

  let truncated: MailTruncation | null = null;
  const cut = findTruncation(new TextDecoder('latin1').decode(view));
  if (cut) {
    const last = cut.attachment ? attachments[attachments.length - 1] : undefined;
    if (last) {
      last.incomplete = true;
      truncated = { part: 'attachment', filename: last.filename };
    } else {
      truncated = cut.attachment ? { part: 'attachment', filename: null } : { part: 'body' };
    }
  }

  return {
    ok: true,
    message: {
      subject: headerText(email.subject),
      from: addressesOf(email.from),
      to: addressesOf(email.to),
      cc: addressesOf(email.cc),
      bcc: addressesOf(email.bcc),
      replyTo: addressesOf(email.replyTo),
      date: headerText(email.date),
      html: sealed ? null : (email.html ?? null),
      text: sealed ? null : text,
      attachments,
      security,
      truncated,
    },
  };
}
