// SPDX-License-Identifier: AGPL-3.0-only
// The Excalidraw fonts this app serves are the ones of the installed library. The library asks for
// each font by a name that carries a content hash, so a copy left behind by an upgrade would not be
// found, and the library would then reach for its public CDN.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXCALIDRAW_LOCAL_ASSET_PATH } from '../../../src/components/excalidraw-assets';
import { WHITEBOARD_ASSET_PATH } from '../../../src/fantay/artifact/viewers/whiteboard/draw';

const WEB_ROOT = resolve(__dirname, '../../..');
const PACKAGE_FONTS = join(WEB_ROOT, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
const SERVED_FONTS = join(WEB_ROOT, 'public', EXCALIDRAW_LOCAL_ASSET_PATH, 'fonts');

function listFiles(root: string, folder = root): string[] {
  return readdirSync(folder, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? listFiles(root, join(folder, entry.name)) : [relative(root, join(folder, entry.name))]))
    .sort();
}

const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('the Excalidraw fonts served with the app', () => {
  it('are served from the one path the sketch editor and the drawing viewer both use', () => {
    expect(EXCALIDRAW_LOCAL_ASSET_PATH).toBe('/artifact/excalidraw/');
    expect(WHITEBOARD_ASSET_PATH).toBe(EXCALIDRAW_LOCAL_ASSET_PATH);
    expect(existsSync(SERVED_FONTS)).toBe(true);
  });

  it('are byte for byte the fonts of the installed library', () => {
    const shipped = listFiles(PACKAGE_FONTS);
    expect(shipped.length).toBeGreaterThan(200);
    expect(listFiles(SERVED_FONTS)).toEqual(shipped);
    for (const file of shipped) {
      expect(digest(join(SERVED_FONTS, file)), file).toBe(digest(join(PACKAGE_FONTS, file)));
    }
  });
});
