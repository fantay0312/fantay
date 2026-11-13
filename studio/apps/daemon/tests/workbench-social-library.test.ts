// SPDX-License-Identifier: AGPL-3.0-only
// Recorded-shape fixtures for the workbench social import normalizers and the library AI helpers.
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkbenchItem, WorkbenchState } from '@open-design/contracts';
import { configureTokenToSeaRuntime, type TokenToSeaRuntime } from '../src/integrations/tokentosea-runtime.js';
import {
  count, fetchAccount, importPosts, instagramUserId, normalizePosts, normalizeProfile, parseAccountUrl, postsToMaterial, socialStatus,
  type SocialPost,
} from '../src/workbench/social-import.js';
import { applyOrganize, countWords, isPlaceholderTitle, organizeItems, searchLibrary, terms } from '../src/workbench/library-ai.js';

function state(items: Partial<WorkbenchItem>[] = []): WorkbenchState {
  return {
    version: 1, sampleCleared: true, sampleLang: 'zh', spaces: [], people: [], angles: [], skills: [], accounts: [], metrics: [], styles: [],
    activeStyleId: null, chat: [],
    items: items.map((item, index) => ({
      id: `it_${index}`, kind: 'note', title: '', body: '', tags: [], status: 'idea', personaIds: [], drafts: {}, createdAt: `2026-11-0${(index % 9) + 1}T00:00:00.000Z`,
      ...item,
    }) as WorkbenchItem),
  };
}

