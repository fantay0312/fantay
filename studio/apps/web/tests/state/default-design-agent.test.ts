import { describe, expect, it } from 'vitest';
import { defaultDesignAgent } from '../../src/state/default-design-agent';

describe('missing design agent choice', () => {
  it('prefers installed DeepSeek without selecting the upstream cloud login', () => {
    expect(defaultDesignAgent([{ id: 'tokentosea', available: true }, { id: 'claude', available: true }, { id: 'deepseek', available: true }])?.id).toBe('deepseek');
    expect(defaultDesignAgent([{ id: 'tokentosea', available: true }])).toBeUndefined();
  });
});
