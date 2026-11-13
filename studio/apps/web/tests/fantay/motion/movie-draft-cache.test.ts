// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { createMovieDocument } from '@open-design/contracts';

import {
  dropMovieDraft,
  resetMovieDraftCacheForTests,
  stashMovieDraft,
  takeMovieDraft,
} from '../../../src/fantay/motion/movie-draft-cache';

afterEach(resetMovieDraftCacheForTests);

describe('movie draft cache', () => {
  it('returns a stashed draft for its base revision and removes it', () => {
    const draft = { ...createMovieDocument('Unsaved'), revision: 7 };
    stashMovieDraft({ projectId: 'p', baseRevision: 7, draft, savedAt: 1 });
    expect(takeMovieDraft('p', 7)).toBe(draft);
    expect(takeMovieDraft('p', 7)).toBeNull();
  });

  it('drops a draft whose base revision is no longer current', () => {
    stashMovieDraft({ projectId: 'p', baseRevision: 3, draft: createMovieDocument('Old'), savedAt: 1 });
    expect(takeMovieDraft('p', 4)).toBeNull();
    expect(takeMovieDraft('p', 3)).toBeNull();
  });

  it('keeps drafts per project and replaces an older stash', () => {
    const first = createMovieDocument('First');
    const second = createMovieDocument('Second');
    stashMovieDraft({ projectId: 'a', baseRevision: 1, draft: first, savedAt: 1 });
    stashMovieDraft({ projectId: 'b', baseRevision: 1, draft: createMovieDocument('B'), savedAt: 1 });
    stashMovieDraft({ projectId: 'a', baseRevision: 2, draft: second, savedAt: 2 });
    expect(takeMovieDraft('a', 1)).toBeNull();
    stashMovieDraft({ projectId: 'a', baseRevision: 2, draft: second, savedAt: 3 });
    expect(takeMovieDraft('a', 2)).toBe(second);
    dropMovieDraft('b');
    expect(takeMovieDraft('b', 1)).toBeNull();
  });
});
