// SPDX-License-Identifier: Apache-2.0
/**
 * HTML page → editable design (06 §8.1).
 *
 * The page is parsed inertly, stripped of active content (`safeHTML`), and its project-relative
 * stylesheets and images are inlined through the host (`asset.fetch`; URLs resolve against the
 * source file's folder on the reserved `https://project.invalid/` origin, nothing else is
 * fetched). dom-css then lays it out in its sandboxed iframe and the core turns the styled tree
 * into layers. The result is always lossy (scripts, video, iframes and remote images do not
 * convert).
 */
import type { DesignOpenWarning } from '@open-design/contracts/runtime/design-editor-bridge';

import {
  browserHTMLToDesignDocument,
  browserTailwindHTMLToDesignDocument,
  sceneGraphFromStyledHTML,
  type SceneGraph,
} from '../engine/op';

export interface HtmlImportOptions {
  sourcePath: string | null;
  fetchAsset(path: string): Promise<{ bytes: ArrayBuffer; mime: string }>;
  pageName: string;
  signal?: AbortSignal;
}

export const HTML_ASSET_LIMITS = {
  maxAssets: 50,
  maxAssetBytes: 10 * 1024 * 1024,
  maxTotalBytes: 30 * 1024 * 1024,
} as const;

export const PROJECT_ASSET_ORIGIN = 'https://project.invalid';

const REMOVED_ELEMENTS = 'script, iframe, object, embed, applet, base, meta, noscript, frame, frameset, portal';

function stripControls(value: string): string {
  // Browsers ignore ASCII whitespace and control characters inside a URL scheme ("java\tscript:").
  return value.replace(/[\u0000- \u007f]/g, '');
}

