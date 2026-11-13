// SPDX-License-Identifier: AGPL-3.0-only
// Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
// 抓取网页和个人主页的公开信息。只读公开 HTML，不登录，也不绕过平台限制。
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { tr } from './i18n.js';

type FetchImpl = typeof fetch;

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 4;

function isPrivateAddress(address: string): boolean {
  if (address === '::1' || address === '::') return true;
  const lower = address.toLowerCase();
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  let v4 = lower.startsWith('::ffff:') ? lower.slice(7) : lower;
  // URL 解析器会把 ::ffff:127.0.0.1 规范化成 ::ffff:7f00:1
  const mapped = /^([\da-f]{1,4}):([\da-f]{1,4})$/.exec(v4);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16);
    const low = parseInt(mapped[2]!, 16);
    v4 = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  if (isIP(v4) !== 4) return false;
  const [a = 0, b = 0] = v4.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/** 粘贴的链接可能来自任何地方，不能让它访问本机或内网服务。 */
export async function assertPublicUrl(raw: string | URL): Promise<URL> {
  let url: URL;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new Error(tr('链接格式不对'));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(tr('只支持 http 和 https 链接'));
  if (url.username || url.password) throw new Error(tr('链接里不能带账号密码'));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error(tr('不能抓取本机地址'));
  const records = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!records.length || records.some(record => isPrivateAddress(record.address))) throw new Error(tr('不能抓取内网地址'));
  return url;
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text
    .replace(/&#(\d+);/g, (_, n: string) => { const code = Number(n); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; })
    .replace(/&#x([\da-f]+);/gi, (_, n: string) => { const code = parseInt(n, 16); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; })
    .replace(/&([a-z]+);/gi, (all, name: string) => named[name.toLowerCase()] ?? all)
    .trim();
}

function meta(html: string, names: string[]): string | null {
  for (const name of names) {
    const a = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html);
    if (a?.[1]) return decodeEntities(a[1]);
    const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i').exec(html);
    if (b?.[1]) return decodeEntities(b[1]);
  }
  return null;
}

function followerHint(text: string): number | null {
  const m = /([\d.,]+)\s*(万|千|k|K|m|M)?\s*(?:粉丝|关注者|followers)/.exec(text) ?? /(?:粉丝|followers)[^\d]{0,6}([\d.,]+)\s*(万|千|k|K|m|M)?/.exec(text);
  if (!m) return null;
  const units: Record<string, number> = { 万: 1e4, 千: 1e3, k: 1e3, K: 1e3, m: 1e6, M: 1e6 };
  const unit = m[2] ? units[m[2]] ?? 1 : 1;
  const value = Number(m[1]!.replace(/,/g, '')) * unit;
  return Number.isFinite(value) ? Math.round(value) : null;
}

/** 手动跟随跳转，每一跳都重新检查目标地址。 */
export async function fetchPublic(raw: string, fetchImpl: FetchImpl = fetch, init: { accept?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ res: Response; url: URL }> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertPublicUrl(current);
    const timeout = AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS);
    const res = await fetchImpl(url, {
      redirect: 'manual', signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', accept: init.accept ?? 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => undefined);
      current = new URL(location, url).toString();
      continue;
    }
    return { res, url };
  }
  throw new Error(tr('跳转次数过多'));
}

/** 读一个有大小上限的响应体。 */
export async function readLimited(res: Response, limit: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

async function readHtml(raw: string, fetchImpl: FetchImpl): Promise<{ html: string; url: URL }> {
  const { res, url } = await fetchPublic(raw, fetchImpl);
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(tr('页面返回 {status}，可能需要登录或被平台拦截', { status: res.status }));
  }
  const type = res.headers.get('content-type') || '';
  if (!/html|xml/i.test(type)) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(tr('这不是网页（{type}）', { type: type || tr('未知类型') }));
  }
  return { html: (await readLimited(res, MAX_BYTES)).toString('utf8'), url };
}

export interface HarvestTextResult { url: string; title: string | null; text: string }
export interface HarvestResult { url: string; title: string | null; description: string | null; image: string | null; siteName: string | null; followers: number | null }

/** 抓一个公开页面的正文，用来提炼风格。 */
export async function harvestText(raw: string, fetchImpl: FetchImpl = fetch): Promise<HarvestTextResult> {
  const { html, url } = await readHtml(raw, fetchImpl);
  const title = meta(html, ['og:title']) ?? decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '');
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body).split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(line => line.length > 8).join('\n');
  return { url: url.toString(), title: title || null, text };
}

/** 读取一个公开页面的标题、简介、封面和可见的粉丝数。 */
export async function harvest(raw: string, fetchImpl: FetchImpl = fetch): Promise<HarvestResult> {
  const { html, url } = await readHtml(raw, fetchImpl);
  const title = meta(html, ['og:title', 'twitter:title']) ?? decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '');
  const description = meta(html, ['og:description', 'description', 'twitter:description']);
  let image = meta(html, ['og:image', 'twitter:image', 'og:image:url']);
  if (image) {
    try {
      image = new URL(image, url).toString();
      if (!/^https?:/.test(image)) image = null;
    } catch {
      image = null;
    }
  }
  const siteName = meta(html, ['og:site_name']) ?? url.hostname.replace(/^www\./, '');
  return { url: url.toString(), title: title || null, description, image, siteName, followers: followerHint(`${description ?? ''} ${html.slice(0, 200000).replace(/<[^>]+>/g, ' ')}`) };
}
