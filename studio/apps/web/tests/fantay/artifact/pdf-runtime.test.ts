// SPDX-License-Identifier: AGPL-3.0-only
// The parts of the PDF viewer around the drawing itself: the order pages are drawn in, what is kept
// of a viewer that went away, how load errors are worded, where a link's destination points, and
// that the worker and data files this app serves are the ones of the installed pdf.js.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPdfBitmapKeeper, freePdfCanvas } from '../../../src/fantay/artifact/viewers/pdf/bitmap-keeper';
import {
  PDF_ASSET_PATH,
  classifyPdfError,
  forgetPdfPassword,
  isPdfCancellation,
  rememberPdfPassword,
  rememberedPdfPassword,
} from '../../../src/fantay/artifact/viewers/pdf/pdf-document';
import { pdfDestinationTop } from '../../../src/fantay/artifact/viewers/pdf/pdf-links';
import { createPdfRenderQueue } from '../../../src/fantay/artifact/viewers/pdf/render-queue';

const WEB_ROOT = resolve(__dirname, '../../..');

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolvePromise = done;
  });
  return { promise, resolve: resolvePromise };
}

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
};

describe('the drawing queue', () => {
  it('draws one page at a time, nearest to the middle of the window first', async () => {
    const queue = createPdfRenderQueue();
    const order: number[] = [];
    const gates = new Map<number, ReturnType<typeof deferred>>();
    const distances = new Map([
      [0, 900],
      [1, 0],
      [2, 400],
    ]);
    for (const page of [0, 1, 2]) {
      const gate = deferred();
      gates.set(page, gate);
      queue.enqueue(
        () => distances.get(page) ?? 0,
        async () => {
          order.push(page);
          await gate.promise;
        },
      );
    }
    await settle();
    expect(order).toEqual([1]);
    expect(queue.size).toBe(3);
    gates.get(1)?.resolve();
    await settle();
    expect(order).toEqual([1, 2]);
    gates.get(2)?.resolve();
    await settle();
    expect(order).toEqual([1, 2, 0]);
    gates.get(0)?.resolve();
    await settle();
    expect(queue.size).toBe(0);
  });

  it('asks for the distance when it picks, so the order follows the scroll', async () => {
    const queue = createPdfRenderQueue();
    const order: string[] = [];
    const first = deferred();
    let scrolled = false;
    queue.enqueue(
      () => 0,
      async () => {
        order.push('visible');
        await first.promise;
      },
    );
    queue.enqueue(() => (scrolled ? 500 : 100), async () => void order.push('a'));
    queue.enqueue(() => (scrolled ? 50 : 300), async () => void order.push('b'));
    await settle();
    scrolled = true;
    first.resolve();
    await settle();
    expect(order).toEqual(['visible', 'b', 'a']);
  });

  it('does not start a job that was withdrawn, and survives a job that throws', async () => {
    const queue = createPdfRenderQueue();
    const order: string[] = [];
    queue.enqueue(
      () => 0,
      async () => {
        order.push('throws');
        throw new Error('page failed');
      },
    );
    const withdraw = queue.enqueue(() => 1, async () => void order.push('withdrawn'));
    queue.enqueue(() => 2, async () => void order.push('after'));
    withdraw();
    await settle();
    expect(order).toEqual(['throws', 'after']);
  });

  it('starts nothing while paused and catches up afterwards', async () => {
    const queue = createPdfRenderQueue();
    const order: string[] = [];
    queue.setPaused(true);
    queue.enqueue(() => 0, async () => void order.push('page'));
    await settle();
    expect(order).toEqual([]);
    queue.setPaused(false);
    await settle();
    expect(order).toEqual(['page']);
  });
});

