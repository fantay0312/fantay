// SPDX-License-Identifier: AGPL-3.0-only
// What can be known about a 3D file before any 3D code is loaded: which viewer path its format
// takes, what a glTF needs from outside itself (buffers, textures, extensions), where such a
// reference points inside the project, and how to word a model's size. Pure: no three.js, no DOM.

export type ModelFormat = 'gltf' | 'obj' | 'stl' | 'ply' | 'fbx' | '3mf';

/**
 * How a format is read. `worker`: geometry only, parsed off the main thread. `main`: carries
 * materials and textures three.js can only build on the main thread. `none`: no reliable reader.
 */
export const MODEL_READERS: Record<ModelFormat, 'worker' | 'main' | 'none'> = {
  gltf: 'main',
  obj: 'worker',
  stl: 'worker',
  ply: 'worker',
  '3mf': 'main',
  fbx: 'none',
};

/** Largest file each format is read at. Text formats cost far more memory per byte than binary ones. */
export const MODEL_MAX_BYTES: Record<ModelFormat, number> = {
  gltf: 160 * 1024 * 1024,
  obj: 64 * 1024 * 1024,
  stl: 96 * 1024 * 1024,
  ply: 96 * 1024 * 1024,
  '3mf': 48 * 1024 * 1024,
  fbx: 48 * 1024 * 1024,
};

export function isModelFormat(format: string): format is ModelFormat {
  return format in MODEL_READERS;
}

/** Formats that are drawn Z-up by the tools that write them (3D printing, CAD). */
export function defaultUpAxis(format: ModelFormat): 'y' | 'z' {
  return format === 'stl' || format === '3mf' ? 'z' : 'y';
}

// ── glTF: what it needs from outside ────────────────────────────────────────────────────────────

/** glTF extensions the preview cannot decode, with the name a person would recognise. */
const UNREADABLE_EXTENSIONS: Record<string, string> = {
  KHR_draco_mesh_compression: 'Draco',
  KHR_texture_basisu: 'KTX2',
};

export interface GltfInspection {
  /** Buffers the geometry lives in. Without one of these there is no model. */
  buffers: string[];
  /** Pictures. A missing one leaves a surface untextured. */
  images: string[];
  /** A required extension the preview cannot read, by its plain name; null when all is readable. */
  unreadable: string | null;
}

interface GltfJson {
  buffers?: Array<{ uri?: unknown }>;
  images?: Array<{ uri?: unknown }>;
  extensionsRequired?: unknown;
  extensionsUsed?: unknown;
}

function gltfJsonText(bytes: ArrayBuffer): string | null {
  const view = new DataView(bytes);
  // Binary glTF: "glTF", version, length, then a JSON chunk.
  if (bytes.byteLength >= 20 && view.getUint32(0, true) === 0x46546c67) {
    const length = view.getUint32(12, true);
    if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > bytes.byteLength) return null;
    return new TextDecoder().decode(new Uint8Array(bytes, 20, length));
  }
  return new TextDecoder().decode(bytes);
}

function isExternal(uri: unknown): uri is string {
  return typeof uri === 'string' && uri !== '' && !/^(data|blob):/i.test(uri);
}

/** Reads a glTF's own table of contents. Null when the bytes are not glTF JSON. */
export function inspectGltf(bytes: ArrayBuffer): GltfInspection | null {
  let json: GltfJson;
  try {
    const text = gltfJsonText(bytes);
    if (text === null) return null;
    json = JSON.parse(text) as GltfJson;
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const list = (items: Array<{ uri?: unknown }> | undefined): string[] =>
    Array.isArray(items) ? items.map((item) => item?.uri).filter(isExternal) : [];
  const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  const required = names(json.extensionsRequired);
  // Draco and KTX2 data cannot be skipped even when a file forgets to list them as required.
  const hard = names(json.extensionsUsed).filter((name) => name === 'KHR_draco_mesh_compression' || name === 'KHR_texture_basisu');
  const blocking = [...required, ...hard].find((name) => UNREADABLE_EXTENSIONS[name]);
  return { buffers: list(json.buffers), images: list(json.images), unreadable: blocking ? (UNREADABLE_EXTENSIONS[blocking] ?? null) : null };
}

// ── references from a model to other files ──────────────────────────────────────────────────────

export type ModelResource =
  /** Carried inside the model file (a data: or blob: address). */
  | { kind: 'inline' }
  /** Another file of the same project. */
  | { kind: 'project'; path: string }
  /** Anywhere else: the network, or outside the project folder. Never fetched. */
  | { kind: 'blocked' };

/**
 * Where a reference inside a model file points. Only files of the same project are followed: a
 * model must not make the app reach out to the network, nor climb out of the project folder.
 */
export function resolveModelResource(modelPath: string, uri: string): ModelResource {
  if (/^(data|blob):/i.test(uri)) return { kind: 'inline' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('//') || uri.startsWith('/') || uri.startsWith('\\')) return { kind: 'blocked' };
  let relative = uri.replace(/[?#].*$/, '').replace(/\\/g, '/');
  try {
    relative = decodeURIComponent(relative);
  } catch {
    /* Not percent-encoded: use it as written. */
  }
  const parts = modelPath.split('/').slice(0, -1);
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return { kind: 'blocked' };
      parts.pop();
    } else parts.push(part);
  }
  return parts.length === 0 ? { kind: 'blocked' } : { kind: 'project', path: parts.join('/') };
}

// ── words ───────────────────────────────────────────────────────────────────────────────────────

/** One side of a model's bounding box: three significant digits, no trailing zeros. */
export function formatExtent(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const magnitude = Math.abs(value);
  if (magnitude === 0) return '0';
  if (magnitude >= 1000) return String(Math.round(value));
  if (magnitude < 0.001) return value.toExponential(1);
  return String(Number(value.toPrecision(3)));
}

/** "2 × 2 × 2": width, height, depth in the file's own units, which a 3D file does not name. */
export function formatExtents(size: readonly [number, number, number]): string {
  return size.map(formatExtent).join(' × ');
}
