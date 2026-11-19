// SPDX-License-Identifier: AGPL-3.0-only
// "Can this font draw this character", answered by drawing. Used for fonts whose tables could not
// be read (WOFF2). A character the font lacks is drawn by the fallback font, so the test draws it
// twice, once with the font in front of a fallback and once with the fallback alone: the same
// picture both times means the font added nothing. Two different fallbacks are tried, so a font
// that happens to look like one of them is still seen.
import type { GlyphTest } from './font-specimen';

const SIZE = 32;

/** Call after the font has been added to `document.fonts` under `family`. */
export function createMeasuredGlyphTest(family: string): GlyphTest {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const cache = new Map<number, boolean>();
  if (!context) return () => false;
  context.textBaseline = 'middle';
  context.textAlign = 'center';

  const draw = (font: string, text: string): Uint8ClampedArray => {
    context.clearRect(0, 0, SIZE, SIZE);
    context.font = font;
    context.fillText(text, SIZE / 2, SIZE / 2);
    return context.getImageData(0, 0, SIZE, SIZE).data;
  };
  const same = (a: Uint8ClampedArray, b: Uint8ClampedArray): boolean => {
    for (let index = 3; index < a.length; index += 4) if (a[index] !== b[index]) return false;
    return true;
  };
  const adds = (fallback: string, text: string): boolean =>
    !same(draw(`20px "${family}", ${fallback}`, text), draw(`20px ${fallback}`, text));

  return (codePoint) => {
    const known = cache.get(codePoint);
    if (known !== undefined) return known;
    const text = String.fromCodePoint(codePoint);
    const result = adds('serif', text) || adds('sans-serif', text);
    cache.set(codePoint, result);
    return result;
  };
}
