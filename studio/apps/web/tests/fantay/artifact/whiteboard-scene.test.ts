// SPDX-License-Identifier: AGPL-3.0-only
// The whiteboard reads untrusted `.excalidraw` files before the drawing library sees them: these pin
// what counts as a scene, what is counted, which embedded files survive, the limits, and where the
// library's CDN font requests are sent instead.
import { describe, expect, it } from 'vitest';

import { localFontAddress } from '../../../src/fantay/artifact/viewers/whiteboard/draw';
import {
  MAX_EMBEDDED_BYTES,
  MAX_SCENE_ELEMENTS,
  hashText,
  isPlainColor,
  isTransparentColor,
  readScene,
  readSceneFile,
  sceneBackground,
} from '../../../src/fantay/artifact/viewers/whiteboard/scene';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function element(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: `${type}-${Math.random().toString(36).slice(2)}`, type, x: 0, y: 0, width: 10, height: 10, ...extra };
}

function file(elements: unknown[], appState: unknown = { viewBackgroundColor: '#ffffff' }, files: unknown = {}): string {
  return JSON.stringify({ type: 'excalidraw', version: 2, source: 'https://excalidraw.com', elements, appState, files });
}

describe('readScene', () => {
  it('reads a scene and counts only elements that are not deleted', () => {
    const reading = readScene(file([element('rectangle'), element('ellipse'), element('text', { isDeleted: true })]));
    expect(reading.kind).toBe('scene');
    if (reading.kind !== 'scene') return;
    expect(reading.stats).toEqual({ elements: 2, images: 0 });
    expect(reading.scene.elements).toHaveLength(2);
    expect(reading.scene.background).toBe('#ffffff');
    expect(reading.scene.authoredDark).toBe(false);
  });

  it('calls a scene with nothing visible empty', () => {
    expect(readScene(file([])).kind).toBe('empty');
    expect(readScene(file([element('rectangle', { isDeleted: true })])).kind).toBe('empty');
    expect(readScene(JSON.stringify({ type: 'excalidraw', version: 2 })).kind).toBe('empty');
  });

  it('tells a damaged file from JSON that is not a scene', () => {
    const whole = file([element('rectangle')]);
    expect(readScene(whole.slice(0, whole.length / 2)).kind).toBe('damaged');
    expect(readScene('').kind).toBe('damaged');
    expect(readScene(JSON.stringify({ type: 'tldraw', records: [] })).kind).toBe('not-scene');
    expect(readScene(JSON.stringify([1, 2, 3])).kind).toBe('not-scene');
    expect(readScene(JSON.stringify({ type: 'excalidraw', elements: 'nope' })).kind).toBe('not-scene');
  });

  it('accepts the editor clipboard payload, a scene without a type and a byte-order mark', () => {
    expect(readScene(JSON.stringify({ type: 'excalidraw/clipboard', elements: [element('rectangle')] })).kind).toBe('scene');
    expect(readScene(JSON.stringify({ elements: [element('rectangle')] })).kind).toBe('scene');
    expect(readScene(`﻿${file([element('rectangle')])}`).kind).toBe('scene');
  });

  it('keeps the paper, a transparent scene and a scene drawn in the dark theme', () => {
    const coloured = readScene(file([element('rectangle')], { viewBackgroundColor: '#fff4e6' }));
    const clear = readScene(file([element('rectangle')], { viewBackgroundColor: 'transparent' }));
    const dark = readScene(file([element('rectangle')], { theme: 'dark' }));
    expect(coloured.kind === 'scene' && coloured.scene.background).toBe('#fff4e6');
    expect(clear.kind === 'scene' && clear.scene.background).toBeNull();
    expect(dark.kind === 'scene' && dark.scene.authoredDark).toBe(true);
    expect(dark.kind === 'scene' && dark.scene.background).toBe('#ffffff');
  });

  it('replaces colours that are not plain colours', () => {
    const reading = readScene(
      file([element('rectangle', { strokeColor: 'url(https://example.com/paint.svg#p)', backgroundColor: '"><script>' })], {
        viewBackgroundColor: 'url(https://example.com/x)',
      }),
    );
    expect(reading.kind).toBe('scene');
    if (reading.kind !== 'scene') return;
    expect(reading.scene.elements[0]?.strokeColor).toBe('#1e1e1e');
    expect(reading.scene.elements[0]?.backgroundColor).toBe('transparent');
    expect(reading.scene.background).toBe('#ffffff');
  });

  it('keeps only image files a visible element shows, of an image type, as base64 data URLs', () => {
    const reading = readScene(
      file(
        [
          element('image', { fileId: 'good' }),
          element('image', { fileId: 'script' }),
          element('image', { fileId: 'remote' }),
          element('image', { fileId: 'html' }),
          element('image', { fileId: 'gone', isDeleted: true }),
        ],
        {},
        {
          good: { id: 'good', mimeType: 'image/png', dataURL: PNG, created: 1 },
          script: { id: 'script', mimeType: 'image/png', dataURL: 'javascript:alert(1)' },
          remote: { id: 'remote', mimeType: 'image/png', dataURL: 'https://example.com/a.png' },
          html: { id: 'html', mimeType: 'image/png', dataURL: 'data:text/html;base64,PHNjcmlwdD4=' },
          gone: { id: 'gone', mimeType: 'image/png', dataURL: PNG },
          unused: { id: 'unused', mimeType: 'image/png', dataURL: PNG },
        },
      ),
    );
    expect(reading.kind).toBe('scene');
    if (reading.kind !== 'scene') return;
    expect(Object.keys(reading.scene.files)).toEqual(['good']);
    expect(reading.stats.images).toBe(1);
  });

  it('keeps an embedded SVG picture: it is drawn as an image inside an image, where nothing runs', () => {
    const svg = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')}`;
    expect(readSceneFile('s', { dataURL: svg })?.file.mimeType).toBe('image/svg+xml');
    expect(readSceneFile('s', { dataURL: 'data:image/svg+xml,<svg/>' })).toBeNull();
    expect(readSceneFile('s', { dataURL: 'data:image/png;base64,<<<' })).toBeNull();
  });

  it('refuses scenes over the element and embedded-bytes limits', () => {
    const many = Array.from({ length: MAX_SCENE_ELEMENTS + 1 }, () => element('rectangle'));
    const tooMany = readScene(file(many));
    expect(tooMany).toMatchObject({ kind: 'too-many-elements', count: MAX_SCENE_ELEMENTS + 1, limit: MAX_SCENE_ELEMENTS });

    const body = 'A'.repeat(Math.ceil(((MAX_EMBEDDED_BYTES + 1024) * 4) / 3 / 4) * 4);
    const heavy = readScene(file([element('image', { fileId: 'big' })], {}, { big: { dataURL: `data:image/png;base64,${body}` } }));
    expect(heavy.kind).toBe('too-many-bytes');
  });
});

