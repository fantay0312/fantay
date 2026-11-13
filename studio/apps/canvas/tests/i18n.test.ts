// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/** Editor strings (06 §9, A5): the bilingual standalone notice, SDK locale mapping, host messages. */
import { describe, expect, it } from 'vitest';

import { STANDALONE_NOTICE, sdkLocaleFor, setEditorLocale, t } from '../src/host/i18n';

describe('editor strings', () => {
  it('names the product exactly in the only literal UI string (A5)', () => {
    expect(STANDALONE_NOTICE).toBe('Open design files from a Fantaydesign workspace · 请在 Fantaydesign 工作区中打开设计文件');
    expect(STANDALONE_NOTICE).not.toMatch(/Fantay(?!design)/);
  });

  it('maps Fantay locales onto the SDK catalogues', () => {
    expect(sdkLocaleFor('en')).toBe('en');
    expect(sdkLocaleFor('es-ES')).toBe('es');
    expect(sdkLocaleFor('zh-CN')).toBe('zh-CN');
    expect(sdkLocaleFor('zh-TW')).toBe('zh-CN');
    expect(sdkLocaleFor('ja')).toBe('ja');
    expect(sdkLocaleFor('ko')).toBe('en');
    expect(sdkLocaleFor('pt-BR')).toBe('en');
  });

  it('applies the host language and fills placeholders', () => {
    setEditorLocale('zh-CN', { 'designEditor.toast.copied': '已复制{what}', 'designEditor.panel.layers': '图层' });
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(t('designEditor.panel.layers')).toBe('图层');
    expect(t('designEditor.toast.copied', { what: 'SVG' })).toBe('已复制SVG');
    expect(t('designEditor.toast.copied')).toBe('已复制{what}');
    expect(t('designEditor.unknown')).toBe('');
    setEditorLocale('not a locale', {});
    expect(document.documentElement.lang).toBe('en');
  });
});
