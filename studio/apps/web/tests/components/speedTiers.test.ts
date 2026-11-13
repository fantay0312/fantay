import { describe, expect, it } from 'vitest';
import { isStandardSpeedTier, speedKind, speedTierDescription, speedTierHint, speedTierName } from '../../src/components/speedTiers';

describe('speed tier names and copy', () => {
  it('names Codex flag tiers and folded fast ids alike', () => {
    expect([null, 'default', 'standard', 'priority', 'fast', 'ultrafast', 'flex'].map(speedKind))
      .toEqual(['standard', 'standard', 'standard', 'fast', 'fast', 'ultrafast', 'other']);
    expect(isStandardSpeedTier('Default')).toBe(true);
    expect(speedTierName({ id: 'priority', label: 'Fast' }, true)).toBe('快速');
    expect(speedTierName({ id: 'ultrafast', label: 'Ultrafast' }, true)).toBe('超快');
    expect(speedTierName(null, true)).toBe('标准');
    expect(speedTierName({ id: 'ultrafast' }, false)).toBe('Ultrafast');
    expect(speedTierName({ id: 'flex', label: 'Flex' }, true)).toBe('Flex');
  });

  it('localizes the catalog copy it knows and keeps the rest as written', () => {
    const zh = (description: string) => speedTierDescription({ description }, true);
    expect(zh('2x speed, increased usage')).toBe('2 倍速度，用量更多');
    expect(zh('1.5x speed')).toBe('1.5 倍速度');
    expect(zh('1.5x speed, increased usage')).toBe('1.5 倍速度，用量更多');
    expect(zh('3x speed')).toBe('3 倍速度');
    expect(zh('The fastest available responses for latency-sensitive work.')).toBe('最快的响应，适合对延迟敏感的工作');
    expect(zh('Fast variant. 2x the price.')).toBe('更快的版本，价格约 2 倍');
    expect(zh('Priority processing')).toBe('Priority processing');
    expect(speedTierDescription({ description: '2x speed, increased usage' }, false)).toBe('2x speed, increased usage');
    expect(speedTierDescription({ description: '  ' }, true)).toBeNull();
  });

  it('falls back to a line per kind when the catalog has no copy', () => {
    expect(speedTierHint(null, true)).toBe('默认速度');
    expect(speedTierHint({ id: 'fast' }, true)).toBe('更快的响应，用量更多');
    expect(speedTierHint({ id: 'ultrafast' }, true)).toBe('最快的响应');
    expect(speedTierHint({ id: 'priority', description: '1.5x speed' }, true)).toBe('1.5 倍速度');
    expect(speedTierHint({ id: 'fast' }, false)).toBe('Faster responses, more usage');
    expect(speedTierHint({ id: 'flex' }, true)).toBeNull();
  });
});