function sanitizeDocument(doc: Document): Document {
  doc.querySelectorAll(REMOVED_ELEMENTS).forEach((node) => node.remove());
  doc.querySelectorAll('link').forEach((link) => {
    if (!/(^|\s)stylesheet(\s|$)/i.test(link.getAttribute('rel') ?? '')) link.remove();
  });
  for (const element of doc.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith('on') ||
        name === 'srcdoc' ||
        /^(?:javascript|vbscript):|^data:text\/html/i.test(stripControls(attribute.value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return doc;
}

/**
 * Wraps `Document` so that any `<iframe>` created by `@open-pencil/dom-css` during
 * `computeStylesInIframe` receives `sandbox="allow-same-origin"` (without `allow-scripts`),
 * blocking script execution in the temporary iframe while keeping `contentDocument` and
 * `getComputedStyle` accessible.
 */
export function createSandboxedRuntimeDocument(doc: Document): Document {
  return new Proxy(doc, {
    get(target, prop) {
      if (prop === 'createElement') {
        return (tagName: string, options?: ElementCreationOptions) => {
          const element = target.createElement(tagName, options);
          if (String(tagName).toLowerCase() === 'iframe') {
            element.setAttribute('sandbox', 'allow-same-origin');
          }
          return element;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function serialize(doc: Document): string {
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

/** Drops script, iframe, object, embed, base, meta[http-equiv] and non-stylesheet links; strips on* handlers, srcdoc and javascript:/vbscript: URLs. */
export function safeHTML(source: string): string {
  return serialize(sanitizeDocument(new DOMParser().parseFromString(source, 'text/html')));
}

/** The sanitized `<head>` styles and `<body>` content of a page, for embedding in another page. */
export function safeHTMLFragment(source: string): string {
  const doc = sanitizeDocument(new DOMParser().parseFromString(source, 'text/html'));
  const styles = [...doc.head.querySelectorAll('style, link')].map((node) => node.outerHTML).join('');
  return styles + doc.body.innerHTML;
}

/**
 * The project-relative path a page URL points at, resolved against the page's folder, or null
 * for anything outside the project (remote URLs, data: URLs, fragments, `..` escapes).
 */
export function resolveProjectAssetPath(src: string, sourcePath: string | null): string | null {
  const raw = src.trim();
  if (!raw || raw.startsWith('#') || /^(?:data|blob|about|javascript|vbscript|mailto):/i.test(stripControls(raw))) return null;
  const slash = sourcePath ? sourcePath.lastIndexOf('/') : -1;
  const dir = slash > 0 ? sourcePath!.slice(0, slash + 1) : '';
  let url: URL;
  try {
    url = new URL(raw, `${PROJECT_ASSET_ORIGIN}/${dir}`);
  } catch {
    return null;
  }
  if (url.origin !== PROJECT_ASSET_ORIGIN) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (!path || path.includes('\0') || path.includes('\\') || path.split('/').some((segment) => segment === '..' || segment === '.')) {
    return null;
  }
  return path;
}

/** Pages styled with Tailwind (the CDN script, `@import "tailwindcss"` or `@tailwind`). */
export function isTailwindHTML(html: string): boolean {
  return (
    /<script\b[^>]*\bsrc\s*=\s*["'][^"']*(?:cdn\.tailwindcss\.com|[/@]tailwindcss[@/.])/i.test(html) ||
    /@import\s+(?:url\()?\s*["']tailwindcss/i.test(html) ||
    /@tailwind\s+(?:base|components|utilities)\b/i.test(html)
  );
}

export function collectClassTokens(doc: Document): string[] {
  const tokens = new Set<string>();
  for (const element of doc.querySelectorAll('[class]')) {
    for (const token of (element.getAttribute('class') ?? '').split(/\s+/)) if (token) tokens.add(token);
  }
  return [...tokens];
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(text);
}

/**
 * Inlines project stylesheets (`<link rel=stylesheet>` → `<style>`) and images (`<img src>` →
 * data URL) within HTML_ASSET_LIMITS; assets past a limit or that fail to load are skipped.
 */
export async function inlineProjectAssets(doc: Document, opts: HtmlImportOptions): Promise<{ skipped: number }> {
  let skipped = 0;
  let count = 0;
  let total = 0;

  async function load(src: string | null): Promise<{ bytes: ArrayBuffer; mime: string } | null> {
    opts.signal?.throwIfAborted();
    const path = src ? resolveProjectAssetPath(src, opts.sourcePath) : null;
    if (!path) return null;
    if (count >= HTML_ASSET_LIMITS.maxAssets) {
      skipped += 1;
      return null;
    }
    count += 1;
    try {
      const asset = await opts.fetchAsset(path);
      const size = asset.bytes.byteLength;
      if (size > HTML_ASSET_LIMITS.maxAssetBytes || total + size > HTML_ASSET_LIMITS.maxTotalBytes) {
        skipped += 1;
        return null;
      }
      total += size;
      return asset;
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      skipped += 1;
      return null;
    }
  }

  for (const link of [...doc.querySelectorAll('link')]) {
    const asset = await load(link.getAttribute('href'));
    if (!asset) continue;
    const style = doc.createElement('style');
    style.textContent = new TextDecoder().decode(asset.bytes);
    link.replaceWith(style);
  }
  for (const image of [...doc.querySelectorAll('img')]) {
    image.removeAttribute('srcset');
    const asset = await load(image.getAttribute('src'));
    if (!asset) continue;
    image.setAttribute('src', `data:${asset.mime || 'application/octet-stream'};base64,${toBase64(new Uint8Array(asset.bytes))}`);
  }
  return { skipped };
}

export async function htmlToSceneGraph(html: string, opts: HtmlImportOptions): Promise<{ graph: SceneGraph; warnings: DesignOpenWarning[] }> {
  const tailwind = isTailwindHTML(html);
  const doc = sanitizeDocument(new DOMParser().parseFromString(html, 'text/html'));
  const { skipped } = await inlineProjectAssets(doc, opts);
  const cleaned = serialize(doc);
  const runtimeDoc = typeof document !== 'undefined' ? createSandboxedRuntimeDocument(document) : undefined;
  const styled = tailwind
    ? await browserTailwindHTMLToDesignDocument(cleaned, collectClassTokens(doc), {
        sandbox: 'iframe',
        signal: opts.signal,
        ...(runtimeDoc ? { document: runtimeDoc } : {}),
      })
    : await browserHTMLToDesignDocument(cleaned, {
        sandbox: 'iframe',
        signal: opts.signal,
        ...(runtimeDoc ? { document: runtimeDoc } : {}),
      });
  const graph = sceneGraphFromStyledHTML(styled, { pageName: opts.pageName });
  const page = graph.getPages()[0];
  if (page) {
    graph.updateNode(page.id, {
      pluginData: [
        ...(page.pluginData ?? []).filter((entry) => !(entry.pluginId === 'fantay' && entry.key === 'source')),
        { pluginId: 'fantay', key: 'source', value: JSON.stringify({ kind: 'html', path: opts.sourcePath }) },
      ],
    });
  }
  const warnings: DesignOpenWarning[] = ['lossy-html'];
  if (skipped > 0) warnings.push('images-skipped');
  return { graph, warnings };
}
