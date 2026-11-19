// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { joinProjectPath } from '../../../../src/fantay/workspace/code/project-path';

describe('joinProjectPath', () => {
  it('joins a POSIX project directory and a relative name', () => {
    expect(joinProjectPath('/Users/me/site', 'src/app/page.tsx')).toBe('/Users/me/site/src/app/page.tsx');
    expect(joinProjectPath('/Users/me/site/', 'index.html')).toBe('/Users/me/site/index.html');
  });

  it('keeps a Windows directory in backslashes all the way', () => {
    expect(joinProjectPath('C:\\work\\site', 'src/app/page.tsx')).toBe('C:\\work\\site\\src\\app\\page.tsx');
    expect(joinProjectPath('C:\\work\\site\\', 'index.html')).toBe('C:\\work\\site\\index.html');
  });
});
