import { useState, type CSSProperties } from 'react';
import styles from './ModelBrandIcon.module.css';

export interface ModelIconMetadata { brand?: string | null; icon?: string | null; iconMono?: boolean; brandLabel?: string; provider?: string; }
const MONO = new Set(['claude', 'deepseek', 'doubao', 'gemini', 'grok', 'happyhorse', 'hunyuan', 'kimi', 'meta', 'minimax', 'mistral', 'openai', 'qwen', 'siliconcloud', 'wenxin', 'yi', 'zhipu']);
export const LOCAL_MODEL_ICON_IDS = [
  'claude', 'cloudflare-color', 'cogvideo-color', 'cogview-color', 'deepseek-color', 'deepseek', 'doubao-color', 'doubao', 'gemini', 'grok', 'hailuo-color', 'happyhorse', 'hunyuan', 'kimi', 'meta', 'minimax-color', 'minimax', 'mistral', 'openai', 'qwen-color', 'qwen', 'siliconcloud', 'stepfun-color', 'tongyi', 'typesafe', 'wan', 'wenxin', 'yi', 'zhipu-color', 'zhipu',
] as const;
const ICON_IDS = new Set<string>(LOCAL_MODEL_ICON_IDS);
const BRAND_ICON: Record<string, string> = {
  qwen: 'qwen-color', wan: 'wan', happyhorse: 'happyhorse', cosyvoice: 'tongyi', funasr: 'tongyi', paraformer: 'tongyi', tongyi: 'tongyi', zimage: 'tongyi', zhipu: 'zhipu-color', cogview: 'cogview-color', cogvideox: 'cogvideo-color', minimax: 'minimax-color', hailuo: 'hailuo-color', doubao: 'doubao-color', stepfun: 'stepfun-color', kimi: 'kimi', deepseek: 'deepseek-color', cloudflare: 'cloudflare-color', typesafe: 'typesafe', openai: 'openai', claude: 'claude', anthropic: 'claude', gemini: 'gemini', google: 'gemini', grok: 'grok', xai: 'grok', meta: 'meta', mistral: 'mistral', hunyuan: 'hunyuan', wenxin: 'wenxin', yi: 'yi', siliconcloud: 'siliconcloud',
};

/** Only known local assets are loaded. Explicit model-brand metadata wins over the supply channel. */
export function resolveModelBrandIcon(model: ModelIconMetadata): { src: string; mono: boolean } | null {
  if (model.brand === 'other') return null;
  const token = model.icon && ICON_IDS.has(model.icon) ? model.icon
    : BRAND_ICON[(model.brand ?? model.brandLabel ?? model.provider ?? '').trim().toLowerCase()];
  return token ? { src: `/model-brand-icons/${token}.svg`, mono: MONO.has(token) } : null;
}

export function ModelBrandIcon({ model, fallback }: { model: ModelIconMetadata; fallback: string }) {
  const icon = resolveModelBrandIcon(model);
  const [failed, setFailed] = useState<string | null>(null);
  if (!icon || failed === icon.src) return <span>{fallback}</span>;
  if (icon.mono) return <span className={styles.mask} style={{ maskImage: `url("${icon.src}")`, WebkitMaskImage: `url("${icon.src}")` } as CSSProperties} aria-hidden="true" />;
  return <img className={styles.image} src={icon.src} alt="" aria-hidden="true" draggable={false} onError={() => setFailed(icon.src)} />;
}
