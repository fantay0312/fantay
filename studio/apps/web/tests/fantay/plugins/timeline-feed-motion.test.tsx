// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TIMELINE_COPY } from '../../../src/fantay/plugins/builtin/project-timeline/copy';
import { TimelineFeed } from '../../../src/fantay/plugins/builtin/project-timeline/TimelineFeed';
import type { TimelineEntry } from '../../../src/fantay/plugins/builtin/project-timeline/timeline-model';

const note: TimelineEntry = { id: 'note:1', project: null, kind: 'note', at: 300, text: 'Recent update', files: [] };
const reply: TimelineEntry = { id: 'run:1', project: null, kind: 'running', at: 200, files: [] };
const completed = { ...reply, kind: 'succeeded', completedAt: 400 } as const;
const props = {
  order: 'progress', copy: TIMELINE_COPY.en, locale: 'en', context: null,
  followed: new Set<string>(), onSelect: vi.fn(), onToggleFollow: vi.fn(),
} as const;

const offsetTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
const animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');

function mockLayout(reduced: boolean) {
  const animations: { row?: string; keyframes: Keyframe[]; duration: number }[] = [];
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) { return Array.from(this.parentElement?.children ?? []).indexOf(this) * 100; },
  });
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value(this: HTMLElement, keyframes: Keyframe[], { duration }: { duration: number }) {
      animations.push({ row: this.dataset.entryId, keyframes, duration });
      return { cancel: vi.fn() };
    },
  });
  return animations;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (offsetTopDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTopDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'offsetTop');
  if (animateDescriptor) Object.defineProperty(HTMLElement.prototype, 'animate', animateDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
});

describe('timeline progress motion', () => {
  it('moves the existing reply card from its previous position when it completes', () => {
    const animations = mockLayout(false);
    const view = render(<TimelineFeed {...props} entries={[note, reply]} />);
    const list = view.getByTestId('project-timeline-progress-list');
    const original = list.children[1];
    expect(animations).toHaveLength(0);
    view.rerender(<TimelineFeed {...props} entries={[completed, note]} />);
    expect(list.children[0]).toBe(original);
    expect(animations).toContainEqual(expect.objectContaining({
      row: 'run:1', duration: 320,
      keyframes: expect.arrayContaining([expect.objectContaining({ transform: 'translateY(100px)' })]),
    }));
  });

  it('moves directly to the new order when reduced motion is requested', () => {
    const animations = mockLayout(true);
    const view = render(<TimelineFeed {...props} entries={[note, reply]} />);
    view.rerender(<TimelineFeed {...props} entries={[completed, note]} />);
    expect(view.getByTestId('project-timeline-progress-list').firstElementChild?.getAttribute('data-entry-id')).toBe(reply.id);
    expect(animations).toHaveLength(0);
  });
});
