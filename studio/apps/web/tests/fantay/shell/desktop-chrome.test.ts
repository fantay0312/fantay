// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Web side of the desktop chrome (spec 02 §10.6, §14): colour parsing for the Windows overlay, menu labels,
// zoom100 mapping, and the hook wiring native menu commands into the web command registry.
import { act, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  listener: null as null | ((command: string) => void),
  unsubscribe: vi.fn(),
  setLabels: vi.fn(async () => ({ ok: true })),
  setOverlay: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@open-design/host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@open-design/host')>();
  return {
    ...actual,
    subscribeHostMenuCommands: (listener: (command: string) => void) => {
      host.listener = listener;
      return host.unsubscribe;
    },
    setHostMenuLabels: host.setLabels,
    setHostTitleBarOverlay: host.setOverlay,
  };
});

import { en } from '../../../src/i18n/locales/en';
import type { Dict } from '../../../src/i18n/types';
import { registerFantayCommand, resetFantayCommandsForTests } from '../../../src/fantay/shell/commands';
import {
  buildFantayMenuLabels,
  mapHostMenuCommand,
  resolveCssColorToHex,
  runHostMenuCommand,
  useDesktopShellChrome,
} from '../../../src/fantay/shell/desktop-chrome';
import { __resetToastsForTests, useToasts } from '../../../src/fantay/ui/toast';

const t = (key: keyof Dict) => en[key];

describe('resolveCssColorToHex', () => {
  it('normalizes hex, rgb()/rgba() and color(srgb …) to #rrggbb', () => {
    expect(resolveCssColorToHex('#abc')).toBe('#aabbcc');
    expect(resolveCssColorToHex('#141414')).toBe('#141414');
    expect(resolveCssColorToHex(' #A9A8A5 ')).toBe('#a9a8a5');
    expect(resolveCssColorToHex('rgb(20, 20, 20)')).toBe('#141414');
    expect(resolveCssColorToHex('rgba(253, 253, 253, 0.5)')).toBe('#fdfdfd');
    expect(resolveCssColorToHex('rgb(20 20 20 / 50%)')).toBe('#141414');
    expect(resolveCssColorToHex('color(srgb 0.0784 0.0784 0.0784)')).toBe('#141414');
    expect(resolveCssColorToHex('color(srgb 1 1 1 / 0.4)')).toBe('#ffffff');
  });

  it('rejects anything else', () => {
    expect(resolveCssColorToHex('')).toBeNull();
    expect(resolveCssColorToHex(null)).toBeNull();
    expect(resolveCssColorToHex('var(--paper)')).toBeNull();
    expect(resolveCssColorToHex('#12')).toBeNull();
    expect(resolveCssColorToHex('rgb(1, 2)')).toBeNull();
    expect(resolveCssColorToHex('hsl(0 0% 8%)')).toBeNull();
    expect(resolveCssColorToHex('transparent')).toBeNull();
  });
});

describe('menu labels and command mapping', () => {
  it('builds every native menu label from the fantayMenu.* keys', () => {
    expect(buildFantayMenuLabels(t)).toEqual({
      file: en['fantayMenu.file'],
      newProject: en['fantayMenu.newProject'],
      newChat: en['fantayMenu.newChat'],
      importDesign: en['fantayMenu.importDesign'],
      settings: en['fantayMenu.settings'],
      toggleSidebar: en['fantayMenu.toggleSidebar'],
      zoomIn: en['fantayMenu.zoomIn'],
      zoomOut: en['fantayMenu.zoomOut'],
      zoomFit: en['fantayMenu.zoomFit'],
      zoom100: en['fantayMenu.zoom100'],
    });
  });

  it('maps zoom100 to zoomTo {zoom: 1} and keeps every other command', () => {
    expect(mapHostMenuCommand('fantay.board.zoom100')).toEqual(['fantay.board.zoomTo', { zoom: 1 }]);
    expect(mapHostMenuCommand('fantay.toggleSidebar')).toEqual(['fantay.toggleSidebar']);
    expect(mapHostMenuCommand('fantay.design.import')).toEqual(['fantay.design.import']);
  });
});

