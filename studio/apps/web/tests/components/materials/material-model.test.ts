import { MATERIAL_KNOWN_KINDS } from '@open-design/contracts';
import { describe, expect, it } from 'vitest';

import {
  DESIGN_SKILL_SECTIONS,
  appendMaterialPage,
  formatSkillCommand,
  getSecondarySectionOptions,
  isSafeCssColor,
  isWebsiteMaterial,
  materialBlurb,
  materialCategoryOptions,
  materialCoverText,
  materialKindLabel,
  materialKindOptions,
  materialPathBasename,
  materialSourceHost,
  safeMaterialSourceUrl,
  materialResultCountLabel,
} from '../../../src/components/materials/material-model';
import { materialSearchParams } from '../../../src/providers/materials';
import { makeItem } from './fixtures';

describe('material-model', () => {
  it('offers every known kind until the summary loads, then only populated ones (plus the active one)', () => {
    expect(materialKindOptions(null, '')).toEqual([...MATERIAL_KNOWN_KINDS]);
    expect(materialKindOptions({ svg: 3, component: 0, website: 2 }, '')).toEqual(['svg', 'website']);
    expect(materialKindOptions({ svg: 3 }, 'html')).toEqual(['svg', 'html']);
  });

  it('uses the singular result string for exactly one hit', () => {
    const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? `:${vars.count}` : ''}`;
    expect(materialResultCountLabel(1, t)).toBe('materials.resultCountOne');
    expect(materialResultCountLabel(0, t)).toBe('materials.resultCount:0');
    expect(materialResultCountLabel(24, t)).toBe('materials.resultCount:24');
  });

  it('labels known kinds through i18n and keeps unknown kinds verbatim', () => {
    const t = (key: string) => `t:${key}`;
    expect(materialKindLabel('svg', t)).toBe('t:materials.kind.svg');
    expect(materialKindLabel('video', t)).toBe('video');
  });

  it('sorts categories by count, then name, and drops empty ones', () => {
    expect(materialCategoryOptions({ b: 2, a: 2, c: 9, empty: 0 })).toEqual([
      { name: 'c', count: 9 },
      { name: 'a', count: 2 },
      { name: 'b', count: 2 },
    ]);
    expect(materialCategoryOptions(undefined)).toEqual([]);
  });

  it('treats website kinds and website_record capabilities as bookmarks', () => {
    expect(isWebsiteMaterial(makeItem(1, { kind: 'website' }))).toBe(true);
    expect(
      isWebsiteMaterial(
        makeItem(1, {
          kind: 'html',
          capabilities: { ...makeItem(1).capabilities, material: 'website_record' },
        }),
      ),
    ).toBe(true);
    expect(isWebsiteMaterial(makeItem(1, { kind: 'component' }))).toBe(false);
  });

  it('only links http(s) sources', () => {
    expect(safeMaterialSourceUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeMaterialSourceUrl('javascript:alert(1)')).toBeNull();
    expect(safeMaterialSourceUrl('not a url')).toBeNull();
    expect(materialSourceHost('https://www.example.com/x')).toBe('example.com');
    expect(materialSourceHost(undefined)).toBeNull();
  });

  it('accepts only plain colour literals for palette styles', () => {
    expect(isSafeCssColor('#87ea5c')).toBe(true);
    expect(isSafeCssColor('rgb(1, 2, 3)')).toBe(true);
    expect(isSafeCssColor('oklch(0.7 0.2 140)')).toBe(true);
    expect(isSafeCssColor('red; background: url(x)')).toBe(false);
    expect(isSafeCssColor('url(https://x)')).toBe(false);
  });

  it('picks the card blurb and the fallback cover eyebrow', () => {
    expect(materialBlurb({ subtitle: ' Sub ', description: 'Desc' })).toBe('Sub');
    expect(materialBlurb({ description: 'Desc' })).toBe('Desc');
    expect(materialCoverText({ ...makeItem(1, { kind: 'website', source: 'https://www.linear.app/', section: '工具' }) })).toEqual({
      eyebrow: '工具',
      headline: 'linear.app',
    });
    expect(materialCoverText(makeItem(1, { kind: 'component', collection: 'Kobra' }))).toEqual({
      eyebrow: 'Kobra',
      headline: 'Material 1',
    });
    // A component with an upstream repo still leads with its own title.
    expect(materialCoverText(makeItem(1, { source: 'https://github.com/x/y' })).headline).toBe('Material 1');
  });

  it('appends pages without duplicating ids', () => {
    const a = makeItem(1);
    const b = makeItem(2);
    const current = [a];
    expect(appendMaterialPage(current, [a, b]).map((item) => item.id)).toEqual(['item-1', 'item-2']);
    expect(appendMaterialPage(current, [a])).toBe(current);
  });

  it('names applied files by their basename', () => {
    expect(materialPathBasename('references/kobra-toast/toast.tsx')).toBe('toast.tsx');
  });

  it('builds the items query string without empty values', () => {
    expect(materialSearchParams({ q: '  ', limit: 24, offset: 0 })).toBe('limit=24');
    expect(
      new URLSearchParams(materialSearchParams({ q: '通知 toast', kind: 'svg', category: 'SVG 图标', limit: 24, offset: 48 })).toString(),
    ).toBe(new URLSearchParams({ q: '通知 toast', kind: 'svg', category: 'SVG 图标', limit: '24', offset: '48' }).toString());
  });

  it('populates secondary sections for 设计 Skill and formats vs-* skill commands', () => {
    const sections = getSecondarySectionOptions('设计 Skill', [
      makeItem(1, { category: '设计 Skill', section: '网页 / UI' }),
    ]);
    const names = sections.map((s) => s.name);
    for (const expected of DESIGN_SKILL_SECTIONS) {
      expect(names).toContain(expected);
    }
    expect(sections.find((s) => s.name === '网页 / UI')?.count).toBe(1);
    expect(formatSkillCommand({ id: 'vs-dammyjay93-interface-design', title: 'interface-design' })).toBe(
      '/nmem-skill-load dammyjay93-interface-design',
    );
    expect(formatSkillCommand({ id: 'skill-frontend-design', title: 'frontend-design' })).toBe(
      '/nmem-skill-load frontend-design',
    );
  });
});
