import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const USAGE_PRICE_SOURCE = 'https://models.dev/api.json';
export interface UsagePrice { input: number; output: number; cacheRead?: number | undefined; cacheWrite?: number | undefined }
export interface UsagePriceSnapshot { fetchedAt: number; prices: Record<string, UsagePrice> }
type Value = Record<string, unknown>;
const object = (v: unknown): Value => v && typeof v === 'object' && !Array.isArray(v) ? v as Value : {};
const rate = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/** Keep exact provider/model identities. Never guess a price from a similar model name. */
export function parseUsagePrices(value: unknown, now = Date.now()): UsagePriceSnapshot {
  const prices: Record<string, UsagePrice> = {};
  for (const [provider, entry] of Object.entries(object(value))) {
    for (const [model, data] of Object.entries(object(object(entry).models))) {
      const cost = object(object(data).cost);
      const input = rate(cost.input), output = rate(cost.output);
      if (input === undefined || output === undefined) continue;
      // Tiered/context-dependent rates need more billing context than local logs expose.
      if (Object.keys(cost).some(key => /above|tier|context/i.test(key))) continue;
      prices[`${provider}/${model}`] = { input, output, cacheRead: rate(cost.cache_read), cacheWrite: rate(cost.cache_write) };
    }
  }
  return { fetchedAt: now, prices };
}

export interface UsagePriceInput {
  model: string;
  priceProvider?: string | undefined;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  /** OpenAI/Gemini input includes cached tokens; Anthropic/OpenCode input does not. */
  inputIncludesCache: boolean;
}

export function estimateUsageUsd(snapshot: UsagePriceSnapshot | null, usage: UsagePriceInput): number | undefined {
  if (!snapshot || usage.cacheWrite1h) return undefined;
  const model = usage.model.startsWith('global:') ? usage.model.slice(7) : usage.model;
  const inferred = model.startsWith('claude-') ? 'anthropic' : /^(gpt-|o[134](?:-|$)|codex-)/.test(model) ? 'openai' : model.startsWith('gemini-') ? 'google' : model.startsWith('deepseek-') ? 'deepseek' : model.startsWith('grok-') ? 'xai' : /^minimax-/i.test(model) ? 'minimax' : /^(kimi-|moonshot-)/.test(model) ? 'moonshotai' : undefined;
  const provider = usage.priceProvider || inferred;
  const price = snapshot.prices[model] ?? (provider ? snapshot.prices[`${provider}/${model}`] : undefined);
  if (!price || usage.cacheRead > 0 && price.cacheRead === undefined || usage.cacheWrite > 0 && price.cacheWrite === undefined) return undefined;
  const input = usage.input - (usage.inputIncludesCache ? usage.cacheRead + usage.cacheWrite : 0);
  if (input < 0) return undefined;
  return (input * price.input + usage.output * price.output + usage.cacheRead * (price.cacheRead ?? 0) + usage.cacheWrite * (price.cacheWrite ?? 0)) / 1_000_000;
}

/** The only network request is a public price list; no local usage or account data is sent. */
export class UsagePricing {
  private snapshot: UsagePriceSnapshot | null = null;
  private attemptedAt = 0;
  constructor(private readonly dataDir: string) {}

  async get(): Promise<UsagePriceSnapshot | null> {
    const fresh = this.snapshot && Date.now() - this.snapshot.fetchedAt < 86_400_000;
    if (fresh || Date.now() - this.attemptedAt < 300_000) return this.snapshot;
    this.attemptedAt = Date.now();
    const file = path.join(this.dataDir, 'usage', 'prices.json');
    if (!this.snapshot) {
      try {
        const saved = JSON.parse(await readFile(file, 'utf8')) as UsagePriceSnapshot;
        if (Number.isFinite(saved.fetchedAt) && saved.prices && typeof saved.prices === 'object') this.snapshot = saved;
      } catch { /* First use or an unreadable cache. Usage remains available offline. */ }
    }
    if (this.snapshot && Date.now() - this.snapshot.fetchedAt < 86_400_000) return this.snapshot;
    try {
      const response = await fetch(USAGE_PRICE_SOURCE, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
      if (!response.ok) return this.snapshot;
      const raw = await response.text();
      if (raw.length > 32 * 1024 * 1024) return this.snapshot;
      const next = parseUsagePrices(JSON.parse(raw));
      if (!Object.keys(next.prices).length) return this.snapshot;
      this.snapshot = next;
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    } catch { /* Network/cache errors must not hide local token counts. */ }
    return this.snapshot;
  }
}
