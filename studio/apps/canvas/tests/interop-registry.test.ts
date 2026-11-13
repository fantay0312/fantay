// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/** Interop registry (06 §8.5): extension routing, Penpot disabled, `.op` stays `.op`, converted `.op` paths. */
import { DesignBridgeFailure } from '@open-design/contracts/runtime/design-editor-bridge';
import { describe, expect, it, vi } from 'vitest';

import { convertedFigPath, probeProjectFileExists } from '../src/fx/editor/session';
import { canAutoFocusCanvas, editorUi } from '../src/fx/editor/ui-state';
import { patchCanvasKitPathForOpSdk } from '../src/fx/interop/op';
import { DESIGN_INTEROPS, baseNameOf, extensionOf, findInterop, importDesignFile } from '../src/fx/interop/registry';

const ctx = { fetchAsset: async () => ({ bytes: new ArrayBuffer(0), mime: '' }), t: (key: string) => key };

describe('DESIGN_INTEROPS', () => {
  it('lists the phase-1 formats with Penpot disabled', () => {
    expect(DESIGN_INTEROPS.map((interop) => [interop.id, interop.enabled])).toEqual([
      ['fig', true],
      ['op', true],
      ['pen', true],
      ['svg', true],
      ['html', true],
      ['doop-json', true],
      ['penpot', false],
    ]);
    for (const interop of DESIGN_INTEROPS) {
      for (const extension of interop.extensions) expect(extension).toMatch(/^[a-z]+$/);
      expect(interop.label).not.toMatch(/Fantay/);
      if (interop.enabled) expect(typeof interop.import).toBe('function');
    }
    expect(DESIGN_INTEROPS.find((interop) => interop.id === 'penpot')?.label).toBe('Penpot (.penpot)');
  });
});

describe('findInterop', () => {
  it('routes by extension, case-insensitively', () => {
    expect(findInterop('designs/Home.FIG')?.id).toBe('fig');
    expect(findInterop('a.op')?.id).toBe('op');
    expect(findInterop('a.pen')?.id).toBe('pen');
    expect(findInterop('logo.svg')?.id).toBe('svg');
    expect(findInterop('index.html')?.id).toBe('html');
    expect(findInterop('index.htm')?.id).toBe('html');
    expect(findInterop('canvas.json')?.id).toBe('doop-json');
  });

  it('returns nothing for disabled or unknown formats', () => {
    expect(findInterop('file.penpot')).toBeNull();
    expect(findInterop('photo.png')).toBeNull();
    expect(findInterop('README')).toBeNull();
    expect(findInterop('.fig')).toBeNull();
  });

  it('parses names', () => {
    expect(extensionOf('a/b/c.SVG')).toBe('svg');
    expect(extensionOf('noext')).toBe('');
    expect(baseNameOf('designs/首页.fig')).toBe('首页');
    expect(baseNameOf('C:\\files\\logo.svg')).toBe('logo');
    expect(baseNameOf('.hidden')).toBe('.hidden');
  });
});

describe('importDesignFile', () => {
  it('keeps .op documents as .op bytes', async () => {
    const bytes = new TextEncoder().encode('{"version":"1"}').buffer;
    const result = await importDesignFile({ fileName: 'a.op', bytes }, ctx);
    expect(result.kind).toBe('op');
    if (result.kind === 'op') expect([...result.bytes]).toEqual([...new Uint8Array(bytes)]);
  });

  it('rejects unsupported files', async () => {
    await expect(importDesignFile({ fileName: 'a.penpot', bytes: new ArrayBuffer(1) }, ctx)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('convertedFigPath', () => {
  it('puts the converted design next to the .op original, then suffixes', () => {
    expect(convertedFigPath('designs/首页.op', 1)).toBe('designs/首页.fig');
    expect(convertedFigPath('designs/首页.op', 2)).toBe('designs/首页-2.fig');
    expect(convertedFigPath('board.OP', 3)).toBe('board-3.fig');
  });
});

describe('probeProjectFileExists (B28)', () => {
  it('treats only NOT_FOUND as free, TOO_LARGE as existing, and rethrows other errors', async () => {
    await expect(probeProjectFileExists(async () => ({ bytes: new ArrayBuffer(1), mime: 'text/plain' }), 'a.fig')).resolves.toBe(true);
    await expect(
      probeProjectFileExists(async () => {
        throw new DesignBridgeFailure('TOO_LARGE', 'too large');
      }, 'a.fig'),
    ).resolves.toBe(true);
    await expect(
      probeProjectFileExists(async () => {
        throw new DesignBridgeFailure('NOT_FOUND', 'missing');
      }, 'a.fig'),
    ).resolves.toBe(false);
    await expect(
      probeProjectFileExists(async () => {
        throw new DesignBridgeFailure('NETWORK', 'offline');
      }, 'a.fig'),
    ).rejects.toMatchObject({ code: 'NETWORK' });
    await expect(
      probeProjectFileExists(async () => {
        throw new DesignBridgeFailure('FORBIDDEN', 'forbidden');
      }, 'a.fig'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('canAutoFocusCanvas (O2)', () => {
  it('suppresses auto-focus when hidden, headless, or inside an aria-hidden frame', () => {
    editorUi.visible = true;
    expect(canAutoFocusCanvas(window)).toBe(true);
    editorUi.visible = false;
    expect(canAutoFocusCanvas(window)).toBe(false);
    editorUi.visible = true;
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    const fakeWin = { location: { search: '' }, frameElement: frame } as unknown as Window;
    expect(canAutoFocusCanvas(fakeWin)).toBe(false);
  });
});

describe('patchCanvasKitPathForOpSdk', () => {
  it('shims Path.prototype.transform and path builder methods via PathBuilder', () => {
    const deleteSpy = vi.fn();
    class FakePath {
      Fd = 100;
      delete() {
        deleteSpy(this.Fd);
      }
    }
    class FakePathBuilder {
      private nextFd: number;
      constructor(source?: FakePath) {
        this.nextFd = (source?.Fd ?? 0) + 1;
      }
      transform() {
        this.nextFd += 10;
      }
      moveTo() {
        this.nextFd += 1;
      }
      lineTo() {
        this.nextFd += 2;
      }
      close() {
        this.nextFd += 3;
      }
      detachAndDelete() {
        const out = new FakePath();
        out.Fd = this.nextFd;
        return out;
      }
    }
    patchCanvasKitPathForOpSdk({
      Path: FakePath as unknown as { prototype?: Record<string, unknown> },
      PathBuilder: FakePathBuilder as unknown as new (path?: unknown) => FakePathBuilder,
    });
    const path = new FakePath() as FakePath & {
      transform(matrix: number[]): FakePath;
      moveTo(x: number, y: number): FakePath;
      lineTo(x: number, y: number): FakePath;
      close(): FakePath;
    };
    path.transform([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(path.Fd).toBe(111);
    expect(deleteSpy).toHaveBeenCalledWith(100);
    path.moveTo(0, 0);
    path.lineTo(10, 10);
    path.close();
    expect(path.Fd).toBe(120);
  });
});
