// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const themeState = vi.hoisted(() => ({
  preference: 'light' as 'dark' | 'light',
  setPreference: vi.fn(),
}));

vi.mock('../../../src/fantay/theme/theme', () => ({
  useTheme: () => ({
    preference: themeState.preference,
    resolved: themeState.preference,
    setPreference: themeState.setPreference,
  }),
}));

import { I18nProvider } from '../../../src/i18n';
import { ThemeSegmented } from '../../../src/fantay/theme/ThemeSegmented';

beforeEach(() => {
  themeState.preference = 'light';
  themeState.setPreference.mockReset();
});

afterEach(cleanup);

describe('ThemeSegmented', () => {
  it('offers only Dark and Light buttons under the Appearance label, defaulting to Light', () => {
    render(<ThemeSegmented />);
    const group = screen.getByRole('radiogroup', { name: 'Appearance' });
    expect(group).toHaveAttribute('data-size', 'md');
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('radio', { name: 'System' })).toBeNull();
  });

  it('calls setPreference with the chosen value only on a change and supports arrow keys', () => {
    render(<ThemeSegmented size="sm" className="ms-auto" />);
    const group = screen.getByRole('radiogroup');
    expect(group).toHaveAttribute('data-size', 'sm');
    expect(group.className).toContain('ms-auto');

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(themeState.setPreference).toHaveBeenCalledWith('dark');

    themeState.setPreference.mockClear();
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(themeState.setPreference).not.toHaveBeenCalled();

    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(themeState.setPreference).toHaveBeenCalledWith('dark');
  });

  it('uses the zh-CN labels for the two appearance buttons', () => {
    themeState.preference = 'dark';
    render(
      <I18nProvider initial="zh-CN">
        <ThemeSegmented />
      </I18nProvider>,
    );
    expect(screen.getByRole('radiogroup', { name: '外观' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '深色' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '浅色' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('radio', { name: '跟随系统' })).toBeNull();
  });
});
