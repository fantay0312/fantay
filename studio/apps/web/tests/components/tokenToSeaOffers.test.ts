import { expect, it } from 'vitest';
import { channelPrice } from '../../src/components/tokenToSeaOffers';
import type { AgentModelOption } from '../../src/types';

const option = (fields: Partial<NonNullable<AgentModelOption['channelOffer']>>): AgentModelOption => ({
  id: 'supplier:test/cn/model', label: 'Model', channelOffer: { modelKey: 'model', modelName: 'Model', supplier: 'Test', channel: 'cn', ...fields },
});

it('distinguishes historical prices from live prices and explains missing comparisons', () => {
  expect(channelPrice(option({ referenceBasis: 'historical', inputMultiplier: '0.2', outputMultiplier: '0.2' }), true)).toBe('历史官价 · 0.2×');
  expect(channelPrice(option({ referenceBasis: 'historical_peak', inputMultiplier: '0.2', outputMultiplier: '0.3' }), true)).toBe('历史峰时官价 · 输入 0.2× · 输出 0.3×');
  expect(channelPrice(option({ referenceBasis: 'historical_off_peak', inputMultiplier: '0.4' }), false)).toContain('Historical off-peak price');
  expect(channelPrice(option({ unavailableReason: 'no_published_price' }), true)).toBe('官网未公布该型号按量价');
  expect(channelPrice(option({ unavailableReason: 'returned_model_mismatch' }), true)).toContain('glm-5v-turbo');
  expect(channelPrice(option({ multiplier: '1' }), true)).toBe('1×');
});
