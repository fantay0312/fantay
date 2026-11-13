import { expect, it } from 'vitest';
import { withNativeProject } from '../../src/movie/native-project-queue.js';

it('keeps project binding and edits together while other projects progress', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const first = withNativeProject('a', async () => { calls.push('a:bind'); await gate; calls.push('a:edit'); });
  const second = withNativeProject('a', async () => { calls.push('a:second'); });
  await withNativeProject('b', async () => { calls.push('b:edit'); });
  expect(calls).toEqual(['a:bind', 'b:edit']);
  release();
  await Promise.all([first, second]);
  expect(calls).toEqual(['a:bind', 'b:edit', 'a:edit', 'a:second']);
});

it('releases the project after a failed edit', async () => {
  await expect(withNativeProject('failed', async () => { throw new Error('failure'); })).rejects.toThrow('failure');
  await expect(withNativeProject('failed', async () => 'ready')).resolves.toBe('ready');
});
