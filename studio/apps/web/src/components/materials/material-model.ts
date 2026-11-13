// Pure helpers shared by the Materials view and the composer's material picker.
// No JSX, no DOM: everything here is unit-testable without jsdom.

import {
  MATERIAL_KNOWN_KINDS,
  type MaterialKnownKind,
  type MaterialLibraryUnavailableReason,
  type MaterialSummaryItem,
} from '@open-design/contracts';
import type { Dict } from '../../i18n/types';

type DictKey = keyof Dict;

/** One batch of the infinite grid. Matches the contract's default page size. */
export const MATERIAL_PAGE_SIZE = 24;

/** Search input debounce, the same pause the OD Library picker uses. */
export const MATERIAL_SEARCH_DEBOUNCE_MS = 250;

const KIND_LABEL_KEYS: Partial<Record<MaterialKnownKind, DictKey>> = {
  style: 'materials.kind.style',
  component: 'materials.kind.component',
  svg: 'materials.kind.svg',
  skill: 'materials.kind.skill',
  website: 'materials.kind.website',
  html: 'materials.kind.html',
  markdown: 'materials.kind.markdown',
  file: 'materials.kind.file',
};

export function isKnownMaterialKind(kind: string): kind is MaterialKnownKind {
  return (MATERIAL_KNOWN_KINDS as readonly string[]).includes(kind);
}

/**
 * Label for a record kind. The archive may add kinds the contract does not
 * list yet; those render verbatim instead of disappearing.
 */
/** "N results", with the singular string for exactly one. */
export function materialResultCountLabel(
  total: number,
  t: (key: DictKey, vars?: Record<string, string | number>) => string,
): string {
  return total === 1 ? t('materials.resultCountOne') : t('materials.resultCount', { count: total });
}

export function materialKindLabel(
  kind: string,
  t: (key: DictKey) => string,
): string {
  const labelKey = isKnownMaterialKind(kind) ? KIND_LABEL_KEYS[kind] : undefined;
  return labelKey ? t(labelKey) : kind;
}

/**
 * The kind filter options, in contract order. Once the summary is loaded,
 * kinds with no records are dropped (a filter that can only return nothing is
 * noise), but the active one always stays so the control never loses its
 * selection.
 */
export function materialKindOptions(
  kindCounts: Record<string, number> | null | undefined,
  active: string,
): MaterialKnownKind[] {
  if (!kindCounts) return [...MATERIAL_KNOWN_KINDS];
  return MATERIAL_KNOWN_KINDS.filter((kind) => (kindCounts[kind] ?? 0) > 0 || kind === active);
}

