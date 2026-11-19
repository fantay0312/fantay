// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/extendedDocumentPreview.ts @ c5e6b24f (MIT): the
// bounded XML reader (`parseXml`, `find`, `archivePath`) that its OpenDocument and EPUB previews share.
// Changed here: entities are decoded by a small local function instead of the `entities` package,
// the namespace table is passed in by the caller, limits are named, and failures are `ReadError`
// codes the viewer words itself instead of English sentences.
//
// The input is untrusted. A document type or entity declaration is refused (no entity expansion),
// and depth, node count and source size are capped. No DOM: this runs in a worker and in tests.
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export type ReadFailure = 'invalid' | 'too-large' | 'unsupported' | 'protected' | 'empty';

/** A reader could not produce a preview; `code` says why, in terms the viewer can word. */
export class ReadError extends Error {
  constructor(readonly code: ReadFailure) {
    super(code);
  }
}

/** `text` and `attrs` hold decoded values. Names are `prefix:local` with the caller's prefixes. */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

type OrderedXml = { [key: string]: OrderedXml[] | Record<string, string> | string };

export const MAX_XML_CHARS = 8 * 1024 * 1024;
const MAX_XML_DEPTH = 100;
const MAX_XML_NODES = 200_000;

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The five XML entities, `&nbsp;` and numeric references. Anything else stays as written. */
export function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[\da-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/**
 * Parses XML into a plain tree. `prefixes` maps a namespace URI to the prefix the caller wants to
 * read it by ('' for "no prefix"), so `<text:p>` is found whatever prefix the file chose.
 */
export function parseXml(source: string, prefixes: Readonly<Record<string, string>> = {}): XmlNode {
  // XHTML and NCX files commonly declare an external DTD. Discard it without resolving it.
  let text = source.replace(/^﻿/, '').replaceAll(/<!DOCTYPE\s+[^<>[\]]*>/gi, '');
  if (text.length > MAX_XML_CHARS) throw new ReadError('too-large');
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(text)) throw new ReadError('unsupported');
  // Named HTML entities are not XML; the common one would otherwise fail validation.
  text = text.replaceAll('&nbsp;', '&#160;');
  if (XMLValidator.validate(text) !== true) throw new ReadError('invalid');

  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    processEntities: false,
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
    cdataPropName: '#cdata',
  });
  const ordered = parser.parse(text) as OrderedXml[];
  let count = 0;

  function convert(items: OrderedXml[], depth: number, inherited: Record<string, string>): XmlNode[] {
    if (depth > MAX_XML_DEPTH) throw new ReadError('too-large');
    const nodes: XmlNode[] = [];
    for (const item of items) {
      count += 1;
      if (count > MAX_XML_NODES) throw new ReadError('too-large');
      const name = Object.keys(item).find((key) => key !== ':@') ?? '#text';
      const value = item[name];
      if (name === '#cdata') {
        const literal = Array.isArray(value) ? value.map((part) => (typeof part['#text'] === 'string' ? part['#text'] : '')).join('') : '';
        nodes.push({ name: '#text', attrs: {}, children: [], text: literal });
        continue;
      }
      // Declarations and processing instructions carry nothing a preview shows.
      if (name.startsWith('?')) continue;
      const rawAttrs = (item[':@'] ?? {}) as Record<string, string>;
      const attrs: Record<string, string> = {};
      for (const [key, raw] of Object.entries(rawAttrs)) attrs[key] = decodeXmlEntities(String(raw));

      const namespaces = Object.create(inherited) as Record<string, string>;
      for (const [key, uri] of Object.entries(attrs)) {
        if (key === 'xmlns') namespaces[''] = uri;
        else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = uri;
      }
      const expanded = (qualified: string, attribute = false): string => {
        if (qualified.startsWith('#')) return qualified;
        const colon = qualified.indexOf(':');
        if (colon < 0 && attribute) return qualified;
        const uri = namespaces[colon < 0 ? '' : qualified.slice(0, colon)];
        if (!uri) return qualified;
        const local = qualified.slice(colon + 1);
        if (!Object.hasOwn(prefixes, uri)) return `{${uri}}${local}`;
        const prefix = prefixes[uri];
        return prefix ? `${prefix}:${local}` : local;
      };

      const expandedAttrs: Record<string, string> = {};
      for (const [key, attr] of Object.entries(attrs)) expandedAttrs[expanded(key, true)] = attr;
      nodes.push({
        name: expanded(name),
        attrs: expandedAttrs,
        children: Array.isArray(value) ? convert(value, depth + 1, namespaces) : [],
        text: typeof value === 'string' ? decodeXmlEntities(value) : '',
      });
    }
    return nodes;
  }

  return { name: 'root', attrs: {}, children: convert(ordered, 0, Object.create(null) as Record<string, string>), text: '' };
}

/** Every descendant called `name`, not looking inside matches or inside `skip` elements. */
export function findAll(node: XmlNode, name: string, skip?: string): XmlNode[] {
  const found: XmlNode[] = [];
  const visit = (parent: XmlNode): void => {
    for (const child of parent.children) {
      if (child.name === skip) continue;
      if (child.name === name) found.push(child);
      else visit(child);
    }
  };
  visit(node);
  return found;
}

export function findFirst(node: XmlNode, name: string): XmlNode | null {
  for (const child of node.children) {
    if (child.name === name) return child;
    const deeper = findFirst(child, name);
    if (deeper) return deeper;
  }
  return null;
}

/** All text under a node, in order. */
export function textOf(node: XmlNode): string {
  return node.name === '#text' ? node.text : node.children.map(textOf).join('');
}

/**
 * Resolves `href` against the archive path of the file that contains it. Null for anything that is
 * not a plain relative path inside the archive (a scheme, an absolute path, an escape with `..`).
 */
export function archivePath(base: string, href: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(href)) return null;
  const parts = base.split('/').slice(0, -1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? '');
  } catch {
    return null;
  }
  for (const part of decoded.split('/')) {
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
