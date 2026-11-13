// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';

import {
  DESIGN_OPEN_REQUEST_TTL_MS,
  cancelDesignOpenRequest,
  peekDesignOpenRequest,
  putDesignOpenRequest,
  resetDesignOpenRequestsForTests,
  takeDesignOpenRequest,
} from '../../../src/fantay/design/design-open-requests';

afterEach(resetDesignOpenRequestsForTests);

describe('design pending-open map', () => {
  it('hands a request to the first taker only', () => {
    putDesignOpenRequest('p1', 'designs/首页.fig', { kind: 'blank', title: '首页', sourceNodeId: 'n1' });
    expect(peekDesignOpenRequest('p1', 'designs/首页.fig')).toEqual({ kind: 'blank', title: '首页', sourceNodeId: 'n1' });
    expect(takeDesignOpenRequest('p1', 'designs/首页.fig')).toEqual({ kind: 'blank', title: '首页', sourceNodeId: 'n1' });
    expect(takeDesignOpenRequest('p1', 'designs/首页.fig')).toBeNull();
  });

  it('keys by project and normalized path', () => {
    putDesignOpenRequest('p1', './designs\\a.fig', { kind: 'convert-html', sourcePath: 'index.html' });
    expect(takeDesignOpenRequest('p2', 'designs/a.fig')).toBeNull();
    expect(takeDesignOpenRequest('p1', '/designs/a.fig')).toEqual({ kind: 'convert-html', sourcePath: 'index.html' });
  });

  it('replaces an earlier request for the same path and can be cancelled', () => {
    putDesignOpenRequest('p1', 'designs/a.fig', { kind: 'blank' });
    putDesignOpenRequest('p1', 'designs/a.fig', { kind: 'new-from-image', image: { path: 'img/a.png' }, sourceNodeId: 'n7' });
    expect(peekDesignOpenRequest('p1', 'designs/a.fig')).toMatchObject({ kind: 'new-from-image', sourceNodeId: 'n7' });
    expect(cancelDesignOpenRequest('p1', 'designs/a.fig')).toBe(true);
    expect(cancelDesignOpenRequest('p1', 'designs/a.fig')).toBe(false);
    expect(takeDesignOpenRequest('p1', 'designs/a.fig')).toBeNull();
  });

  it('expires requests after the TTL', () => {
    const now = 1_000_000;
    const file = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' });
    putDesignOpenRequest('p1', 'designs/logo.fig', { kind: 'import-file', file }, now);
    expect(peekDesignOpenRequest('p1', 'designs/logo.fig', now + DESIGN_OPEN_REQUEST_TTL_MS - 1)).toMatchObject({ kind: 'import-file' });
    expect(takeDesignOpenRequest('p1', 'designs/logo.fig', now + DESIGN_OPEN_REQUEST_TTL_MS)).toBeNull();
  });
});
