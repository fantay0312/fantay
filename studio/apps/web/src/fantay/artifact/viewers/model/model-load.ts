// SPDX-License-Identifier: AGPL-3.0-only
// Turns a 3D file's bytes into a three.js object. Each format's loader is imported when a file of
// that format opens. Geometry-only formats (OBJ, STL, PLY) are parsed in a worker under a deadline;
// glTF and 3MF carry materials and textures that three.js builds on the main thread.
// The file is untrusted. A reference to another file is followed only inside the same project
// (see `resolveModelResource`); anything else is recorded as missing and never fetched.
import { BufferAttribute, BufferGeometry, Group, LineSegments, LoadingManager, Mesh, Points, type Object3D } from 'three';

import type { MeshPart, MeshWorkerFormat, MeshWorkerRequest, MeshWorkerResponse } from './mesh.worker';
import { MODEL_READERS, resolveModelResource, type ModelFormat } from './model-format';

const WORKER_TIMEOUT_MS = 30_000;
const MAIN_TIMEOUT_MS = 30_000;
/** An address no loader can fetch: where a blocked reference is sent. */
const BLOCKED_URL = 'blocked:';

export type ModelLoadFailure = 'invalid' | 'empty' | 'timeout' | 'missing' | 'unsupported';

export class ModelLoadError extends Error {
  constructor(
    readonly code: ModelLoadFailure,
    /** For `missing`: the files the model asked for and did not get. */
    readonly files: readonly string[] = [],
  ) {
    super(code);
  }
}

export interface LoadedModel {
  root: Object3D;
  /**
   * True when the format has no material of its own: every surface gets the viewer's neutral one.
   * False keeps the file's materials (and replaces only glTF's placeholder for "no material").
   */
  bare: boolean;
  /** Textures the model asked for and did not get; the model is shown without them. */
  missing: string[];
}

export interface ModelLoadContext {
  format: ModelFormat;
  bytes: ArrayBuffer;
  /** Project-relative path of the model, the base for its references. */
  path: string;
  /** The address of another file of the project. */
  projectUrl(path: string): string;
  /** Headers the project's file route needs (workspace identity), if any. */
  headers?: Record<string, string>;
}

function parseInWorker(format: MeshWorkerFormat, bytes: ArrayBuffer): Promise<MeshPart[]> {
  return new Promise<MeshPart[]>((resolve, reject) => {
    const worker = new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module' });
    const finish = (settle: () => void): void => {
      window.clearTimeout(timer);
      worker.terminate();
      settle();
    };
    const timer = window.setTimeout(() => finish(() => reject(new ModelLoadError('timeout'))), WORKER_TIMEOUT_MS);
    worker.addEventListener('message', (event: MessageEvent<MeshWorkerResponse>) => {
      const data = event.data;
      finish(() => ('parts' in data ? resolve(data.parts) : reject(new ModelLoadError(data.error))));
    });
    worker.addEventListener('error', () => finish(() => reject(new ModelLoadError('invalid'))));
    // Copied, not transferred: the viewer's source keeps the bytes until a newer version arrives.
    worker.postMessage({ format, bytes } satisfies MeshWorkerRequest);
  });
}

function fromParts(parts: readonly MeshPart[]): Group {
  const root = new Group();
  for (const part of parts) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(part.position, 3));
    if (part.normal) geometry.setAttribute('normal', new BufferAttribute(part.normal, 3));
    if (part.color) geometry.setAttribute('color', new BufferAttribute(part.color, part.colorSize));
    if (part.index) geometry.setIndex(new BufferAttribute(part.index, 1));
    // The stage assigns the materials; these objects only say what kind of thing they are.
    root.add(part.kind === 'mesh' ? new Mesh(geometry) : part.kind === 'points' ? new Points(geometry) : new LineSegments(geometry));
  }
  return root;
}

function withDeadline<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new ModelLoadError('timeout')), MAIN_TIMEOUT_MS);
    work.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Rejects with a `ModelLoadError`. */
export async function loadModel(context: ModelLoadContext): Promise<LoadedModel> {
  const { format, bytes } = context;
  const reader = MODEL_READERS[format];
  if (reader === 'none') throw new ModelLoadError('unsupported');
  if (reader === 'worker') {
    return { root: fromParts(await parseInWorker(format as MeshWorkerFormat, bytes)), bare: true, missing: [] };
  }

  // References are resolved here, once, for every loader three.js uses underneath.
  const asked = new Map<string, string>();
  const failed = new Set<string>();
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    const resource = resolveModelResource(context.path, url);
    if (resource.kind === 'inline') return url;
    const address = resource.kind === 'project' ? context.projectUrl(resource.path) : `${BLOCKED_URL}${asked.size}`;
    asked.set(address, url);
    return address;
  });
  manager.onError = (url) => {
    failed.add(asked.get(url) ?? url);
  };

  try {
    if (format === 'gltf') {
      const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
        import('three/examples/jsm/loaders/GLTFLoader.js'),
        import('three/examples/jsm/libs/meshopt_decoder.module.js'),
      ]);
      const loader = new GLTFLoader(manager);
      loader.setMeshoptDecoder(MeshoptDecoder);
      if (context.headers) loader.setRequestHeader(context.headers);
      const gltf = await withDeadline(loader.parseAsync(bytes, ''));
      return { root: gltf.scene ?? gltf.scenes[0] ?? new Group(), bare: false, missing: [...failed] };
    }
    const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
    const loader = new ThreeMFLoader(manager);
    return { root: loader.parse(bytes), bare: false, missing: [...failed] };
  } catch (error) {
    if (error instanceof ModelLoadError) throw error;
    // A buffer that could not be fetched is the one failure with a cause worth naming.
    if (failed.size > 0) throw new ModelLoadError('missing', [...failed]);
    throw new ModelLoadError('invalid');
  }
}
