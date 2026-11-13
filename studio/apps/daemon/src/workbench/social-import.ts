// SPDX-License-Identifier: AGPL-3.0-only
// Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
//
// Social-account import for the workbench. The reference shelled out to the user's Monid CLI,
// which called TikHub. Fantay calls the same TikHub endpoints through the TokenToSea tool
// market (tool 社媒数据) with the signed-in TokenToSea session, so no provider key is ever
// asked for or stored. Every call spends the user's balance: endpoints, page size and the
// number of calls per import are fixed here.
//
// Connect tool protocol: `tools/quote` → `tools/invoke` (with the quote's price version and
// reserve as the cost ceiling) → poll `tools/runs/<id>` while running. Run output is the
// TikHub body with its transport envelope removed, so every normalizer accepts both the raw
// and the unwrapped shape. Third-party output is untrusted: only whitelisted fields are read,
// lengths are capped, ids are format-checked before they are put into URLs, and covers are
// https-only.

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  WORKBENCH_IMPORT_PLATFORMS,
  type WorkbenchAccount,
  type WorkbenchImportPlatform,
  type WorkbenchItem,
  type WorkbenchMetric,
  type WorkbenchSocialStatus,
  type WorkbenchState,
} from '@open-design/contracts';
import { optionalTokenToSeaRuntime, type TokenToSeaRuntime } from '../integrations/tokentosea-runtime.js';
import { assertPublicUrl } from './harvest.js';
import { byLang, platformName, tr } from './i18n.js';
import { newId } from './ops.js';

export interface SocialAccountRef { platform: WorkbenchImportPlatform; id: string; url: string }
export interface SocialPost { id: string; title: string; body: string; publishedAt: string; url: string; cover: string | null; views: number; likes: number; comments: number; saves: number; shares: number }
export interface SocialProfile { nickname: string; followers: number; description: string; avatar: string | null }

// ── TokenToSea 社媒数据 catalog ─────────────────────────────────────

/** Public id of the TokenToSea tool 社媒数据 (TikHub resale). */
export const SOCIAL_TOOL_ID = 'tool_3c48d428b3c48283a841a15b4b12b6ef';

type SocialPurpose = 'posts' | 'profile' | 'relation';

/**
 * Action ids per platform and purpose (TokenToSea catalog snapshot 2026-10-23). Update ids
 * here only. `endpoint` is the TikHub route the action resells, kept for diagnostics.
 */
export const SOCIAL_ACTIONS: Record<WorkbenchImportPlatform, Partial<Record<SocialPurpose, { actionId: string; endpoint: string }>>> = {
  小红书: {
    posts: { actionId: 'act_aa781d2c40ad8bb3fc20fa4dd4f9cf65', endpoint: '/api/v1/xiaohongshu/app_v2/get_user_posted_notes' },
    profile: { actionId: 'act_57f8de18805464b352e85500bb49547c', endpoint: '/api/v1/xiaohongshu/app_v2/get_user_info' },
  },
  抖音: {
    posts: { actionId: 'act_2247c74bc520d301dfe3965c1b56d932', endpoint: '/api/v1/douyin/app/v3/fetch_user_post_videos' },
    profile: { actionId: 'act_29129e8d7b4f0df2001fc559da548a87', endpoint: '/api/v1/douyin/app/v3/handler_user_profile' },
  },
  B站: {
    posts: { actionId: 'act_b46147d1390d39f75cd58c42915521b6', endpoint: '/api/v1/bilibili/web/fetch_user_post_videos' },
    profile: { actionId: 'act_df5641cfaa960a632cb6349bc19ff270', endpoint: '/api/v1/bilibili/web/fetch_user_profile' },
    relation: { actionId: 'act_51d67440d1a73ed3743fd02502e6239b', endpoint: '/api/v1/bilibili/web/fetch_user_relation_stat' },
  },
  TikTok: {
    posts: { actionId: 'act_f2a1af48ba4b8e86d35804171139cb09', endpoint: '/api/v1/tiktok/app/v3/fetch_user_post_videos' },
    profile: { actionId: 'act_d5e8178c136a5ef36b30a3b894ebe6bf', endpoint: '/api/v1/tiktok/app/v3/handler_user_profile' },
  },
  // Posts need the numeric user id, so the profile is read first.
  Instagram: {
    profile: { actionId: 'act_db36651ebaaf37977aab380680dbd1d2', endpoint: '/api/v1/instagram/v1/fetch_user_info_by_username' },
    posts: { actionId: 'act_ff3fdaad01f8411ccc8cd16821f0b02d', endpoint: '/api/v1/instagram/v1/fetch_user_posts' },
  },
  X: {
    posts: { actionId: 'act_1cd1a5730af2ab840132792c53535965', endpoint: "X (Twitter) user's posts by handle or user id" },
    profile: { actionId: 'act_2e3de28168514b1bdfdeeccdc1d17255', endpoint: 'X (Twitter) profile by handle or user id' },
  },
};

const POST_COUNT = 20;
const MAX_POSTS = 50;
const RUN_TIMEOUT_MS = 120_000;
const POLL_MS = 1500;
const STATUS_TTL_MS = 10 * 60_000;
/** Used for the import estimate when the catalog does not publish a price (upper end of 0.001–0.01). */
const FALLBACK_CALL_USD = 0.01;
const COVER_MAX_BYTES = 8 * 1024 * 1024;
const COVER_CONCURRENCY = 4;
const SHORT_HOSTS = ['xhslink.com', 'v.douyin.com', 'b23.tv', 'vm.tiktok.com', 'vt.tiktok.com'];
const IN_PROGRESS = new Set(['running', 'queued', 'pending', 'created', 'accepted', 'starting']);

function queryFor(platform: WorkbenchImportPlatform, purpose: SocialPurpose, id: string): Record<string, string | number> {
  switch (platform) {
    case '小红书': return { user_id: id };
    case '抖音': return purpose === 'posts' ? { sec_user_id: id, count: POST_COUNT } : { sec_user_id: id };
    case 'B站': return purpose === 'posts' ? { uid: id, ps: POST_COUNT } : { uid: id };
    case 'TikTok': return purpose === 'posts' ? { unique_id: id, count: POST_COUNT } : { unique_id: id };
    case 'Instagram': return purpose === 'posts' ? { user_id: id, count: POST_COUNT } : { username: id };
    case 'X': return { screen_name: id };
  }
}

