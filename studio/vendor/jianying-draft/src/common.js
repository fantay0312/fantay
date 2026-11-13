import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const US = 1_000_000;
export const clone = value => structuredClone(value);
export const id = () => randomUUID().toUpperCase();
export class DraftError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DraftError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
export function fail(code, message, details) { throw new DraftError(code, message, details); }
export function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${label} must be an object`);
  return value;
}
export function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('INVALID_INPUT', `Unknown ${label} field: ${key}`);
  }
}
export function number(value, label, { min = 0, positive = false, integer = false, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max ||
      (positive && value <= 0) || (integer && !Number.isSafeInteger(value))) {
    fail('INVALID_INPUT', `${label} must be a finite ${positive ? 'positive ' : ''}${integer ? 'integer ' : ''}number in ${min}..${max}`);
  }
  return value;
}
export function micros(value, label, positive = false) {
  number(value, label, { positive });
  const result = Math.round(value * US);
  if (!Number.isSafeInteger(result) || (positive && result <= 0)) fail('INVALID_INPUT', `${label} is outside microsecond precision`);
  return result;
}
export function string(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail('INVALID_INPUT', `${label} must be a nonempty string`);
  return value;
}
export function json(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) { fail('READ_FAILED', `Cannot read ${file}: ${error.message}`); }
  try { return JSON.parse(text); }
  catch { fail('UNREADABLE_DRAFT', `Not plaintext JSON: ${file}. Encrypted, compressed or damaged drafts require a plaintext export from their matching Jianying version.`); }
}
export function writeJSON(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'w' });
}
export function digest(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
export function inside(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
export function rewritePaths(value, from, to) {
  if (typeof value === 'string') {
    if (value === from) return to;
    if (value.startsWith(from + path.sep)) return to + value.slice(from.length);
    return value;
  }
  if (Array.isArray(value)) return value.map(item => rewritePaths(item, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewritePaths(item, from, to)]));
  return value;
}

export function mediaPath(value, dir) {
  const match = /^##_draftpath_placeholder_[A-Za-z0-9-]+_##[\\/](.*)$/.exec(value);
  if (match) {
    const result = path.resolve(dir, match[1]);
    if (!inside(dir, result)) fail('UNSAFE_PATH', 'Draft media placeholder escapes the project directory');
    return result;
  }
  return path.isAbsolute(value) ? value : path.resolve(dir, value);
}
