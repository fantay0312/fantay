// SPDX-License-Identifier: Apache-2.0
// Fantay default chat column (spec 02 §7.6): the project-split-layout policy seam gives an uncustomized split
// 420 px (clamped to what the split allows); without a policy the upstream equal split stands; a dragged width
// still wins; the shell installs the policy at module evaluation only when it is on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CHAT_PANEL_WIDTH,
  MIN_CHAT_PANEL_WIDTH,
  SPLIT_RESIZE_HANDLE_WIDTH,
  defaultChatPanelWidthForSplit,
  resolveProjectSplitLayout,
  setDefaultChatPanelWidthPolicy,
} from '../../../src/components/project-split-layout';
import { fantayDefaultChatPanelWidth, installFantaySplitPolicy } from '../../../src/fantay/shell/split-policy';

describe('default chat width policy seam', () => {
  afterEach(() => {
    setDefaultChatPanelWidthPolicy(null);
  });

  it('keeps the upstream equal split without a policy', () => {
    setDefaultChatPanelWidthPolicy(null);
    expect(defaultChatPanelWidthForSplit(1192)).toBe(Math.round((1192 - SPLIT_RESIZE_HANDLE_WIDTH) / 2));
    expect(defaultChatPanelWidthForSplit(0)).toBe(DEFAULT_CHAT_PANEL_WIDTH);
  });

  it('gives 420 px with the Fantay policy, clamped to the split', () => {
    expect(installFantaySplitPolicy(true)).toBe(true);
    expect(fantayDefaultChatPanelWidth()).toBe(420);
    expect(defaultChatPanelWidthForSplit(1192)).toBe(420);
    expect(defaultChatPanelWidthForSplit(1600)).toBe(420);
    // a split too narrow for 420 + the 400 px workspace minimum clamps (never below the 345 px chat minimum)
    const narrow = defaultChatPanelWidthForSplit(760);
    expect(narrow).toBeLessThanOrEqual(420);
    expect(narrow).toBeGreaterThanOrEqual(Math.min(MIN_CHAT_PANEL_WIDTH, 760));
  });

  it('lets a width the user dragged win over the policy', () => {
    installFantaySplitPolicy(true);
    expect(resolveProjectSplitLayout(1400, { width: 600, customized: true }).chatPanelWidth).toBe(600);
    expect(resolveProjectSplitLayout(1400, { width: 460, customized: false }).chatPanelWidth).toBe(420);
  });

  it('does not install anything when the shell is off', () => {
    setDefaultChatPanelWidthPolicy(null);
    expect(installFantaySplitPolicy(false)).toBe(false);
    expect(defaultChatPanelWidthForSplit(1192)).toBe(594);
  });
});

describe('split-policy module evaluation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('installs the policy when the shell is on', async () => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    const layout = await import('../../../src/components/project-split-layout');
    await import('../../../src/fantay/shell/split-policy');
    expect(layout.defaultChatPanelWidthForSplit(1192)).toBe(420);
    layout.setDefaultChatPanelWidthPolicy(null);
  });

  it('leaves the upstream default when the shell is off (the vitest default)', async () => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '0');
    const layout = await import('../../../src/components/project-split-layout');
    await import('../../../src/fantay/shell/split-policy');
    expect(layout.defaultChatPanelWidthForSplit(1192)).toBe(594);
  });
});
