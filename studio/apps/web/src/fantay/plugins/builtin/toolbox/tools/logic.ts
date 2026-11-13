// SPDX-License-Identifier: AGPL-3.0-only
// The conversions behind the built-in 工具台 tools, kept free of React so they can be tested on their own.
// Every function returns a result object instead of throwing; the panels turn the error codes into text.

/* ── JSON ───────────────────────────────────────────────────────────────────────────────── */

export type JsonMode = 'format' | 'minify';

export type JsonResult =
  | { ok: true; text: string }
  | { ok: false; message: string; line?: number; column?: number };

type RawJson = { rawJSON?: (text: string) => unknown };

/* Where the engine supports JSON.rawJSON, numbers are written back exactly as they were typed, so a 64-bit
   id or `1.50` survives formatting instead of being rounded through a double. */
function keepNumberText(_key: string, value: unknown, context?: { source?: string }): unknown {
  const rawJSON = (JSON as unknown as RawJson).rawJSON;
  return typeof value === 'number' && rawJSON && typeof context?.source === 'string' ? rawJSON(context.source) : value;
}

/** Line and column (1-based) of a JSON.parse failure, read from the engine's message. */
function locate(source: string, message: string): { line?: number; column?: number } {
  const lineColumn = /line (\d+) column (\d+)/i.exec(message);
  if (lineColumn) return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  const position = /position (\d+)/i.exec(message);
  if (!position) return {};
  const index = Math.min(Number(position[1]), source.length);
  const before = source.slice(0, index);
  return { line: before.split('\n').length, column: index - before.lastIndexOf('\n') };
}

export function transformJson(source: string, mode: JsonMode): JsonResult {
  let value: unknown;
  try {
    value = JSON.parse(source, keepNumberText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message, ...locate(source, message) };
  }
  return { ok: true, text: JSON.stringify(value, null, mode === 'format' ? 2 : undefined) ?? '' };
}

/* ── Base64 and URL ─────────────────────────────────────────────────────────────────────── */

export type Codec = 'base64' | 'url';
export type Direction = 'encode' | 'decode';
export type CodecError = 'invalidBase64' | 'invalidUtf8' | 'invalidUrl' | 'invalidText';
export type CodecResult = { ok: true; text: string } | { ok: false; error: CodecError };

function base64Encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  // Chunked, so a large input does not overflow the argument list.
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/** Accepts the standard and the URL-safe alphabet, line breaks, and missing padding. */
function base64Decode(input: string): CodecResult {
  const compact = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return { ok: false, error: 'invalidBase64' };
  const body = compact.replace(/=+$/, '');
  const padded = compact.length !== body.length;
  if (body.length % 4 === 1 || (padded && compact.length % 4 !== 0)) return { ok: false, error: 'invalidBase64' };
  let binary: string;
  try {
    binary = atob(body + '='.repeat((4 - (body.length % 4)) % 4));
  } catch {
    return { ok: false, error: 'invalidBase64' };
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  try {
    // ignoreBOM keeps a leading U+FEFF, so encoding and decoding give back exactly the same text.
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { ok: false, error: 'invalidUtf8' };
  }
}

export function transcode(codec: Codec, direction: Direction, input: string): CodecResult {
  if (codec === 'base64') return direction === 'encode' ? { ok: true, text: base64Encode(input) } : base64Decode(input);
  try {
    return { ok: true, text: direction === 'encode' ? encodeURIComponent(input) : decodeURIComponent(input) };
  } catch {
    return { ok: false, error: direction === 'encode' ? 'invalidText' : 'invalidUrl' };
  }
}

/* ── Timestamps ─────────────────────────────────────────────────────────────────────────── */

export type StampUnit = 'seconds' | 'milliseconds';
export type TimeError = 'invalidStamp' | 'outOfRange' | 'invalidDate';
export type StampResult = { ok: true; unit: StampUnit; ms: number } | { ok: false; error: TimeError };
export type DateResult = { ok: true; ms: number } | { ok: false; error: TimeError };

/** The largest distance from the epoch a Date can hold (ECMA-262 TimeClip). */
const MAX_MS = 8.64e15;
/** Below this a value is read as seconds (up to the year 5138), from it on as milliseconds (from 1973). */
const MILLISECONDS_FROM = 1e11;

export function parseTimestamp(raw: string): StampResult {
  const compact = raw.trim().replace(/[\s,_]/g, '');
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(compact)) return { ok: false, error: 'invalidStamp' };
  const value = Number(compact);
  const unit: StampUnit = Math.abs(value) >= MILLISECONDS_FROM ? 'milliseconds' : 'seconds';
  const ms = Math.round(unit === 'seconds' ? value * 1000 : value);
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_MS) return { ok: false, error: 'outOfRange' };
  return { ok: true, unit, ms };
}

function pad(value: number, width = 2): string {
  return String(Math.abs(value)).padStart(width, '0');
}

/** `2026-11-13 22:15:03` in local time, with `.123` only when the milliseconds are not zero. */
export function formatLocal(date: Date): string {
  const year = date.getFullYear();
  const yearText = year < 0 ? `-${pad(year, 6)}` : year > 9999 ? `+${pad(year, 6)}` : pad(year, 4);
  const text = `${yearText}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const ms = date.getMilliseconds();
  return ms ? `${text}.${pad(ms, 3)}` : text;
}

/** The local offset in force on `date`, as `UTC+08:00`. */
export function formatOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const abs = Math.abs(minutes);
  return `UTC${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The IANA zone the window runs in (`Asia/Shanghai`), or '' when the engine does not say. */
export function localZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

const LOCAL_DATE_TIME = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:[.,](\d{1,3})\d*)?)?)?$/i;

/**
 * A date-time without a zone (`2026-11-13 22:15:03`, `2026/11/13`, `2026-11-13T22:15`) is read in local time,
 * the date-only form included. Anything else with a four-digit year, such as an ISO 8601 string with `Z` or an
 * offset, goes to Date.parse.
 */
export function parseDateTime(raw: string): DateResult {
  const text = raw.trim();
  const local = LOCAL_DATE_TIME.exec(text);
  if (local) {
    const [, yearText, monthText, dayText, hourText = '0', minuteText = '0', secondText = '0', fraction = ''] = local;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
      return { ok: false, error: 'invalidDate' };
    }
    const date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(hour, minute, second, fraction ? Number(fraction.padEnd(3, '0')) : 0);
    return { ok: true, ms: date.getTime() };
  }
  // Date.parse reads a bare number such as "12" as a date in 2001; only text that names a year goes there.
  if (!/\d{4}/.test(text) || /^[+-]?\d+(?:\.\d+)?$/.test(text)) return { ok: false, error: 'invalidDate' };
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? { ok: false, error: 'invalidDate' } : { ok: true, ms };
}