// ── Messages ────────────────────────────────────────────────────────

/** New TokenToSea-specific copy carries both languages inline; reference copy goes through `tr`. */
function say(zh: string, en: string, vars?: Record<string, string | number>): string {
  const text = byLang(zh, en);
  return vars ? text.replace(/\{(\w+)\}/g, (match, key: string) => (vars[key] === undefined ? match : String(vars[key]))) : text;
}

type StatusError = Error & { status: number; code?: string; chargedUsd?: string };

function fail(status: number, message: string, extra: { code?: string; chargedUsd?: string } = {}): StatusError {
  return Object.assign(new Error(message), { status }, extra);
}

const notSignedIn = () => fail(401, say('请先登录 TokenToSea，再导入账号数据。', 'Sign in to TokenToSea before importing account data.'), { code: 'not_signed_in' });

// ── URL parsing and short links ─────────────────────────────────────

// Paths that are not account names.
const RESERVED = {
  Instagram: new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'direct', 'tv']),
  X: new Set(['i', 'home', 'search', 'explore', 'intent', 'share', 'settings', 'messages', 'notifications', 'hashtag', 'compose']),
};

function hostIs(host: string, name: string): boolean {
  return host === name || host.endsWith(`.${name}`);
}

/** First link inside share text; app share text mixes titles and codes around it. */
export function findUrl(text: string): string | null {
  const match = /https?:\/\/[^\s，。！？、；：「」《》（）()"'<>]+/i.exec(String(text ?? ''));
  return match?.[0] ?? null;
}

/** Platform and account id from a profile link. Ids are sent to the tool, so only fixed formats pass. */
export function parseAccountUrl(raw: string): SocialAccountRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (hostIs(host, 'xiaohongshu.com')) {
    const id = /^\/user\/profile\/([0-9a-f]{24})(?:\/|$)/i.exec(url.pathname)?.[1];
    return id ? { platform: '小红书', id, url: `https://www.xiaohongshu.com/user/profile/${id}` } : null;
  }
  if (hostIs(host, 'douyin.com') || hostIs(host, 'iesdouyin.com')) {
    const id = /^\/(?:share\/)?user\/([\w-]{20,120})(?:\/|$)/.exec(url.pathname)?.[1];
    return id ? { platform: '抖音', id, url: `https://www.douyin.com/user/${id}` } : null;
  }
  if (host === 'space.bilibili.com' || host === 'm.bilibili.com') {
    const id = /^\/(?:space\/)?(\d{1,20})(?:\/|$)/.exec(url.pathname)?.[1];
    return id ? { platform: 'B站', id, url: `https://space.bilibili.com/${id}` } : null;
  }
  if (hostIs(host, 'tiktok.com')) {
    const id = /^\/@([\w.]{2,24})(?:\/|$)/.exec(url.pathname)?.[1];
    return id ? { platform: 'TikTok', id, url: `https://www.tiktok.com/@${id}` } : null;
  }
  if (hostIs(host, 'instagram.com')) {
    const id = /^\/([\w.]{1,30})\/?$/.exec(url.pathname)?.[1];
    return id && !RESERVED.Instagram.has(id.toLowerCase()) ? { platform: 'Instagram', id, url: `https://www.instagram.com/${id}/` } : null;
  }
  if (hostIs(host, 'x.com') || hostIs(host, 'twitter.com')) {
    const id = /^\/(\w{1,15})\/?$/.exec(url.pathname)?.[1];
    return id && !RESERVED.X.has(id.toLowerCase()) ? { platform: 'X', id, url: `https://x.com/${id}` } : null;
  }
  return null;
}

/** Pasted text may hold a short link: follow only those hosts, checking every hop is public. */
export async function resolveAccount(text: string, fetchImpl: typeof fetch = fetch): Promise<SocialAccountRef> {
  const first = findUrl(text);
  if (!first) throw fail(400, tr('没找到链接，请贴账号主页的链接'));
  const unsupported = () => fail(400, tr('认不出这个主页。目前支持小红书、抖音、B 站、TikTok、Instagram 和 X 的账号主页链接，别的平台可以贴内容来提炼风格。'));
  let current = first;
  for (let hop = 0; hop < 4; hop += 1) {
    const account = parseAccountUrl(current);
    if (account) return account;
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      break;
    }
    if (hop === 0 && !SHORT_HOSTS.some(name => hostIs(url.hostname.toLowerCase(), name))) throw unsupported();
    try {
      await assertPublicUrl(current);
    } catch (error) {
      throw fail(400, error instanceof Error ? error.message : String(error));
    }
    let location: string | null = null;
    try {
      const res = await fetchImpl(current, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' },
      });
      location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
    } catch {
      break;
    }
    if (!location) break;
    try {
      current = new URL(location, current).toString();
    } catch {
      break;
    }
  }
  throw fail(400, tr('这个链接打开后不是账号主页。请到账号主页再复制一次链接。'));
}

// ── Untrusted-output helpers ────────────────────────────────────────

type Json = Record<string, unknown>;

