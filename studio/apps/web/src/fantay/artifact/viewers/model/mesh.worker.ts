// SPDX-License-Identifier: AGPL-3.0-only
// Geometry-only model formats (OBJ, STL, PLY), parsed off the main thread. A text model of tens of
// megabytes takes seconds to parse and three.js cannot be interrupted, so the parse runs here and
// the viewer ends this worker if it does not answer in time. The result is flat vertex data (the
// scene's transforms already applied), transferred back without copying; the viewer builds the
// meshes and gives them its own material, since none of these formats carries one worth keeping.
/// <reference lib="webworker" />
import type { BufferAttribute, BufferGeometry, InterleavedBufferAttribute, Object3D } from 'three';

export type MeshWorkerFormat = 'obj' | 'stl' | 'ply';
export type MeshWorkerRequest = { format: MeshWorkerFormat; bytes: ArrayBuffer };

export interface MeshPart {
  kind: 'mesh' | 'lines' | 'points';
  /** xyz per vertex. */
  position: Float32Array;
  normal: Float32Array | null;
  /** Vertex colours (linear), `colorSize` values per vertex. */
  color: Float32Array | null;
  colorSize: 3 | 4;
  index: Uint32Array | null;
}

export type MeshWorkerFailure = 'invalid' | 'empty';
export type MeshWorkerResponse = { parts: MeshPart[] } | { error: MeshWorkerFailure };

type Attribute = BufferAttribute | InterleavedBufferAttribute;

function floats(attribute: Attribute | undefined, size: number): Float32Array | null {
  if (!attribute || attribute.itemSize < size) return null;
  const plain = attribute as BufferAttribute;
  // The usual case: the loader's own float array, handed over as it is.
  if (!('data' in attribute) && plain.array instanceof Float32Array && attribute.itemSize === size && !plain.normalized) return plain.array;
  const out = new Float32Array(attribute.count * size);
  for (let index = 0; index < attribute.count; index += 1) {
    for (let part = 0; part < size; part += 1) out[index * size + part] = attribute.getComponent(index, part);
  }
  return out;
}

function partOf(kind: MeshPart['kind'], geometry: BufferGeometry): MeshPart | null {
  const position = floats(geometry.getAttribute('position'), 3);
  if (!position || position.length === 0) return null;
  const colors = geometry.getAttribute('color');
  const colorSize = colors && colors.itemSize >= 4 ? 4 : 3;
  const index = geometry.getIndex();
  return {
    kind,
    position,
    normal: kind === 'mesh' ? floats(geometry.getAttribute('normal'), 3) : null,
    color: floats(colors, colorSize),
    colorSize,
    index: index ? Uint32Array.from(index.array) : null,
  };
}

async function parse(request: MeshWorkerRequest): Promise<MeshPart[]> {
  const parts: MeshPart[] = [];
  if (request.format === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    const root = new OBJLoader().parse(new TextDecoder().decode(request.bytes));
    root.updateMatrixWorld(true);
    root.traverse((object: Object3D) => {
      const item = object as Object3D & { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; geometry?: BufferGeometry };
      if (!item.geometry) return;
      const part = partOf(item.isMesh ? 'mesh' : item.isPoints ? 'points' : 'lines', item.geometry.applyMatrix4(object.matrixWorld));
      if (part) parts.push(part);
    });
    return parts;
  }
  let geometry: BufferGeometry;
  if (request.format === 'stl') {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
    geometry = new STLLoader().parse(request.bytes);
  } else {
    const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
    geometry = new PLYLoader().parse(request.bytes);
  }
  // A PLY without faces is a point cloud.
  const faces = geometry.getIndex() !== null || request.format === 'stl';
  const part = partOf(faces ? 'mesh' : 'points', geometry);
  if (part) parts.push(part);
  return parts;
}

self.addEventListener('message', (event: MessageEvent<MeshWorkerRequest>) => {
  const post = (response: MeshWorkerResponse, transfer: Transferable[] = []): void => {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(response, transfer);
  };
  parse(event.data).then(
    (parts) => {
      if (parts.length === 0) {
        post({ error: 'empty' });
        return;
      }
      // A buffer may back more than one array, and a transfer list must not name it twice.
      const transfer = new Set<Transferable>();
      for (const part of parts) {
        transfer.add(part.position.buffer);
        if (part.normal) transfer.add(part.normal.buffer);
        if (part.color) transfer.add(part.color.buffer);
        if (part.index) transfer.add(part.index.buffer);
      }
      post({ parts }, [...transfer]);
    },
    () => post({ error: 'invalid' }),
  );
});
