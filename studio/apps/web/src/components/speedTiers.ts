/**
 * Speed tiers as every picker names them. A model route's `serviceTierOptions`
 * carry provider ids: Codex flags (`priority`, `ultrafast`) and the `fast` tier
 * a folded CLI family (Cursor Agent, Antigravity, Grok Build) gets from its fast
 * ids. The pickers always offer 标准 (no tier) first, then only the tiers the
 * model really lists, named 快速 / 超快 whatever the provider calls them.
 */

export type SpeedKind = 'standard' | 'fast' | 'ultrafast' | 'other';

/** The radio value the pickers use for the standard tier (nothing is sent). */
export const STANDARD_SPEED = 'default';

/** Tier ids that mean "no tier": the pickers' own 标准 row stands for them. */
export function isStandardSpeedTier(id: string | null | undefined): boolean {
  const key = id?.trim().toLowerCase();
  return !key || key === 'default' || key === 'standard';
}

export function speedKind(id: string | null | undefined): SpeedKind {
  if (isStandardSpeedTier(id)) return 'standard';
  const key = id!.trim().toLowerCase();
  if (key === 'fast' || key === 'priority') return 'fast';
  if (key === 'ultrafast') return 'ultrafast';
  return 'other';
}

const SPEED_NAMES: Record<Exclude<SpeedKind, 'other'>, { zh: string; en: string }> = {
  standard: { zh: '标准', en: 'Standard' },
  fast: { zh: '快速', en: 'Fast' },
  ultrafast: { zh: '超快', en: 'Ultrafast' },
};

/** 标准 / 快速 / 超快 (Standard / Fast / Ultrafast); a tier the pickers do not know keeps its own label. */
export function speedTierName(tier: { id: string; label?: string } | null | undefined, zh: boolean): string {
  const kind = speedKind(tier?.id);
  if (kind === 'other') return tier?.label || tier!.id;
  return zh ? SPEED_NAMES[kind].zh : SPEED_NAMES[kind].en;
}

const KNOWN_DESCRIPTIONS_ZH: Record<string, string> = {
  'the fastest available responses for latency-sensitive work.': '最快的响应，适合对延迟敏感的工作',
};
const SPEED_MULTIPLIER = /^(\d+(?:\.\d+)?)\s*x speed(,\s*increased usage)?\.?$/i;
const PRICED_VARIANT = /^fast variant\.\s*(\d+(?:\.\d+)?)\s*x the price\.?$/i;

/**
 * The provider's one-line copy for a tier, in Chinese when it is a phrasing we
 * know (`2x speed, increased usage` → 2 倍速度，用量更多) and as written otherwise.
 * Null when the catalog has no copy for the tier.
 */
export function speedTierDescription(tier: { description?: string } | null | undefined, zh: boolean): string | null {
  const text = tier?.description?.trim();
  if (!text) return null;
  if (!zh) return text;
  const known = KNOWN_DESCRIPTIONS_ZH[text.toLowerCase()];
  if (known) return known;
  const multiplier = SPEED_MULTIPLIER.exec(text);
  if (multiplier) return `${multiplier[1]} 倍速度${multiplier[2] ? '，用量更多' : ''}`;
  const priced = PRICED_VARIANT.exec(text);
  if (priced) return `更快的版本，价格约 ${priced[1]} 倍`;
  return text;
}

const FALLBACK_DESCRIPTIONS: Record<Exclude<SpeedKind, 'other'>, { zh: string; en: string }> = {
  standard: { zh: '默认速度', en: 'Default speed' },
  fast: { zh: '更快的响应，用量更多', en: 'Faster responses, more usage' },
  ultrafast: { zh: '最快的响应', en: 'The fastest responses' },
};

/** What the composer's speed menu says under a tier: the provider copy, else a line per kind. */
export function speedTierHint(tier: { id: string; description?: string } | null | undefined, zh: boolean): string | null {
  const kind = speedKind(tier?.id);
  if (kind !== 'standard') {
    const described = speedTierDescription(tier, zh);
    if (described) return described;
  }
  if (kind === 'other') return null;
  return zh ? FALLBACK_DESCRIPTIONS[kind].zh : FALLBACK_DESCRIPTIONS[kind].en;
}
