import { HttpError } from './types.js';

const text = (value: unknown) => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim().slice(0, 300) : '';
/** Public licensed photographs, with attribution. No provider credential leaves the server. */
export async function searchTokenToSeaStock(raw: unknown, request: typeof fetch = fetch) {
  const input = raw as { slots?: Array<{ id: string; query: string }>; request_timeout_ms?: number; budget_ms?: number };
  if (!input || !Array.isArray(input.slots) || !input.slots.length || input.slots.length > 30
    || input.slots.some(slot => typeof slot.id !== 'string' || slot.id.length > 160 || !slot.id || typeof slot.query !== 'string' || !slot.query.trim() || slot.query.length > 300)) throw new HttpError(400, '素材搜索参数无效');
  const deadline = Date.now() + Math.min(Math.max(input.budget_ms ?? 60_000, 1000), 180_000);
  const results: unknown[] = new Array(input.slots.length); let next = 0;
  async function worker() {
    while (next < input.slots!.length) {
      const index = next++, slot = input.slots![index]!, started = Date.now();
      if (started >= deadline) { results[index] = { id: slot.id, status: 'budget_exceeded', attempts: [] }; continue; }
      let status: number | null = null;
      try {
        const url = new URL('https://commons.wikimedia.org/w/api.php');
        url.search = new URLSearchParams({ action: 'query', generator: 'search', gsrnamespace: '6', gsrsearch: slot.query,
          gsrlimit: '3', prop: 'imageinfo', iiprop: 'url|extmetadata|mime|size', iiurlwidth: '1600', format: 'json' }).toString();
        const response = await request(url, { redirect: 'error', headers: { 'User-Agent': 'Fantaydesign/1.0 (https://design.tokentosea.com)' }, signal: AbortSignal.timeout(Math.max(1, Math.min(12_000, input.request_timeout_ms ?? 12_000, deadline - Date.now()))) });
        status = response.status;
        if (!response.ok) throw new Error('stock_source_unavailable');
        const data = await response.json() as { query?: { pages?: Record<string, { title: string; imageinfo?: Array<{ url?: string; thumburl?: string; descriptionurl?: string; mime?: string; extmetadata?: Record<string, { value?: string }> }> }> } };
        const image = Object.values(data.query?.pages ?? {}).flatMap(page => (page.imageinfo ?? []).map(info => ({ ...info, title: page.title })))
          .find(info => ['image/jpeg', 'image/png', 'image/webp'].includes(info.mime ?? '') && text(info.extmetadata?.LicenseShortName?.value) && (info.thumburl || info.url) && info.descriptionurl);
        const attempt = { provider: 'wikimedia', stage: 'search', status: image ? 'ok' : 'not_found', timestamp: new Date(started).toISOString(), duration_ms: Date.now() - started, http_status: status };
        results[index] = image ? { id: slot.id, status: 'ok', provider: 'wikimedia', download_url: image.thumburl ?? image.url,
          source_url: image.descriptionurl, license: text(image.extmetadata?.LicenseShortName?.value), author: text(image.extmetadata?.Artist?.value),
          author_url: image.descriptionurl, alt: text(image.extmetadata?.ImageDescription?.value) || image.title, attempts: [attempt] }
          : { id: slot.id, status: 'not_found', attempts: [attempt] };
      } catch {
        results[index] = { id: slot.id, status: 'error', error: 'stock_source_unavailable', attempts: [{ provider: 'wikimedia', stage: 'search', status: 'error', timestamp: new Date(started).toISOString(), duration_ms: Date.now() - started, http_status: status }] };
      }
    }
  }
  await Promise.all([worker(), worker()]);
  return { providers: ['wikimedia'], slots: results };
}