describe('kept bitmaps', () => {
  /** Stands in for a canvas: the keeper only reads and zeroes its size. */
  const canvas = (width = 1000, height = 1000): HTMLCanvasElement => ({ width, height }) as HTMLCanvasElement;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('releases a page that only scrolled away', () => {
    const keeper = createPdfBitmapKeeper('scroll-away', () => 0);
    const detach = keeper.attach();
    const page = canvas();
    keeper.retire(4, page);
    vi.advanceTimersByTime(1);
    expect(page.width).toBe(0);
    detach();
    vi.advanceTimersByTime(1);
    expect(createPdfBitmapKeeper('scroll-away', () => 0).seed(4)).toBeUndefined();
  });

  it('hands the pages on screen to the next viewer of the same file', () => {
    const keeper = createPdfBitmapKeeper('tab-switch', () => 7);
    const detach = keeper.attach();
    const pages = new Map([6, 7, 8].map((index) => [index, canvas()] as const));
    // The viewer unmounts: its pages give their canvases back, then it detaches.
    for (const [index, page] of pages) keeper.retire(index, page);
    detach();
    vi.advanceTimersByTime(1);

    const next = createPdfBitmapKeeper('tab-switch', () => 7);
    expect(next.seed(7)).toBe(pages.get(7));
    expect(pages.get(7)?.width).toBe(1000);
    // Handed out once.
    expect(next.seed(7)).toBeUndefined();
    // Another file gets nothing.
    expect(createPdfBitmapKeeper('other-file', () => 7).seed(6)).toBeUndefined();
  });

  it('keeps the pages nearest to the reader within the byte budget', () => {
    const keeper = createPdfBitmapKeeper('budget', () => 10);
    const detach = keeper.attach();
    // 16 MB each: only two fit in the budget.
    const pages = new Map([8, 9, 10, 11].map((index) => [index, canvas(2000, 2000)] as const));
    for (const [index, page] of pages) keeper.retire(index, page);
    detach();
    vi.advanceTimersByTime(1);
    expect(pages.get(10)?.width).toBe(2000);
    expect(pages.get(8)?.width).toBe(0);
    expect([9, 11].filter((index) => pages.get(index)?.width === 2000)).toHaveLength(1);
  });

  it('lets go of what it kept after a while', () => {
    const keeper = createPdfBitmapKeeper('expiry', () => 0);
    const detach = keeper.attach();
    const page = canvas();
    keeper.retire(0, page);
    detach();
    vi.advanceTimersByTime(1);
    expect(page.width).toBe(1000);
    vi.advanceTimersByTime(10 * 60_000);
    expect(page.width).toBe(0);
    expect(createPdfBitmapKeeper('expiry', () => 0).seed(0)).toBeUndefined();
  });

  it('gives a page its canvas back when the viewer is mounted again at once (React strict mode)', () => {
    const keeper = createPdfBitmapKeeper('strict', () => 0);
    let detach = keeper.attach();
    const page = canvas();
    keeper.retire(2, page);
    detach();
    detach = keeper.attach();
    expect(keeper.seed(2)).toBe(page);
    vi.advanceTimersByTime(1);
    expect(page.width).toBe(1000);
    detach();
  });

  it('frees a canvas by zeroing its size', () => {
    const page = canvas(640, 480);
    freePdfCanvas(page);
    expect([page.width, page.height]).toEqual([0, 0]);
  });
});

describe('load errors', () => {
  const named = (name: string, message = ''): Error => Object.assign(new Error(message), { name });

  it('sorts pdf.js exceptions into the states the viewer shows', () => {
    expect(classifyPdfError(named('InvalidPDFException', 'Invalid PDF structure.'))).toBe('damaged');
    expect(classifyPdfError(named('InvalidPDFException', 'The PDF file is empty, i.e. its size is zero bytes.'))).toBe('empty');
    expect(classifyPdfError(named('FormatError', 'bad XRef entry'))).toBe('damaged');
    expect(classifyPdfError(named('UnknownErrorException'))).toBe('damaged');
    expect(classifyPdfError(named('ResponseException'))).toBe('damaged');
  });

  it('does not blame the file when the library itself failed', () => {
    expect(classifyPdfError(new Error('Loading chunk 12 failed'))).toBe('unavailable');
    expect(classifyPdfError(new Error('The API version "6.5.438" does not match the Worker version "6.4.0".'))).toBe('unavailable');
    expect(classifyPdfError(undefined)).toBe('unavailable');
    expect(classifyPdfError('boom')).toBe('unavailable');
  });

  it('recognises a cancelled drawing', () => {
    expect(isPdfCancellation(named('RenderingCancelledException'))).toBe(true);
    expect(isPdfCancellation(named('AbortException'))).toBe(true);
    expect(isPdfCancellation(new Error('nope'))).toBe(false);
    expect(isPdfCancellation(null)).toBe(false);
  });
});

