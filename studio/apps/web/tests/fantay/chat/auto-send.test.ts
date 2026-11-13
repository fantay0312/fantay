// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  autoSendFirstMessageKey,
  autoSendPromptKey,
  stageProjectAutoSend,
} from '../../../src/fantay/chat/auto-send';

describe('stageProjectAutoSend', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it('writes the ProjectView auto-send handshake keys', () => {
    expect(stageProjectAutoSend('p1', '为这部影片生成分镜')).toBe(true);
    expect(window.sessionStorage.getItem('od:auto-send-first:p1')).toBe('1');
    expect(window.sessionStorage.getItem('od:auto-send-prompt:p1')).toBe('为这部影片生成分镜');
    expect(autoSendFirstMessageKey('p1')).toBe('od:auto-send-first:p1');
    expect(autoSendPromptKey('p1')).toBe('od:auto-send-prompt:p1');
  });

  it('returns false when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(stageProjectAutoSend('p1', 'prompt')).toBe(false);
  });

  it('does not leave the send flag without its prompt', () => {
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith('od:auto-send-prompt:')) throw new Error('QuotaExceededError');
      setItem.call(this, key, value);
    });
    expect(stageProjectAutoSend('p1', 'prompt')).toBe(false);
    expect(window.sessionStorage.getItem('od:auto-send-first:p1')).toBeNull();
  });
});
