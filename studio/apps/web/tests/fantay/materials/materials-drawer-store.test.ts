// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MATERIALS_DRAWER_WIDTH_STORAGE_KEY,
  closeMaterialsDrawer,
  getMaterialsDrawerState,
  openMaterialsDrawer,
  resetMaterialsDrawerForTests,
  setMaterialsDrawerWidth,
  toggleMaterialsDrawer,
  useMaterialsDrawer,
} from '../../../src/fantay/materials/materials-drawer-store';

describe('materials drawer store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetMaterialsDrawerForTests();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
    resetMaterialsDrawerForTests();
  });

  it('starts closed at the default width', () => {
    expect(MATERIALS_DRAWER_WIDTH_STORAGE_KEY).toBe('fantay:materials-drawer:width');
    expect(getMaterialsDrawerState()).toEqual({ open: false, width: 360 });
  });

  it('opens, closes and toggles, notifying the hook', () => {
    const drawer = renderHook(() => useMaterialsDrawer());
    expect(drawer.result.current.open).toBe(false);

    act(() => openMaterialsDrawer());
    expect(drawer.result.current.open).toBe(true);
    act(() => toggleMaterialsDrawer());
    expect(drawer.result.current.open).toBe(false);
    act(() => toggleMaterialsDrawer());
    expect(drawer.result.current.open).toBe(true);
    act(() => closeMaterialsDrawer());
    expect(drawer.result.current.open).toBe(false);
  });

  it('keeps the controller object stable while nothing changes', () => {
    const drawer = renderHook(() => useMaterialsDrawer());
    const first = drawer.result.current;
    act(() => closeMaterialsDrawer());
    drawer.rerender();
    expect(drawer.result.current).toBe(first);
  });

  it('reads the persisted width and clamps it to 320–520', () => {
    window.localStorage.setItem(MATERIALS_DRAWER_WIDTH_STORAGE_KEY, '440');
    resetMaterialsDrawerForTests();
    expect(getMaterialsDrawerState().width).toBe(440);

    window.localStorage.setItem(MATERIALS_DRAWER_WIDTH_STORAGE_KEY, '9999');
    resetMaterialsDrawerForTests();
    expect(getMaterialsDrawerState().width).toBe(520);

    window.localStorage.setItem(MATERIALS_DRAWER_WIDTH_STORAGE_KEY, '12');
    resetMaterialsDrawerForTests();
    expect(getMaterialsDrawerState().width).toBe(320);

    window.localStorage.setItem(MATERIALS_DRAWER_WIDTH_STORAGE_KEY, 'wide');
    resetMaterialsDrawerForTests();
    expect(getMaterialsDrawerState().width).toBe(360);
  });

  it('clamps, persists and publishes width changes through setWidth', () => {
    const drawer = renderHook(() => useMaterialsDrawer());
    act(() => drawer.result.current.setWidth(400.6));
    expect(drawer.result.current.width).toBe(401);
    expect(window.localStorage.getItem(MATERIALS_DRAWER_WIDTH_STORAGE_KEY)).toBe('401');

    act(() => setMaterialsDrawerWidth(1000));
    expect(drawer.result.current.width).toBe(520);
    act(() => setMaterialsDrawerWidth(Number.NaN));
    expect(drawer.result.current.width).toBe(360);
  });

  it('works when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    resetMaterialsDrawerForTests();
    expect(getMaterialsDrawerState().width).toBe(360);
    expect(() => setMaterialsDrawerWidth(480)).not.toThrow();
    expect(getMaterialsDrawerState().width).toBe(480);
  });

  it('server-renders closed at the default width (B2 getServerSnapshot)', () => {
    openMaterialsDrawer();
    setMaterialsDrawerWidth(500);
    function Probe() {
      const drawer = useMaterialsDrawer();
      return createElement('span', null, `${drawer.open ? 'open' : 'closed'}:${drawer.width}`);
    }
    expect(renderToString(createElement(Probe))).toBe('<span>closed:360</span>');
  });
});
