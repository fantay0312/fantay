// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { requestEntryNewProject, subscribeEntryNewProject } from '../../src/components/entryRailBridge';

describe('new project entry', () => {
  it('opens the mounted dialog when the sidebar requests it', () => {
    const open = vi.fn();
    const stop = subscribeEntryNewProject(open);
    try {
      requestEntryNewProject();
      expect(open).toHaveBeenCalledOnce();
    } finally { stop(); }
  });

  it('retains a request across navigation and consumes it only once', () => {
    requestEntryNewProject();
    const open = vi.fn();
    const stop = subscribeEntryNewProject(open);
    expect(open).toHaveBeenCalledOnce();
    stop();
    const afterRemount = vi.fn();
    subscribeEntryNewProject(afterRemount)();
    expect(afterRemount).not.toHaveBeenCalled();
  });
});
