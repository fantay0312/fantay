// SPDX-License-Identifier: AGPL-3.0-only
// What the model viewer decides before any 3D code loads: what a glTF needs from outside itself
// and where a reference inside a model may point.
import { describe, expect, it } from 'vitest';

import {
  MODEL_READERS,
  defaultUpAxis,
  formatExtent,
  formatExtents,
  inspectGltf,
  isModelFormat,
  resolveModelResource,
} from '../../../src/fantay/artifact/viewers/model/model-format';

function bytesOf(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** A binary glTF holding only its JSON chunk. */
function glb(json: unknown): ArrayBuffer {
  let text = JSON.stringify(json);
  while (text.length % 4 !== 0) text += ' ';
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(20 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, body.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(body, 20);
  return out.buffer;
}

describe('inspectGltf', () => {
  it('lists the files a .gltf keeps outside itself', () => {
    const inspection = inspectGltf(
      bytesOf(JSON.stringify({ buffers: [{ uri: 'scene.bin' }, { uri: 'data:application/octet-stream;base64,AAAA' }], images: [{ uri: 'tex/a.png' }, { bufferView: 0 }] })),
    );
    expect(inspection).toEqual({ buffers: ['scene.bin'], images: ['tex/a.png'], unreadable: null });
  });

  it('reads the JSON chunk of a .glb', () => {
    expect(inspectGltf(glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 8 }] }))).toEqual({ buffers: [], images: [], unreadable: null });
  });

  it('names a compression the preview cannot read', () => {
    expect(inspectGltf(glb({ extensionsRequired: ['KHR_draco_mesh_compression'] }))?.unreadable).toBe('Draco');
    expect(inspectGltf(glb({ extensionsUsed: ['KHR_texture_basisu'] }))?.unreadable).toBe('KTX2');
    expect(inspectGltf(glb({ extensionsRequired: ['KHR_materials_unlit'], extensionsUsed: ['EXT_meshopt_compression'] }))?.unreadable).toBeNull();
  });

  it('answers null for bytes that are not glTF', () => {
    expect(inspectGltf(bytesOf('glTF but then nonsense that is not a chunk'))).toBeNull();
    expect(inspectGltf(bytesOf('not json'))).toBeNull();
  });
});

describe('resolveModelResource', () => {
  it('follows references inside the project, relative to the model', () => {
    expect(resolveModelResource('3d/scene/model.gltf', 'model.bin')).toEqual({ kind: 'project', path: '3d/scene/model.bin' });
    expect(resolveModelResource('3d/scene/model.gltf', './textures/%E6%B5%B7%E6%8A%A5.png?v=2')).toEqual({ kind: 'project', path: '3d/scene/textures/海报.png' });
    expect(resolveModelResource('3d/scene/model.gltf', '../shared/wood.jpg')).toEqual({ kind: 'project', path: '3d/shared/wood.jpg' });
    expect(resolveModelResource('model.gltf', 'model.bin')).toEqual({ kind: 'project', path: 'model.bin' });
  });

  it('leaves embedded data alone', () => {
    expect(resolveModelResource('a/model.gltf', 'data:image/png;base64,AAAA')).toEqual({ kind: 'inline' });
    expect(resolveModelResource('a/model.gltf', 'blob:http://localhost/1234')).toEqual({ kind: 'inline' });
  });

  it('never reaches the network or leaves the project', () => {
    expect(resolveModelResource('a/model.gltf', 'https://example.com/tracker.png')).toEqual({ kind: 'blocked' });
    expect(resolveModelResource('a/model.gltf', '//example.com/a.bin')).toEqual({ kind: 'blocked' });
    expect(resolveModelResource('a/model.gltf', 'file:///etc/passwd')).toEqual({ kind: 'blocked' });
    expect(resolveModelResource('a/model.gltf', '/etc/passwd')).toEqual({ kind: 'blocked' });
    expect(resolveModelResource('a/model.gltf', '../../outside.bin')).toEqual({ kind: 'blocked' });
    expect(resolveModelResource('model.gltf', '..')).toEqual({ kind: 'blocked' });
  });
});

describe('formats and words', () => {
  it('knows which formats it reads and how', () => {
    expect(isModelFormat('gltf')).toBe(true);
    expect(isModelFormat('usdz')).toBe(false);
    expect(MODEL_READERS.stl).toBe('worker');
    expect(MODEL_READERS.fbx).toBe('none');
  });

  it('stands printing formats up along Z', () => {
    expect(defaultUpAxis('stl')).toBe('z');
    expect(defaultUpAxis('gltf')).toBe('y');
  });

  it('words a bounding box at three significant digits', () => {
    expect(formatExtent(2)).toBe('2');
    expect(formatExtent(52.000004)).toBe('52');
    expect(formatExtent(0.123456)).toBe('0.123');
    expect(formatExtent(1234.56)).toBe('1235');
    expect(formatExtent(0)).toBe('0');
    expect(formatExtents([2, 3.5, 0.25])).toBe('2 × 3.5 × 0.25');
  });
});
