// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { stageMovieHandoff, takeMovieHandoff } from '../../../src/components/movie/movie-handoff';
afterEach(() => { takeMovieHandoff(); sessionStorage.clear(); });
it('carries the home brief and design system once into the movie creator', () => {
  stageMovieHandoff({ brief: 'Make a film', designSystemId: 'fantay' });
  expect(takeMovieHandoff()).toEqual({ brief: 'Make a film', designSystemId: 'fantay' });
  expect(takeMovieHandoff()).toBeNull();
});
