import { expect, it } from 'vitest';
import { parseMovieExportOptions } from '../../src/movie/export-profile.js';
it('validates real containers, even dimensions and rational frame rates before starting a render', () => {
  expect(parseMovieExportOptions(undefined)).toBeUndefined();
  const profile = { format: 'mov', width: 1080, height: 1920, frameRate: { numerator: 30000, denominator: 1001 } };
  expect(parseMovieExportOptions(profile)).toEqual(profile);
  for (const patch of [{ format: 'webm' }, { width: 1919 }, { height: Infinity }, { frameRate: { numerator: 30000, denominator: 0 } }, { frameRate: { numerator: 240, denominator: 1 } }]) {
    expect(() => parseMovieExportOptions({ ...profile, ...patch })).toThrow();
  }
});
