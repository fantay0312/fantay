import { describe, it, expect } from 'vitest';
import { withStudioEditorLock } from '../../src/design-systems/studio-editor.js';

describe('studio editor write serialization', () => {
  it('detects a stale second editor after the first editor commits', async () => {
    let content = 'before';
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const first = withStudioEditorLock('same-system', async () => { expect(content).toBe('before'); await pending; content = 'first'; });
    const second = withStudioEditorLock('same-system', async () => { if (content !== 'before') throw new Error('TOKEN_CONFLICT'); content = 'second'; });
    const rejection = expect(second).rejects.toThrow('TOKEN_CONFLICT');
    release(); await first; await rejection;
    expect(content).toBe('first');
  });
  it('releases a failed write without blocking later saves', async () => {
    await expect(withStudioEditorLock('retry', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    await expect(withStudioEditorLock('retry', async () => 'saved')).resolves.toBe('saved');
  });
});