describe('useDesktopShellChrome', () => {
  beforeEach(() => {
    host.listener = null;
    host.unsubscribe.mockClear();
    host.setLabels.mockClear();
    host.setOverlay.mockClear();
    resetFantayCommandsForTests();
    __resetToastsForTests();
  });

  afterEach(() => {
    resetFantayCommandsForTests();
    vi.restoreAllMocks();
  });

  it('does nothing on the web', () => {
    const rootRef = createRef<HTMLElement>();
    renderHook(() => useDesktopShellChrome({ clientType: 'web', hostPlatform: undefined, rootRef, locale: 'en', t }));
    expect(host.listener).toBeNull();
    expect(host.setLabels).not.toHaveBeenCalled();
    expect(host.setOverlay).not.toHaveBeenCalled();
  });

  it('dispatches native menu commands, relabels on locale change and toasts an unhandled design import', () => {
    const zoomTo = vi.fn();
    const toggle = vi.fn();
    const search = vi.fn();
    registerFantayCommand('fantay.board.zoomTo', zoomTo);
    registerFantayCommand('fantay.toggleSidebar', toggle);
    registerFantayCommand('fantay.search', search);
    const rootRef = createRef<HTMLElement>();
    const toasts = renderHook(() => useToasts());
    const { rerender, unmount } = renderHook(
      ({ locale }: { locale: string }) => useDesktopShellChrome({ clientType: 'desktop', hostPlatform: 'darwin', rootRef, locale, t }),
      { initialProps: { locale: 'en' } },
    );
    expect(host.setLabels).toHaveBeenCalledTimes(1);
    expect(host.setLabels).toHaveBeenLastCalledWith(buildFantayMenuLabels(t));

    act(() => host.listener?.('fantay.board.zoom100'));
    expect(zoomTo).toHaveBeenCalledWith({ zoom: 1 });
    act(() => host.listener?.('fantay.toggleSidebar'));
    expect(toggle).toHaveBeenCalledTimes(1);
    act(() => host.listener?.('fantay.search'));
    expect(search).toHaveBeenCalledTimes(1);
    // board zoom without a mounted board is silent
    expect(runHostMenuCommand('fantay.board.zoomFit')).toBe(false);
    act(() => host.listener?.('fantay.design.import'));
    expect(toasts.result.current.map((record) => record.title)).toEqual([en['fantayShell.command.unavailable']]);

    rerender({ locale: 'zh-CN' });
    expect(host.setLabels).toHaveBeenCalledTimes(2);
    unmount();
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);
    // no overlay outside Windows
    expect(host.setOverlay).not.toHaveBeenCalled();
  });

  it('recolours the Windows title-bar overlay from the live tokens and de-duplicates payloads', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const rootRef = { current: root };
    let paper = 'rgb(20, 20, 20)';
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element) => {
      const variable = element.getAttribute('data-fx-probe');
      return { color: variable === '--paper' ? paper : 'rgb(169, 168, 165)' } as CSSStyleDeclaration;
    });
    const { unmount } = renderHook(() =>
      useDesktopShellChrome({ clientType: 'desktop', hostPlatform: 'win32', rootRef, locale: 'en', t }),
    );
    expect(host.setOverlay).toHaveBeenCalledTimes(1);
    expect(host.setOverlay).toHaveBeenLastCalledWith({ color: '#141414', symbolColor: '#a9a8a5', height: 44 });
    // the probe never stays in the DOM
    expect(root.childElementCount).toBe(0);

    // a theme repaint with the same colours sends nothing; a real change sends once
    document.documentElement.setAttribute('data-theme', 'dark');
    await Promise.resolve();
    expect(host.setOverlay).toHaveBeenCalledTimes(1);
    paper = 'rgb(253, 253, 253)';
    document.documentElement.setAttribute('data-theme', 'light');
    await Promise.resolve();
    expect(host.setOverlay).toHaveBeenCalledTimes(2);
    expect(host.setOverlay).toHaveBeenLastCalledWith({ color: '#fdfdfd', symbolColor: '#a9a8a5', height: 44 });
    unmount();
    root.remove();
  });
});