describe('parseAccountUrl', () => {
  it('recognises profile links and rejects reserved paths', () => {
    expect(parseAccountUrl('https://www.xiaohongshu.com/user/profile/5f1a2b3c4d5e6f7a8b9c0d1e?xsec=1')).toEqual({ platform: '小红书', id: '5f1a2b3c4d5e6f7a8b9c0d1e', url: 'https://www.xiaohongshu.com/user/profile/5f1a2b3c4d5e6f7a8b9c0d1e' });
    expect(parseAccountUrl('https://www.iesdouyin.com/share/user/MS4wLjABAAAAabcdefghijklmnop?x=1')?.platform).toBe('抖音');
    expect(parseAccountUrl('https://space.bilibili.com/12345678')?.id).toBe('12345678');
    expect(parseAccountUrl('https://www.tiktok.com/@some.user')?.id).toBe('some.user');
    expect(parseAccountUrl('https://www.instagram.com/natgeo/')?.id).toBe('natgeo');
    expect(parseAccountUrl('https://www.instagram.com/explore/')).toBeNull();
    expect(parseAccountUrl('https://twitter.com/jack')).toEqual({ platform: 'X', id: 'jack', url: 'https://x.com/jack' });
    expect(parseAccountUrl('https://x.com/home')).toBeNull();
    expect(parseAccountUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('normalizers', () => {
  it('parses display counts', () => {
    expect(count('1.2万')).toBe(12000);
    expect(count('10万+')).toBe(100000);
    expect(count('3.4k')).toBe(3400);
    expect(count(-5)).toBe(0);
    expect(count('abc')).toBe(0);
  });

  const note = { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', title: '春季穿搭', desc: '正文', create_time: 1730000000, images_list: [{ url: 'http://sns-img.example.com/a.jpg' }], likes: 12, comments_count: '3', collected_count: 4, share_count: 1 };
  it('accepts raw and unwrapped 小红书 shapes', () => {
    for (const output of [{ notes: [note] }, { code: 0, data: { notes: [note] } }, { data: { data: { notes: [note] } } }]) {
      const [post] = normalizePosts('小红书', output);
      expect(post).toMatchObject({ id: note.id, title: '春季穿搭', likes: 12, comments: 3, saves: 4, cover: 'https://sns-img.example.com/a.jpg', url: `https://www.xiaohongshu.com/explore/${note.id}` });
    }
    expect(normalizePosts('小红书', { notes: [{ ...note, id: '../evil' }] })).toEqual([]);
  });

  it('reads 抖音 and throws on upstream failure', () => {
    const output = { status_code: 0, aweme_list: [{ aweme_id: '7300000000000000001', desc: '第一行\n第二行', create_time: 1730000000, statistics: { play_count: 100, digg_count: 9 }, video: { cover: { url_list: ['https://p3.example.com/c.jpg'] } } }] };
    expect(normalizePosts('抖音', output)[0]).toMatchObject({ title: '第一行', views: 100, likes: 9, url: 'https://www.douyin.com/video/7300000000000000001' });
    expect(() => normalizePosts('抖音', { status_code: 2053, status_msg: 'user not found' })).toThrow('user not found');
  });

  it('reads B站 vlist and profile + relation', () => {
    const posts = normalizePosts('B站', { list: { vlist: [{ bvid: 'BV1xx411c7mD', title: '视频', description: '简介', created: 1730000000, pic: '//i0.hdslb.com/a.jpg', play: 50, comment: 2 }] } });
    expect(posts[0]).toMatchObject({ id: 'BV1xx411c7mD', views: 50, comments: 2, cover: 'https://i0.hdslb.com/a.jpg' });
    expect(normalizeProfile('B站', { profile: { name: 'UP', sign: '签名', face: 'https://i0.hdslb.com/f.jpg', mid: 1 }, relation: { data: { follower: 321 } } }))
      .toEqual({ nickname: 'UP', description: '签名', followers: 321, avatar: 'https://i0.hdslb.com/f.jpg' });
  });

  it('finds the Instagram numeric id and posts', () => {
    const profile = { data: { user: { id: '25025320', username: 'natgeo', full_name: 'National Geographic', biography: 'bio', edge_followed_by: { count: 280000000 } } } };
    expect(instagramUserId(profile, 'NatGeo')).toBe('25025320');
    expect(normalizeProfile('Instagram', { profile }).followers).toBe(280000000);
    const posts = normalizePosts('Instagram', { items: [{ code: 'C1abcDEF', caption: { text: 'Hello' }, taken_at: 1730000000, like_count: 5, image_versions2: { candidates: [{ url: 'https://scontent.example.com/x.jpg' }] } }] });
    expect(posts[0]).toMatchObject({ id: 'C1abcDEF', url: 'https://www.instagram.com/p/C1abcDEF/', likes: 5 });
  });

  it('walks unknown X shapes for tweets without splitting quoted tweets', () => {
    const tweet = (id: string, textValue: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
      __typename: 'Tweet', rest_id: id, views: { count: '1200' },
      core: { user_results: { result: { legacy: { screen_name: 'jack' } } } },
      legacy: { full_text: textValue, created_at: createdAt, favorite_count: 10, retweet_count: 2, quote_count: 1, reply_count: 3, bookmark_count: 4, extended_entities: { media: [{ media_url_https: 'https://pbs.twimg.com/media/a.jpg' }] } },
      ...extra,
    });
    const graphql = { data: { user: { result: { timeline: { timeline: { instructions: [{ entries: [
      { content: { itemContent: { tweet_results: { result: tweet('1850000000000000001', 'older', 'Wed Oct 30 10:00:00 +0000 2024') } } } },
      { content: { itemContent: { tweet_results: { result: tweet('1850000000000000002', 'newer', 'Thu Oct 31 10:00:00 +0000 2024', { quoted_status_result: { result: tweet('1700000000000000009', 'quoted', 'Mon Jan 01 10:00:00 +0000 2024') } }) } } } },
    ] }] } } } } } };
    const posts = normalizePosts('X', graphql, 'jack');
    expect(posts.map(post => post.id)).toEqual(['1850000000000000002', '1850000000000000001']);
    expect(posts[0]).toMatchObject({ views: 1200, likes: 10, comments: 3, saves: 4, shares: 3, cover: 'https://pbs.twimg.com/media/a.jpg', url: 'https://x.com/jack/status/1850000000000000002' });

    const flat = { user: { name: 'Jack', profile: 'jack', sub_count: 5000 }, timeline: [{ tweet_id: '1850000000000000003', text: 'flat', created_at: 'Fri Nov 01 10:00:00 +0000 2024', favorites: 7, retweets: 1, quotes: 0, replies: 2, bookmarks: 0, views: '99' }] };
    expect(normalizePosts('X', flat, 'jack')[0]).toMatchObject({ id: '1850000000000000003', likes: 7, views: 99 });

    const profile = { user: { result: { rest_id: '12', legacy: { name: 'jack', screen_name: 'jack', description: 'hi', followers_count: 6_500_000, profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg' } } } };
    expect(normalizeProfile('X', { profile }, 'jack')).toEqual({ nickname: 'jack', description: 'hi', followers: 6_500_000, avatar: 'https://pbs.twimg.com/profile_images/1/a_400x400.jpg' });
    expect(normalizeProfile('X', { profile: null, posts: flat }, 'jack').followers).toBe(5000);
  });
});

describe('importPosts', () => {
  const post: SocialPost = { id: 'BV1xx411c7mD', title: 'T', body: 'B', publishedAt: '2026-10-01T00:00:00.000Z', url: 'https://www.bilibili.com/video/BV1xx411c7mD', cover: null, views: 1, likes: 2, comments: 3, saves: 4, shares: 5 };
  it('upserts items, metrics and the account by externalId', () => {
    const draft = state();
    const account = { platform: 'B站' as const, id: '1', url: 'https://space.bilibili.com/1' };
    const profile = { nickname: 'UP', followers: 10, description: '', avatar: null };
    const first = importPosts(draft, { account, profile, posts: [post], covers: new Map([[post.id, 'workbench/files/c.jpg']]), now: '2026-11-12T00:00:00.000Z' });
    expect(first).toMatchObject({ added: 1, updated: 0 });
    expect(draft.items[0]).toMatchObject({ id: first.ids[0], kind: 'web', status: 'published', imported: true, externalId: 'B站:BV1xx411c7mD', triagedAt: '2026-11-12T00:00:00.000Z', media: { src: 'workbench/files/c.jpg' } });
    draft.items[0]!.title = 'user edit';
    const second = importPosts(draft, { account, profile, posts: [{ ...post, views: 99 }], covers: new Map() });
    expect(second).toEqual({ added: 0, updated: 1, ids: [] });
    expect(draft.items[0]!.title).toBe('user edit');
    expect(draft.metrics).toHaveLength(1);
    expect(draft.metrics[0]!.views).toBe(99);
    expect(draft.accounts).toHaveLength(1);
    expect(postsToMaterial([post])).toBe('T\nB');
  });
});

describe('fetchAccount over the TokenToSea connect protocol', () => {
  afterEach(() => configureTokenToSeaRuntime(undefined));

  it('quotes, invokes, polls and sums charges', async () => {
    const calls: Array<{ resource: string; body: unknown }> = [];
    let polled = false;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    const runtime = {
      current: () => ({ raw: 'x', user: { id: 'u1' } }),
      authorizationBudget: async () => 1,
      response: async (resource: string, _method: string, body?: unknown) => {
        calls.push({ resource, body });
        const input = (body ?? {}) as Record<string, unknown>;
        if (resource === 'tools/quote') return json({ id: `q_${String(input.actionId)}`, reserveUsd: '0.01', priceVersion: `quote:q_${String(input.actionId)}` });
        if (resource === 'tools/invoke') {
          if (input.actionId === 'act_b46147d1390d39f75cd58c42915521b6') return json({ id: 'run_posts', status: 'running' });
          if (input.actionId === 'act_51d67440d1a73ed3743fd02502e6239b') return json({ id: 'run_rel', status: 'succeeded', chargedUsd: '0.001', output: { follower: 42 } });
          return json({ id: 'run_profile', status: 'succeeded', chargedUsd: '0.002', output: { name: 'UP', sign: 's', mid: 1 } });
        }
        if (resource === 'tools/runs/run_posts') {
          polled = true;
          return json({ id: 'run_posts', status: 'succeeded', chargedUsd: '0.003', output: { list: { vlist: [{ bvid: 'BV1xx411c7mD', title: 'V', play: 3 }] } } });
        }
        if (resource === 'tools/describe') return json({ name: 'x', priceUsd: '0.002' });
        return json({ error: 'not_found' }, 404);
      },
    };
    configureTokenToSeaRuntime(runtime as unknown as TokenToSeaRuntime);
    const result = await fetchAccount({ platform: 'B站', id: '1', url: 'https://space.bilibili.com/1' });
    expect(polled).toBe(true);
    expect(result.chargedUsd).toBe('0.006');
    expect(result.profile).toMatchObject({ nickname: 'UP', followers: 42 });
    const invoke = calls.find(call => call.resource === 'tools/invoke')!.body as Record<string, unknown>;
    expect(invoke).toMatchObject({ actionId: 'act_b46147d1390d39f75cd58c42915521b6', input: { queryParams: { uid: '1', ps: 20 } }, priceVersion: 'quote:q_act_b46147d1390d39f75cd58c42915521b6', maxCostUsd: '0.01', quoteId: 'q_act_b46147d1390d39f75cd58c42915521b6' });
    expect(String(invoke.requestKey).length).toBeGreaterThanOrEqual(16);

    const status = await socialStatus();
    expect(status).toMatchObject({ signedIn: true, available: true });
    expect(status.estimatedUsd['B站']).toBe('0.006');
  });

  it('maps insufficient balance and refuses when signed out', async () => {
    configureTokenToSeaRuntime({
      current: () => ({ raw: 'x', user: { id: 'u2' } }),
      authorizationBudget: async () => 1,
      response: async () => new Response(JSON.stringify({ error: 'tool_insufficient_balance', message: 'no money' }), { status: 402 }),
    } as unknown as TokenToSeaRuntime);
    await expect(fetchAccount({ platform: '抖音', id: 'MS4wLjABAAAAabcdefghijklmnop', url: 'https://www.douyin.com/user/x' })).rejects.toMatchObject({ status: 402, code: 'tool_insufficient_balance' });
    configureTokenToSeaRuntime({ current: () => ({ raw: '', user: null }) } as unknown as TokenToSeaRuntime);
    await expect(fetchAccount({ platform: '抖音', id: 'x', url: 'x' })).rejects.toMatchObject({ status: 401 });
    expect((await socialStatus()).signedIn).toBe(false);
  });
});

describe('library AI', () => {
  it('detects placeholder titles', () => {
    for (const title of ['', 'IMG_2034.HEIC', '截屏2026-11-12 10.22.33.png', '2026-11-12', '11月12日 下午3:20', 'https://example.com/a', 'example.com/post/1', 'Untitled']) {
      expect(isPlaceholderTitle({ title, url: null })).toBe(true);
    }
    for (const title of ['春季穿搭灵感', 'How to design a logo', 'Q3 plan']) expect(isPlaceholderTitle({ title, url: null })).toBe(false);
  });

  it('splits CJK terms and counts words', () => {
    expect(terms('露营装备').map(t => t.term)).toEqual(expect.arrayContaining(['露营装备', '露营', '装备']));
    expect(countWords('你好 world')).toBe(3);
  });

  it('searches text with excerpts and excludes trash', async () => {
    const s = state([
      { title: '周末露营清单', body: '帐篷、睡袋和炉具' },
      { title: '设计稿', body: '一段很长的说明，里面提到了露营装备的配色。' },
      { title: '露营', trashedAt: '2026-11-01T00:00:00.000Z' },
    ]);
    const hits = await searchLibrary(s, '露营', 'text', { callText: async () => { throw new Error('unused'); } });
    expect(hits.map(h => h.id)).toEqual(['it_0', 'it_1']);
    expect(hits[1]!.excerpt).toContain('露营装备');
    const meaning = await searchLibrary(s, 'camping', 'meaning', { callText: async () => ({ text: '{"hits":[{"id":"it_1","score":80},{"id":"it_2","score":90},{"id":"nope","score":99}]}', model: 'm' }) });
    expect(meaning).toEqual([{ id: 'it_1', score: 0.8, excerpt: expect.any(String) }]);
    const fallback = await searchLibrary(s, '露营', 'meaning', { callText: async () => { throw new Error('down'); } });
    expect(fallback.map(h => h.id)).toEqual(['it_0', 'it_1']);
  });

  it('organises with validation and applies only safe fields', async () => {
    const s = state([
      { kind: 'web', title: 'https://example.com/a', url: 'https://example.com/a', body: 'A long article about camping gear. '.repeat(40), tags: ['Camping'] },
      { kind: 'note', title: '我的标题', body: '笔记', spaceId: null },
      { kind: 'image', title: 'IMG_1.jpg', media: { src: 'workbench/files/a.png' } },
    ]);
    s.items[0]!.tags = ['camping'];
    let sawImages = 0;
    const reply = (ids: string[]) => JSON.stringify({ items: ids.map(id => ({
      id, title: 'Camping gear guide', tags: ['CAMPING', '#gear', 'x'.repeat(100)], space: 'sp_missing',
      newSpace: { name: 'Outdoors', color: 'green' }, summary: 's'.repeat(400), keywords: ['tent'], ocrText: 'SALE 50%',
    })) });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const { patches, errors } = await organizeItems(s, ['it_0', 'it_1', 'it_2', 'missing'], {
      readMedia: async () => png,
      callText: async ({ user, images }) => {
        if (images?.length) sawImages += images.length;
        const ids = [...user.matchAll(/"id":"(it_\d)"/g)].map(m => m[1]!);
        return { text: `\`\`\`json\n${reply(ids)}\n\`\`\``, model: 'm' };
      },
    });
    expect(errors).toEqual([]);
    expect(sawImages).toBe(1);
    const web = patches.find(p => p.id === 'it_0')!;
    expect(web.title).toBe('Camping gear guide');
    expect(web.tags?.[0]).toBe('camping');
    expect(web.tags?.every(tag => tag.length <= 24)).toBe(true);
    expect(web.summary?.length).toBe(280);
    expect(web.readMinutes).toBeGreaterThan(0);
    expect(patches.find(p => p.id === 'it_1')!.title).toBeUndefined();
    expect(patches.find(p => p.id === 'it_2')!.ocrText).toBe('SALE 50%');
    expect(patches.find(p => p.id === 'it_0')!.ocrText).toBeUndefined();

    const now = '2026-11-12T00:00:00.000Z';
    const done = applyOrganize(s, patches, now);
    expect(done.sort()).toEqual(['it_0', 'it_1', 'it_2']);
    expect(s.spaces).toHaveLength(1);
    expect(s.items.every(item => item.spaceId === s.spaces[0]!.id && item.triagedAt === now && item.organizedAt === now)).toBe(true);
    expect(s.items[1]!.title).toBe('我的标题');

    // User edits after organising are kept on the next run.
    s.items[0]!.summary = 'mine';
    s.items[0]!.updatedAt = '2026-11-13T00:00:00.000Z';
    applyOrganize(s, [{ id: 'it_0', summary: 'ai again', tags: ['new'] }], '2026-11-14T00:00:00.000Z');
    expect(s.items[0]!.summary).toBe('mine');
    expect(s.items[0]!.tags).not.toContain('new');
  });

  it('reports a failed batch instead of throwing', async () => {
    const s = state([{ title: 'a', body: 'b' }]);
    const result = await organizeItems(s, ['it_0'], { readMedia: async () => null, callText: async () => ({ text: 'not json', model: 'm' }) });
    expect(result.patches).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });
});
