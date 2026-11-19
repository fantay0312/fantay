// SPDX-License-Identifier: AGPL-3.0-only
// What happens around the Word renderer: the look at the container before anything is laid out,
// the stand-in fonts, and the arithmetic of "fit width".
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { DOCX_RENDER_OPTIONS, inspectDocx } from '../../../src/fantay/artifact/viewers/document/docx';
import { splitFamilies, withFontFallbacks } from '../../../src/fantay/artifact/viewers/document/fonts';
import { fitWidthZoom } from '../../../src/fantay/artifact/viewers/document/frame-view';

const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function docx(extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8('<w:document/>'),
    ...extra,
  });
}

describe('inspectDocx', () => {
  it('accepts a Word container and reads the page count Word saved', () => {
    expect(inspectDocx(docx())).toEqual({ ok: true, pages: null });
    const app = strToU8('<Properties><Application>Microsoft Office Word</Application><Pages>12</Pages></Properties>');
    expect(inspectDocx(docx({ 'docProps/app.xml': app }))).toEqual({ ok: true, pages: 12 });
    expect(inspectDocx(docx({ 'docProps/app.xml': strToU8('<Properties><Pages>0</Pages></Properties>') }))).toEqual({ ok: true, pages: null });
  });

  it('tells a password-protected file from an old binary one', () => {
    const encrypted = Uint8Array.from([...OLE, ...new Array<number>(64).fill(0), ...Array.from('EncryptedPackage').flatMap((char) => [char.charCodeAt(0), 0])]);
    expect(inspectDocx(encrypted)).toEqual({ ok: false, problem: 'encrypted' });
    expect(inspectDocx(Uint8Array.from([...OLE, ...new Array<number>(64).fill(0)]))).toEqual({ ok: false, problem: 'legacy' });
  });

  it('refuses what is not a Word document', () => {
    expect(inspectDocx(strToU8('{\\rtf1 hello}'))).toEqual({ ok: false, problem: 'not-word' });
    expect(inspectDocx(zipSync({ 'readme.txt': strToU8('zip, but not Word') }))).toEqual({ ok: false, problem: 'not-word' });
    expect(inspectDocx(zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'xl/workbook.xml': strToU8('<x/>') }))).toEqual({ ok: false, problem: 'not-word' });
    expect(inspectDocx(new Uint8Array(0))).toEqual({ ok: false, problem: 'not-word' });
  });

  it('never lets the file bring its own HTML or leave object addresses behind', () => {
    expect(DOCX_RENDER_OPTIONS.renderAltChunks).toBe(false);
    expect(DOCX_RENDER_OPTIONS.useBase64URL).toBe(true);
  });
});

describe('withFontFallbacks', () => {
  it('appends the fonts that stand in for a Windows font, then a generic family', () => {
    expect(withFontFallbacks('宋体')).toBe('宋体, "Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", "Source Han Serif SC", serif');
    expect(withFontFallbacks('"Microsoft YaHei"')).toBe('"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif');
  });

  it('keeps the document order: the Latin font first, then the East Asian one', () => {
    expect(withFontFallbacks('Calibri, 宋体')).toBe(
      'Calibri, "Carlito", "Helvetica Neue", "Arial", 宋体, "Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", "Source Han Serif SC", sans-serif',
    );
  });

  it('leaves variables and unknown fonts alone, and does not add a second generic', () => {
    expect(withFontFallbacks('var(--docx-minorHAnsi-font), 黑体')).toBe(
      'var(--docx-minorHAnsi-font), 黑体, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif',
    );
    expect(withFontFallbacks('"My Brand Font"')).toBe('"My Brand Font", sans-serif');
    expect(withFontFallbacks('Georgia, serif')).toBe('Georgia, "Caladea", "Times New Roman", serif');
  });

  it('adds no generic to a value used at the front of a longer list', () => {
    expect(withFontFallbacks('Calibri', false)).toBe('Calibri, "Carlito", "Helvetica Neue", "Arial"');
  });

  it('splits on commas outside quotes and parentheses only', () => {
    expect(splitFamilies('"A, B", var(--x, serif), C')).toEqual(['"A, B"', 'var(--x, serif)', 'C']);
  });
});

describe('fitWidthZoom', () => {
  it('fills the width of the window, never above 100%', () => {
    expect(fitWidthZoom(794, 548, 24)).toBeCloseTo(500 / 794, 5);
    expect(fitWidthZoom(794, 1600, 24)).toBe(1);
    expect(fitWidthZoom(794, 100, 24, 0.25)).toBe(0.25);
    expect(fitWidthZoom(0, 600, 24)).toBe(1);
  });
});
