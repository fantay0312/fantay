import { describe, expect, it } from 'vitest';
import { resolveVelaConsoleOrigin } from '../src/integrations/vela.js';

describe('legacy console-origin compatibility', () => {
  it('always selects TokenToSea and ignores retired upstream profile URLs', () => {
    expect(resolveVelaConsoleOrigin({})).toBe('https://tokentosea.com');
    expect(resolveVelaConsoleOrigin({ OD_VELA_WEB_URL: 'https://untrusted.invalid' }, { OPEN_DESIGN_AMR_PROFILE: 'test' })).toBe('https://tokentosea.com');
  });
});
