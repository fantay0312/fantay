// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';

import {
  FANTAY_MATERIAL_MIME,
  MATERIAL_DRAG_MAX_BYTES,
  hasMaterialDrag,
  readMaterialDrag,
  writeMaterialDrag,
} from '../../../src/fantay/materials/material-drag';
import { WEBSITE_ITEM, makeItem } from '../../components/materials/fixtures';

/** A DataTransfer stand-in (jsdom has none): typed data by format plus `types`. */
class FakeDataTransfer {
  private readonly data = new Map<string, string>();
  effectAllowed = 'all';
  dropEffect = 'none';

  get types(): string[] {
    return Array.from(this.data.keys());
  }

  setData(format: string, value: string): void {
    this.data.set(format, value);
  }

  getData(format: string): string {
    return this.data.get(format) ?? '';
  }
}

function transfer(): DataTransfer {
  return new FakeDataTransfer() as unknown as DataTransfer;
}

function withPayload(raw: string): DataTransfer {
  const dt = transfer();
  dt.setData(FANTAY_MATERIAL_MIME, raw);
  return dt;
}

describe('material drag payload', () => {
  it('round-trips the fields a board insert needs, with a text/plain title and a copy effect', () => {
    const item = makeItem(2, { source: 'https://github.com/example/kit' });
    const dt = transfer();
    writeMaterialDrag(dt, item);

    expect(dt.getData('text/plain')).toBe('Material 2');
    expect(dt.effectAllowed).toBe('copy');
    expect(JSON.parse(dt.getData(FANTAY_MATERIAL_MIME)).v).toBe(1);
    expect(readMaterialDrag(dt)).toEqual({
      v: 1,
      item: {
        id: 'item-2',
        title: 'Material 2',
        kind: item.kind,
        capabilities: item.capabilities,
        source: 'https://github.com/example/kit',
        license: 'MIT · Example',
        subtitle: 'Subtitle 2',
        description: 'Description 2',
        thumbnailUrl: '/api/materials/items/item-2/thumbnail',
      },
    });
  });

  it('keeps only the summary fields (no tags, palette, collection) in the payload', () => {
    const dt = transfer();
    writeMaterialDrag(dt, WEBSITE_ITEM);
    const raw = JSON.parse(dt.getData(FANTAY_MATERIAL_MIME)) as { item: Record<string, unknown> };
    expect(Object.keys(raw.item).sort()).toEqual(
      ['capabilities', 'description', 'id', 'kind', 'license', 'source', 'subtitle', 'thumbnailUrl', 'title'].sort(),
    );
  });

  it('rejects a wrong version, a missing id or title, garbage and oversized JSON', () => {
    const good = { v: 1, item: { id: 'a', title: 'A' } };
    expect(readMaterialDrag(withPayload(JSON.stringify(good)))?.item.id).toBe('a');
    expect(readMaterialDrag(withPayload(JSON.stringify({ ...good, v: 2 })))).toBeNull();
    expect(readMaterialDrag(withPayload(JSON.stringify({ v: 1, item: { title: 'A' } })))).toBeNull();
    expect(readMaterialDrag(withPayload(JSON.stringify({ v: 1, item: { id: '  ', title: 'A' } })))).toBeNull();
    expect(readMaterialDrag(withPayload(JSON.stringify({ v: 1, item: { id: 'a' } })))).toBeNull();
    expect(readMaterialDrag(withPayload(JSON.stringify({ v: 1, item: [] })))).toBeNull();
    expect(readMaterialDrag(withPayload('{not json'))).toBeNull();
    expect(readMaterialDrag(withPayload('null'))).toBeNull();
    const oversized = JSON.stringify({ ...good, item: { ...good.item, description: 'x'.repeat(MATERIAL_DRAG_MAX_BYTES) } });
    expect(readMaterialDrag(withPayload(oversized))).toBeNull();
    expect(readMaterialDrag(transfer())).toBeNull();
    expect(readMaterialDrag(null)).toBeNull();
  });

  it('normalises foreign field types instead of trusting them', () => {
    const payload = readMaterialDrag(
      withPayload(
        JSON.stringify({
          v: 1,
          item: {
            id: ' id-1 ',
            title: 'Title',
            kind: 7,
            capabilities: { material: 'rm -rf', previewEntry: 'yes' },
            source: 42,
            license: null,
            thumbnailUrl: { href: 'x' },
          },
        }),
      ),
    );
    expect(payload?.item).toEqual({
      id: 'id-1',
      title: 'Title',
      kind: '',
      capabilities: {
        material: 'source_file',
        previewEntry: false,
        designTokens: false,
        sourceManifest: false,
        licenseDocument: false,
      },
      license: '',
      description: '',
      thumbnailUrl: null,
    });
  });

  it('detects the MIME type during dragover, when the data itself is unreadable', () => {
    const dt = transfer();
    expect(hasMaterialDrag(dt)).toBe(false);
    writeMaterialDrag(dt, makeItem(1));
    expect(hasMaterialDrag(dt)).toBe(true);
    const files = transfer();
    files.setData('Files', '');
    expect(hasMaterialDrag(files)).toBe(false);
    expect(hasMaterialDrag(null)).toBe(false);
  });
});
