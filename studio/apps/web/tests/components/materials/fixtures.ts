// Shared fixtures for the Fantay materials tests: contract-shaped records and
// a fetch router that answers `/api/materials/*` the way the daemon contract
// describes (offset/limit paging, kind/q filters, detail, context, apply).

import type {
  MaterialApplyResponse,
  MaterialContextResponse,
  MaterialDetailResponse,
  MaterialSearchResponse,
  MaterialSummaryItem,
  MaterialSummaryResponse,
} from '@open-design/contracts';
import { MATERIAL_NOTICE } from '@open-design/contracts';

export function makeItem(index: number, overrides: Partial<MaterialSummaryItem> = {}): MaterialSummaryItem {
  const kind = overrides.kind ?? (index % 3 === 0 ? 'svg' : 'component');
  const category = overrides.category ?? (kind === 'svg' ? 'SVG 图标' : '交互组件');
  const section = overrides.section ?? (category === '交互组件' ? (index % 2 === 0 ? '操作' : '输入') : undefined);
  return {
    id: `item-${index}`,
    title: `Material ${index}`,
    subtitle: `Subtitle ${index}`,
    kind,
    category,
    section,
    collection: kind === 'svg' ? 'Developer Icons' : 'Kobra',
    description: `Description ${index}`,
    tags: ['tag-a'],
    license: 'MIT · Example',
    palette: index === 1 ? [{ name: 'Ink', value: '#202020' }, { name: 'Lime', value: '#87ea5c' }] : [],
    capabilities: {
      material: kind === 'website' ? 'website_record' : 'source_file',
      previewEntry: true,
      designTokens: false,
      sourceManifest: false,
      licenseDocument: true,
    },
    thumbnailUrl: index % 2 === 0 ? `/api/materials/items/item-${index}/thumbnail` : null,
    ...overrides,
  };
}

export const WEBSITE_ITEM = makeItem(900, {
  id: 'site-linear',
  title: 'Linear',
  kind: 'website',
  category: '收藏网站',
  collection: '网站收藏',
  source: 'https://linear.app/',
  useStatus: '待阅读',
  thumbnailUrl: null,
  capabilities: {
    material: 'website_record',
    previewEntry: false,
    designTokens: false,
    sourceManifest: false,
    licenseDocument: false,
  },
});

export function summaryResponse(overrides: Partial<MaterialSummaryResponse> = {}): MaterialSummaryResponse {
  return {
    status: {
      enabled: true,
      root: '/library/素材库',
      rootSource: 'sibling',
      indexUpdatedAt: '2026-10-25T08:00:00.000Z',
    },
    total: 60,
    categories: { 交互组件: 40, 'SVG 图标': 20 },
    kinds: { component: 40, svg: 20 },
    collections: { Kobra: 40, 'Developer Icons': 20 },
    notice: MATERIAL_NOTICE,
    ...overrides,
  };
}

