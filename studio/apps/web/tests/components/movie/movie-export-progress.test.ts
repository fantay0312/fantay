import { expect, it } from 'vitest';
import { movieExportProgress } from '../../../src/components/movie/movie-export-progress';
it('uses completed frames for progress and reserves the end for encoding and saving', () => {
  expect(movieExportProgress('Frames 150/300', false, true)).toEqual({ value: 45, label: '正在合成画面 · 150 / 300 帧' });
  expect(movieExportProgress('Frames 300/300', false, true).value).toBe(90);
  expect(movieExportProgress('Encoding 300 frame(s)', false, true).value).toBe(92);
  expect(movieExportProgress(undefined, true, true).value).toBe(98);
  expect(movieExportProgress('Frames 1/0', false, true).value).toBe(0);
});