/** Categories sorted by record count (desc), then name, for the filter Select. */
export function materialCategoryOptions(
  categories: Record<string, number> | null | undefined,
): Array<{ name: string; count: number }> {
  if (!categories) return [];
  return Object.entries(categories)
    .filter(([name, count]) => name && count > 0)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Website records are bookmarks: there is nothing to copy into a project, so
 * the composer inserts their reference packet as text instead of applying them.
 */
export function isWebsiteMaterial(item: Pick<MaterialSummaryItem, 'kind' | 'capabilities'>): boolean {
  return item.kind === 'website' || item.capabilities?.material === 'website_record';
}

/** Host of the record's source URL (`www.` stripped), or null when it has none. */
export function materialSourceHost(source: string | undefined | null): string | null {
  if (!source) return null;
  try {
    const url = new URL(source);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Only http(s) sources become links; anything else renders as plain text. */
export function safeMaterialSourceUrl(source: string | undefined | null): string | null {
  if (!source) return null;
  try {
    const url = new URL(source);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Palette values are archive data; only plain CSS colour literals reach `style`. */
export function isSafeCssColor(value: string): boolean {
  const v = value.trim();
  return (
    /^#[0-9a-f]{3,8}$/i.test(v)
    || /^(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([0-9.,%\s/+-]+\)$/i.test(v)
  );
}

/** Line under the card title: subtitle when the archive has one, else description. */
export function materialBlurb(item: Pick<MaterialSummaryItem, 'subtitle' | 'description'>): string {
  const subtitle = item.subtitle?.trim();
  if (subtitle) return subtitle;
  return item.description?.trim() ?? '';
}

/**
 * Text for the typographic fallback cover. A bookmark is identified by its
 * site, so website records lead with the host (the title already sits under
 * the cover); everything else leads with its title under the collection name.
 */
export function materialCoverText(
  item: Pick<MaterialSummaryItem, 'kind' | 'capabilities' | 'source' | 'title' | 'section' | 'collection' | 'category'>,
): { eyebrow: string; headline: string } {
  const host = isWebsiteMaterial(item) ? materialSourceHost(item.source) : null;
  if (host) return { eyebrow: item.section ?? item.category ?? '', headline: host };
  return { eyebrow: item.collection || item.category || '', headline: item.title };
}

export const MATERIAL_REASON_KEYS: Record<MaterialLibraryUnavailableReason, DictKey> = {
  'not-configured': 'materials.reason.notConfigured',
  'missing-root': 'materials.reason.missingRoot',
  'missing-index': 'materials.reason.missingIndex',
  'invalid-index': 'materials.reason.invalidIndex',
};

/** Last path segment, used as the attachment chip name for applied files. */
export function materialPathBasename(relPath: string): string {
  const parts = relPath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? relPath;
}

/** Image-like file names become image attachment chips. */
export function looksLikeMaterialImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(name);
}

/** Merge a new page into the loaded list, dropping ids already shown. */
export function appendMaterialPage(
  current: MaterialSummaryItem[],
  next: MaterialSummaryItem[],
): MaterialSummaryItem[] {
  if (next.length === 0) return current;
  const seen = new Set(current.map((item) => item.id));
  const fresh = next.filter((item) => !seen.has(item.id));
  return fresh.length === 0 ? current : [...current, ...fresh];
}

export interface PrimaryTabOption {
  key: string;
  label: string;
  category: string;
  count: number;
}

export const MATERIAL_BUSINESS_CATEGORIES = [
  '全部',
  '组件',
  '设计 Skill',
  '图像创作',
  '视频创作',
  '收藏网站',
  '风格参考',
  'SVG 图标',
  '模板与资料',
] as const;

export type MaterialBusinessCategory = (typeof MATERIAL_BUSINESS_CATEGORIES)[number];

/** Calculates exact Level 1 Primary Tab counts from summary */
export function getPrimaryTabOptions(
  summaryCounts: { categories?: Record<string, number> | null; total?: number | null } | null | undefined,
): PrimaryTabOption[] {
  const cats = summaryCounts?.categories ?? {};
  const total = summaryCounts?.total ?? 0;

  const componentCount = (cats['交互组件'] ?? 0) + (cats['AI 组件'] ?? 0);
  const templateCount = (cats['页面模板'] ?? 0) + (cats['参考资料'] ?? 0);

  return [
    { key: 'all', label: '全部', category: '', count: total },
    { key: 'component', label: '组件', category: '组件', count: componentCount },
    { key: 'skill', label: '设计 Skill', category: '设计 Skill', count: cats['设计 Skill'] ?? 0 },
    { key: 'image', label: '图像创作', category: '图像创作', count: cats['图像创作'] ?? 0 },
    { key: 'video', label: '视频创作', category: '视频创作', count: cats['视频创作'] ?? 0 },
    { key: 'website', label: '收藏网站', category: '收藏网站', count: cats['收藏网站'] ?? 0 },
    { key: 'style', label: '风格参考', category: '风格参考', count: cats['风格参考'] ?? 0 },
    { key: 'svg', label: 'SVG 图标', category: 'SVG 图标', count: cats['SVG 图标'] ?? 0 },
    { key: 'template', label: '模板与资料', category: '模板与资料', count: templateCount },
  ];
}

export interface SectionOption {
  key: string;
  name: string;
  count: number;
}

export const COMPONENT_SUBCATEGORIES: readonly string[] = [
  '操作',
  '输入',
  '导航',
  '浮层',
  '数据展示',
  '反馈',
  '布局',
  '动效视觉',
  'Agent/AI 组件',
];

export const DESIGN_SKILL_SECTIONS: readonly string[] = [
  '网页 / UI',
  '图解 / 信息图',
  '视觉报告',
  '平面 / 品牌',
  '3D / 空间',
  '游戏视觉',
  '数据可视化',
  '光影与动效',
  'CAD / 工程图',
  '插图与交互',
];

export const VIDEO_CREATION_SECTIONS: readonly string[] = [
  '动画与三维',
  '视频制作',
  '视频拆解与工作流',
  '视频创作',
  'PPT / 演示',
  '动画 / 动效',
];

export const STYLE_REFERENCE_SECTIONS: readonly string[] = [
  '拟物与材质',
  '产品与组件',
  '光影与动效',
  '叙事与空间',
  '作品集与个人网站',
];

export const IMAGE_CREATION_SECTIONS: readonly string[] = [
  '图像处理',
  '插画与图像',
  '插图与交互',
  '封面与海报',
  '图像 / 插画',
];

export function matchesMaterialCategory(
  item: Pick<MaterialSummaryItem, 'category'>,
  category: string,
): boolean {
  if (!category || category === '全部') return true;
  if (category === '组件') {
    return item.category === '交互组件' || item.category === 'AI 组件';
  }
  if (category === '模板与资料') {
    return item.category === '页面模板' || item.category === '参考资料';
  }
  return item.category === category;
}

/** Dynamically computes Level 2 Section options and exact counts for the active category */
export function getSecondarySectionOptions(
  category: string,
  items: MaterialSummaryItem[],
): SectionOption[] {
  const matching = items.filter((item) => matchesMaterialCategory(item, category));
  const counts: Record<string, number> = {};
  for (const item of matching) {
    if (item.section) {
      counts[item.section] = (counts[item.section] ?? 0) + 1;
    }
  }

  // Pre-populate expected sections so they appear even if current batch hasn't finished loading all items
  if (category === '组件') {
    for (const sub of COMPONENT_SUBCATEGORIES) {
      if (counts[sub] === undefined) counts[sub] = 0;
    }
  } else if (category === '设计 Skill') {
    for (const sub of DESIGN_SKILL_SECTIONS) {
      if (counts[sub] === undefined) counts[sub] = 0;
    }
  } else if (category === '视频创作') {
    for (const sub of VIDEO_CREATION_SECTIONS) {
      if (counts[sub] === undefined) counts[sub] = 0;
    }
  } else if (category === '风格参考') {
    for (const sub of STYLE_REFERENCE_SECTIONS) {
      if (counts[sub] === undefined) counts[sub] = 0;
    }
  } else if (category === '图像创作') {
    for (const sub of IMAGE_CREATION_SECTIONS) {
      if (counts[sub] === undefined) counts[sub] = 0;
    }
  }

  return Object.entries(counts)
    .filter(([name]) => Boolean(name))
    .map(([name, count]) => ({ key: name, name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export type MaterialCardArchetype =
  | 'style'
  | 'component'
  | 'skill'
  | 'multimedia'
  | 'website'
  | 'default';

export function getMaterialArchetype(
  item: Pick<MaterialSummaryItem, 'category' | 'kind' | 'capabilities'>,
): MaterialCardArchetype {
  if (
    item.category === '收藏网站'
    || item.kind === 'website'
    || item.capabilities?.material === 'website_record'
  ) {
    return 'website';
  }
  if (
    item.category === '设计 Skill'
    || (item.kind === 'skill' && item.category !== '视频创作' && item.category !== '图像创作')
  ) {
    return 'skill';
  }
  if (item.category === '风格参考' || item.kind === 'style') {
    return 'style';
  }
  if (
    item.category === '交互组件'
    || item.category === 'AI 组件'
    || item.category === '组件'
    || item.kind === 'component'
  ) {
    return 'component';
  }
  if (
    item.category === '图像创作'
    || item.category === '视频创作'
    || item.kind === 'video'
    || item.kind === 'image'
  ) {
    return 'multimedia';
  }
  return 'default';
}

export function extractPromptBadge(
  item: Pick<MaterialSummaryItem, 'subtitle' | 'description' | 'tags'>,
): string | null {
  const haystack = `${item.subtitle ?? ''} ${item.description ?? ''} ${(item.tags ?? []).join(' ')}`;
  const match = haystack.match(/(\d+)\s*(?:份|套|个|支)?\s*(?:prompts?|提示词)/i);
  if (match) return `${match[1]} 份 Prompts`;
  if (haystack.includes('提示词') || haystack.includes('prompt')) return '提示词集';
  return null;
}

export function formatSkillCommand(item: Pick<MaterialSummaryItem, 'id' | 'title'>): string {
  const clean = item.id.replace(/^(?:skill|vs)-/, '');
  return `/nmem-skill-load ${clean}`;
}

