// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Kbd, KbdCombo, formatShortcut, isMacPlatform } from '../../../src/fantay/ui/kbd';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('formatShortcut', () => {
  it('formats modifiers per platform', () => {
    expect(formatShortcut('mod+shift+k', 'mac')).toEqual(['⌘', '⇧', 'K']);
    expect(formatShortcut('mod+shift+k', 'other')).toEqual(['Ctrl', 'Shift', 'K']);
    expect(formatShortcut('alt+enter', 'mac')).toEqual(['⌥', '↵']);
    expect(formatShortcut('alt+enter', 'other')).toEqual(['Alt', 'Enter']);
    expect(formatShortcut('ctrl+backspace', 'mac')).toEqual(['⌃', '⌫']);
    expect(formatShortcut('ctrl+backspace', 'other')).toEqual(['Ctrl', 'Backspace']);
  });

  it('maps esc, arrows and plain keys', () => {
    expect(formatShortcut('esc', 'mac')).toEqual(['Esc']);
    expect(formatShortcut('shift+up', 'other')).toEqual(['Shift', '↑']);
    expect(formatShortcut('down', 'mac')).toEqual(['↓']);
    expect(formatShortcut('left', 'other')).toEqual(['←']);
    expect(formatShortcut('right', 'other')).toEqual(['→']);
    expect(formatShortcut('v', 'other')).toEqual(['V']);
    expect(formatShortcut('mod+\\', 'mac')).toEqual(['⌘', '\\']);
    expect(formatShortcut('mod++', 'other')).toEqual(['Ctrl', '+']);
  });

  it('detects the platform from the navigator', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(isMacPlatform()).toBe(true);
    expect(formatShortcut('mod+k')).toEqual(['⌘', 'K']);
    vi.stubGlobal('navigator', { platform: 'Win32', userAgentData: { platform: 'Windows' } });
    expect(isMacPlatform()).toBe(false);
    expect(formatShortcut('mod+k')).toEqual(['Ctrl', 'K']);
    vi.stubGlobal('navigator', { platform: '', userAgentData: { platform: 'macOS' } });
    expect(isMacPlatform()).toBe(true);
  });
});

describe('Kbd', () => {
  it('renders key caps in three variants', () => {
    const { container } = render(
      <>
        <Kbd>Esc</Kbd>
        <Kbd variant="onInk">K</Kbd>
        <KbdCombo shortcut="mod+k" variant="plain" platform="mac" />
      </>,
    );
    const keys = container.querySelectorAll('kbd');
    expect(keys).toHaveLength(4);
    expect(keys[0]).toHaveAttribute('data-variant', 'default');
    expect(keys[0]?.className).toContain('text-micro');
    expect(keys[1]?.className).toContain('text-paper/75');
    expect(keys[2]).toHaveTextContent('⌘');
    expect(keys[2]?.className).toContain('text-caption');
    expect(keys[3]).toHaveTextContent('K');
  });
});