describe('remembered passwords', () => {
  it('are kept per file, in memory, and can be forgotten', () => {
    expect(rememberedPdfPassword('p\na.pdf')).toBeUndefined();
    rememberPdfPassword('p\na.pdf', 'coffee');
    expect(rememberedPdfPassword('p\na.pdf')).toBe('coffee');
    expect(rememberedPdfPassword('p\nb.pdf')).toBeUndefined();
    forgetPdfPassword('p\na.pdf');
    expect(rememberedPdfPassword('p\na.pdf')).toBeUndefined();
  });

  it('are bounded', () => {
    for (let index = 0; index < 40; index += 1) rememberPdfPassword(`p\n${index}.pdf`, 'x');
    expect(rememberedPdfPassword('p\n0.pdf')).toBeUndefined();
    expect(rememberedPdfPassword('p\n39.pdf')).toBe('x');
  });
});

describe('link destinations', () => {
  const ref = { num: 4, gen: 0 };

  it('reads the height a destination asks for', () => {
    expect(pdfDestinationTop([ref, { name: 'XYZ' }, 72, 640, null])).toBe(640);
    expect(pdfDestinationTop([ref, { name: 'XYZ' }, null, null, null])).toBeNull();
    expect(pdfDestinationTop([ref, { name: 'FitH' }, 500])).toBe(500);
    expect(pdfDestinationTop([ref, { name: 'FitBH' }, 480])).toBe(480);
    expect(pdfDestinationTop([ref, { name: 'FitR' }, 10, 20, 300, 700])).toBe(700);
  });

  it('means the top of the page for a destination without one', () => {
    expect(pdfDestinationTop([ref, { name: 'Fit' }])).toBeNull();
    expect(pdfDestinationTop([ref, { name: 'FitV' }, 100])).toBeNull();
    expect(pdfDestinationTop([ref])).toBeNull();
    expect(pdfDestinationTop([ref, 'XYZ', 0, 100])).toBeNull();
  });
});

describe('the pdf.js files this app serves', () => {
  const served = join(WEB_ROOT, 'public', PDF_ASSET_PATH);
  const packageRoot = join(WEB_ROOT, 'node_modules/pdfjs-dist');
  const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

  it('has the worker of the installed version, byte for byte', () => {
    expect(existsSync(join(served, 'pdf.worker.min.mjs'))).toBe(true);
    expect(sha(join(served, 'pdf.worker.min.mjs'))).toBe(sha(join(packageRoot, 'build/pdf.worker.min.mjs')));
  });

  it('has every character map, standard font and colour profile of the package', () => {
    for (const folder of ['cmaps', 'standard_fonts', 'iccs']) {
      const expected = readdirSync(join(packageRoot, folder)).sort();
      expect(readdirSync(join(served, folder)).sort()).toEqual(expected);
      for (const name of expected) expect(sha(join(served, folder, name)), `${folder}/${name}`).toBe(sha(join(packageRoot, folder, name)));
    }
  });

  it('has the image decoders and never the scripting sandbox', () => {
    const names = readdirSync(join(served, 'wasm'));
    for (const name of ['openjpeg.wasm', 'openjpeg_nowasm_fallback.js', 'jbig2.wasm', 'jbig2_nowasm_fallback.js', 'qcms_bg.wasm']) {
      expect(names).toContain(name);
      expect(sha(join(served, 'wasm', name)), name).toBe(sha(join(packageRoot, 'wasm', name)));
    }
    // QuickJS runs JavaScript embedded in a PDF. This viewer never does, so the engine is not shipped.
    expect(names.filter((name) => /quickjs/i.test(name))).toEqual([]);
    expect(readdirSync(served).filter((name) => /sandbox/i.test(name))).toEqual([]);
  });
});
