import type { AgentModelOption } from '../types';

export function modelOffer(option: AgentModelOption) {
  if (option.channelOffer) return option.channelOffer;
  // Older daemons still expose the exact route and a human supplier prefix.
  const route = /^supplier:([^/]+)\/([^/]+)\/(.+)$/i.exec(option.id);
  const [first, ...rest] = option.label.split(' · ');
  const direct = option.id.startsWith('official:');
  return { modelKey: route?.[3]?.toLowerCase() ?? option.id.replace(/^official:/, '').toLowerCase(),
    modelName: route && rest.length ? rest.join(' · ') : option.label, supplier: route ? first! : '',
    channel: route?.[2] ?? (direct ? 'official' : '') } as NonNullable<AgentModelOption['channelOffer']>;
}

export function groupTokenToSeaModels(options: AgentModelOption[]) {
  const groups = new Map<string, { key: string; name: string; options: AgentModelOption[] }>();
  for (const option of options) {
    const offer = modelOffer(option);
    const existing = groups.get(offer.modelKey);
    if (existing) existing.options.push(option);
    else groups.set(offer.modelKey, { key: offer.modelKey, name: offer.modelName, options: [option] });
  }
  return [...groups.values()];
}

export function channelLabel(option: AgentModelOption, zh: boolean, peers: AgentModelOption[] = []) {
  const offer = modelOffer(option);
  const channel = offer.channel === 'official' ? (zh ? '官方直供' : 'Official') : offer.channel;
  const duplicate = peers.some(peer => {
    if (peer.id === option.id) return false;
    const other = modelOffer(peer);
    return other.modelKey === offer.modelKey && other.supplier === offer.supplier && other.channel === offer.channel;
  });
  return [offer.supplier, channel, duplicate && option.id.split('/').at(-1)].filter(Boolean).join(' · ') || (zh ? '市场渠道' : 'Marketplace');
}

export function channelPrice(option: AgentModelOption, zh: boolean) {
  const offer = option.channelOffer;
  if (offer?.free) return zh ? '免费' : 'Free';
  if (offer?.unavailableReason === 'no_published_price') return zh ? '官网未公布该型号按量价' : 'No published price for this model';
  if (offer?.unavailableReason === 'returned_model_mismatch') return zh ? '渠道回执为 glm-5v-turbo，型号不符' : 'Channel reports glm-5v-turbo; model mismatch';
  const { multiplier, inputMultiplier, outputMultiplier } = offer ?? {};
  const common = multiplier ?? (inputMultiplier === outputMultiplier ? inputMultiplier : undefined);
  const basis = offer?.referenceBasis;
  const prefix = basis === 'historical_peak' ? (zh ? '历史峰时官价' : 'Historical peak price')
    : basis === 'historical_off_peak' ? (zh ? '历史闲时官价' : 'Historical off-peak price')
    : basis === 'historical' ? (zh ? '历史官价' : 'Historical official price') : '';
  const ratios = common ? common + '×' : [inputMultiplier && (zh ? '输入 ' : 'In ') + inputMultiplier + '×',
    outputMultiplier && (zh ? '输出 ' : 'Out ') + outputMultiplier + '×'].filter(Boolean).join(' · ');
  if (ratios) return [prefix, ratios].filter(Boolean).join(' · ');
  return zh ? '暂无可比倍率' : 'Ratio unavailable';
}