describe('colours', () => {
  it('knows plain colours and transparent ones', () => {
    for (const color of ['#fff', '#ffffff', '#ffffff80', 'transparent', 'white', 'rgb(1, 2, 3)', 'hsl(120 50% 50% / 0.5)']) {
      expect(isPlainColor(color)).toBe(true);
    }
    for (const color of ['url(#a)', 'red; fill: url(x)', '#ggg', 'rgb(url(x))', '']) expect(isPlainColor(color)).toBe(false);
    expect(isTransparentColor('transparent')).toBe(true);
    expect(isTransparentColor('#ffffff00')).toBe(true);
    expect(isTransparentColor('rgba(255, 255, 255, 0)')).toBe(true);
    expect(isTransparentColor('#ffffff')).toBe(false);
    expect(sceneBackground(null)).toBe('#ffffff');
    expect(sceneBackground({ viewBackgroundColor: 42 })).toBe('#ffffff');
  });
});

describe('hashText', () => {
  it('is stable and tells versions apart', () => {
    expect(hashText('{"a":1}')).toBe(hashText('{"a":1}'));
    expect(hashText('{"a":1}')).not.toBe(hashText('{"a":2}'));
  });
});

describe('localFontAddress', () => {
  const base = 'http://127.0.0.1:17575/artifact/excalidraw/';
  it('answers the library CDN font requests from the local copy', () => {
    expect(localFontAddress('https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/Xiaolai/Xiaolai-Regular-019d66dcad46dc156b162d267f981c20.woff2', base)).toBe(
      'http://127.0.0.1:17575/artifact/excalidraw/fonts/Xiaolai/Xiaolai-Regular-019d66dcad46dc156b162d267f981c20.woff2',
    );
    expect(localFontAddress('https://esm.sh/@excalidraw/excalidraw/dist/prod/fonts/Virgil/Virgil-Regular.woff2', base)).toBe(
      'http://127.0.0.1:17575/artifact/excalidraw/fonts/Virgil/Virgil-Regular.woff2',
    );
  });
  it('leaves every other address alone', () => {
    expect(localFontAddress('https://esm.sh/other/dist/prod/fonts/x.woff2', base)).toBeNull();
    expect(localFontAddress('http://127.0.0.1:17575/api/projects', base)).toBeNull();
    expect(localFontAddress('https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/index.js', base)).toBeNull();
  });
});
