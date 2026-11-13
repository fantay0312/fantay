// SPDX-License-Identifier: Apache-2.0
/**
 * `.op` documents (ZSeven `@zseven-w/op-web-sdk`, read-only by design, 06 §8.3): the viewer's
 * wasm location, the lossy SVG route to an editable design, and a best-effort PNG cover.
 */
import { svgToSceneGraph } from './svg';
import type { SceneGraph } from '../engine/op';

/** The SDK loader also hard-codes `/canvaskit/canvaskit.js` (copied by the canvas build). */
export const OP_WASM_URL = '/canvas-editor/op_web_sdk_bg.wasm';

interface CanvasKitPathLike {
  delete(): void;
}

interface CanvasKitPathBuilderLike {
  transform(...args: number[]): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  close(): void;
  detachAndDelete(): CanvasKitPathLike;
}

export interface CanvasKitCompatTarget {
  Path?: {
    prototype?: Record<string, unknown>;
  };
  PathBuilder?: new (path?: unknown) => CanvasKitPathBuilderLike;
}

function swapEmbindHandle(target: object, replacement: CanvasKitPathLike): void {
  const keys = Reflect.ownKeys(target);
  const replacementRecord = replacement as unknown as Record<PropertyKey, unknown>;
  const targetRecord = target as unknown as Record<PropertyKey, unknown>;
  for (const key of keys) {
    if (key in replacementRecord) {
      const prev = targetRecord[key];
      targetRecord[key] = replacementRecord[key];
      replacementRecord[key] = prev;
    }
  }
  replacement.delete();
}

/**
 * `@zseven-w/op-web-sdk@0.8.0` (`op_ck_bridge.js`) was built against `canvaskit-wasm@0.40.0`,
 * where `CK.Path` had mutable `.transform()`, `.moveTo()`, `.lineTo()`, and `.close()` methods.
 * In `canvaskit-wasm@0.41.1` (used by `@open-pencil/core@0.16.0`), `CK.Path` is immutable and
 * those methods live on `CK.PathBuilder`. Shim them onto `CK.Path.prototype` via `PathBuilder`.
 */
export function patchCanvasKitPathForOpSdk(ck: CanvasKitCompatTarget | null | undefined): void {
  const proto = ck?.Path?.prototype;
  const PathBuilderCtor = ck?.PathBuilder;
  if (!proto || !PathBuilderCtor) return;

  if (typeof proto.transform !== 'function') {
    proto.transform = function transform(this: object, ...args: unknown[]) {
      const builder = new PathBuilderCtor(this);
      const matrix =
        args.length === 1 && (Array.isArray(args[0]) || ArrayBuffer.isView(args[0]))
          ? Array.from(args[0] as ArrayLike<number>)
          : (args as number[]);
      builder.transform(...matrix);
      swapEmbindHandle(this, builder.detachAndDelete());
      return this;
    };
  }

  for (const method of ['moveTo', 'lineTo', 'close'] as const) {
    if (typeof proto[method] !== 'function') {
      proto[method] = function pathBuilderMethod(this: object, ...args: number[]) {
        const builder = new PathBuilderCtor(this);
        (builder[method] as (...a: number[]) => void)(...args);
        swapEmbindHandle(this, builder.detachAndDelete());
        return this;
      };
    }
  }
}

type CanvasKitInitFn = (opts?: { locateFile?: (file: string) => string }) => Promise<unknown>;

export async function ensureOpCanvasKitInit(win: Window = window): Promise<void> {
  const w = win as Window & {
    CanvasKitInit?: CanvasKitInitFn & { __fxOpPatched?: boolean };
  };
  if (!w.CanvasKitInit) {
    await new Promise<void>((resolve, reject) => {
      const script = win.document.createElement('script');
      script.src = '/canvaskit/canvaskit.js';
      script.onload = () => resolve();
      script.onerror = (err) => reject(err);
      win.document.head.appendChild(script);
    });
  }
  const orig = w.CanvasKitInit;
  if (typeof orig === 'function' && !orig.__fxOpPatched) {
    const wrapped: CanvasKitInitFn & { __fxOpPatched?: boolean } = async (opts) => {
      const ck = await orig(opts);
      patchCanvasKitPathForOpSdk(ck as CanvasKitCompatTarget);
      return ck;
    };
    wrapped.__fxOpPatched = true;
    w.CanvasKitInit = wrapped;
  }
}

/** "Convert to editable design (via SVG)": the viewer's SVG export as layers; always lossy. */
export function opSvgToSceneGraph(svg: string, name: string): SceneGraph {
  return svgToSceneGraph(svg, name);
}

/** An SVG drawn through an <img> onto a 2D canvas, scaled so its longest side is at most `maxEdge`. */
export async function svgToPng(svg: string, maxEdge = 1600): Promise<{ png: Uint8Array; width: number; height: number } | null> {
  if (typeof document === 'undefined') return null;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const sourceWidth = image.naturalWidth || 1;
    const sourceHeight = image.naturalHeight || 1;
    const scale = Math.min(2, maxEdge / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? { png: new Uint8Array(await blob.arrayBuffer()), width, height } : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