function isObj(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function obj(value: unknown): Json {
  return isObj(value) ? value : {};
}

function at(value: unknown, ...path: Array<string | number>): unknown {
  let node = value;
  for (const key of path) {
    if (typeof key === 'number') node = Array.isArray(node) ? node[key] : undefined;
    else node = isObj(node) ? node[key] : undefined;
    if (node === undefined || node === null) return undefined;
  }
  return node;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

const UNITS: Record<string, number> = { 万: 1e4, w: 1e4, W: 1e4, 千: 1e3, k: 1e3, K: 1e3, m: 1e6, M: 1e6, 亿: 1e8, b: 1e9, B: 1e9 };

/** Non-negative integer from a number or a display string such as `1.2万`, `3.4k` or `10万+`. */
export function count(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  if (typeof value !== 'string') return 0;
  const match = /^\s*([\d.,]+)\s*(万|w|W|千|k|K|m|M|亿|b|B)?\+?\s*$/.exec(value);
  if (!match) return 0;
  const n = Number(match[1]!.replace(/,/g, '')) * (match[2] ? UNITS[match[2]] ?? 1 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** ISO time from epoch seconds, epoch milliseconds, numeric strings or date strings. */
function isoFrom(value: unknown): string {
  let ms = Number.NaN;
  if (typeof value === 'number') ms = value > 1e12 ? value : value * 1000;
  else if (typeof value === 'string' && /^\d{9,13}$/.test(value.trim())) {
    const n = Number(value);
    ms = n > 1e12 ? n : n * 1000;
  } else if (typeof value === 'string') ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 && ms < 4.1e12 ? new Date(ms).toISOString() : new Date().toISOString();
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  const raw = value.startsWith('//') ? `https:${value}` : value.replace(/^http:\/\//i, 'https://');
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function firstUrl(...values: unknown[]): string | null {
  for (const value of values) {
    const url = httpsUrl(Array.isArray(value) ? value[0] : value);
    if (url) return url;
  }
  return null;
}

function firstLine(value: string, fallback: string): string {
  const line = value.slice(0, 300).split('\n').find(row => row.trim())?.trim() ?? '';
  return line.slice(0, 40) || fallback;
}

function untitled(): string {
  return tr('无标题');
}

/** Breadth-first search for the first array stored under one of `keys`. */
function findArray(root: unknown, keys: string[], depth = 6): unknown[] | null {
  let level: unknown[] = [root];
  for (let d = 0; d <= depth && level.length; d += 1) {
    const next: unknown[] = [];
    for (const node of level) {
      if (!isObj(node)) continue;
      for (const key of keys) {
        const value = node[key];
        if (Array.isArray(value)) return value;
      }
      for (const value of Object.values(node)) if (isObj(value)) next.push(value);
    }
    level = next.slice(0, 400);
  }
  return null;
}

/** Breadth-first search for the first object passing `test` (arrays are searched too). */
function findObject(root: unknown, test: (node: Json) => boolean, depth = 6): Json | null {
  let level: unknown[] = [root];
  for (let d = 0; d <= depth && level.length; d += 1) {
    const next: unknown[] = [];
    for (const node of level) {
      if (Array.isArray(node)) {
        next.push(...node.slice(0, 50));
        continue;
      }
      if (!isObj(node)) continue;
      if (test(node)) return node;
      for (const value of Object.values(node)) if (typeof value === 'object' && value !== null) next.push(value);
    }
    level = next.slice(0, 400);
  }
  return null;
}

/** Explicit upstream failure message, if the (possibly unwrapped) body carries one. */
function upstreamFailure(output: unknown): string | null {
  for (const node of [output, at(output, 'data')]) {
    if (!isObj(node)) continue;
    const code = node.status_code;
    if (typeof code === 'number' && code !== 0) return text(node.status_msg ?? node.message ?? node.msg, 120) || `status_code ${code}`;
    if (node.success === false) return text(node.message ?? node.msg ?? node.error, 120) || 'success: false';
  }
  return null;
}

function cap(posts: SocialPost[]): SocialPost[] {
  const seen = new Set<string>();
  return posts.filter(post => (seen.has(post.id) ? false : (seen.add(post.id), true))).slice(0, MAX_POSTS);
}

// ── Platform normalizers ────────────────────────────────────────────

function xiaohongshuPosts(output: unknown): SocialPost[] {
  return (findArray(output, ['notes']) ?? []).map(raw => {
    const row = obj(raw);
    const id = typeof row.id === 'string' ? row.id : typeof row.note_id === 'string' ? row.note_id : '';
    if (!/^[0-9a-f]{24}$/i.test(id)) return null;
    const body = text(row.desc, 2000);
    const interact = obj(row.interact_info);
    return {
      id, title: text(row.title || row.display_title, 80) || firstLine(body, untitled()), body, publishedAt: isoFrom(row.create_time ?? row.time ?? row.last_update_time),
      url: `https://www.xiaohongshu.com/explore/${id}`,
      cover: firstUrl(at(row, 'images_list', 0, 'url_size_large'), at(row, 'images_list', 0, 'url'), at(row, 'cover', 'url'), at(row, 'cover', 'url_default')),
      views: count(row.view_count), likes: count(row.likes ?? row.liked_count ?? interact.liked_count), comments: count(row.comments_count ?? interact.comment_count),
      saves: count(row.collected_count ?? interact.collected_count), shares: count(row.share_count ?? interact.share_count),
    } satisfies SocialPost;
  }).filter((post): post is SocialPost => post !== null);
}

function awemePosts(output: unknown, platform: '抖音' | 'TikTok'): SocialPost[] {
  return (findArray(output, ['aweme_list']) ?? []).map(raw => {
    const row = obj(raw);
    const id = typeof row.aweme_id === 'string' ? row.aweme_id : '';
    if (!/^\d{5,30}$/.test(id)) return null;
    const stat = obj(row.statistics);
    const body = text(row.desc, 2000);
    const handle = text(at(row, 'author', 'unique_id'), 40);
    const url = platform === '抖音' ? `https://www.douyin.com/video/${id}` : `https://www.tiktok.com/@${/^[\w.]{2,24}$/.test(handle) ? handle : 'tiktok'}/video/${id}`;
    return {
      id, title: firstLine(body, untitled()), body, publishedAt: isoFrom(row.create_time), url,
      cover: firstUrl(at(row, 'video', 'cover', 'url_list'), at(row, 'video', 'origin_cover', 'url_list'), at(row, 'video', 'dynamic_cover', 'url_list')),
      views: count(stat.play_count), likes: count(stat.digg_count), comments: count(stat.comment_count), saves: count(stat.collect_count), shares: count(stat.share_count),
    } satisfies SocialPost;
  }).filter((post): post is SocialPost => post !== null);
}

function bilibiliPosts(output: unknown): SocialPost[] {
  return (findArray(output, ['vlist', 'archives']) ?? []).map(raw => {
    const row = obj(raw);
    const id = typeof row.bvid === 'string' ? row.bvid : '';
    if (!/^BV\w{6,16}$/.test(id)) return null;
    const stat = obj(row.stat);
    return {
      id, title: text(row.title, 80) || untitled(), body: text(row.description ?? row.desc, 2000), publishedAt: isoFrom(row.created ?? row.pubdate ?? row.ctime),
      url: `https://www.bilibili.com/video/${id}`, cover: httpsUrl(row.pic),
      views: count(row.play ?? stat.view), likes: count(stat.like), comments: count(row.comment ?? stat.reply), saves: count(stat.favorite), shares: count(stat.share),
    } satisfies SocialPost;
  }).filter((post): post is SocialPost => post !== null);
}

function instagramPosts(output: unknown): SocialPost[] {
  const items = findArray(output, ['items']) ?? (findArray(output, ['edges']) ?? []).map(edge => at(edge, 'node'));
  return items.map(raw => {
    const row = obj(raw);
    const id = typeof row.code === 'string' ? row.code : typeof row.shortcode === 'string' ? row.shortcode : '';
    if (!/^[\w-]{5,40}$/.test(id)) return null;
    const body = text(at(row, 'caption', 'text') ?? at(row, 'edge_media_to_caption', 'edges', 0, 'node', 'text'), 2000);
    return {
      id, title: firstLine(body, untitled()), body, publishedAt: isoFrom(row.taken_at ?? row.taken_at_timestamp),
      url: `https://www.instagram.com/p/${id}/`,
      cover: firstUrl(at(row, 'image_versions2', 'candidates', 0, 'url'), at(row, 'carousel_media', 0, 'image_versions2', 'candidates', 0, 'url'), row.display_url, row.thumbnail_src, row.thumbnail_url),
      views: count(row.ig_play_count ?? row.play_count ?? row.view_count ?? row.video_view_count),
      likes: count(row.like_count ?? at(row, 'edge_liked_by', 'count') ?? at(row, 'edge_media_preview_like', 'count')),
      comments: count(row.comment_count ?? at(row, 'edge_media_to_comment', 'count')), saves: 0, shares: count(row.reshare_count),
    } satisfies SocialPost;
  }).filter((post): post is SocialPost => post !== null);
}

function tweetId(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : '';
  return /^\d{5,25}$/.test(id) ? id : '';
}

function tweetMedia(...sources: unknown[]): string | null {
  for (const source of sources) {
    const list = Array.isArray(source) ? source : isObj(source) ? Object.values(source).flatMap(value => (Array.isArray(value) ? value : [])) : [];
    for (const raw of list.slice(0, 8)) {
      const m = obj(raw);
      const url = firstUrl(m.media_url_https, m.media_url, m.preview_image_url, m.thumbnail, m.url);
      if (url) return url;
    }
  }
  return null;
}

/** A tweet in any of the shapes X data comes in: GraphQL (`rest_id` + `legacy`), v1.1, v2 or flat TikHub rows. */
function tweetFrom(node: Json, fallbackScreen: string): SocialPost | null {
  const legacy = isObj(node.legacy) && (typeof node.legacy.full_text === 'string' || typeof node.legacy.text === 'string') ? node.legacy : null;
  const src = legacy ?? node;
  const id = tweetId(node.rest_id) || tweetId(src.id_str) || tweetId(node.id_str) || tweetId(node.tweet_id) || tweetId(node.id);
  if (!id) return null;
  const longText = at(node, 'note_tweet', 'note_tweet_results', 'result', 'text');
  const raw = typeof longText === 'string' ? longText : src.full_text ?? src.text ?? node.full_text ?? node.text;
  if (typeof raw !== 'string') return null;
  const metrics = obj(src.public_metrics ?? node.public_metrics);
  const signal = ['created_at', 'favorite_count', 'like_count', 'favorites', 'retweet_count', 'retweets', 'reply_count'].some(key => key in src || key in node) || Object.keys(metrics).length > 0;
  if (!signal) return null;
  const body = text(raw, 2000);
  const screen = [
    at(node, 'core', 'user_results', 'result', 'legacy', 'screen_name'), at(node, 'core', 'user_results', 'result', 'core', 'screen_name'),
    at(node, 'user', 'screen_name'), at(node, 'author', 'screen_name'), at(node, 'author', 'username'), node.screen_name,
  ].find((value): value is string => typeof value === 'string' && /^\w{1,15}$/.test(value)) ?? fallbackScreen;
  const views = at(node, 'views', 'count') ?? node.view_count ?? src.view_count ?? (typeof node.views === 'number' || typeof node.views === 'string' ? node.views : undefined) ?? metrics.impression_count;
  return {
    id, title: firstLine(body, untitled()), body, publishedAt: isoFrom(src.created_at ?? node.created_at ?? node.createdAt),
    url: `https://x.com/${screen}/status/${id}`,
    cover: tweetMedia(at(src, 'extended_entities', 'media'), at(src, 'entities', 'media'), node.media, src.media),
    views: count(typeof views === 'string' ? views.trim() : views),
    likes: count(src.favorite_count ?? src.like_count ?? src.favorites ?? src.likes ?? metrics.like_count),
    comments: count(src.reply_count ?? src.replies ?? metrics.reply_count),
    saves: count(src.bookmark_count ?? src.bookmarks ?? metrics.bookmark_count),
    shares: count(src.retweet_count ?? src.retweets ?? metrics.retweet_count) + count(src.quote_count ?? src.quotes ?? metrics.quote_count),
  };
}

/**
 * The X action is not the TikHub endpoint the reference used, so its shape is unknown. Walk the
 * output depth-first and keep every tweet-like object, without descending into a matched tweet
 * (that would pick up quoted and retweeted tweets as separate posts). Newest first.
 */
function xPosts(output: unknown, screenName: string): SocialPost[] {
  const fallback = /^\w{1,15}$/.test(screenName) ? screenName : 'i';
  const found: SocialPost[] = [];
  const stack: Array<{ node: unknown; depth: number }> = [{ node: output, depth: 0 }];
  let visits = 0;
  while (stack.length && visits < 50_000 && found.length < MAX_POSTS * 2) {
    const { node, depth } = stack.pop()!;
    visits += 1;
    if (depth > 16 || typeof node !== 'object' || node === null) continue;
    if (Array.isArray(node)) {
      for (let i = Math.min(node.length, 500) - 1; i >= 0; i -= 1) stack.push({ node: node[i], depth: depth + 1 });
      continue;
    }
    const tweet = tweetFrom(node as Json, fallback);
    if (tweet) {
      found.push(tweet);
      continue;
    }
    const values = Object.values(node as Json);
    for (let i = values.length - 1; i >= 0; i -= 1) stack.push({ node: values[i], depth: depth + 1 });
  }
  return found.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/** Untrusted TikHub output → posts. Throws when the platform reports a failure. */
export function normalizePosts(platform: WorkbenchImportPlatform, output: unknown, accountId = ''): SocialPost[] {
  const failure = upstreamFailure(output);
  if (failure) throw fail(502, failure || tr('平台没有返回内容'));
  switch (platform) {
    case '小红书': return cap(xiaohongshuPosts(output));
    case '抖音': return cap(awemePosts(output, '抖音'));
    case 'TikTok': return cap(awemePosts(output, 'TikTok'));
    case 'Instagram': return cap(instagramPosts(output));
    case 'X': return cap(xPosts(output, accountId));
    case 'B站': return cap(bilibiliPosts(output));
  }
}

function profileOf(nickname: unknown, description: unknown, followers: unknown, avatar: string | null): SocialProfile {
  return { nickname: text(nickname, 40), description: text(description, 300), followers: count(followers), avatar };
}

function xProfile(output: unknown, handle: string): SocialProfile | null {
  let best: { score: number; profile: SocialProfile } | null = null;
  const want = handle.toLowerCase();
  const stack: Array<{ node: unknown; depth: number }> = [{ node: output, depth: 0 }];
  let visits = 0;
  while (stack.length && visits < 20_000) {
    const { node, depth } = stack.pop()!;
    visits += 1;
    if (depth > 14 || typeof node !== 'object' || node === null) continue;
    if (Array.isArray(node)) {
      for (const value of node.slice(0, 200)) stack.push({ node: value, depth: depth + 1 });
      continue;
    }
    const o = node as Json;
    const legacy = obj(o.legacy);
    const core = obj(o.core);
    const metrics = obj(o.public_metrics);
    const followers = o.followers_count ?? legacy.followers_count ?? metrics.followers_count ?? o.sub_count ?? o.normal_followers_count;
    const screen = [o.screen_name, legacy.screen_name, core.screen_name, o.username, o.profile].find((value): value is string => typeof value === 'string');
    const name = [o.name, legacy.name, core.name].find((value): value is string => typeof value === 'string');
    if (followers !== undefined || (name && screen)) {
      const score = (screen && screen.toLowerCase() === want ? 10 : 0) + (followers !== undefined ? 2 : 0) + (name ? 1 : 0);
      if (!best || score > best.score) {
        const rawAvatar = [o.profile_image_url_https, legacy.profile_image_url_https, at(o, 'avatar', 'image_url'), o.profile_image_url, o.avatar]
          .find((value): value is string => typeof value === 'string');
        const avatar = httpsUrl(rawAvatar?.replace(/_normal\.(jpe?g|png|webp)/i, '_400x400.$1'));
        best = { score, profile: profileOf(name ?? screen, o.description ?? legacy.description ?? o.desc, followers, avatar) };
      }
      if (score >= 12) break;
    }
    for (const value of Object.values(o)) stack.push({ node: value, depth: depth + 1 });
  }
  return best?.profile ?? null;
}

/** Untrusted profile outputs → profile. Never throws; missing parts stay empty. */
export function normalizeProfile(platform: WorkbenchImportPlatform, sources: { profile?: unknown; relation?: unknown; posts?: unknown }, accountId = ''): SocialProfile {
  const { profile, relation } = sources;
  const empty: SocialProfile = { nickname: '', description: '', followers: 0, avatar: null };
  if (platform === '小红书') {
    const user = findObject(profile, node => typeof node.nickname === 'string' && ('interactions' in node || 'red_id' in node || 'desc' in node || 'fans' in node));
    if (!user) return empty;
    const fans = (Array.isArray(user.interactions) ? user.interactions : []).map(obj).find(row => row.type === 'fans')?.count ?? user.fans;
    return profileOf(user.nickname, user.desc, fans, firstUrl(user.images, user.imageb, user.avatar));
  }
  if (platform === '抖音' || platform === 'TikTok') {
    const user = (isObj(at(profile, 'user')) ? obj(at(profile, 'user')) : null)
      ?? findObject(profile, node => typeof node.nickname === 'string' && ('follower_count' in node || 'signature' in node || 'sec_uid' in node || 'unique_id' in node));
    if (!user) return empty;
    const stats = obj(findObject(profile, node => 'followerCount' in node));
    return profileOf(user.nickname, user.signature, user.follower_count ?? user.mplatform_followers_count ?? stats.followerCount,
      firstUrl(at(user, 'avatar_larger', 'url_list'), at(user, 'avatar_300x300', 'url_list'), at(user, 'avatar_medium', 'url_list'), at(user, 'avatar_thumb', 'url_list'), user.avatarLarger, user.avatarMedium));
  }
  if (platform === 'Instagram') {
    const user = findObject(profile, node => typeof node.username === 'string' && ('full_name' in node || 'biography' in node || 'edge_followed_by' in node || 'follower_count' in node));
    if (!user) return empty;
    return profileOf(user.full_name || user.username, user.biography, at(user, 'edge_followed_by', 'count') ?? user.follower_count,
      firstUrl(user.profile_pic_url_hd, at(user, 'hd_profile_pic_url_info', 'url'), user.profile_pic_url));
  }
  if (platform === 'X') return xProfile(profile, accountId) ?? xProfile(sources.posts, accountId) ?? empty;
  const user = findObject(profile, node => typeof node.name === 'string' && ('mid' in node || 'sign' in node || 'face' in node));
  const stat = findObject(relation, node => 'follower' in node);
  return profileOf(user?.name, user?.sign, stat?.follower ?? at(user, 'follower'), firstUrl(user?.face));
}

/** Instagram posts need the numeric user id from the profile output. */
export function instagramUserId(profile: unknown, username: string): string | null {
  const want = username.toLowerCase();
  const numeric = (node: Json) => [node.pk, node.pk_id, node.id].map(value => (typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value))
    .find((value): value is string => typeof value === 'string' && /^\d{1,25}$/.test(value)) ?? null;
  const exact = findObject(profile, node => typeof node.username === 'string' && node.username.toLowerCase() === want && numeric(node) !== null);
  const any = exact ?? findObject(profile, node => typeof node.username === 'string' && numeric(node) !== null);
  return any ? numeric(any) : null;
}

// ── TokenToSea connect calls ────────────────────────────────────────

interface ToolQuote { id: string; actionId?: string; reserveUsd: string | number; expiresAt?: string; priceVersion: string; billingNote?: string }
interface ToolRun { id: string; actionId?: string; status: string; priceUsd?: string | number | null; chargedUsd?: string | number | null; output?: unknown; errorCode?: string | null; pendingConfirmation?: unknown }
interface ToolDescribe { name?: string; toolId?: string; priceUsd?: string | number | null; priceVersion?: string | number; price?: { usd?: string | number } | null }

/** Integer micro-USD from an untrusted amount. */
function micros(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1e6) : 0;
}

function formatUsd(amount: number): string {
  const fixed = (amount / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return fixed || '0';
}

function requireRuntime(): TokenToSeaRuntime {
  const runtime = optionalTokenToSeaRuntime();
  if (!runtime?.current()?.user) throw notSignedIn();
  return runtime;
}

function connectError(status: number, value: unknown): StatusError {
  const body = obj(value);
  const nested = obj(body.error);
  const code = [body.errorCode, body.code, body.error, nested.code].find((entry): entry is string => typeof entry === 'string' && /^[\w.-]{1,64}$/.test(entry)) ?? '';
  const detail = text(body.message ?? nested.message, 160);
  switch (code) {
    case 'tool_not_connected':
      return fail(503, say('TokenToSea 社媒数据工具暂未开通，稍后再试。', 'The TokenToSea social data tool is not connected yet. Try again later.'), { code });
    case 'tool_price_unavailable':
      return fail(503, say('社媒数据暂时无法报价，稍后再试。', 'The social data tool cannot quote a price right now. Try again later.'), { code });
    case 'tool_insufficient_balance':
      return fail(402, say('TokenToSea 余额不足，充值后再导入。', 'Your TokenToSea balance is too low. Top up and import again.'), { code });
    case 'tool_rate_limited':
      return fail(429, say('社媒数据调用太频繁了，请等一分钟再试。', 'Too many social data calls right now. Wait a minute and try again.'), { code });
    case 'tool_price_changed':
      return fail(409, say('社媒数据的价格刚刚变了，请再试一次。', 'The social data price just changed. Please try again.'), { code });
    default:
      break;
  }
  if (status === 401) return fail(401, say('TokenToSea 登录已失效，请重新登录。', 'Your TokenToSea session expired. Sign in again.'), { code: code || 'unauthorized' });
  if (status === 403) return fail(403, say('Fantay 的 TokenToSea 授权不包含工具调用，请退出后重新登录授权。', 'Fantay’s TokenToSea grant does not allow tool calls. Sign out and sign in again to re-authorize.'), { code: code || 'forbidden' });
  if (status === 402) return fail(402, say('TokenToSea 余额或授权额度不足。', 'Your TokenToSea balance or grant limit is too low.'), { code: code || 'payment_required' });
  if (status === 429) return fail(429, say('社媒数据调用太频繁了，请等一分钟再试。', 'Too many social data calls right now. Wait a minute and try again.'), { code: code || 'rate_limited' });
  return fail(status >= 400 && status < 600 ? (status >= 500 ? 502 : status) : 502,
    say('社媒数据请求失败：{detail}', 'Social data request failed: {detail}', { detail: detail || code || String(status) }), { code });
}

async function connect<T>(runtime: TokenToSeaRuntime, resource: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await runtime.response(resource, method, body, {}, signal);
  } catch (error) {
    if ((error as { status?: number })?.status === 401) throw notSignedIn();
    if (signal?.aborted) throw error;
    throw fail(502, say('连不上 TokenToSea：{detail}', 'Could not reach TokenToSea: {detail}', { detail: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
  }
  let value: unknown = null;
  try {
    value = await response.json();
  } catch {
    value = null;
  }
  if (!response.ok) throw connectError(response.status, value);
  return value as T;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface CallLedger { micros: number; budget?: number | null }

function withCharge(error: unknown, ledger: CallLedger): unknown {
  if (error instanceof Error && ledger.micros > 0) Object.assign(error, { chargedUsd: formatUsd(ledger.micros) });
  return error;
}

/** Quote, invoke and poll one action; returns its output and adds the charge to the ledger. */
async function runAction(runtime: TokenToSeaRuntime, actionId: string, input: Record<string, unknown>, ledger: CallLedger, signal?: AbortSignal): Promise<unknown> {
  let run: ToolRun | null = null;
  for (let attempt = 0; attempt < 3 && !run; attempt += 1) {
    try {
      const quote = await connect<ToolQuote>(runtime, 'tools/quote', 'POST', { actionId, input }, signal);
      if (!quote || typeof quote.id !== 'string' || typeof quote.priceVersion !== 'string') {
        throw fail(502, say('社媒数据报价无效。', 'The social data quote is invalid.'));
      }
      const reserve = micros(quote.reserveUsd);
      if (ledger.budget === undefined) ledger.budget = await runtime.authorizationBudget().catch(() => null);
      if (ledger.budget !== null && ledger.budget !== undefined && reserve > Math.round(ledger.budget * 1e6)) {
        throw fail(402, say('这次调用需要预留约 ${usd}，超过了 Fantay 在 TokenToSea 的单次授权额度。请到 TokenToSea 调整应用授权限额。',
          'This call needs a reserve of about ${usd}, above Fantay’s per-call TokenToSea grant. Raise the app’s grant limit in TokenToSea.', { usd: formatUsd(reserve) }), { code: 'grant_budget_exceeded' });
      }
      run = await connect<ToolRun>(runtime, 'tools/invoke', 'POST', {
        actionId, input, requestKey: `${randomUUID()}-workbench`, priceVersion: quote.priceVersion,
        maxCostUsd: typeof quote.reserveUsd === 'number' ? quote.reserveUsd.toFixed(6) : quote.reserveUsd, quoteId: quote.id,
      }, signal);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      // A price change needs a fresh quote; a rate limit usually clears within seconds.
      if (attempt < 2 && (code === 'tool_price_changed' || (code === 'tool_rate_limited' && attempt === 0))) {
        await sleep(code === 'tool_rate_limited' ? 3000 : 200, signal);
        continue;
      }
      throw error;
    }
  }
  if (!run || typeof run.id !== 'string' || !/^[\w-]{1,128}$/.test(run.id)) throw fail(502, say('社媒数据没有返回任务。', 'The social data tool returned no run.'));
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (IN_PROGRESS.has(String(run.status))) {
    if (Date.now() > deadline) throw fail(504, say('社媒数据等了两分钟还没返回，请稍后再试。', 'The social data tool did not answer within two minutes. Try again later.'), { code: 'tool_timeout' });
    await sleep(POLL_MS, signal);
    const id: string = run.id;
    run = await connect<ToolRun>(runtime, `tools/runs/${id}`, 'GET', undefined, signal);
    if (!run || typeof run.status !== 'string') throw fail(502, say('社媒数据任务状态无效。', 'The social data run status is invalid.'));
    run.id = id;
  }
  if (run.status === 'succeeded') {
    ledger.micros += micros(run.chargedUsd ?? run.priceUsd);
    let output = run.output;
    if (typeof output === 'string') {
      try {
        output = JSON.parse(output) as unknown;
      } catch { /* keep the string */ }
    }
    return output;
  }
  ledger.micros += micros(run.chargedUsd);
  if (run.pendingConfirmation) {
    throw fail(402, say('这次调用需要先在 TokenToSea 确认，确认后再导入。', 'This call needs confirmation in TokenToSea first. Confirm it and import again.'), { code: 'tool_confirmation_required' });
  }
  const code = text(run.errorCode, 64);
  if (code === 'tool_insufficient_balance') throw connectError(402, { code });
  throw fail(502, say('社媒数据这次没跑完（{status}）。', 'The social data run did not finish ({status}).', { status: code || text(run.status, 24) || 'failed' }), { code: code || 'tool_run_failed' });
}

// ── Public API ──────────────────────────────────────────────────────

const statusCache = new Map<string, { at: number; status: WorkbenchSocialStatus }>();

/** Whether import can run for the signed-in account, and roughly what one import costs. */
export async function socialStatus(): Promise<WorkbenchSocialStatus> {
  const all = [...WORKBENCH_IMPORT_PLATFORMS];
  const runtime = optionalTokenToSeaRuntime();
  const user = runtime?.current()?.user;
  if (!runtime || !user) {
    return { signedIn: false, available: false, platforms: all, estimatedUsd: {}, reason: say('请先登录 TokenToSea。', 'Sign in to TokenToSea first.') };
  }
  const cached = statusCache.get(user.id);
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;
  const actions = new Map<string, number | null>();
  for (const platform of all) for (const entry of Object.values(SOCIAL_ACTIONS[platform])) if (entry) actions.set(entry.actionId, null);
  const failures: string[] = [];
  await Promise.all([...actions.keys()].map(async actionId => {
    try {
      const view = await connect<ToolDescribe>(runtime, 'tools/describe', 'POST', { actionId });
      if (typeof view?.toolId === 'string' && view.toolId !== SOCIAL_TOOL_ID) throw fail(409, 'action belongs to another tool');
      actions.set(actionId, micros(view?.priceUsd ?? view?.price?.usd) || Math.round(FALLBACK_CALL_USD * 1e6));
    } catch (error) {
      actions.delete(actionId);
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }));
  const platforms: WorkbenchImportPlatform[] = [];
  const estimatedUsd: Partial<Record<WorkbenchImportPlatform, string>> = {};
  for (const platform of all) {
    const entries = Object.values(SOCIAL_ACTIONS[platform]).filter((entry): entry is { actionId: string; endpoint: string } => Boolean(entry));
    const posts = SOCIAL_ACTIONS[platform].posts;
    if (!posts || !actions.has(posts.actionId)) continue;
    if (platform === 'Instagram' && !actions.has(SOCIAL_ACTIONS.Instagram.profile!.actionId)) continue;
    platforms.push(platform);
    estimatedUsd[platform] = formatUsd(entries.reduce((sum, entry) => sum + (actions.get(entry.actionId) ?? 0), 0));
  }
  const status: WorkbenchSocialStatus = platforms.length
    ? { signedIn: true, available: true, platforms, estimatedUsd }
    : { signedIn: true, available: false, platforms: [], estimatedUsd: {}, reason: failures[0] ?? say('TokenToSea 社媒数据暂不可用。', 'TokenToSea social data is unavailable.') };
  // Do not pin a transient outage for ten minutes.
  if (status.available) statusCache.set(user.id, { at: Date.now(), status });
  return status;
}

/**
 * One page of posts plus the profile, no paging, fixed number of calls. `chargedUsd` is the
 * sum of all runs; errors thrown after a charge carry `chargedUsd` too.
 */
export async function fetchAccount(account: SocialAccountRef, signal?: AbortSignal): Promise<{ posts: SocialPost[]; profile: SocialProfile; chargedUsd: string }> {
  const runtime = requireRuntime();
  const plan = SOCIAL_ACTIONS[account.platform];
  if (!plan?.posts) throw fail(400, tr('认不出这个主页。目前支持小红书、抖音、B 站、TikTok、Instagram 和 X 的账号主页链接，别的平台可以贴内容来提炼风格。'));
  const ledger: CallLedger = { micros: 0 };
  const call = (purpose: SocialPurpose, id = account.id) => {
    const entry = plan[purpose];
    if (!entry) return Promise.resolve(undefined);
    return runAction(runtime, entry.actionId, { queryParams: queryFor(account.platform, purpose, id) }, ledger, signal);
  };
  const extras: { profile?: unknown; relation?: unknown; posts?: unknown } = {};
  try {
    let postsId = account.id;
    if (account.platform === 'Instagram') {
      extras.profile = await call('profile');
      const numeric = instagramUserId(extras.profile, account.id);
      if (!numeric) throw fail(404, tr('没抓到内容，账号可能是私密的或者还没发过内容。'));
      postsId = numeric;
    }
    const output = await call('posts', postsId);
    extras.posts = output;
    const posts = normalizePosts(account.platform, output, account.id);
    if (!posts.length) throw fail(404, tr('没抓到内容，账号可能是私密的或者还没发过内容。'));
    // Profile data is optional: a failure here never loses the posts already paid for.
    const optional = (['profile', 'relation'] as const).filter(kind => plan[kind] && extras[kind] === undefined);
    await Promise.all(optional.map(async kind => {
      try {
        extras[kind] = await call(kind);
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }));
    return { posts, profile: normalizeProfile(account.platform, extras, account.id), chargedUsd: formatUsd(ledger.micros) };
  } catch (error) {
    throw withCharge(error, ledger);
  }
}

function sniffImage(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png';
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') return '.gif';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (buffer.subarray(4, 12).toString('latin1') === 'ftypavif') return '.avif';
  return null;
}

async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

/** Platform image URLs expire, so covers are stored locally. A failure skips the cover only. */
async function saveCover(raw: string, filesDir: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    let current = raw;
    for (let hop = 0; hop < 3; hop += 1) {
      if (!current.startsWith('https://')) return null;
      await assertPublicUrl(current);
      const res = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => undefined);
        current = new URL(location, current).toString();
        continue;
      }
      if (!res.ok || Number(res.headers.get('content-length') ?? 0) > COVER_MAX_BYTES) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      const buffer = await readCapped(res, COVER_MAX_BYTES);
      const ext = buffer ? sniffImage(buffer) : null;
      if (!buffer || !ext) return null;
      const name = `${newId('c')}${ext}`;
      await writeFile(join(filesDir, name), buffer);
      return `workbench/files/${name}`;
    }
  } catch { /* covers are optional */ }
  return null;
}

/** Download covers for posts that have one; returns postId → `workbench/files/<name>`. */
export async function saveCovers(posts: SocialPost[], filesDir: string, fetchImpl: typeof fetch = fetch): Promise<Map<string, string>> {
  const queue = posts.filter(post => post.cover && post.cover.startsWith('https://'));
  const saved = new Map<string, string>();
  if (!queue.length) return saved;
  await mkdir(filesDir, { recursive: true });
  const worker = async () => {
    for (let post = queue.shift(); post; post = queue.shift()) {
      const src = await saveCover(post.cover!, filesDir, fetchImpl);
      if (src) saved.set(post.id, src);
    }
  };
  await Promise.all(Array.from({ length: COVER_CONCURRENCY }, worker));
  return saved;
}

/**
 * Write the account's own posts into the library and insights. Re-importing only refreshes the
 * numbers (upsert by `externalId`) and never touches text the user edited. New posts skip the
 * Inbox (`triagedAt`). Returns the ids of new items.
 */
export function importPosts(draft: WorkbenchState, args: { account: SocialAccountRef; profile: SocialProfile; posts: SocialPost[]; covers: Map<string, string>; now?: string }): { added: number; updated: number; ids: string[] } {
  const { account, profile, posts, covers } = args;
  const now = args.now ?? new Date().toISOString();
  const { platform } = account;
  const nickname = profile.nickname || platformName(platform);
  const ids: string[] = [];
  for (const post of posts) {
    const externalId = `${platform}:${post.id}`;
    let item = draft.items.find(row => row.externalId === externalId);
    if (!item) {
      const fresh: WorkbenchItem = {
        id: newId('it'), kind: 'web', title: post.title, body: post.body, tags: [], status: 'published', personaIds: [], drafts: {},
        createdAt: post.publishedAt, publishedAt: post.publishedAt, scheduledAt: post.publishedAt, platform, url: post.url, source: nickname,
        media: null, imported: true, externalId, triagedAt: now,
      };
      draft.items.push(fresh);
      ids.push(fresh.id);
      item = fresh;
    }
    const cover = covers.get(post.id);
    if (cover) item.media = { src: cover };
    const numbers = { views: post.views, likes: post.likes, comments: post.comments, shares: post.shares, saves: post.saves };
    const metric = draft.metrics.find(row => row.externalId === externalId);
    if (metric) Object.assign(metric, numbers, { fetchedAt: now });
    else {
      const row: WorkbenchMetric = { id: newId('m'), itemId: item.id, platform, date: post.publishedAt, ...numbers, externalId, fetchedAt: now };
      draft.metrics.push(row);
    }
  }
  const key = `${platform}:${account.id}`;
  const existing = draft.accounts.find(entry => entry.externalId === key);
  const fields = {
    platform, handle: nickname, url: account.url, followers: profile.followers || null, description: profile.description,
    avatar: profile.avatar ?? existing?.avatar ?? null, fetchedAt: now, fetchError: null,
  } satisfies Partial<WorkbenchAccount>;
  if (existing) Object.assign(existing, fields);
  else draft.accounts.push({ id: newId('ac'), createdAt: now, externalId: key, ...fields });
  return { added: ids.length, updated: posts.length - ids.length, ids };
}

/** Style-extraction material. Most-viewed and most-engaged first: the model weighs the start more. */
export function postsToMaterial(posts: SocialPost[]): string {
  const score = (post: SocialPost) => post.likes + post.comments + post.saves + post.shares;
  return [...posts]
    .sort((a, b) => (b.views - a.views) || (score(b) - score(a)))
    .map(post => (post.body && !post.body.startsWith(post.title) ? `${post.title}\n${post.body}` : post.body || post.title))
    .join('\n\n---\n\n');
}