export interface MaterialsFetchOptions {
  items?: MaterialSummaryItem[];
  summary?: MaterialSummaryResponse | { status: number; body?: unknown };
  /** Ids whose apply request fails with a 409 not-copyable error. */
  failApply?: Set<string>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function materialsFetch(options: MaterialsFetchOptions = {}) {
  const items = options.items ?? Array.from({ length: 60 }, (_, i) => makeItem(i));
  const calls: Array<{ url: string; method: string; body: unknown }> = [];

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const parsed = new URL(url, 'http://localhost');
    const path = parsed.pathname;

    if (path === '/api/materials/summary') {
      const summary = options.summary ?? summaryResponse();
      if (typeof summary.status === 'number') {
        const failure = summary as { status: number; body?: unknown };
        return json(failure.body ?? { error: 'Not found' }, failure.status);
      }
      return json(summary);
    }
    if (path === '/api/materials/items' && method === 'GET') {
      const q = parsed.searchParams.get('q')?.toLowerCase() ?? '';
      const kind = parsed.searchParams.get('kind') ?? '';
      const category = parsed.searchParams.get('category') ?? '';
      const section = parsed.searchParams.get('section') ?? '';
      const limit = Number(parsed.searchParams.get('limit') ?? '24');
      const offset = Number(parsed.searchParams.get('offset') ?? '0');
      const matching = items.filter(
        (item) =>
          (!kind || item.kind === kind)
          && (!category
            || item.category === category
            || (category === '组件' && (item.category === '交互组件' || item.category === 'AI 组件'))
            || (category === '模板与资料' && (item.category === '页面模板' || item.category === '参考资料')))
          && (!section || item.section === section)
          && (!q || `${item.title} ${item.description}`.toLowerCase().includes(q)),
      );
      const page = matching.slice(offset, offset + limit);
      const next = offset + page.length;
      const res: MaterialSearchResponse = {
        query: q,
        total: matching.length,
        offset,
        returned: page.length,
        nextOffset: next < matching.length ? next : null,
        items: page,
        notice: MATERIAL_NOTICE,
      };
      return json(res);
    }
    const applyMatch = /^\/api\/materials\/items\/([^/]+)\/apply$/.exec(path);
    if (applyMatch && method === 'POST') {
      const id = decodeURIComponent(applyMatch[1]!);
      if (options.failApply?.has(id)) {
        return json({ error: { code: 'not-copyable', message: `${id} cannot be copied` } }, 409);
      }
      const res: MaterialApplyResponse = {
        id,
        projectId: String((body as { projectId?: string })?.projectId ?? ''),
        dir: `references/${id}`,
        files: [
          { relPath: `references/${id}/thumbnail.png`, bytes: 10, sha256: 'a'.repeat(64) },
          { relPath: `references/${id}/index.tsx`, bytes: 20, sha256: 'b'.repeat(64) },
        ],
        attachments: [`references/${id}/thumbnail.png`, `references/${id}/index.tsx`],
        receiptRelPath: `references/${id}/.material-receipt.json`,
        notice: MATERIAL_NOTICE,
      };
      return json(res);
    }
    const detailMatch = /^\/api\/materials\/items\/([^/]+)$/.exec(path);
    if (detailMatch && method === 'GET') {
      const id = decodeURIComponent(detailMatch[1]!);
      const item = [...items, WEBSITE_ITEM].find((candidate) => candidate.id === id);
      if (!item) return json({ error: { code: 'unknown-id', message: 'Unknown id' } }, 404);
      const res: MaterialDetailResponse = {
        item: {
          ...item,
          absolutePath: `/library/素材库/${item.category}/${item.id}/index.tsx`,
          collectionRoot: `/library/素材库/${item.category}/${item.id}`,
          files: [
            {
              field: 'path',
              relativePath: `${item.category}/${item.id}/index.tsx`,
              absolutePath: `/library/素材库/${item.category}/${item.id}/index.tsx`,
              exists: true,
            },
            {
              field: 'license_document',
              relativePath: `${item.category}/${item.id}/LICENSE`,
              absolutePath: `/library/素材库/${item.category}/${item.id}/LICENSE`,
              exists: false,
            },
          ],
          children: [],
        },
        notice: MATERIAL_NOTICE,
      };
      return json(res);
    }
    if (path === '/api/materials/context' && method === 'POST') {
      const ids = ((body as { ids?: string[] })?.ids ?? []) as string[];
      const res: MaterialContextResponse = {
        ids,
        markdown: `# Reference packet\n\n${ids.map((id) => `- ${id}`).join('\n')}`,
        notice: MATERIAL_NOTICE,
      };
      return json(res);
    }
    return json([], 200);
  };

  return { handler, calls };
}

/**
 * Minimal IntersectionObserver stand-in: jsdom has none. Tests call
 * `intersectAll()` to report every observed node as visible, which is what
 * scrolling the grid's sentinel into view does in a browser.
 */
export class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];

  readonly callback: IntersectionObserverCallback;
  readonly options: IntersectionObserverInit | undefined;
  readonly nodes = new Set<Element>();
  disconnected = false;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    MockIntersectionObserver.instances.push(this);
  }

  observe(node: Element) {
    this.nodes.add(node);
  }

  unobserve(node: Element) {
    this.nodes.delete(node);
  }

  disconnect() {
    this.disconnected = true;
    this.nodes.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  static reset() {
    MockIntersectionObserver.instances = [];
  }

  static intersectAll() {
    for (const observer of MockIntersectionObserver.instances) {
      if (observer.disconnected || observer.nodes.size === 0) continue;
      const entries = Array.from(observer.nodes).map(
        (target) => ({ isIntersecting: true, target, intersectionRatio: 1 }) as unknown as IntersectionObserverEntry,
      );
      observer.callback(entries, observer as unknown as IntersectionObserver);
    }
  }
}
