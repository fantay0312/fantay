// SPDX-License-Identifier: AGPL-3.0-only
// The plain data a message is read into (`read-mail.ts`, in a worker) and shown from (the viewer). It
// lives apart from the reader so that the main thread never loads the MIME parser: only the worker
// does.

/** Larger files are not read: the whole message and its decoded parts are held in memory. */
export const MAX_MAIL_BYTES = 25 * 1024 * 1024;

export interface MailAddress {
  /** Decoded display name; empty when the header gives none. */
  name: string;
  /** Empty for a group without members ("undisclosed-recipients:;"). */
  address: string;
}

export interface MailAttachment {
  /** Position in the message: the identity of the part. */
  index: number;
  /** Decoded file name as the sender wrote it, or null. Clean it before showing or saving it. */
  filename: string | null;
  mimeType: string;
  disposition: string | null;
  /** Content-ID without its angle brackets, lowercased, for `cid:` addresses; null when absent. */
  contentId: string | null;
  /** In a multipart/related tree: a resource of the body rather than a file sent along. */
  related: boolean;
  content: ArrayBuffer;
  /** The file ends inside this part: only its first bytes are here. */
  incomplete: boolean;
}

/**
 * `signed`: the content is readable and carries a signature nobody here checks. `encrypted`: the
 * content cannot be read without a key. `sealed`: S/MIME opaque signed or compressed data, whose
 * content is packed inside a binary structure this viewer does not unpack.
 */
export type MailSecurity = 'none' | 'signed' | 'encrypted' | 'sealed';

/** Where the file ended before the message did. */
export type MailTruncation = { part: 'body' } | { part: 'attachment'; filename: string | null };

export interface MailMessage {
  subject: string | null;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  /** ISO 8601 when the Date header parsed; otherwise the header as written; null when absent. */
  date: string | null;
  html: string | null;
  text: string | null;
  /** What the reader sees as attachments: signature and key parts are left out. */
  attachments: MailAttachment[];
  security: MailSecurity;
  truncated: MailTruncation | null;
}

export type MailReadFailure = 'empty' | 'too-large' | 'not-mail' | 'too-complex' | 'failed';
export type MailReadResult = { ok: true; message: MailMessage } | { ok: false; code: MailReadFailure };

export function normalizeContentId(value: string): string {
  let id = value.trim();
  if (id.startsWith('<') && id.endsWith('>')) id = id.slice(1, -1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // A stray `%` is part of the name.
  }
  return id.trim().toLowerCase();
}
