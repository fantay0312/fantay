// SPDX-License-Identifier: AGPL-3.0-only
// The words and names a message is shown with: its date in the reader's locale, who a person is, what
// an attachment is called and whether it is a picture, and the message's source as text. Everything
// here reads untrusted values and returns something safe to show or to save.
import type { MailAddress, MailAttachment } from './mail-types';

/** "2026年10月14日 09:31" / "October 14, 2026 at 09:31", plus the full form for a tooltip. */
export function formatMailDate(value: string | null, locale: string): { text: string; full: string; iso: string | null } | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { text: value, full: value, iso: null };
  try {
    const text = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
    const full = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long' }).format(date);
    return { text, full, iso: date.toISOString() };
  } catch {
    return { text: date.toISOString(), full: date.toISOString(), iso: date.toISOString() };
  }
}

/** The name a person is shown by: the display name, or the address when there is none. */
export function personName(person: MailAddress): string {
  return person.name || person.address;
}

/** "Lin Xia <lin@example.test>", for a tooltip; the address alone when the name is the address. */
export function personTitle(person: MailAddress): string {
  if (!person.name || !person.address || person.name === person.address) return person.address || person.name;
  return `${person.name} <${person.address}>`;
}

export function sameMailbox(a: MailAddress, b: MailAddress): boolean {
  return a.address !== '' && a.address.toLowerCase() === b.address.toLowerCase();
}

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/json': 'json',
  'application/ics': 'ics',
  'message/rfc822': 'eml',
  'text/calendar': 'ics',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/csv': 'csv',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
};

/**
 * A file name that is safe to show and to save: no path, no control characters, no direction
 * overrides (which can make "gpj.exe" read as "exe.jpg"), bounded. Null when nothing is left.
 */
export function cleanFileName(value: string | null): string | null {
  if (!value) return null;
  const name = value
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\\/]+/g, '_')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!name) return null;
  if (name.length <= 180) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  return name.slice(0, 180 - extension.length) + extension;
}

/** The name an attachment is shown and saved under; `fallback(n)` words "Attachment n". */
export function attachmentName(attachment: MailAttachment, position: number, fallback: (position: number) => string, forwarded: string): string {
  const clean = cleanFileName(attachment.filename);
  if (clean) return clean;
  const extension = EXTENSIONS[attachment.mimeType] ?? 'bin';
  return `${attachment.mimeType === 'message/rfc822' ? forwarded : fallback(position)}.${extension}`;
}

/** "name.tar.gz" → ["name.tar", ".gz"], so a long name can give way while its type stays in view. */
export function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || name.length - dot > 10) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif', 'image/svg+xml']);

/** The picture type of some bytes by their signature, for parts sent as application/octet-stream. */
function sniffPicture(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]): boolean => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (starts(0x42, 0x4d)) return 'image/bmp';
  return null;
}

/** The type to draw a part as a picture with, or null when it is not one this viewer draws. */
export function pictureType(attachment: Pick<MailAttachment, 'mimeType' | 'content'>): string | null {
  if (PICTURE_TYPES.has(attachment.mimeType)) return attachment.mimeType;
  if (attachment.mimeType === 'application/octet-stream' || attachment.mimeType.startsWith('image/')) {
    return sniffPicture(new Uint8Array(attachment.content, 0, Math.min(16, attachment.content.byteLength)));
  }
  return null;
}

/**
 * The message's source as text. Mail is ASCII almost always; 8-bit parts are read as UTF-8 when they
 * are, otherwise in the first character set the message names (GBK, Big5, Shift_JIS …), otherwise as
 * Windows-1252, so the source never shows a wall of replacement marks.
 */
export function decodeMailSource(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(view);
  } catch {
    const head = new TextDecoder('latin1').decode(view.subarray(0, Math.min(view.length, 256 * 1024)));
    const charset = /charset\s*=\s*"?([\w.:-]{2,40})/i.exec(head)?.[1];
    if (charset) {
      try {
        return new TextDecoder(charset).decode(view);
      } catch {
        // A name TextDecoder does not know.
      }
    }
    return new TextDecoder('windows-1252').decode(view);
  }
}
