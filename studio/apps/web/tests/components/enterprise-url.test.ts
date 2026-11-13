import { describe, expect, it } from 'vitest';

import { enterpriseUrl } from '../../src/components/enterpriseUrl';

// FantayDesign has no localized enterprise landing pages: the "Workspace for
// Teams" entry opens the deployed TokenToSea feedback page for every locale.
const ENTERPRISE_URL = 'https://design.tokentosea.com/feedback/';

describe('enterpriseUrl', () => {
  it('uses the deployed marketing origin in every environment', () => {
    expect(enterpriseUrl('en')).toBe(ENTERPRISE_URL);
    expect(enterpriseUrl('zh-CN')).not.toContain('127.0.0.1');
  });

  it('opens the same page for every client locale', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'pt-BR', 'pl', 'id', 'ar', 'uk']) {
      expect(enterpriseUrl(locale)).toBe(ENTERPRISE_URL);
    }
  });
});
